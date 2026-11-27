import { getBrowserLocale } from '@/i18n/locale';
import { translateUiText } from '@/i18n/uiTranslations';
import { formatBytes, formatEta, formatSpeed, utf8Length } from '@/components/server/files/upload/format';
import SpeedTracker from '@/components/server/files/upload/speedTracker';
import { classifyUploadError, UploadStalledError } from '@/components/server/files/upload/errors';
import { retryDelay, runPool, StallWatchdog } from '@/components/server/files/upload/queue';
import {
    RemoteEntry,
    temporaryName,
    UploadDeps,
    uploadFile,
    UploadJob,
    UploadPatch,
} from '@/components/server/files/upload/uploadEngine';

// Messages are localized from navigator.language; pin the locale so assertions do not depend on the machine.
jest.mock('@/i18n/locale', () => ({
    ...jest.requireActual('@/i18n/locale'),
    getBrowserLocale: jest.fn(() => 'en'),
}));

const wingsError = (status: number, error: string) => ({ response: { status, data: { error } } });

describe('format', () => {
    it('formats sizes in binary units like the file manager', () => {
        expect(formatBytes(0)).toBe('0 B');
        expect(formatBytes(512)).toBe('512 B');
        expect(formatBytes(1024 * 1024 * 152.78)).toBe('152.78 MiB');
        expect(formatBytes(10 * 1024 ** 3)).toBe('10.00 GiB');
    });

    it('formats speed in decimal MB/s', () => {
        expect(formatSpeed(0)).toBe('0.00 MB/s');
        expect(formatSpeed(2_500_000)).toBe('2.50 MB/s');
        expect(formatSpeed(NaN)).toBe('0.00 MB/s');
    });

    it('formats remaining time', () => {
        expect(formatEta(null)).toBe('—');
        expect(formatEta(45)).toBe('45s');
        expect(formatEta(192)).toBe('3m 12s');
        expect(formatEta(7500)).toBe('2h 05m');
    });

    it('counts UTF-8 bytes, not characters', () => {
        expect(utf8Length('abc')).toBe(3);
        expect(utf8Length('ação')).toBe(6);
        expect(utf8Length('😀')).toBe(4);
    });
});

describe('SpeedTracker', () => {
    it('reports the current rate and an ETA', () => {
        const t = new SpeedTracker();
        t.record(0, 0);
        t.record(1_000_000, 1000);

        expect(t.bytesPerSecond).toBe(1_000_000);
        expect(t.eta(5_000_000, 1_000_000)).toBe(4);
    });

    it('follows the recent window instead of the lifetime average', () => {
        const t = new SpeedTracker(2000);
        t.record(0, 0);
        t.record(10_000_000, 1000); // fast start
        t.record(10_000_000, 4000); // stalled
        t.record(10_100_000, 5000);

        // Only the last ~2s count: 100 kB in 1s... not the 2 MB/s lifetime average.
        expect(t.bytesPerSecond).toBeLessThan(200_000);
    });

    it('returns no estimate without data and ignores backwards progress', () => {
        const t = new SpeedTracker();
        expect(t.bytesPerSecond).toBe(0);
        expect(t.eta(100, 0)).toBeNull();

        t.record(500, 0);
        t.record(100, 1000);
        expect(t.bytesPerSecond).toBe(0);
    });
});

describe('classifyUploadError', () => {
    it('explains the Wings 404 as a rejected one-time token, not a missing file', () => {
        const info = classifyUploadError(wingsError(404, 'The requested resource was not found on this server.'));

        expect(info.kind).toBe('token_rejected');
        expect(info.retryable).toBe(true);
        expect(info.message).toMatch(/authorization/i);
    });

    it('treats a 404 from the panel (signing step) as a permission problem, without retrying', () => {
        const info = classifyUploadError(wingsError(404, 'Not found'), 'sign');

        expect(info.kind).toBe('forbidden');
        expect(info.retryable).toBe(false);
    });

    it('reports the node upload limit from Wings', () => {
        const info = classifyUploadError(
            wingsError(400, 'File big.rar is larger than the maximum file upload size of 10240 MB.')
        );

        expect(info.kind).toBe('too_large');
        expect(info.retryable).toBe(false);
        expect(info.message).toContain('10240 MB');
    });

    it('flags proxy limits, full disks and server errors distinctly', () => {
        expect(classifyUploadError(wingsError(413, 'Payload Too Large')).kind).toBe('proxy_limit');
        expect(
            classifyUploadError(wingsError(500, 'Cannot perform that action: server is at its disk limit.')).kind
        ).toBe('insufficient_storage');

        const server = classifyUploadError(wingsError(502, 'Bad gateway'));
        expect(server.kind).toBe('server');
        expect(server.retryable).toBe(true);
        expect(server.message).toContain('502');
    });

    it('treats connection loss as retryable and cancellation as final', () => {
        expect(classifyUploadError({ code: 'ERR_NETWORK', message: 'Network Error' })).toMatchObject({
            kind: 'network',
            retryable: true,
        });
        expect(classifyUploadError({ code: 'ERR_CANCELED' })).toMatchObject({ kind: 'canceled', retryable: false });
        expect(classifyUploadError(new UploadStalledError(60))).toMatchObject({ kind: 'stalled', retryable: true });
    });
});

