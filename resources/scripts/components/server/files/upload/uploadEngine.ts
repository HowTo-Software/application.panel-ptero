import axios from 'axios';
import { translateUiText } from '@/i18n/uiTranslations';
import getFileUploadUrl from '@/api/server/files/getFileUploadUrl';
import loadDirectory from '@/api/server/files/loadDirectory';
import renameFiles from '@/api/server/files/renameFiles';
import deleteFiles from '@/api/server/files/deleteFiles';
import {
    ClassifiedUploadError,
    classifyUploadError,
    UploadFlowError,
    UploadPhase,
    UploadStalledError,
} from '@/components/server/files/upload/errors';
import { formatBytes, utf8Length } from '@/components/server/files/upload/format';
import {
    abortableSleep,
    MAX_ATTEMPTS,
    retryDelay,
    StallWatchdog,
    STALL_TIMEOUT_MS,
} from '@/components/server/files/upload/queue';
import SpeedTracker from '@/components/server/files/upload/speedTracker';

export type UploadStatus = 'queued' | 'uploading' | 'retrying' | 'verifying' | 'finalizing' | 'done' | 'error';

export interface UploadPatch {
    status?: UploadStatus;
    loaded?: number;
    speed?: number;
    eta?: number | null;
    attempt?: number;
    maxAttempts?: number;
    retryInMs?: number | null;
    error?: string | null;
    errorKind?: string | null;
}

export interface RemoteEntry {
    name: string;
    size: number;
    isFile: boolean;
}

export interface UploadDeps {
    getUploadUrl(uuid: string): Promise<string>;
    send(args: {
        url: string;
        blob: Blob;
        remoteName: string;
        directory: string;
        signal: AbortSignal;
        onProgress: (loaded: number) => void;
    }): Promise<void>;
    list(uuid: string, directory: string): Promise<RemoteEntry[]>;
    rename(uuid: string, directory: string, from: string, to: string): Promise<void>;
    remove(uuid: string, directory: string, name: string): Promise<void>;
    sleep(ms: number, signal?: AbortSignal): Promise<void>;
    randomId(): string;
    now(): number;
}

export const defaultDeps: UploadDeps = {
    getUploadUrl: (uuid) => getFileUploadUrl(uuid),
    send: async ({ url, blob, remoteName, directory, signal, onProgress }) => {
        const form = new FormData();
        // The third argument sends the bytes under a different name without copying the file in memory.
        form.append('files', blob, remoteName);

        await axios.post(url, form, {
            signal,
            params: { directory },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            onUploadProgress: (event) => onProgress(event.loaded),
        });
    },
    list: async (uuid, directory) =>
        (await loadDirectory(uuid, directory)).map((f) => ({ name: f.name, size: f.size, isFile: f.isFile })),
    rename: (uuid, directory, from, to) => renameFiles(uuid, directory, [{ from, to }]),
    remove: (uuid, directory, name) => deleteFiles(uuid, directory, [name]),
    sleep: abortableSleep,
    randomId: () => Math.random().toString(36).slice(2, 10),
    now: () => Date.now(),
};

export interface UploadJob {
    uuid: string;
    directory: string;
    /** The file the user picked. Only `name` and `size` are read from it besides being streamed. */
    blob: Blob & { name: string };
    signal: AbortSignal;
    /**
     * Upload under a temporary name and rename on success (needs `file.update`). The final name only ever
     * points at a complete file, and a failed or duplicated request can never delete or truncate an
     * existing file with that name.
     */
    staged: boolean;
    /** Allowed to delete an existing file with the same name when finishing (needs `file.delete`). */
    canReplace: boolean;
    onUpdate: (patch: UploadPatch) => void;
}

export interface UploadOptions {
    maxAttempts?: number;
    stallTimeoutMs?: number;
    /** After every byte has been sent, how long to wait for Wings to answer before giving up. */
    responseTimeoutMs?: number;
}

const MAX_FILE_NAME_BYTES = 255;

export const temporaryName = (name: string, id: string): string => `${name}.${id}.part`;

export const backupFileName = (name: string, id: string): string => `${name}.${id}.bak`;

