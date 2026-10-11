/**
 * The welcome banner — the Crossly mark as real 3D geometry, spinning.
 *
 * ── WHEN IT RUNS, AND WHY THAT MATTERS MORE THAN HOW IT LOOKS ────────
 * Only on a bare `crossly`, only on a TTY, never in CI, never when output is
 * piped. An animation that delayed `crossly orders list` by a second would be
 * the opposite of professional — it is the thing people write scripts to work
 * around. If anything is going to READ this output, there is no animation.
 *
 * `CROSSLY_NO_BANNER=1` turns it off. `NO_COLOR` keeps the whole thing and
 * drops only the tint, because the FORM here is carried by the characters
 * rather than by the colour.
 *
 * ── WHY ASCII AND NOT BLOCKS ─────────────────────────────────────────
 * Half-block characters give twice the resolution and look like a low-res
 * image. A luminance ramp — `.` through `@` — looks like a drawing, and it is
 * the language terminals have used for lit 3D since `donut.c`. Each character
 * is a brightness sample, so the shape emerges from shading the way a pencil
 * sketch does rather than from filling pixels.
 *
 * ── AN ACTUAL 3D PIPELINE ────────────────────────────────────────────
 * The mark is geometry, not a projected outline: two crossed bars, each a box
 * of twelve triangles, rotated in world space, perspective-projected and
 * rasterized with a Z-BUFFER. The buffer is what makes the crossing correct —
 * without it, draw order would decide which bar is in front and it would flip
 * as the mark turned.
 *
 * Lighting is per-face Lambert against a fixed key light, so the shading
 * changes as it spins. That change over time is what sells the depth; a static
 * frame of this would just be a textured X.
 */

import { wordmarkLines, WORDMARK_ROWS } from './wordmark.js';
import { CRUISE, progress, velocity } from './motion.js';

/** Character grid. Cells are ~2:1, so X is stretched to compensate. */
const COLS = 62;
const ROWS = 18;
const CELL_ASPECT = 2;

/**
 * Dark to bright.
 *
 * Chosen so the steps look evenly spaced by INK rather than by ASCII value —
 * a ramp that jumps from `-` to `#` shows banding on a curved surface, and the
 * bars here have three faces at similar angles where banding is exactly what
 * would be noticed.
 */
const RAMP = ' .,:;irsXA253hMHGS#9B&@';

const ESC = '\u001b';
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
/** Erase from the cursor to the end of the line. */
const ERASE_EOL = `${ESC}[K`;

/**
 * How far to rewind between frames.
 *
 * ── OFF BY ONE HERE DESTROYS THE SCREEN ──────────────────────────────
 * A frame is written as a leading newline, then ROWS lines, then a trailing
 * newline — ROWS + 1 newlines in total, so the cursor ends exactly that far
 * below where it started. This
 * was ROWS + 2 — one line too many — so every frame climbed one row higher
 * than it drew. Over thirty-six frames the animation walked 36 lines UP the
 * terminal, overwriting the shell prompt, the command the user had typed, and
 * its own earlier output.
 *
 * Derived from ROWS rather than written as a number, so changing the frame
 * height cannot silently reintroduce it.
 */
const FRAME_ADVANCE = ROWS + 1;

/**
 * Rows a completed `animate()` leaves behind.
 *
 * FRAME_ADVANCE for the mark, then the wordmark block: a leading blank, its
 * five letter rows, the tagline, and a trailing newline — WORDMARK_ROWS + 2
 * newlines, not + 3. Counted rather than estimated, because a caller that
 * rewinds by this number (the demo's replay) would drift by the difference.
 */
export const BANNER_HEIGHT = FRAME_ADVANCE + WORDMARK_ROWS + 2;

/** Straight from favicon.svg. */
const WHITE_RGB: [number, number, number] = [235, 235, 238];
const EMERALD_RGB: [number, number, number] = [16, 185, 129];

type Vec3 = [number, number, number];

interface Tri {
  a: Vec3;
  b: Vec3;
  c: Vec3;
  /** Which bar this belongs to — decides the tint, never the brightness. */
  bar: 0 | 1;
}

// ── Geometry ────────────────────────────────────────────────────────────

