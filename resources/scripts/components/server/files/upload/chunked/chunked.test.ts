import AdaptiveConcurrency from '@/components/server/files/upload/chunked/adaptive';
import { ChunkedDeps, uploadChunked } from '@/components/server/files/upload/chunked/chunkedEngine';
import { CHUNKED_MIN_BYTES, StrategyDeps, uploadAuto } from '@/components/server/files/upload/chunked/uploadStrategy';
import {
    CompleteResult,
    RemoteSession,
    UploadSessionGrant,
    WingsApi,
} from '@/components/server/files/upload/chunked/types';
import { classifyUploadError, UploadFlowError } from '@/components/server/files/upload/errors';
import { RemoteEntry, UploadJob, UploadPatch } from '@/components/server/files/upload/uploadEngine';

// Messages are localized from navigator.language; pin the locale so assertions do not depend on the machine.
jest.mock('@/i18n/locale', () => ({
    ...jest.requireActual('@/i18n/locale'),
    getBrowserLocale: jest.fn(() => 'en'),
}));

const CHUNK = 1000;

const nodeError = (status: number, code: string, error = 'x') => ({ response: { status, data: { error, code } } });

/* -------------------------------- adaptive concurrency -------------------------------- */

/**
 * Simulates a link where every connection can carry at most `perConn` bytes/s and the whole path at most `cap`.
 * Each call advances `windows` measurement windows and feeds the controller what such a link would carry.
 */
const simulate = (
    ctl: AdaptiveConcurrency,
    model: (n: number) => number,
    windows: number,
    windowMs = 1000
): number[] => {
    const targets: number[] = [];
    let now = 0;
    ctl.record(0, now);

    for (let w = 0; w < windows; w++) {
        const rate = model(ctl.target);
        for (let step = 0; step < 10; step++) {
            now += windowMs / 10;
            ctl.record((rate * windowMs) / 10 / 1000, now);
        }
        ctl.tick(now);
        targets.push(ctl.target);
    }

    return targets;
};

describe('AdaptiveConcurrency', () => {
    const opts = { windowMs: 1000, max: 8, initial: 1, holdWindows: 3 };

    it('grows while each extra connection adds throughput (per-connection limited path)', () => {
        const ctl = new AdaptiveConcurrency(opts);
        // One connection gets 0.5 MB/s no matter what; the link itself is far from full.
        simulate(ctl, (n) => n * 500_000, 12);

        expect(ctl.target).toBe(8);
    });

    it('stops at the point where more connections no longer help (link-limited path)', () => {
        const ctl = new AdaptiveConcurrency(opts);
        // Link of 2 MB/s, 0.5 MB/s per connection: 4 connections fill it.
        simulate(ctl, (n) => Math.min(n * 500_000, 2_000_000), 30);

        expect(ctl.target).toBeGreaterThanOrEqual(4);
        expect(ctl.target).toBeLessThanOrEqual(5);
    });

    it('does not climb at all when one connection already fills the link', () => {
        const ctl = new AdaptiveConcurrency(opts);
        simulate(ctl, (n) => Math.min(n * 5_000_000, 5_000_000), 30);

        expect(ctl.target).toBeLessThanOrEqual(2);
    });

    it('goes back when more connections make things worse', () => {
        const ctl = new AdaptiveConcurrency(opts);
        // Peaks at 3 connections, then degrades (e.g. the node or disk becomes the bottleneck).
        const targets = simulate(ctl, (n) => (n <= 3 ? n * 1_000_000 : 3_000_000 - (n - 3) * 600_000), 30);

        // Settles on the best number (3), not just "not too many": a smaller number is kept when it is not worse.
        const settled = targets.slice(-12).sort((a, b) => a - b);
        expect(settled[Math.floor(settled.length / 2)]).toBe(3);
    });

    it('never leaves its bounds and halves on errors and on a busy node', () => {
        const ctl = new AdaptiveConcurrency({ ...opts, max: 4, initial: 4 });
        expect(ctl.target).toBe(4);

        ctl.onError();
        expect(ctl.target).toBe(2);
        ctl.onError();
        ctl.onError();
        expect(ctl.target).toBe(1);

        const busy = new AdaptiveConcurrency({ ...opts, max: 8, initial: 6 });
        busy.onBusy(3);
        expect(busy.target).toBe(3);
        busy.onBusy(0);
        expect(busy.target).toBe(1);
    });

    it('waits out the hold period after a failed probe before trying again', () => {
        const ctl = new AdaptiveConcurrency({ ...opts, initial: 2, holdWindows: 4 });
        const targets = simulate(ctl, () => 1_000_000, 8); // flat: more connections never help

        // After the probe 2 -> 4 fails it returns to 2 and stays there for the hold period.
        const firstReturn = targets.indexOf(2, targets.indexOf(4));
        expect(firstReturn).toBeGreaterThan(-1);
        expect(targets.slice(firstReturn, firstReturn + 4).every((t) => t === 2)).toBe(true);
    });
});

