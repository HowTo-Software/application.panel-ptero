import { translateUiText } from '@/i18n/uiTranslations';
import {
    ClassifiedUploadError,
    classifyUploadError,
    UploadFlowError,
    UploadStalledError,
} from '@/components/server/files/upload/errors';
import { formatBytes } from '@/components/server/files/upload/format';
import { StallWatchdog, STALL_TIMEOUT_MS } from '@/components/server/files/upload/queue';
import SpeedTracker from '@/components/server/files/upload/speedTracker';
import AdaptiveConcurrency from '@/components/server/files/upload/chunked/adaptive';
import {
    expandRanges,
    RemoteSession,
    UploadSessionGrant,
    UploadSessionGrantResult,
    WingsApi,
} from '@/components/server/files/upload/chunked/types';
import type { RemoteEntry, UploadJob } from '@/components/server/files/upload/uploadEngine';

export interface ChunkedDeps {
    /** Asks the panel for a (fresh) signed token for this very file. */
    getGrant(): Promise<UploadSessionGrantResult>;
    wings: WingsApi;
    list(uuid: string, directory: string): Promise<RemoteEntry[]>;
    /** SHA-256 of a chunk as lower-case hex, or null when the browser cannot compute it. */
    digest(blob: Blob): Promise<string | null>;
    sleep(ms: number, signal?: AbortSignal): Promise<void>;
    now(): number;
    pending: {
        save(entry: { sessionId: string; name: string; directory: string; size: number }): void;
        remove(sessionId: string): void;
    };
}

export interface ChunkedOptions {
    /** Upper bound on parallel connections (the node may lower it further). */
    maxConnections?: number;
    /** Attempts per chunk for recoverable errors. */
    chunkAttempts?: number;
    stallTimeoutMs?: number;
    /** How often the scheduler wakes up to take decisions and report progress. */
    tickMs?: number;
    progressThrottleMs?: number;
    /** Maximum times a whole session is restarted/resumed after the node lost or rejected it. */
    maxSessionRestarts?: number;
}

const canceled = (): UploadFlowError =>
    new UploadFlowError({ kind: 'canceled', retryable: false, message: translateUiText('Upload canceled.') });

const backoff = (attempt: number): number => Math.min(30_000, 1000 * 2 ** (attempt - 1));

/**
 * Uploads one file in fixed-size chunks to a Wings node that supports upload sessions.
 *
 *  - chunks are sent in parallel; how many is decided by measuring throughput (see AdaptiveConcurrency);
 *  - the node keeps what it received, so a dropped connection, a node restart, or closing the browser costs at
 *    most the chunks that were in flight: selecting the same file again resumes from where it stopped;
 *  - every chunk carries its SHA-256, which the node verifies; the node also hashes the whole file and returns
 *    that hash when the upload is completed;
 *  - the file only appears under its final name when the node has verified it and swapped it in atomically, so an
 *    existing file is never left half overwritten;
 *  - a chunk that fails is retried with backoff; an expired token is renewed transparently.
 */
