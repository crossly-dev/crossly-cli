/**
 * The motion profile.
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────
 * The spin used ease-out — fastest at the start, gliding to a stop — so the
 * speed was different on every single frame. Watching it, that reads as the
 * animation stuttering rather than as an object turning. "The spin looks a bit
 * weird, speed ain't consistent" is exactly what an easing curve looks like
 * applied to rotation.
 *
 * A trapezoid fixes it: ramp up, hold ONE speed for most of the run, ramp
 * down. These tests assert the shape of that curve, which is the part that can
 * silently regress into an ease if somebody "simplifies" it.
 */
import { describe, it, expect } from 'vitest';
import { progress, velocity, CRUISE } from '../render/motion.js';

describe('velocity profile', () => {
  it('starts from a standstill', () => {
    expect(velocity(0)).toBe(0);
  });

  it('holds exactly one speed across the whole cruise', () => {
    // The point of the whole exercise. Sampled densely because a curve that
    // merely PASSES through 1 at the midpoint would satisfy a lazier check.
    for (let t = CRUISE.from; t <= CRUISE.to; t += 0.01) {
      expect(velocity(t), `t=${t.toFixed(2)}`).toBeCloseTo(1, 10);
    }
  });

  it('spends most of the run at that constant speed', () => {
    // If the ramps grew to swallow the middle, the motion would be an ease
    // again while every other assertion here still passed.
    expect(CRUISE.to - CRUISE.from).toBeGreaterThan(0.5);
  });

  it('comes to a stop', () => {
    expect(velocity(1)).toBeCloseTo(0, 10);
  });

  it('never reverses', () => {
    for (let t = 0; t <= 1; t += 0.02) {
      expect(velocity(t), `t=${t.toFixed(2)}`).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('position', () => {
  it('runs from 0 to exactly 1', () => {
    // The normalisation is what lets the caller land on a chosen angle. Drift
    // here means the mark stops somewhere arbitrary — which for a logo can be
    // edge-on.
    expect(progress(0)).toBe(0);
    expect(progress(1)).toBeCloseTo(1, 10);
  });

  it('only ever moves forward', () => {
    let last = -1;
    for (let t = 0; t <= 1; t += 0.01) {
      const p = progress(t);
      expect(p, `t=${t.toFixed(2)}`).toBeGreaterThanOrEqual(last);
      last = p;
    }
  });

  it('is linear through the cruise', () => {
    // Equal time, equal rotation — the observable consequence of constant
    // velocity, and the thing the eye actually judges.
    const a = progress(CRUISE.from + 0.1);
    const b = progress(CRUISE.from + 0.2);
    const c = progress(CRUISE.from + 0.3);
    expect(b - a).toBeCloseTo(c - b, 6);
  });

  it('moves slower at the start than mid-cruise', () => {
    // Sanity on the ramp existing at all: a profile that was constant from
    // frame one would look like the mark was already spinning when it appeared.
    const early = progress(0.04) - progress(0.02);
    const mid = progress(0.52) - progress(0.5);
    expect(early).toBeLessThan(mid);
  });

  it('clamps outside 0..1 rather than extrapolating', () => {
    expect(progress(-1)).toBe(0);
    expect(progress(2)).toBeCloseTo(1, 10);
  });
});