/* ------------------------------------- engine -------------------------------------- */

/** An in-memory Wings: stores chunks, reports sessions, and can be told to misbehave. */
class FakeNode implements WingsApi {
    chunks = new Map<number, string>();
    created = 0;
    putCalls: number[] = [];
    completeCalls = 0;
    aborted = false;
    concurrent = 0;
    maxConcurrent = 0;
    failures: Array<(index: number, call: number) => unknown> = [];
    completeError: unknown = null;
    sessionExists = false;

    readonly size: number;
    readonly chunkSize: number;

    constructor(size: number, chunkSize = CHUNK) {
        this.size = size;
        this.chunkSize = chunkSize;
    }

    get count() {
        return Math.ceil(this.size / this.chunkSize);
    }

    private session(): RemoteSession {
        const idx = [...this.chunks.keys()].sort((a, b) => a - b);
        const received: Array<[number, number]> = [];
        for (const i of idx) {
            const last = received[received.length - 1];
            if (last && last[1] === i - 1) last[1] = i;
            else received.push([i, i]);
        }

        return {
            session_id: 'a'.repeat(32),
            name: 'f.bin',
            directory: '/',
            size: this.size,
            chunk_size: this.chunkSize,
            chunk_count: this.count,
            max_parallel: 8,
            received,
            received_bytes: idx.reduce((s, i) => s + Math.min(this.chunkSize, this.size - i * this.chunkSize), 0),
            hashed_bytes: 0,
        };
    }

    async createSession() {
        this.created++;
        const resumed = this.sessionExists;
        this.sessionExists = true;

        return { resumed, session: this.session() };
    }

    async getSession() {
        return this.session();
    }

    async putChunk({ index, blob, sha256, onProgress }: Parameters<WingsApi['putChunk']>[0]) {
        const call = this.putCalls.push(index);
        this.concurrent++;
        this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
        try {
            await new Promise((resolve) => setTimeout(resolve, 3));
            for (const f of this.failures) {
                const err = f(index, call);
                if (err) throw err;
            }
            onProgress(blob.size / 2);
            await Promise.resolve();
            onProgress(blob.size);
            this.chunks.set(index, sha256 ?? 'none');

            return { already: false };
        } finally {
            this.concurrent--;
        }
    }

    async complete(): Promise<CompleteResult> {
        this.completeCalls++;
        if (this.completeError) throw this.completeError;
        if (this.chunks.size !== this.count) throw nodeError(409, 'E_INCOMPLETE');

        return { name: 'f.bin', size: this.size, sha256: 'f'.repeat(64) };
    }

    async abort() {
        this.aborted = true;
        this.chunks.clear();
    }
}

const grant = (over: Partial<UploadSessionGrant> = {}): UploadSessionGrant => ({
    supported: true,
    baseUrl: 'https://node:8443',
    token: 't0',
    sessionId: 'a'.repeat(32),
    replace: true,
    chunkSize: CHUNK,
    maxParallelChunks: 8,
    maxSize: 0,
    http2: true,
    expiresAt: '2030-01-01T00:00:00Z',
    ...over,
});

const makeBlob = (size: number, name = 'f.bin') =>
    ({
        name,
        size,
        lastModified: 123,
        slice: (a: number, b: number) => ({ size: b - a, start: a }),
    } as unknown as Blob & { name: string });

interface Rig {
    node: FakeNode;
    deps: ChunkedDeps;
    patches: UploadPatch[];
    job: (over?: Partial<UploadJob>) => UploadJob;
    pending: { saved: string[]; removed: string[] };
    grants: number;
    fs: RemoteEntry[];
}

