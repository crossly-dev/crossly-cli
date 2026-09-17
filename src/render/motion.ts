/**
 * How the mark moves.
 *
 * ── WHY NOT AN EASING CURVE ──────────────────────────────────────────
 * The first version used ease-out: fast at the start, gliding to a stop. Read
 * as a page transition rather than as an object turning, and the speed was
 * never the same for two frames running — which is exactly what "the spin
 * looks a bit weird, speed ain't consistent" describes.
 *
 * A physical thing spins up, then turns at a steady rate. That is a
 * TRAPEZOIDAL VELOCITY profile — ramp, cruise, ramp down — and the cruise
 * section is the whole point: most of the animation is at one constant speed,
 * so it looks like something rotating rather than something being animated.
 */

/** Fraction of the run spent getting up to speed. */
const ACCEL = 0.16;
/** Fraction spent slowing to a stop. Longer than the ramp, so it settles. */
const DECEL = 0.3;

/** Area under the velocity curve — used to normalise position to end at 1. */
const TOTAL_AREA = ACCEL / 2 + (1 - ACCEL - DECEL) + DECEL / 2;

/**
 * Fraction of total rotation completed at time `t` (0..1).
 *
 * The integral of the trapezoid, normalised so `progress(1) === 1`. That
 * normalisation is what lets a caller say "turn exactly this far" and land on
 * a chosen angle — without it the mark stops wherever the maths happened to
 * leave it, which for a logo can be edge-on.
 */
export function progress(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  let area: number;

  if (clamped < ACCEL) {
    // Ramping: area under a straight line from 0.
    area = (clamped * clamped) / (2 * ACCEL);
  } else if (clamped <= 1 - DECEL) {
    // Cruising at velocity 1.
    area = ACCEL / 2 + (clamped - ACCEL);
  } else {
    // Ramping down: full area minus the triangle still to come.
    const left = 1 - clamped;
    area = ACCEL / 2 + (1 - ACCEL - DECEL) + (DECEL / 2 - (left * left) / (2 * DECEL));
  }

  return area / TOTAL_AREA;
}

/**
 * Velocity at time `t`, relative to cruise speed. Exported so the shape of the
 * motion can be asserted rather than eyeballed.
 */
export function velocity(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  if (clamped < ACCEL) return clamped / ACCEL;
  if (clamped <= 1 - DECEL) return 1;
  return (1 - clamped) / DECEL;
}

/** Where the cruise section begins and ends, for tests and for tuning. */
export const CRUISE = { from: ACCEL, to: 1 - DECEL };