describe('pt-BR translations', () => {
    afterEach(() => (getBrowserLocale as jest.Mock).mockReturnValue('en'));

    it('translates every upload message and keeps the placeholders', () => {
        (getBrowserLocale as jest.Mock).mockReturnValue('pt');

        const samples: Array<[string, Record<string, string | number> | undefined]> = [
            ['Upload canceled.', undefined],
            [
                'The upload stopped receiving data for {{seconds}} seconds, so it was restarted automatically.',
                { seconds: 60 },
            ],
            [
                'The node rejected the upload authorization (expired, already used or revoked). A new authorization is requested automatically.',
                undefined,
            ],
            ['The file is larger than the maximum upload size allowed by this node ({{limit}} MB).', { limit: 10240 }],
            [
                'The file on the server is {{remote}} but the original is {{local}}. The upload was not marked as complete.',
                { remote: '1 B', local: '2 B' },
            ],
            ['Retrying in {{seconds}}s (attempt {{attempt}} of {{max}})', { seconds: 2, attempt: 2, max: 3 }],
            ['{{time}} remaining', { time: '3m 12s' }],
        ];

        samples.forEach(([source, vars]) => {
            const out = translateUiText(source, vars);
            expect(out).not.toBe(source);
            expect(out).not.toContain('{{');
        });
        expect(
            translateUiText('The file is larger than the maximum upload size allowed by this node ({{limit}} MB).', {
                limit: 10240,
            })
        ).toContain('10240');
    });
});

describe('queue helpers', () => {
    it('never runs more than `limit` workers and survives a failing worker', async () => {
        let running = 0;
        let peak = 0;
        const done: number[] = [];

        await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
            running++;
            peak = Math.max(peak, running);
            await new Promise((r) => setTimeout(r, 5));
            running--;
            if (n === 2) throw new Error('boom');
            done.push(n);
        });

        expect(peak).toBe(3);
        expect(done.sort()).toEqual([1, 3, 4, 5, 6, 7]);
    });

    it('applies bounded jitter to the retry delay', () => {
        expect(retryDelay(0, () => 0)).toBe(1600);
        expect(retryDelay(0, () => 1)).toBe(2400);
        expect(retryDelay(9, () => 0.5)).toBe(6000);
    });

    describe('StallWatchdog', () => {
        beforeEach(() => jest.useFakeTimers({ doNotFake: ['performance'] }));
        afterEach(() => jest.useRealTimers());

        it('fires only after the timeout without progress', () => {
            const onStall = jest.fn();
            const w = new StallWatchdog(10_000, onStall);
            w.start();

            jest.advanceTimersByTime(8000);
            w.touch();
            jest.advanceTimersByTime(8000);
            expect(onStall).not.toHaveBeenCalled();

            jest.advanceTimersByTime(10_000);
            expect(onStall).toHaveBeenCalledTimes(1);
        });
    });
});

/* ------------------------------------------------------------------------------------------------ */

const makeFile = (name: string, size: number) => ({ name, size } as unknown as Blob & { name: string });

interface Harness {
    deps: UploadDeps;
    fs: Map<string, RemoteEntry>;
    calls: { send: string[]; remove: string[]; rename: Array<[string, string]>; urls: number };
    patches: UploadPatch[];
    job: (overrides?: Partial<UploadJob>) => UploadJob;
}