/** A box as twelve triangles, centred on the origin. */
function box(len: number, thick: number, depth: number, bar: 0 | 1): Tri[] {
  const [x, y, z] = [len / 2, thick / 2, depth / 2];
  const v: Vec3[] = [
    [-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z],
    [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z],
  ];
  const quads = [
    [0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7],
    [1, 5, 6, 2], [4, 5, 1, 0], [3, 2, 6, 7],
  ];
  const tris: Tri[] = [];
  for (const q of quads) {
    tris.push({ a: v[q[0]!]!, b: v[q[1]!]!, c: v[q[2]!]!, bar });
    tris.push({ a: v[q[0]!]!, b: v[q[2]!]!, c: v[q[3]!]!, bar });
  }
  return tris;
}

function rotZ(v: Vec3, angle: number): Vec3 {
  const [x, y, z] = v;
  return [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle), z];
}

/** Push a vertex along the viewing axis — see SEPARATION below. */
function shiftZ(v: Vec3, dz: number): Vec3 {
  return [v[0], v[1], v[2] + dz];
}

/**
 * Two bars crossed at ±45°, each with real thickness and depth.
 *
 * Built once. Twenty-four triangles is nothing, but rebuilding geometry thirty
 * times a second would still be a silly thing to have written.
 */
const MARK: Tri[] = (() => {
  const LEN = 3.05;
  const THICK = 0.5;
  /**
   * Each slat's own depth. Halved from 0.5 because the two are now STACKED
   * rather than sharing the same space, so the combined solid keeps roughly
   * its old thickness.
   */
  const DEPTH = 0.26;

  /**
   * ── WHY THE BARS ARE OFFSET IN Z ─────────────────────────────────────
   * Both used to be centred on z = 0 and each 0.5 deep, so they occupied the
   * SAME volume through the crossing. Two surfaces at the same depth is
   * classic z-fighting: the buffer comparison is decided by floating-point
   * noise, so which colour wins flips from pixel to pixel and from frame to
   * frame. On screen that is the crossing shimmering between white and
   * emerald — "batting for colour".
   *
   * Offsetting each by half its depth makes them TOUCH rather than overlap.
   * There is now an unambiguous nearer surface at every pixel, so the answer
   * is stable, and the mark reads as two physical slats crossed — which is
   * what the logo is.
   *
   * The offset is applied AFTER the ±45° roll, so it is along the viewing
   * axis rather than along each bar's own length.
   */
  const SEPARATION = DEPTH / 2;

  return ([
    [Math.PI / 4, 0, -SEPARATION],
    [-Math.PI / 4, 1, SEPARATION],
  ] as Array<[number, 0 | 1, number]>).flatMap(([angle, bar, dz]) =>
    box(LEN, THICK, DEPTH, bar).map((t) => ({
      a: shiftZ(rotZ(t.a, angle), dz),
      b: shiftZ(rotZ(t.b, angle), dz),
      c: shiftZ(rotZ(t.c, angle), dz),
      bar: t.bar,
    })),
  );
})();

// ── Renderer ────────────────────────────────────────────────────────────

function rotateYX(v: Vec3, ay: number, ax: number): Vec3 {
  const [x0, y0, z0] = v;
  const x1 = x0 * Math.cos(ay) - z0 * Math.sin(ay);
  const z1 = x0 * Math.sin(ay) + z0 * Math.cos(ay);
  const y2 = y0 * Math.cos(ax) - z1 * Math.sin(ax);
  const z2 = y0 * Math.sin(ax) + z1 * Math.cos(ax);
  return [x1, y2, z2];
}

const CAMERA_Z = 7.5;
/**
 * Focal length, in cells.
 *
 * Sized against the geometry rather than guessed: a bar of length 2.6 rotated
 * 45° reaches about 1.84 units from centre, and the grid is 20 rows, so a
 * factor near 33/7.5 ≈ 4.4 puts the mark at roughly 8 rows tall — filling the
 * frame with a margin. The first value here was 7.6, which rendered the whole
 * mark into five characters.
 */
const SCALE = 40;

/** Perspective projection into cell space. Third value is 1/z, for the buffer. */
function project(v: Vec3): [number, number, number] {
  const z = v[2] + CAMERA_Z;
  const f = SCALE / z;
  // X is multiplied by the cell aspect so the mark is not squashed sideways.
  return [COLS / 2 + v[0] * f * CELL_ASPECT, ROWS / 2 - v[1] * f, 1 / z];
}

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Key light: above, in front, a little to the left. */
const LIGHT = normalize([-0.45, 0.62, 0.64]);

