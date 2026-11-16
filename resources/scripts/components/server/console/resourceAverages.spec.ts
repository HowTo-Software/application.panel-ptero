import {
    averageNetworkRate,
    averageOf,
    formatDuration,
    MAX_SAMPLE_GAP_MS,
    recordSample,
    startHistory,
} from './resourceAverages';
import { ResourceStats } from './resourceStats';

const stats = (overrides: Partial<ResourceStats>): ResourceStats => ({
    cpu: 0,
    memory: 0,
    disk: 0,
    rx: 0,
    tx: 0,
    uptime: 60_000,
    ...overrides,
});

describe('resource averages', () => {
    it('weights each value by how long it was observed', () => {
        let history = startHistory(stats({ cpu: 10, uptime: 60_000 }), 1_000_000);
        // 10% for 3s, then 40% for 1s.
        history = recordSample(history, stats({ cpu: 40, uptime: 63_000 }), 1_003_000);
        history = recordSample(history, stats({ cpu: 0, uptime: 64_000 }), 1_004_000);

        expect(averageOf(history, 'cpu', 1_004_000)).toBeCloseTo((10 * 3 + 40 * 1) / 4);
        expect(history.metrics.cpu.peak).toBe(40);
        expect(history.metrics.cpu.samples).toBe(3);
    });

    it('includes the latest value up to now', () => {
        const history = recordSample(
            startHistory(stats({ memory: 100, uptime: 60_000 }), 0),
            stats({ memory: 300, uptime: 61_000 }),
            1_000
        );

        // 100 for 1s, then 300 for 1s more.
        expect(averageOf(history, 'memory', 2_000)).toBeCloseTo(200);
    });

    it('caps long gaps so a sleeping tab does not dominate the average', () => {
        const history = recordSample(
            startHistory(stats({ cpu: 90, uptime: 60_000 }), 0),
            stats({ cpu: 10, uptime: 60_000 + 600_000 }),
            600_000
        );

        expect(history.metrics.cpu.weight).toBe(MAX_SAMPLE_GAP_MS);
    });

    it('starts over when the server restarts', () => {
        const history = recordSample(
            startHistory(stats({ cpu: 90, uptime: 3_600_000 }), 3_600_000),
            stats({ cpu: 5, uptime: 2_000 }),
            3_602_000
        );

        expect(history.metrics.cpu.peak).toBe(5);
        expect(history.observedSince).toBe(3_602_000);
    });

    it('computes network rates from cumulative counters', () => {
        const history = recordSample(
            startHistory(stats({ rx: 1_000, uptime: 10_000 }), 0),
            stats({ rx: 3_000, uptime: 12_000 }),
            2_000
        );

        expect(history.rxRate).toBe(1_000);
        expect(averageNetworkRate(stats({ rx: 50_000, uptime: 10_000 }), 'rx')).toBe(5_000);
        expect(averageNetworkRate(stats({ rx: 50_000, uptime: 0 }), 'rx')).toBeNull();
    });

    it('formats observation durations', () => {
        expect(formatDuration(45_000)).toBe('45 s');
        expect(formatDuration(12 * 60_000)).toBe('12 min');
        expect(formatDuration(65 * 60_000)).toBe('1 h 5 min');
        expect(formatDuration(120 * 60_000)).toBe('2 h');
    });
});
