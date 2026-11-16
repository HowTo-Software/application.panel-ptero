import { ResourceStats } from '@/components/server/console/resourceStats';

/**
 * Running averages of the server's resource usage for the current run (since the
 * last start), built from the live samples the panel receives. Wings keeps no
 * history, so CPU/memory/disk cover the time this browser observed the server;
 * network counters are cumulative since start, so their average is exact.
 */
export type AveragedMetric = 'cpu' | 'memory' | 'disk';

export interface MetricAccumulator {
    /** Sum of value × milliseconds it was observed. */
    weightedSum: number;
    /** Total observed milliseconds. */
    weight: number;
    peak: number;
    samples: number;
}

export interface ResourceHistory {
    version: 1;
    /** Estimated start time of the current run (now - uptime). */
    runStartedAt: number;
    observedSince: number;
    lastSampleAt: number;
    last: ResourceStats;
    metrics: Record<AveragedMetric, MetricAccumulator>;
    /** Bytes per second between the last two samples. */
    rxRate: number | null;
    txRate: number | null;
}

/** A gap longer than this (tab asleep, socket down) only counts this long. */
export const MAX_SAMPLE_GAP_MS = 30_000;
/** Two uptimes whose implied start differs by more than this are different runs. */
const RUN_TOLERANCE_MS = 60_000;
const METRICS: AveragedMetric[] = ['cpu', 'memory', 'disk'];

const emptyMetric = (value: number): MetricAccumulator => ({ weightedSum: 0, weight: 0, peak: value, samples: 1 });

export const startHistory = (stats: ResourceStats, now: number): ResourceHistory => ({
    version: 1,
    runStartedAt: now - Math.max(0, stats.uptime),
    observedSince: now,
    lastSampleAt: now,
    last: { ...stats },
    metrics: {
        cpu: emptyMetric(stats.cpu),
        memory: emptyMetric(stats.memory),
        disk: emptyMetric(stats.disk),
    },
    rxRate: null,
    txRate: null,
});

export const isSameRun = (history: ResourceHistory, stats: ResourceStats, now: number): boolean =>
    stats.uptime > 0 && Math.abs(history.runStartedAt - (now - stats.uptime)) <= RUN_TOLERANCE_MS;

const rate = (current: number, previous: number, elapsedMs: number): number | null =>
    elapsedMs > 0 && current >= previous ? ((current - previous) * 1000) / elapsedMs : null;

/** Adds a sample of a running server; starts a new history when the server restarted. */
export const recordSample = (history: ResourceHistory | null, stats: ResourceStats, now: number): ResourceHistory => {
    if (!history || !isSameRun(history, stats, now) || now < history.lastSampleAt) {
        return startHistory(stats, now);
    }

    const elapsed = now - history.lastSampleAt;
    const weight = Math.min(elapsed, MAX_SAMPLE_GAP_MS);
    const metrics = { ...history.metrics };
    METRICS.forEach((key) => {
        const metric = history.metrics[key];
        metrics[key] = {
            // The previous value held until this sample arrived.
            weightedSum: metric.weightedSum + history.last[key] * weight,
            weight: metric.weight + weight,
            peak: Math.max(metric.peak, stats[key]),
            samples: metric.samples + 1,
        };
    });

    return {
        ...history,
        lastSampleAt: now,
        last: { ...stats },
        metrics,
        rxRate: rate(stats.rx, history.last.rx, elapsed) ?? history.rxRate,
        txRate: rate(stats.tx, history.last.tx, elapsed) ?? history.txRate,
    };
};

/** Time-weighted average including the latest value up to `now`. */
export const averageOf = (history: ResourceHistory, key: AveragedMetric, now: number): number => {
    const metric = history.metrics[key];
    const tail = Math.min(Math.max(0, now - history.lastSampleAt), MAX_SAMPLE_GAP_MS);
    const weight = metric.weight + tail;

    return weight > 0 ? (metric.weightedSum + history.last[key] * tail) / weight : history.last[key];
};

/** Average bytes per second since the server started (counters reset on start). */
export const averageNetworkRate = (stats: ResourceStats, key: 'rx' | 'tx'): number | null =>
    stats.uptime > 0 ? (stats[key] * 1000) / stats.uptime : null;

export const formatDuration = (milliseconds: number): string => {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
};

const storageKey = (serverUuid: string) => `howtoo:resource-history:${serverUuid}`;

export const loadHistory = (serverUuid: string): ResourceHistory | null => {
    try {
        const parsed = JSON.parse(window.sessionStorage.getItem(storageKey(serverUuid)) || 'null');
        return parsed && parsed.version === 1 && parsed.metrics?.cpu ? (parsed as ResourceHistory) : null;
    } catch {
        return null;
    }
};

export const saveHistory = (serverUuid: string, history: ResourceHistory): void => {
    try {
        window.sessionStorage.setItem(storageKey(serverUuid), JSON.stringify(history));
    } catch {
        // Private mode or full storage: averages still work for this page view.
    }
};