let clock = 0;
const rig = (size: number): Rig => {
    const node = new FakeNode(size);
    const pending = { saved: [] as string[], removed: [] as string[] };
    const patches: UploadPatch[] = [];
    const r = { grants: 0, fs: [] as RemoteEntry[] } as Rig;
    r.node = node;
    r.patches = patches;
    r.pending = pending;
    r.deps = {
        getGrant: async () => {
            r.grants++;
            return grant({ token: `t${r.grants}` });
        },
        wings: node,
        list: async () => r.fs,
        digest: async (b) => `d${(b as any).start}`,
        sleep: () =>
            new Promise<void>((resolve) =>
                setTimeout(() => {
                    clock += 100;
                    resolve();
                }, 1)
            ),
        now: () => clock,
        pending: { save: (e) => pending.saved.push(e.sessionId), remove: (id) => pending.removed.push(id) },
    };
    r.job = (over = {}) => ({
        uuid: 'u',
        directory: '/mods',
        blob: makeBlob(size),
        signal: new AbortController().signal,
        staged: true,
        canReplace: true,
        onUpdate: (p) => patches.push(p),
        ...over,
    });

    return r;
};

const lastStatus = (patches: UploadPatch[]) => [...patches].reverse().find((p) => p.status)?.status;

describe('uploadChunked', () => {
    beforeEach(() => {
        clock = 0;
    });

    it('uploads every chunk once, in parallel, then completes and reports the node hash', async () => {
        const r = rig(CHUNK * 12 + 300);

        await uploadChunked(r.job(), grant(), r.deps, { maxConnections: 8 });

        expect([...r.node.chunks.keys()].sort((a, b) => a - b)).toEqual(Array.from({ length: 13 }, (_, i) => i));
        expect(r.node.putCalls.sort((a, b) => a - b)).toEqual(Array.from({ length: 13 }, (_, i) => i)); // no duplicates
        expect(r.node.maxConcurrent).toBeGreaterThan(1);
        expect(r.node.maxConcurrent).toBeLessThanOrEqual(8);
        expect(r.node.completeCalls).toBe(1);
        expect(lastStatus(r.patches)).toBe('done');
        expect(r.patches[r.patches.length - 1].sha256).toBe('f'.repeat(64));
        expect(r.pending.saved).toHaveLength(1);
        expect(r.pending.removed).toEqual([grant().sessionId]);
    });

    it('sends each chunk with its SHA-256 so the node can verify it', async () => {
        const r = rig(CHUNK * 3);
        await uploadChunked(r.job(), grant(), r.deps);

        expect([...r.node.chunks.values()].sort()).toEqual(['d0', 'd1000', 'd2000']);
    });

    it('resumes: only the missing chunks are sent, and the progress starts from what the node already has', async () => {
        const r = rig(CHUNK * 10);
        [0, 1, 2, 3, 4, 7].forEach((i) => r.node.chunks.set(i, 'old'));
        r.node.sessionExists = true;

        await uploadChunked(r.job(), grant(), r.deps);

        expect(r.node.putCalls.sort((a, b) => a - b)).toEqual([5, 6, 8, 9]);
        expect(r.patches.find((p) => p.resumedFrom)?.resumedFrom).toBe(6 * CHUNK);
        expect(r.patches[0].loaded).toBeUndefined(); // first patch only resets counters...
        expect(r.patches.find((p) => p.status === 'uploading' && p.loaded !== undefined)?.loaded).toBe(6 * CHUNK);
        expect(lastStatus(r.patches)).toBe('done');
    });

    it('never asks for more connections than the node allows', async () => {
        const r = rig(CHUNK * 20);
        await uploadChunked(r.job(), grant({ maxParallelChunks: 3 }), r.deps, { maxConnections: 8 });

        expect(r.node.maxConcurrent).toBeLessThanOrEqual(3);
    });

    it('retries a chunk that fails with a recoverable error and still delivers everything', async () => {
        const r = rig(CHUNK * 4);
        let failed = false;
        r.node.failures.push((index) => {
            if (index === 2 && !failed) {
                failed = true;
                return { code: 'ERR_NETWORK', message: 'Network Error' };
            }
            return undefined;
        });

        await uploadChunked(r.job(), grant(), r.deps);

        expect(r.node.chunks.size).toBe(4);
        expect(r.node.putCalls.filter((i) => i === 2)).toHaveLength(2);
        expect(lastStatus(r.patches)).toBe('done');
    });

    it('renews an expired token transparently and keeps going', async () => {
        const r = rig(CHUNK * 4);
        let expired = false;
        r.node.failures.push((index) => {
            if (index === 1 && !expired) {
                expired = true;
                return nodeError(401, 'E_TOKEN');
            }
            return undefined;
        });

        await uploadChunked(r.job(), grant(), r.deps);

        expect(r.grants).toBeGreaterThanOrEqual(1);
        expect(lastStatus(r.patches)).toBe('done');
    });

    it('resends a chunk the node found damaged (checksum mismatch)', async () => {
        const r = rig(CHUNK * 2);
        let first = true;
        r.node.failures.push((index) => {
            if (index === 0 && first) {
                first = false;
                return nodeError(422, 'E_CHECKSUM');
            }
            return undefined;
        });

        await uploadChunked(r.job(), grant(), r.deps);

        expect(r.node.putCalls.filter((i) => i === 0)).toHaveLength(2);
        expect(lastStatus(r.patches)).toBe('done');
    });

    it('stops with a specific message on errors that retrying cannot fix', async () => {
        const r = rig(CHUNK * 4);
        r.node.failures.push(() => nodeError(507, 'E_NODISK'));

        await expect(uploadChunked(r.job(), grant(), r.deps)).rejects.toMatchObject({
            info: { kind: 'insufficient_storage' },
        });

        expect(lastStatus(r.patches)).toBe('error');
        expect(r.patches[r.patches.length - 1].error).toMatch(/storage space/i);
        expect(r.pending.removed).toEqual([]); // kept: what was sent can be resumed later
        expect(r.node.aborted).toBe(false); // and the node keeps it
    });

    it('gives up after the allowed attempts instead of looping forever', async () => {
        const r = rig(CHUNK * 2);
        r.node.failures.push((index) => (index === 0 ? { code: 'ERR_NETWORK' } : undefined));

        await expect(uploadChunked(r.job(), grant(), r.deps, { chunkAttempts: 3 })).rejects.toBeInstanceOf(
            UploadFlowError
        );
        expect(r.node.putCalls.filter((i) => i === 0)).toHaveLength(3);
    });

    it('resumes the session when the node lost it halfway', async () => {
        const r = rig(CHUNK * 4);
        let lost = false;
        r.node.failures.push((index) => {
            if (index === 3 && !lost) {
                lost = true;
                return nodeError(404, 'E_NOT_FOUND');
            }
            return undefined;
        });

        await uploadChunked(r.job(), grant(), r.deps);

        expect(r.node.created).toBe(2); // created again, then resumed with what the node kept
        expect(lastStatus(r.patches)).toBe('done');
        expect(r.node.chunks.size).toBe(4);
    });

    it('requeues what the node says is still missing when completing', async () => {
        const r = rig(CHUNK * 3);
        let dropped = false;
        const originalComplete = r.node.complete.bind(r.node);
        r.node.complete = async () => {
            if (!dropped) {
                dropped = true;
                r.node.chunks.delete(1); // e.g. the part file was damaged behind our back
                throw nodeError(409, 'E_INCOMPLETE');
            }

            return originalComplete();
        };

        await uploadChunked(r.job(), grant(), r.deps);

        expect(r.node.putCalls.filter((i) => i === 1)).toHaveLength(2);
        expect(lastStatus(r.patches)).toBe('done');
    });

    it('refuses before sending a byte when the file exists and cannot be replaced', async () => {
        const r = rig(CHUNK * 3);
        r.fs = [{ name: 'f.bin', size: 5, isFile: true }];

        await expect(uploadChunked(r.job(), grant({ replace: false }), r.deps)).rejects.toMatchObject({
            info: { kind: 'exists' },
        });

        expect(r.node.created).toBe(0);
        expect(r.node.putCalls).toEqual([]);
    });

    it('keeps the data and says what to do when the node refuses the replacement at the end', async () => {
        const r = rig(CHUNK * 2);
        r.node.completeError = nodeError(409, 'E_EXISTS');

        await expect(uploadChunked(r.job(), grant(), r.deps)).rejects.toMatchObject({ info: { kind: 'exists' } });

        expect(r.node.chunks.size).toBe(2);
        expect(r.node.aborted).toBe(false);
        expect(lastStatus(r.patches)).toBe('error');
        expect(r.patches[r.patches.length - 1].error).toMatch(/kept/i);
    });

    it('frees the space on the node only when the USER cancels', async () => {
        const r = rig(CHUNK * 6);
        const controller = new AbortController();
        r.node.failures.push((index) => {
            if (index === 2) controller.abort();
        });

        await expect(uploadChunked(r.job({ signal: controller.signal }), grant(), r.deps)).rejects.toMatchObject({
            info: { kind: 'canceled' },
        });

        expect(r.node.aborted).toBe(true);
        expect(r.pending.removed).toEqual([grant().sessionId]);
    });

    it('does not report success when the node returns a different size', async () => {
        const r = rig(CHUNK * 2);
        r.node.complete = async () => ({ name: 'f.bin', size: CHUNK * 2 - 1, sha256: 'a'.repeat(64) });

        await expect(uploadChunked(r.job(), grant(), r.deps)).rejects.toMatchObject({ info: { kind: 'integrity' } });
        expect(r.patches.some((p) => p.status === 'done')).toBe(false);
    });

    it('handles an empty file', async () => {
        const r = rig(0);
        await uploadChunked(r.job(), grant(), r.deps);

        expect(r.node.putCalls).toEqual([]);
        expect(r.node.completeCalls).toBe(1);
        expect(lastStatus(r.patches)).toBe('done');
    });
});