interface Cell {
  lum: number;
  bar: 0 | 1;
}

/**
 * Rasterize one frame.
 *
 * For each triangle: walk its bounding box, use barycentric coordinates to
 * test containment and interpolate 1/z, keep the nearest fragment per cell.
 */
function render(ay: number, ax: number): Array<Cell | null> {
  const cells: Array<Cell | null> = new Array(COLS * ROWS).fill(null);
  const depth = new Float64Array(COLS * ROWS).fill(-Infinity);

  for (const tri of MARK) {
    const a = rotateYX(tri.a, ay, ax);
    const b = rotateYX(tri.b, ay, ax);
    const c = rotateYX(tri.c, ay, ax);

    const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = normalize([
      u[1] * w[2] - u[2] * w[1],
      u[2] * w[0] - u[0] * w[2],
      u[0] * w[1] - u[1] * w[0],
    ]);

    const pa = project(a);
    const pb = project(b);
    const pc = project(c);

    // Screen-space winding. A back face is hidden by the solid anyway, and
    // skipping it halves the work.
    const area = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pc[0] - pa[0]) * (pb[1] - pa[1]);
    if (area >= 0) continue;

    // Lambert, lifted off zero so an unlit face is a dark SURFACE, not a hole.
    const lambert = Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);

    // Specular: a tight highlight where the face mirrors the light toward the
    // camera. Flat-shaded boxes have very few distinct normals — both bars'
    // front faces are coplanar and therefore identical — so diffuse alone gave
    // the whole mark three tones. The highlight adds a fourth that moves as it
    // turns, which is what makes the surface look hard rather than painted.
    const half = normalize([LIGHT[0], LIGHT[1], LIGHT[2] + 1]);
    const spec = Math.pow(Math.max(0, n[0] * half[0] + n[1] * half[1] + n[2] * half[2]), 24);

    const faceLum = 0.16 + lambert * 0.72 + spec * 0.5;

    const minX = Math.max(0, Math.floor(Math.min(pa[0], pb[0], pc[0])));
    const maxX = Math.min(COLS - 1, Math.ceil(Math.max(pa[0], pb[0], pc[0])));
    const minY = Math.max(0, Math.floor(Math.min(pa[1], pb[1], pc[1])));
    const maxY = Math.min(ROWS - 1, Math.ceil(Math.max(pa[1], pb[1], pc[1])));

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const cx = x + 0.5;
        const cy = y + 0.5;

        const e0 = (pb[0] - pa[0]) * (cy - pa[1]) - (cx - pa[0]) * (pb[1] - pa[1]);
        const e1 = (pc[0] - pb[0]) * (cy - pb[1]) - (cx - pb[0]) * (pc[1] - pb[1]);
        const e2 = (pa[0] - pc[0]) * (cy - pc[1]) - (cx - pc[0]) * (pa[1] - pc[1]);
        // Area is negative (positive ones were culled), so inside means every
        // edge function is non-positive.
        if (e0 > 0 || e1 > 0 || e2 > 0) continue;

        const invZ = (e1 / area) * pa[2] + (e2 / area) * pb[2] + (e0 / area) * pc[2];
        const idx = y * COLS + x;
        if (invZ <= depth[idx]!) continue;
        depth[idx] = invZ;

        // Depth falloff, per PIXEL rather than per face.
        //
        // This is what turns three flat tones into a gradient. Every face is a
        // single normal, so without it each one is a solid block of one
        // character and the mark reads as papercraft. Nearer is brighter,
        // which is also just true — and because it varies across a face it
        // gives the ramp something continuous to resolve.
        const z = 1 / invZ;
        const near = CAMERA_Z - 1.9;
        const far = CAMERA_Z + 1.9;
        const depthTerm = 1.18 - 0.42 * ((z - near) / (far - near));
        const lum = Math.max(0.06, Math.min(1, faceLum * depthTerm));

        cells[idx] = { lum, bar: tri.bar };
      }
    }
  }

  return cells;
}