const harness = (size: number, finalName = 'CBRP.rar'): Harness => {
    const fs = new Map<string, RemoteEntry>();
    const calls = { send: [] as string[], remove: [] as string[], rename: [] as Array<[string, string]>, urls: 0 };
    const patches: UploadPatch[] = [];
    let id = 0;

    const deps: UploadDeps = {
        getUploadUrl: async () => `https://node/upload/file?token=t${++calls.urls}`,
        send: async ({ remoteName, onProgress }) => {
            calls.send.push(remoteName);
            onProgress(size / 2);
            onProgress(size);
            fs.set(remoteName, { name: remoteName, size, isFile: true });
        },
        list: async () => Array.from(fs.values()),
        rename: async (_u, _d, from, to) => {
            calls.rename.push([from, to]);
            const entry = fs.get(from);
            if (entry) {
                fs.delete(from);
                fs.set(to, { ...entry, name: to });
            }
        },
        remove: async (_u, _d, name) => {
            calls.remove.push(name);
            fs.delete(name);
        },
        sleep: async () => undefined,
        randomId: () => `id${++id}`,
        now: () => Date.now(),
    };

    return {
        deps,
        fs,
        calls,
        patches,
        job: (overrides = {}) => ({
            uuid: 'uuid',
            directory: '/mods/deathmatch/backups',
            blob: makeFile(finalName, size),
            signal: new AbortController().signal,
            staged: true,
            canReplace: true,
            onUpdate: (p) => patches.push(p),
            ...overrides,
        }),
    };
};

const lastStatus = (patches: UploadPatch[]) => [...patches].reverse().find((p) => p.status)?.status;