const errorDetail = (error: unknown): string => (error as Error)?.message || 'unknown error';

const existsError = (name: string, what: 'folder' | 'file'): UploadFlowError =>
    new UploadFlowError({
        kind: 'exists',
        retryable: false,
        message:
            what === 'folder'
                ? translateUiText('A folder named "{{name}}" already exists in this directory.', { name })
                : translateUiText(
                      'A file named "{{name}}" already exists. To avoid overwriting it destructively, delete or rename it first (replacing needs both update and delete permissions).',
                      { name }
                  ),
    });

const canceled = (): UploadFlowError =>
    new UploadFlowError({ kind: 'canceled', retryable: false, message: translateUiText('Upload canceled.') });

/** Runs a small idempotent panel call a few times so a blip while verifying never forces a re-upload. */
const withRetries = async <T>(fn: () => Promise<T>, deps: UploadDeps, signal: AbortSignal, tries = 3): Promise<T> => {
    let lastError: unknown;

    for (let i = 0; i < tries; i++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (signal.aborted) {
                throw canceled();
            }
            if (i < tries - 1) {
                await deps.sleep(1000 * (i + 1), signal);
            }
        }
    }

    throw lastError;
};

const verifyAndFinalize = async (
    job: UploadJob,
    deps: UploadDeps,
    remoteName: string,
    staged: boolean,
    setPhase: (phase: UploadPhase) => void
): Promise<void> => {
    const { uuid, directory, blob, signal } = job;
    const total = blob.size;
    const finalName = blob.name;

    const unconfirmed = (detail?: string, backup?: string | null) =>
        new UploadFlowError({
            kind: 'finalize',
            retryable: false,
            message:
                translateUiText(
                    'The file was sent, but the panel could not confirm it on the server{{detail}}. Refresh the file list to check it.',
                    { detail: detail ? ` (${detail})` : '' }
                ) + (backup ? ' ' + translateUiText('The previous version was kept as "{{backup}}".', { backup }) : ''),
        });

    let entries: RemoteEntry[];
    try {
        entries = await withRetries(() => deps.list(uuid, directory), deps, signal);
    } catch (error) {
        if (error instanceof UploadFlowError) throw error;
        throw unconfirmed((error as Error)?.message);
    }

    const uploaded = entries.find((e) => e.name === remoteName);
    if (!uploaded) {
        throw new UploadFlowError({
            kind: 'integrity',
            retryable: true,
            message: translateUiText('The file was not found on the server after the upload finished.'),
        });
    }
    if (uploaded.size !== total) {
        throw new UploadFlowError({
            kind: 'integrity',
            retryable: true,
            message: translateUiText(
                'The file on the server is {{remote}} but the original is {{local}}. The upload was not marked as complete.',
                { remote: formatBytes(uploaded.size), local: formatBytes(total) }
            ),
        });
    }

    if (!staged) {
        return;
    }

    setPhase('finalize');
    job.onUpdate({ status: 'finalizing' });

    // From here on the original file may be moved, so these steps ignore the user's cancel: stopping in the
    // middle could leave the original under its backup name. They are short panel calls, not data transfer.
    const uninterruptible = new AbortController().signal;

    const existing = entries.find((e) => e.name === finalName);
    let backupName: string | null = null;

    if (existing) {
        if (!existing.isFile) {
            throw existsError(finalName, 'folder');
        }
        if (!job.canReplace) {
            throw new UploadFlowError({
                kind: 'finalize',
                retryable: false,
                message: translateUiText(
                    'A file named "{{name}}" already exists and you do not have permission to replace it. The new file was kept as "{{temp}}".',
                    { name: finalName, temp: remoteName }
                ),
            });
        }

        // Never delete the original up front. Wings refuses to rename onto an existing name, so the original
        // is first moved aside, the new file moved in, and only then is the old copy removed.
        const backup = backupFileName(finalName, deps.randomId());
        backupName = backup;
        try {
            await withRetries(() => deps.rename(uuid, directory, finalName, backup), deps, uninterruptible);
        } catch (error) {
            throw new UploadFlowError({
                kind: 'finalize',
                retryable: false,
                message: translateUiText(
                    'The existing file "{{name}}" could not be set aside, so it was left untouched. The new file was kept as "{{temp}}": {{detail}}',
                    { name: finalName, temp: remoteName, detail: errorDetail(error) }
                ),
            });
        }
    }

    /** Puts the original back after a failed replacement. Returns false when even that could not be done. */
    const restoreOriginal = async (): Promise<boolean> => {
        if (!backupName) {
            return true;
        }
        const backup = backupName;

        try {
            const now = await withRetries(() => deps.list(uuid, directory), deps, uninterruptible);
            // Something already sits at the final name: do not touch it.
            if (now.some((e) => e.name === finalName)) {
                return false;
            }
            await withRetries(() => deps.rename(uuid, directory, backup, finalName), deps, uninterruptible);

            return true;
        } catch {
            return false;
        }
    };

    const replacementFailed = async (detail: string): Promise<UploadFlowError> => {
        const restored = await restoreOriginal();

        if (restored) {
            return new UploadFlowError({
                kind: 'finalize',
                retryable: false,
                message: backupName
                    ? translateUiText(
                          'The new file could not replace "{{name}}" and the original was restored. The new file was kept as "{{temp}}": {{detail}}',
                          { name: finalName, temp: remoteName, detail }
                      )
                    : translateUiText(
                          'The file was uploaded as "{{temp}}" but could not be renamed to "{{name}}": {{detail}}',
                          { name: finalName, temp: remoteName, detail }
                      ),
            });
        }

        return new UploadFlowError({
            kind: 'finalize',
            retryable: false,
            message: translateUiText(
                'The new file could not replace "{{name}}" and the original could not be restored automatically. Original: "{{backup}}". New file: "{{temp}}". Nothing was deleted: {{detail}}',
                { name: finalName, backup: backupName ?? '', temp: remoteName, detail }
            ),
        });
    };

    try {
        await withRetries(() => deps.rename(uuid, directory, remoteName, finalName), deps, uninterruptible);
    } catch (error) {
        throw await replacementFailed(errorDetail(error));
    }

    // Wings answers a rename of a missing source with success, so confirm the end result explicitly.
    let after: RemoteEntry[];
    try {
        after = await withRetries(() => deps.list(uuid, directory), deps, uninterruptible);
    } catch (error) {
        // Cannot tell what happened; leave everything exactly as it is rather than guess.
        throw unconfirmed(errorDetail(error), backupName);
    }

    const final = after.find((e) => e.name === finalName);
    if (!final) {
        throw await replacementFailed(translateUiText('the new file was not found after the rename'));
    }
    if (final.size !== total) {
        throw unconfirmed(undefined, backupName);
    }

    // The new file is confirmed in place; only now is the previous version removed. A failure here is
    // harmless (a stray backup), so it never turns a successful upload into an error.
    if (backupName) {
        await deps.remove(uuid, directory, backupName).catch(() => undefined);
    }
};