function tint(bar: 0 | 1, lum: number): string {
  const base = bar === 0 ? WHITE_RGB : EMERALD_RGB;
  // The character already carries the brightness; the colour is only lifted a
  // little so the two bars stay distinguishable without the tint fighting the
  // ramp for the same job.
  const k = 0.55 + lum * 0.45;
  return `${ESC}[38;2;${Math.round(base[0] * k)};${Math.round(base[1] * k)};${Math.round(base[2] * k)}m`;
}


/**
 * Erase-to-end-of-line after every row.
 *
 * ── THE BUG THIS FIXES ───────────────────────────────────────────────
 * Each frame is redrawn by moving the cursor UP and printing over the last
 * one. Rows have their trailing spaces trimmed and the mark's width swings
 * between roughly 35 and 45 columns as it turns — so a wide frame followed by
 * a narrow one leaves the uncovered tail of the wide one on screen. The result
 * is a smear of stale characters trailing the animation, which looks exactly
 * like a rendering bug because it is one.
 *
 * `ESC[K` clears from the cursor to the end of the line, so every row is
 * responsible for erasing whatever it no longer covers. Padding each line to
 * the full width would also work and would write 62 spaces per row per frame;
 * this writes three bytes.
 */
function overwrite(body: string): string {
  return body.split('\n').map((line) => line + ERASE_EOL).join('\n');
}

/** One frame, ready to print. */
export function frame(ay: number, ax = 0.3, colour = true): string {
  const cells = render(ay, ax);
  const lines: string[] = [];

  for (let y = 0; y < ROWS; y += 1) {
    let line = '';
    let active = '';

    for (let x = 0; x < COLS; x += 1) {
      const cell = cells[y * COLS + x];
      if (!cell) {
        if (active) {
          line += RESET;
          active = '';
        }
        line += ' ';
        continue;
      }

      const ch = RAMP[Math.max(1, Math.min(RAMP.length - 1, Math.round(cell.lum * (RAMP.length - 1))))]!;
      if (colour) {
        const t = tint(cell.bar, cell.lum);
        if (t !== active) {
          line += t;
          active = t;
        }
      }
      line += ch;
    }

    if (active) line += RESET;
    lines.push(line.replace(/\s+$/, ''));
  }

  return lines.join('\n');
}

// ── Public surface ──────────────────────────────────────────────────────

export function bannerAllowed(): boolean {
  if (process.env.CROSSLY_NO_BANNER) return false;
  if (process.env.CI) return false;
  if (!process.stdout.isTTY) return false;
  if ((process.stdout.columns ?? 80) < COLS + 2) return false;
  return true;
}

const TAGLINE = '  list once, sell everywhere';

function wordmark(colour: boolean): string {
  const lines = wordmarkLines(
    colour
      ? {
          primary: `${BOLD}${ESC}[38;2;235;235;238m`,
          accent: `${BOLD}${ESC}[38;2;16;185;129m`,
          reset: RESET,
        }
      : undefined,
  );
  const tag = colour ? `${DIM}${TAGLINE}${RESET}` : TAGLINE;
  return ['', ...lines, tag, ''].join('\n');
}

/**
 * Where the spin stops: a true three-quarter view.
 *
 * This was `0.9 + PI * 1.75`, which wraps to about 0.12 rad — very nearly
 * face-on. At that angle only the FRONT faces are visible, and both bars'
 * front faces share a normal, so every lit cell had the same brightness and
 * the whole mark rendered in a single character. The depth was all there in
 * the geometry and none of it was visible.
 */
const REST_ANGLE = 0.55;

/** A still frame plus the wordmark, for when motion is not wanted. */
export function staticBanner(colour = true): string {
  return `\n${frame(REST_ANGLE, 0.22, colour)}\n${wordmark(colour)}`;
}

/** Frames per second for both the intro and the free spin. */
const FPS = 30;

/** Radians per frame while cruising — about one turn every two seconds. */
const CRUISE_SPEED = (Math.PI * 2) / (FPS * 2);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Draw one frame in place and rewind, ready for the next.
 *
 * `withWordmark` draws the letters underneath every frame and rewinds past
 * them too. The free spin needs that: it never reaches its own cleanup while
 * somebody is watching, so a wordmark written only on exit is a wordmark that
 * is never on screen during the thing it belongs to. The intro does not — it
 * paints the letters once, at the end, as the animation's full stop.
 *
 * The rewind distance differs between the two, which is exactly the arithmetic
 * that has drifted twice already, so it is derived here rather than at each
 * call site.
 */