export const uploadChunked = async (
    job: UploadJob,
    firstGrant: UploadSessionGrant,
    deps: ChunkedDeps,
    options: ChunkedOptions = {}
): Promise<void> => {
    const total = job.blob.size;
    const name = job.blob.name;
    const chunkAttempts = options.chunkAttempts ?? 5;
    const stallTimeoutMs = options.stallTimeoutMs ?? STALL_TIMEOUT_MS;
    const tickMs = options.tickMs ?? 500;
    const throttleMs = options.progressThrottleMs ?? 250;
    const maxRestarts = options.maxSessionRestarts ?? 2;

    const grantRef = { current: firstGrant };
    const chunkSize = firstGrant.chunkSize;
    const chunkCount = total === 0 ? 0 : Math.ceil(total / chunkSize);
    const chunkLength = (i: number) => Math.min(chunkSize, total - i * chunkSize);

    let refreshing: Promise<void> | null = null;
    const refreshGrant = (): Promise<void> => {
        if (!refreshing) {
            refreshing = (async () => {
                try {
                    const next = await deps.getGrant();
                    if (!next.supported) {
                        throw new UploadFlowError(
                            classifyUploadError({ response: { status: 404, data: { code: 'E_DISABLED' } } })
                        );
                    }
                    grantRef.current = next;
                } finally {
                    refreshing = null;
                }
            })();
        }

        return refreshing;
    };

    const fail = (info: ClassifiedUploadError): never => {
        job.onUpdate({
            status: 'error',
            error: info.message,
            errorKind: info.kind,
            speed: 0,
            eta: null,
            retryInMs: null,
        });
        throw new UploadFlowError(info);
    };

    /** Runs a control call (create/get/complete/abort), renewing an expired token and retrying brief outages. */
    const control = async <T>(fn: () => Promise<T>): Promise<T> => {
        let refreshes = 0;
        let outages = 0;

        for (;;) {
            try {
                return await fn();
            } catch (error) {
                if (job.signal.aborted) {
                    throw canceled();
                }
                const info = classifyUploadError(error, 'upload');
                if (info.kind === 'token_rejected' && refreshes++ < 5) {
                    await refreshGrant();
                    continue;
                }
                if (info.retryable && info.kind !== 'session_lost' && outages++ < 3) {
                    await deps.sleep(backoff(outages), job.signal).catch(() => undefined);
                    continue;
                }
                throw error;
            }
        }
    };

    // Refuse before sending a byte if it could not end well.
    try {
        const entries = await deps.list(job.uuid, job.directory);
        const existing = entries.find((e) => e.name === name);
        if (existing && (!existing.isFile || !firstGrant.replace)) {
            const message = !existing.isFile
                ? translateUiText('A folder named "{{name}}" already exists in this directory.', { name })
                : translateUiText(
                      'A file named "{{name}}" already exists and you do not have permission to replace it. Delete or rename it first.',
                      { name }
                  );
            fail({ kind: 'exists', retryable: false, message });
        }
    } catch (error) {
        if (error instanceof UploadFlowError) {
            throw error;
        }
        // A failed listing must not block the upload; the node enforces the same rules when it finishes.
    }

    // Digests are computed one at a time so that memory stays at about one chunk, however many are in flight.
    let digestChain: Promise<unknown> = Promise.resolve();
    const digest = (blob: Blob): Promise<string | null> => {
        const next = digestChain.then(() => deps.digest(blob));
        digestChain = next.catch(() => undefined);

        return next.catch(() => null);
    };

    const tracker = new SpeedTracker();
    let sessionId = firstGrant.sessionId;

    const transfer = async (): Promise<{ sha256: string; size: number }> => {
        const { session } = await control(() => deps.wings.createSession(grantRef.current));
        sessionId = grantRef.current.sessionId;
        deps.pending.save({ sessionId, name, directory: job.directory, size: total });

        const received = expandRanges(session.received);
        let completedBytes = 0;
        received.forEach((i) => {
            if (i < chunkCount) completedBytes += chunkLength(i);
        });
        const resumedFrom = completedBytes;

        const maxParallel = Math.max(1, Math.min(options.maxConnections ?? 8, grantRef.current.maxParallelChunks));
        const adaptive = new AdaptiveConcurrency({ max: maxParallel, initial: Math.min(2, maxParallel) });
        const inflight = new Map<number, number>();
        const running = new Map<number, Promise<void>>();
        const queue: number[] = [];
        for (let i = 0; i < chunkCount; i++) {
            if (!received.has(i)) queue.push(i);
        }

        tracker.reset();
        let lastEmit = 0;
        const emit = (force = false) => {
            const now = deps.now();
            if (!force && now - lastEmit < throttleMs) return;
            lastEmit = now;

            let loaded = completedBytes;
            inflight.forEach((v) => (loaded += v));
            tracker.record(loaded, now);
            job.onUpdate({
                status: 'uploading',
                mode: 'chunked',
                loaded,
                speed: tracker.bytesPerSecond,
                eta: tracker.eta(total, loaded),
                connections: adaptive.target,
                resumedFrom: resumedFrom > 0 ? resumedFrom : undefined,
                retryInMs: null,
            });
        };
        job.onUpdate({ attempt: 1, maxAttempts: chunkAttempts, error: null, errorKind: null });
        emit(true);

        let fatal = null as unknown;

        const sendChunk = async (index: number): Promise<void> => {
            const start = index * chunkSize;
            const blob = job.blob.slice(start, start + chunkLength(index));
            const sha256 = await digest(blob);
            let attempts = 0;
            let refreshes = 0;
            let busy = 0;

            for (;;) {
                if (job.signal.aborted) {
                    throw canceled();
                }

                const attemptCtl = new AbortController();
                const forward = () => attemptCtl.abort();
                job.signal.addEventListener('abort', forward, { once: true });
                let stalled = false;
                const watchdog = new StallWatchdog(
                    stallTimeoutMs,
                    () => {
                        stalled = true;
                        attemptCtl.abort();
                    },
                    deps.now
                );
                inflight.set(index, 0);
                watchdog.start();

                try {
                    await deps.wings.putChunk({
                        grant: grantRef.current,
                        index,
                        blob,
                        sha256,
                        signal: attemptCtl.signal,
                        onProgress: (loaded) => {
                            watchdog.touch();
                            const previous = inflight.get(index) ?? 0;
                            inflight.set(index, Math.min(loaded, blob.size));
                            adaptive.record(Math.max(0, loaded - previous), deps.now());
                            emit();
                        },
                    });
                    inflight.delete(index);
                    completedBytes += blob.size;

                    return;
                } catch (error) {
                    inflight.delete(index);
                    const info = classifyUploadError(
                        stalled ? new UploadStalledError(Math.round(stallTimeoutMs / 1000)) : error,
                        'upload'
                    );

                    if (info.kind === 'canceled') {
                        throw canceled();
                    }
                    if (info.kind === 'token_rejected' && refreshes++ < 5) {
                        await refreshGrant();
                        continue;
                    }
                    if (info.kind === 'busy' && busy++ < 60) {
                        // The node, not the network, is the limit: ask for no more than it just accepted.
                        adaptive.onBusy(Math.max(1, running.size - 1));
                        await deps.sleep(1000, job.signal).catch(() => undefined);
                        continue;
                    }
                    if (info.retryable && info.kind !== 'session_lost' && ++attempts < chunkAttempts) {
                        adaptive.onError();
                        const delay = backoff(attempts);
                        job.onUpdate({
                            error: info.message,
                            errorKind: info.kind,
                            retryInMs: delay,
                            attempt: attempts + 1,
                        });
                        await deps.sleep(delay, job.signal).catch(() => undefined);
                        continue;
                    }

                    throw new UploadFlowError(info);
                } finally {
                    watchdog.stop();
                    job.signal.removeEventListener('abort', forward);
                }
            }
        };

        while (queue.length > 0 || running.size > 0) {
            if (fatal || job.signal.aborted) {
                break;
            }
            while (queue.length > 0 && running.size < adaptive.target) {
                const index = queue.shift() as number;
                running.set(
                    index,
                    sendChunk(index)
                        .catch((error) => {
                            fatal = fatal ?? error;
                        })
                        .finally(() => running.delete(index))
                );
            }
            if (running.size === 0) {
                break;
            }

            await Promise.race([...running.values(), deps.sleep(tickMs, job.signal).catch(() => undefined)]);
            adaptive.tick(deps.now());
            emit();
        }
        await Promise.allSettled([...running.values()]);

        if (job.signal.aborted) {
            throw canceled();
        }
        if (fatal) {
            throw fatal;
        }

        emit(true);
        job.onUpdate({ status: 'verifying', speed: 0, eta: 0 });

        return control(() => deps.wings.complete(grantRef.current));
    };

    let restarts = 0;
    let result = null as { sha256: string; size: number } | null;

    try {
        for (;;) {
            try {
                result = await transfer();
                break;
            } catch (error) {
                if (job.signal.aborted) {
                    throw canceled();
                }
                const info = classifyUploadError(error, 'upload');
                // The node lost, expired or rejected the session: resume (or start over) instead of failing.
                if (info.kind === 'session_lost' && restarts++ < maxRestarts) {
                    job.onUpdate({ status: 'retrying', error: info.message, errorKind: info.kind, speed: 0 });
                    await deps.sleep(backoff(restarts), job.signal).catch(() => undefined);
                    continue;
                }
                throw error;
            }
        }
    } catch (error) {
        if (job.signal.aborted) {
            // The user cancelled: free the space the node was holding. (Closing the tab does NOT land here.)
            await deps.wings.abort(grantRef.current).catch(() => undefined);
            deps.pending.remove(sessionId);
            job.onUpdate({ status: 'error', error: canceled().info.message, errorKind: 'canceled' });
            throw canceled();
        }

        // The session is deliberately left on the node (a refused replacement, a lost connection, an error): the data
        // already sent is safe and the next attempt with the same file resumes from it.
        return fail(classifyUploadError(error, 'upload'));
    }

    if (result.size !== total) {
        return fail({
            kind: 'integrity',
            retryable: false,
            message: translateUiText(
                'The file on the server is {{remote}} but the original is {{local}}. The upload was not marked as complete.',
                { remote: formatBytes(result.size), local: formatBytes(total) }
            ),
        });
    }

    // The node verified every chunk and the whole file; this extra look only catches the unexpected.
    try {
        const after = await deps.list(job.uuid, job.directory);
        const entry = after.find((e) => e.name === name);
        if (entry && entry.size !== total) {
            return fail({
                kind: 'integrity',
                retryable: false,
                message: translateUiText(
                    'The file on the server is {{remote}} but the original is {{local}}. The upload was not marked as complete.',
                    { remote: formatBytes(entry.size), local: formatBytes(total) }
                ),
            });
        }
    } catch (error) {
        if (error instanceof UploadFlowError) {
            throw error;
        }
    }

    deps.pending.remove(sessionId);
    job.onUpdate({
        status: 'done',
        loaded: total,
        speed: 0,
        eta: 0,
        error: null,
        errorKind: null,
        sha256: result.sha256,
    });
};

export type { RemoteSession };