/**
 * Uploads one file reliably:
 *  1. asks the panel for a NEW one-time upload token for every attempt (Wings rejects a reused token
 *     with a misleading 404 "requested resource was not found");
 *  2. sends to a unique temporary name so concurrent/duplicated attempts cannot delete each other's data;
 *  3. aborts and retries an attempt that stops receiving data instead of hanging forever;
 *  4. checks the size that actually landed on the server and only then renames to the final name.
 *
 * A file is reported `done` only after step 4. Anything else ends in `error` with a specific message.
 *
 * Note: retries restart from byte 0. Resuming needs server-side support that Wings does not have yet
 * (see docs/uploads/WINGS-RESUMABLE-UPLOADS.md).
 */
export const uploadFile = async (
    job: UploadJob,
    deps: UploadDeps = defaultDeps,
    options: UploadOptions = {}
): Promise<void> => {
    const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
    const stallTimeoutMs = options.stallTimeoutMs ?? STALL_TIMEOUT_MS;
    const responseTimeoutMs = options.responseTimeoutMs ?? 120_000;
    const { blob, uuid, directory } = job;
    const total = blob.size;
    const finalName = blob.name;
    const staged = job.staged && utf8Length(temporaryName(finalName, 'xxxxxxxx')) <= MAX_FILE_NAME_BYTES;

    // Refuse BEFORE sending a single byte whenever the upload could destroy an existing file: Wings truncates
    // the target as soon as it receives the first byte of a direct upload. A staged upload may replace an
    // existing file only when the user can also delete (replacement moves the original aside, see above).
    try {
        const entries = await deps.list(uuid, directory);
        const existing = entries.find((e) => e.name === finalName);
        if (existing) {
            const blocked = !existing.isFile
                ? existsError(finalName, 'folder')
                : !staged || !job.canReplace
                ? existsError(finalName, 'file')
                : null;

            if (blocked) {
                job.onUpdate({ status: 'error', error: blocked.info.message, errorKind: blocked.info.kind });
                throw blocked;
            }
        }
    } catch (error) {
        if (error instanceof UploadFlowError) {
            throw error;
        }
        // The listing failed (network blip): do not block the upload; the checks after sending still apply.
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (job.signal.aborted) {
            job.onUpdate({ status: 'error', error: canceled().info.message, errorKind: 'canceled' });
            throw canceled();
        }

        const remoteName = staged ? temporaryName(finalName, deps.randomId()) : finalName;
        const tracker = new SpeedTracker();
        // Mutated from a callback, so TypeScript cannot narrow it; the cast keeps the full union.
        let phase = 'sign' as UploadPhase;
        let stalled = false;

        job.onUpdate({
            status: 'uploading',
            attempt,
            maxAttempts,
            loaded: 0,
            speed: 0,
            eta: null,
            retryInMs: null,
        });

        const attemptController = new AbortController();
        const forwardAbort = () => attemptController.abort();
        job.signal.addEventListener('abort', forwardAbort, { once: true });

        const watchdog = new StallWatchdog(
            stallTimeoutMs,
            () => {
                stalled = true;
                attemptController.abort();
            },
            deps.now
        );

        try {
            const url = await deps.getUploadUrl(uuid);

            phase = 'upload';
            watchdog.start();
            await deps.send({
                url,
                blob,
                remoteName,
                directory,
                signal: attemptController.signal,
                onProgress: (rawLoaded) => {
                    const loaded = Math.min(rawLoaded, total);
                    const now = deps.now();

                    watchdog.touch();
                    if (loaded >= total) {
                        // Everything was sent; now we are only waiting for Wings to confirm.
                        watchdog.timeoutMs = responseTimeoutMs;
                    }

                    tracker.record(loaded, now);
                    job.onUpdate({
                        loaded,
                        speed: tracker.bytesPerSecond,
                        eta: tracker.eta(total, loaded),
                    });
                },
            });
            watchdog.stop();

            phase = 'verify';
            job.onUpdate({ status: 'verifying', loaded: total, speed: 0, eta: 0 });
            await verifyAndFinalize(job, deps, remoteName, staged, (p) => (phase = p));

            job.onUpdate({ status: 'done', loaded: total, speed: 0, eta: 0, error: null, errorKind: null });
            return;
        } catch (rawError) {
            watchdog.stop();

            const error = stalled ? new UploadStalledError(Math.round(stallTimeoutMs / 1000)) : rawError;
            const info: ClassifiedUploadError = classifyUploadError(error, phase);

            // Remove our own leftover temporary file. Never after a failed rename: it may be the only copy.
            if (staged && phase !== 'finalize') {
                await deps.remove(uuid, directory, remoteName).catch(() => undefined);
            }

            if (!info.retryable || attempt >= maxAttempts) {
                job.onUpdate({
                    status: 'error',
                    error: info.message,
                    errorKind: info.kind,
                    speed: 0,
                    eta: null,
                    retryInMs: null,
                });
                throw new UploadFlowError(info);
            }

            const delay = retryDelay(attempt - 1);
            job.onUpdate({ status: 'retrying', error: info.message, errorKind: info.kind, retryInMs: delay, speed: 0 });

            try {
                await deps.sleep(delay, job.signal);
            } catch {
                job.onUpdate({ status: 'error', error: canceled().info.message, errorKind: 'canceled' });
                throw canceled();
            }
        } finally {
            job.signal.removeEventListener('abort', forwardAbort);
        }
    }
};