function paint(ay: number, ax: number, colour: boolean, withWordmark = false): void {
  const body = overwrite(frame(ay, ax, colour));
  if (withWordmark) {
    process.stdout.write(`\n${body}\n${overwrite(wordmark(colour))}`);
    process.stdout.write(`${ESC}[${BANNER_HEIGHT}A`);
    return;
  }
  process.stdout.write(`\n${body}\n`);
  process.stdout.write(`${ESC}[${FRAME_ADVANCE}A`);
}

/**
 * The intro: spin up, cruise, settle on the rest pose.
 *
 * ── WHY IT STOPS AT ALL ──────────────────────────────────────────────
 * `crossly` has to print the command list afterwards, so the banner cannot own
 * the terminal forever. It turns for about two seconds and lands on a fixed
 * three-quarter view — the same pose `staticBanner` uses, so the last frame of
 * the animation and the still image are the same picture.
 *
 * The motion is trapezoidal rather than eased: most of those two seconds are
 * at ONE constant speed. See motion.ts.
 */
export async function animate(): Promise<void> {
  const colour = !process.env.NO_COLOR;
  const frames = 54;
  // Two full turns, ending exactly on REST_ANGLE.
  const sweep = Math.PI * 4;

  process.stdout.write(HIDE_CURSOR);
  try {
    for (let i = 0; i < frames; i += 1) {
      const p = progress(i / (frames - 1));
      // Counts DOWN to the rest angle, so the final frame is the rest pose
      // exactly rather than approximately.
      const ay = REST_ANGLE + (1 - p) * sweep;
      paint(ay, 0.06 + p * 0.16, colour);
      await sleep(1000 / FPS);
    }

    // The settle frame erases too: it is drawn over the last animation frame,
    // which may have been wider.
    process.stdout.write(`\n${overwrite(frame(REST_ANGLE, 0.22, colour))}\n`);
    process.stdout.write(overwrite(wordmark(colour)));
  } finally {
    process.stdout.write(SHOW_CURSOR);
  }
}

export interface SpinOptions {
  /** Stop when this resolves. Without it, spins until the process is killed. */
  signal?: AbortSignal;
  /** Skip the ramp and start at full speed. */
  immediate?: boolean;
}

/**
 * Spin for as long as somebody watches.
 *
 * Separate from `animate()` because they want opposite things: the intro must
 * END so the CLI can print, and this must not. Sharing one function behind a
 * flag would mean the intro's landing logic running every frame of an infinite
 * loop, forever computing a stop that never comes.
 *
 * The ramp is reused, so it spins up the same way before settling into the
 * same cruise speed the intro uses — one motion vocabulary, two durations.
 */
export async function spin(opts: SpinOptions = {}): Promise<void> {
  const colour = !process.env.NO_COLOR;
  const rampFrames = opts.immediate ? 0 : Math.round(FPS * CRUISE.from * 4);

  let ay = REST_ANGLE;
  process.stdout.write(HIDE_CURSOR);

  try {
    for (let i = 0; !opts.signal?.aborted; i += 1) {
      // Ramp for the first stretch, then hold cruise speed exactly. `velocity`
      // returns 1 across the whole cruise band, so after the ramp every frame
      // advances by the same amount — which is the point.
      const v = rampFrames > 0 && i < rampFrames ? velocity((i / rampFrames) * CRUISE.from) : 1;
      ay += CRUISE_SPEED * v;

      // With the wordmark, every frame — the free spin never reaches its own
      // cleanup while somebody is watching it, so letters written only on exit
      // are letters that are never on screen during the spin.
      paint(ay, 0.22, colour, true);
      await sleep(1000 / FPS);
    }
  } finally {
    // Every frame already drew the wordmark; this leaves one COMPLETE copy on
    // screen and moves the cursor past it, so the shell prompt does not land
    // on top of the letters.
    process.stdout.write(`\n${overwrite(frame(ay, 0.22, colour))}\n`);
    process.stdout.write(overwrite(wordmark(colour)));
    process.stdout.write(SHOW_CURSOR);
  }
}

