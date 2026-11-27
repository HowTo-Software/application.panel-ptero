export interface AdaptiveOptions {
    min?: number;
    max?: number;
    initial?: number;
    /** Length of one measurement window. */
    windowMs?: number;
    /** Relative throughput gain a probe must bring to be kept (0.1 = +10 %). */
    minGain?: number;
    /** After a failed probe or an error, how many windows to wait before probing again. */
    holdWindows?: number;
    /** A smaller number of connections is kept if throughput drops by less than this (0.03 = -3 %). */
    downTolerance?: number;
}

/**
 * Chooses how many chunks to send at the same time, between `min` and `max`.
 *
 * Several connections help when one TCP connection cannot fill the path (a long round trip with a little loss
 * keeps a single connection far below the link speed) and stop helping once the link, the disk or the node is
 * the limit. Instead of guessing, it measures: it raises the number of connections, keeps the new number only
 * if the measured throughput grew by at least `minGain`, and otherwise goes back and waits before trying again.
 * Errors (timeouts, 5xx, a busy node) halve it.
 *
 *  - slow start: doubles while every step pays off (1 -> 2 -> 4 -> 8);
 *  - then probes one connection at a time, alternately upwards and downwards: a smaller number is kept when it
 *    carries practically the same (fewer connections cost the node and the browser less), which also corrects an
 *    overshoot of the doubling;
 *  - a probe that does not pay off is undone and not repeated for `holdWindows` windows.
 *
 * It has no timers of its own: the caller reports transferred bytes with `record()` and calls `tick()` often
 * (every few hundred ms); a decision is only taken when a full window has elapsed.
 */
export default class AdaptiveConcurrency {
    private readonly min: number;
    private readonly max: number;
    private readonly windowMs: number;
    private readonly minGain: number;
    private readonly holdWindows: number;
    private readonly downTolerance: number;

    private current: number;
    private windowStart: number | null = null;
    private windowBytes = 0;
    /** Throughput of the window before a probe, to compare the probe against. */
    private baseline: number | null = null;
    private probingFrom: number | null = null;
    private probingDirection: 'up' | 'down' = 'up';
    private nextDirection: 'up' | 'down' = 'up';
    private slowStart = true;
    private hold = 0;

    constructor(options: AdaptiveOptions = {}) {
        this.min = Math.max(1, options.min ?? 1);
        this.max = Math.max(this.min, options.max ?? 8);
        this.windowMs = options.windowMs ?? 6000;
        this.minGain = options.minGain ?? 0.1;
        this.holdWindows = options.holdWindows ?? 4;
        this.downTolerance = options.downTolerance ?? 0.03;
        this.current = Math.min(this.max, Math.max(this.min, options.initial ?? 2));
    }

    /** How many chunks should currently be in flight. */
    get target(): number {
        return this.current;
    }

    /** Reports bytes that were just transferred. */
    record(bytes: number, now: number): void {
        if (this.windowStart === null) {
            this.windowStart = now;
        }
        this.windowBytes += bytes;
    }

    /** Takes a decision if a full window has elapsed. Returns the (possibly new) target. */
    tick(now: number): number {
        if (this.windowStart === null || now - this.windowStart < this.windowMs) {
            return this.current;
        }

        const throughput = this.windowBytes / ((now - this.windowStart) / 1000);
        this.windowStart = now;
        this.windowBytes = 0;

        if (this.probingFrom !== null) {
            // The previous window ran with a different target than the one before it: was it worth it?
            const before = this.baseline ?? 0;
            const gain = before > 0 ? (throughput - before) / before : 1;
            const from = this.probingFrom;
            const direction = this.probingDirection;
            this.probingFrom = null;

            const kept = direction === 'up' ? gain >= this.minGain : gain >= -this.downTolerance;
            if (kept) {
                this.baseline = throughput;

                // Keep going the same way while it keeps paying off.
                return this.probe(direction);
            }

            // Not worth it: go back, stop doubling, leave it alone for a while, then try the other direction.
            this.current = from;
            this.slowStart = false;
            this.hold = this.holdWindows;
            this.baseline = null;
            this.nextDirection = direction === 'up' ? 'down' : 'up';

            return this.current;
        }

        if (this.hold > 0) {
            this.hold--;
            this.baseline = throughput;

            return this.current;
        }

        this.baseline = throughput;

        return this.probe(this.nextDirection);
    }

    /** A chunk failed (timeout, server error): back off. */
    onError(): void {
        this.current = Math.max(this.min, Math.floor(this.current / 2));
        this.slowStart = false;
        this.hold = this.holdWindows;
        this.probingFrom = null;
        this.nextDirection = 'up';
        this.baseline = null;
        this.windowStart = null;
        this.windowBytes = 0;
    }

    /** The node said it cannot take more chunks at once: never ask for more than it just accepted. */
    onBusy(accepted: number): void {
        this.current = Math.max(this.min, Math.min(this.current, accepted));
        this.slowStart = false;
        this.hold = this.holdWindows * 2;
        this.probingFrom = null;
        this.baseline = null;
    }

    private probe(direction: 'up' | 'down'): number {
        // Fall back to the other direction at the edges; nothing to do when there is no room at all.
        if (direction === 'up' && this.current >= this.max) direction = 'down';
        if (direction === 'down' && this.current <= this.min) direction = 'up';
        if (direction === 'up' && this.current >= this.max) return this.current;

        this.probingFrom = this.current;
        this.probingDirection = direction;
        this.current =
            direction === 'up'
                ? Math.min(this.max, this.slowStart ? this.current * 2 : this.current + 1)
                : Math.max(this.min, this.current - 1);

        return this.current;
    }
}
