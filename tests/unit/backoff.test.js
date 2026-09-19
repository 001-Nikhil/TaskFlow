import { describe, it, expect } from 'vitest';
import { computeBackoffMs } from '../../src/jobs/backoff.js';

describe('computeBackoffMs', () => {
    it('caps the exponential growth at maxMs before jittering', () => {
        // attempt 10 would be base*2^9, far past maxMs; with random()=1 the
        // jittered value should hit exactly maxMs (full jitter's upper bound).
        const delay = computeBackoffMs({ attempt: 10, baseMs: 1000, maxMs: 30000, random: () => 1 });
        expect(delay).toBe(30000);
    });

    it('grows exponentially with attempt before hitting the cap', () => {
        const base = 1000;
        const max = 1_000_000;
        const alwaysMax = (attempt) => computeBackoffMs({ attempt, baseMs: base, maxMs: max, random: () => 1 - 1e-9 });
        expect(alwaysMax(1)).toBeLessThan(alwaysMax(2));
        expect(alwaysMax(2)).toBeLessThan(alwaysMax(3));
        expect(alwaysMax(3)).toBeLessThan(alwaysMax(4));
    });

    it('is deterministic for a fixed random source', () => {
        const opts = { attempt: 3, baseMs: 2000, maxMs: 300000, random: () => 0.5 };
        expect(computeBackoffMs(opts)).toBe(computeBackoffMs(opts));
    });

    it('never returns a negative delay, and 0 with random()=0', () => {
        const delay = computeBackoffMs({ attempt: 5, baseMs: 2000, maxMs: 300000, random: () => 0 });
        expect(delay).toBe(0);
    });

    it('rejects attempt < 1', () => {
        expect(() => computeBackoffMs({ attempt: 0, baseMs: 1000, maxMs: 30000 })).toThrow();
    });
});
