interface Sample {
    time: number;
    loaded: number;
}

/**
 * Measures the real transfer rate from the progress events the browser reports, using a sliding window
 * so the figure follows the current throughput instead of being an average over the whole upload
 * (which would hide stalls and make the ETA useless on unstable links).
 */
export default class SpeedTracker {
    private samples: Sample[] = [];
    private readonly windowMs: number;

    constructor(windowMs = 8000) {
        this.windowMs = windowMs;
    }

    record(loaded: number, now: number = Date.now()): void {
        const last = this.samples[this.samples.length - 1];

        // Progress can never go backwards within one attempt; ignore bogus events.
        if (last && loaded < last.loaded) {
            return;
        }

        this.samples.push({ time: now, loaded });

        // Drop samples that fell out of the window but always keep two so a rate can be computed.
        while (this.samples.length > 2 && now - this.samples[0].time > this.windowMs) {
            this.samples.shift();
        }
    }

    reset(): void {
        this.samples = [];
    }

    /** Current rate in bytes per second, or 0 when there is not enough data. */
    get bytesPerSecond(): number {
        if (this.samples.length < 2) {
            return 0;
        }

        const first = this.samples[0];
        const last = this.samples[this.samples.length - 1];
        const elapsedSeconds = (last.time - first.time) / 1000;

        return elapsedSeconds > 0 ? (last.loaded - first.loaded) / elapsedSeconds : 0;
    }

    /** Estimated seconds remaining at the current rate, or null when no estimate is possible. */
    eta(total: number, loaded: number): number | null {
        const speed = this.bytesPerSecond;

        return speed > 0 ? Math.max(0, total - loaded) / speed : null;
    }
}