describe('uploadFile', () => {
    const SIZE = 160_200_000;

    it('uploads to a temporary name, verifies the size and only then exposes the final name', async () => {
        const h = harness(SIZE);

        await uploadFile(h.job(), h.deps);

        expect(h.calls.send).toEqual([temporaryName('CBRP.rar', 'id1')]);
        expect(h.calls.rename).toEqual([[temporaryName('CBRP.rar', 'id1'), 'CBRP.rar']]);
        expect(h.fs.get('CBRP.rar')?.size).toBe(SIZE);
        expect(h.fs.has(temporaryName('CBRP.rar', 'id1'))).toBe(false);
        expect(lastStatus(h.patches)).toBe('done');
        expect(h.patches.some((p) => p.status === 'verifying')).toBe(true);
    });

    it('requests a NEW token for every attempt and retries a rejected (already used) token', async () => {
        const h = harness(SIZE);
        const realSend = h.deps.send;
        let first = true;
        h.deps.send = async (args) => {
            if (first) {
                first = false;
                h.calls.send.push(args.remoteName);
                throw wingsError(404, 'The requested resource was not found on this server.');
            }
            return realSend(args);
        };

        await uploadFile(h.job(), h.deps);

        expect(h.calls.urls).toBe(2);
        expect(h.calls.send).toHaveLength(2);
        expect(h.calls.send[0]).not.toBe(h.calls.send[1]); // distinct temp names: attempts cannot collide
        expect(h.calls.remove).toContain(h.calls.send[0]); // leftover of the failed attempt is cleaned up
        expect(h.fs.get('CBRP.rar')?.size).toBe(SIZE);
        expect(lastStatus(h.patches)).toBe('done');
        expect(h.patches.some((p) => p.status === 'retrying' && /authorization/i.test(p.error ?? ''))).toBe(true);
    });

    it('does not retry errors that retrying cannot fix', async () => {
        const h = harness(SIZE);
        h.deps.send = async () => {
            throw wingsError(400, 'File CBRP.rar is larger than the maximum file upload size of 100 MB.');
        };

        await expect(uploadFile(h.job(), h.deps)).rejects.toMatchObject({ info: { kind: 'too_large' } });

        expect(h.calls.urls).toBe(1);
        expect(lastStatus(h.patches)).toBe('error');
        expect(h.patches[h.patches.length - 1].error).toContain('100 MB');
        expect(h.fs.has('CBRP.rar')).toBe(false);
    });

    it('never reports an incomplete file as done (size mismatch)', async () => {
        const h = harness(SIZE);
        h.deps.send = async ({ remoteName, onProgress }) => {
            h.calls.send.push(remoteName);
            onProgress(SIZE);
            h.fs.set(remoteName, { name: remoteName, size: SIZE - 1, isFile: true }); // truncated on disk
        };

        await expect(uploadFile(h.job(), h.deps, { maxAttempts: 2 })).rejects.toMatchObject({
            info: { kind: 'integrity' },
        });

        expect(h.calls.send).toHaveLength(2);
        expect(h.patches.some((p) => p.status === 'done')).toBe(false);
        expect(h.fs.has('CBRP.rar')).toBe(false);
        expect(h.calls.rename).toHaveLength(0);
    });

    it('replaces an existing file only after the new one is complete', async () => {
        const h = harness(SIZE);
        h.fs.set('CBRP.rar', { name: 'CBRP.rar', size: 5, isFile: true });

        await uploadFile(h.job(), h.deps);

        // The old copy was still there while the new one uploaded: remove happens after the send.
        expect(h.calls.send).toHaveLength(1);
        expect(h.calls.remove).toEqual(['CBRP.rar']);
        expect(h.fs.get('CBRP.rar')?.size).toBe(SIZE);
    });

    it('keeps the new file under its temporary name when it may not replace the old one', async () => {
        const h = harness(SIZE);
        h.fs.set('CBRP.rar', { name: 'CBRP.rar', size: 5, isFile: true });

        await expect(uploadFile(h.job({ canReplace: false }), h.deps)).rejects.toMatchObject({
            info: { kind: 'finalize' },
        });

        expect(h.fs.get('CBRP.rar')?.size).toBe(5); // untouched
        expect(h.fs.has(temporaryName('CBRP.rar', 'id1'))).toBe(true); // not lost
        expect(h.calls.remove).toEqual([]);
    });

    it('detects a rename that silently did nothing (Wings ignores a missing source)', async () => {
        const h = harness(SIZE);
        h.deps.rename = async () => undefined; // reports success, moves nothing

        await expect(uploadFile(h.job(), h.deps)).rejects.toMatchObject({ info: { kind: 'finalize' } });
        expect(h.patches.some((p) => p.status === 'done')).toBe(false);
    });

    it('falls back to a direct upload (same name) without update permission, still verifying the size', async () => {
        const h = harness(SIZE);

        await uploadFile(h.job({ staged: false }), h.deps);

        expect(h.calls.send).toEqual(['CBRP.rar']);
        expect(h.calls.rename).toEqual([]);
        expect(lastStatus(h.patches)).toBe('done');
    });

    it('does not use a temporary name that would exceed the 255 byte file name limit', async () => {
        const longName = 'a'.repeat(250) + '.rar';
        const h = harness(SIZE, longName);

        await uploadFile(h.job(), h.deps);

        expect(h.calls.send).toEqual([longName]);
        expect(h.calls.rename).toEqual([]);
    });

    it('stops without retrying when the user cancels', async () => {
        const h = harness(SIZE);
        const controller = new AbortController();
        h.deps.send = async ({ signal }) =>
            new Promise((_resolve, reject) => {
                controller.abort();
                signal.addEventListener('abort', () => reject({ code: 'ERR_CANCELED' }));
                if (signal.aborted) reject({ code: 'ERR_CANCELED' });
            });

        await expect(uploadFile(h.job({ signal: controller.signal }), h.deps)).rejects.toMatchObject({
            info: { kind: 'canceled' },
        });
        expect(h.calls.urls).toBe(1);
    });

    describe('stalled connections', () => {
        beforeEach(() => jest.useFakeTimers({ doNotFake: ['performance'] }));
        afterEach(() => jest.useRealTimers());

        it('aborts an attempt that stops receiving data and retries with a fresh token', async () => {
            const h = harness(SIZE);
            const realSend = h.deps.send;
            let first = true;
            h.deps.send = ({ signal, onProgress, remoteName, ...rest }) => {
                if (!first) {
                    return realSend({ signal, onProgress, remoteName, ...rest });
                }
                first = false;
                h.calls.send.push(remoteName);
                onProgress(1000);

                // Alive at the TCP level but moving no data: only the abort ends it.
                return new Promise((_resolve, reject) => {
                    signal.addEventListener('abort', () => reject({ code: 'ERR_CANCELED' }));
                });
            };

            const promise = uploadFile(h.job(), h.deps, { stallTimeoutMs: 10_000 });
            await Promise.resolve();
            jest.advanceTimersByTime(20_000);
            await promise;

            expect(h.calls.urls).toBe(2);
            expect(h.patches.some((p) => p.errorKind === 'stalled')).toBe(true);
            expect(lastStatus(h.patches)).toBe('done');
        });
    });
});