/* ---------------------------- choosing legacy vs chunked ---------------------------- */

describe('uploadAuto', () => {
    const big = CHUNKED_MIN_BYTES + 1;

    const strategy = (over: Partial<StrategyDeps> = {}) => {
        const calls = { legacy: 0, chunked: 0 };
        const deps: StrategyDeps = {
            getGrant: async () => grant(),
            legacy: async () => void calls.legacy++,
            chunked: async () => void calls.chunked++,
            ...over,
        };

        return { deps, calls };
    };
    const job = (size: number): UploadJob => ({
        uuid: 'u',
        directory: '/',
        blob: makeBlob(size),
        signal: new AbortController().signal,
        staged: true,
        canReplace: true,
        onUpdate: () => undefined,
    });

    it('uses the regular upload for small files without even asking the panel', async () => {
        const getGrant = jest.fn();
        const { deps, calls } = strategy({ getGrant });

        await uploadAuto(job(1000), deps);

        expect(calls).toEqual({ legacy: 1, chunked: 0 });
        expect(getGrant).not.toHaveBeenCalled();
    });

    it('uses chunks for big files on nodes that support them', async () => {
        const { deps, calls } = strategy();
        await uploadAuto(job(big), deps);

        expect(calls).toEqual({ legacy: 0, chunked: 1 });
    });

    it('falls back to the regular upload on nodes running the original Wings', async () => {
        const { deps, calls } = strategy({ getGrant: async () => ({ supported: false }) });
        await uploadAuto(job(big), deps);

        expect(calls).toEqual({ legacy: 1, chunked: 0 });
    });

    it('falls back when the panel cannot be reached, but reports a definite refusal', async () => {
        let { deps, calls } = strategy({ getGrant: async () => Promise.reject({ code: 'ERR_NETWORK' }) });
        await uploadAuto(job(big), deps);
        expect(calls).toEqual({ legacy: 1, chunked: 0 });

        const patches: UploadPatch[] = [];
        ({ deps, calls } = strategy({
            getGrant: async () =>
                Promise.reject({
                    response: {
                        status: 422,
                        data: { errors: [{ code: 'FileTooLargeException', meta: { max_size: 1048576 * 100 } }] },
                    },
                }),
        }));
        await expect(uploadAuto({ ...job(big), onUpdate: (p) => patches.push(p) }, deps)).rejects.toMatchObject({
            info: { kind: 'too_large' },
        });
        expect(calls).toEqual({ legacy: 0, chunked: 0 });
        expect(patches[0].error).toContain('100 MB');
    });

    it('falls back if the node turned the feature off in the meantime', async () => {
        const { deps, calls } = strategy({
            chunked: async () => {
                throw new UploadFlowError(classifyUploadError(nodeError(404, 'E_DISABLED')));
            },
        });
        await uploadAuto(job(big), deps);

        expect(calls.legacy).toBe(1);
    });
});

describe('error codes', () => {
    it.each([
        ['E_BUSY', 429, 'busy', true],
        ['E_CHECKSUM', 422, 'checksum', true],
        ['E_EXISTS', 409, 'exists', false],
        ['E_NOT_FOUND', 404, 'session_lost', true],
        ['E_INCOMPLETE', 409, 'session_lost', true],
        ['E_DISABLED', 404, 'unsupported', false],
        ['E_TOKEN', 401, 'token_rejected', true],
        ['E_REVOKED', 403, 'forbidden', false],
        ['E_NODISK', 507, 'insufficient_storage', false],
    ])('%s is explained specifically', (code, status, kind, retryable) => {
        const info = classifyUploadError(
            nodeError(status as number, code as string, 'There is not enough disk space.')
        );

        expect(info.kind).toBe(kind);
        expect(info.retryable).toBe(retryable);
    });
});
