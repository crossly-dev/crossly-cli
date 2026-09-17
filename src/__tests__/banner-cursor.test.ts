/**
 * The animation must leave the cursor exactly where it found it.
 *
 * ── THE BUG THIS PINS ────────────────────────────────────────────────
 * Each frame is drawn by printing, then moving the cursor back up to print
 * over it. The rewind was one line larger than the print, so every frame
 * climbed a row higher than it drew — and over thirty-six frames the animation
 * walked 36 lines UP the terminal, overwriting the shell prompt, the command
 * the user had just typed, and its own output. The mark rendered perfectly the
 * whole time; the damage was entirely around it.
 *
 * Nothing about the drawing catches this, which is why it needs its own file.
 * `animate()` is captured with a fake stdout, and the newlines it emits are
 * counted against the cursor movements it requests. They must cancel.
 */
import { describe, it, expect } from 'vitest';
import { animate, BANNER_HEIGHT } from '../render/banner.js';

interface Captured {
  down: number;
  up: number;
  text: string;
}

/** Run animate() against a fake stdout and account for vertical movement. */
async function capture(): Promise<Captured> {
  const chunks: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  const realTty = process.stdout.isTTY;

  // Not a TTY by default in vitest; the banner does not consult that here, but
  // pin it so the test does not depend on how it was invoked.
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    chunks.push(s);
    return true;
  };

  try {
    await animate();
  } finally {
    (process.stdout as unknown as { write: typeof realWrite }).write = realWrite;
    Object.defineProperty(process.stdout, 'isTTY', { value: realTty, configurable: true });
  }

  const text = chunks.join('');
  const ESC = String.fromCharCode(27);

  // Newlines move the cursor down one row each.
  const down = (text.match(/\n/g) ?? []).length;

  // ESC[<n>A moves up n rows.
  let up = 0;
  for (const m of text.matchAll(new RegExp(`${ESC}\\[(\\d+)A`, 'g'))) {
    up += Number(m[1]);
  }

  return { down, up, text };
}

describe('cursor bookkeeping', () => {
  it('ends exactly BANNER_HEIGHT rows below where it started', async () => {
    const { down, up } = await capture();
    // Every rewind must be paid for by the lines that were printed, leaving
    // only the finished banner on screen. A mismatch in either direction is
    // the drift bug — upward eats the user's terminal, downward leaves a
    // growing gap.
    expect(down - up).toBe(BANNER_HEIGHT);
  }, 20_000);

  it('restores the cursor it hid', async () => {
    const { text } = await capture();
    const ESC = String.fromCharCode(27);
    const hides = (text.match(new RegExp(`${ESC}\\[\\?25l`, 'g')) ?? []).length;
    const shows = (text.match(new RegExp(`${ESC}\\[\\?25h`, 'g')) ?? []).length;
    // A CLI that exits leaving the terminal with no cursor is one people
    // uninstall, and it survives until the next `reset`.
    expect(hides).toBeGreaterThan(0);
    expect(shows).toBe(hides);
  }, 20_000);

  it('erases to end of line on every drawn row', async () => {
    const { text } = await capture();
    const ESC = String.fromCharCode(27);
    const erases = (text.match(new RegExp(`${ESC}\\[K`, 'g')) ?? []).length;
    // Without this, a wide frame followed by a narrow one leaves the tail of
    // the wide one on screen — a smear of stale characters trailing the
    // animation. One per row per frame, so the count is large by design.
    expect(erases).toBeGreaterThan(100);
  }, 20_000);
});
