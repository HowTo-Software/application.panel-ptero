/** Total attempts per file (the first try plus automatic retries). */
export const MAX_ATTEMPTS = 3;

/** Delay before retry N (index 0 = before the 2nd attempt). The last value repeats. */
export const RETRY_DELAYS_MS = [2000, 6000];

/** How many files are sent at the same time. */
export const MAX_PARALLEL_UPLOADS = 3;

/** An attempt that receives no progress for this long is considered dead and restarted. */
export const STALL_TIMEOUT_MS = 60_000;

export const retryDelay = (retryIndex: number, random: () => number = Math.random): number => {
    const base = RETRY_DELAYS_MS[Math.min(retryIndex, RETRY_DELAYS_MS.length - 1)];

    // +-20% jitter so several files that failed together do not all retry at the same instant.
    return Math.round(base * (0.8 + random() * 0.4));
};

/**
 * Runs `worker` over `items` with at most `limit` running at once. The worker is expected to handle its own
 * errors; if it throws anyway the pool keeps going so one bad file never cancels the others.
 */
export const runPool = async <T>(
    items: T[],
    limit: number,
    worker: (item: T, index: number) => Promise<void>
): Promise<void> => {
    let next = 0;

    const lane = async (): Promise<void> => {
        while (next < items.length) {
            const index = next++;

            try {
                await worker(items[index], index);
            } catch {
                // Intentionally swallowed, see above.
            }
        }
    };

    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
};

/** Resolves after `ms`, or rejects early (with the abort reason) if the signal fires. */
export const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
        if (signal?.aborted) {
            return reject(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' }));
        }

        const pending: { timer?: ReturnType<typeof setTimeout> } = {};

        const onAbort = () => {
            clearTimeout(pending.timer);
            reject(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' }));
        };

        pending.timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);

        signal?.addEventListener('abort', onAbort, { once: true });
    });

/**
 * Calls `onStall` if `touch()` is not called for `timeoutMs`. Used to kill connections that are alive at
 * the TCP level but no longer move data (the "zombie" upload that never errors and never finishes).
 */
export class StallWatchdog {
    /** Mutable on purpose: the engine relaxes it once every byte was sent and only the reply is pending. */
    timeoutMs: number;
    private readonly onStall: () => void;
    private readonly now: () => number;
    private readonly checkEveryMs: number;
    private last: number;
    private timer: ReturnType<typeof setInterval> | null = null;

    constructor(timeoutMs: number, onStall: () => void, now: () => number = Date.now, checkEveryMs = 5000) {
        this.timeoutMs = timeoutMs;
        this.onStall = onStall;
        this.now = now;
        this.checkEveryMs = checkEveryMs;
        this.last = now();
    }

    start(): void {
        this.last = this.now();
        this.timer = setInterval(() => {
            if (this.now() - this.last >= this.timeoutMs) {
                this.stop();
                this.onStall();
            }
        }, this.checkEveryMs);
    }

    touch(): void {
        this.last = this.now();
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}
