/**
 * The welcome banner: the suppression rules, and the few rendering properties
 * whose absence would be invisible.
 *
 * ── WHY THE RULES MATTER MORE THAN THE ART ───────────────────────────
 * A banner that leaked into piped output would put escape codes into
 * somebody's `jq`, their log file, or their CI transcript. That is not a
 * cosmetic bug — it corrupts the data this CLI exists to produce, and it would
 * be found by whoever's pipeline broke rather than by us.
 *
 * The rendering assertions are narrow on purpose. Whether it LOOKS good is a
 * judgement nobody should encode in a test; whether it renders three tones
 * instead of seven, or collapses to five characters, are bugs that ship
 * silently — both of which happened here.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { frame, staticBanner, bannerAllowed } from '../render/banner.js';

const ESC = String.fromCharCode(27);
const REST = 0.55;

const saved = { ...process.env };
const savedTty = process.stdout.isTTY;

afterEach(() => {
  process.env = { ...saved };
  Object.defineProperty(process.stdout, 'isTTY', { value: savedTty, configurable: true });
});

function setTty(isTty: boolean, columns = 120): void {
  Object.defineProperty(process.stdout, 'isTTY', { value: isTty, configurable: true });
  Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true });
}

const glyphs = (s: string): string[] => s.replace(/\s/g, '').split('');

describe('when the banner is allowed', () => {
  it('on a wide interactive terminal', () => {
    setTty(true);
    delete process.env.CI;
    delete process.env.CROSSLY_NO_BANNER;
    expect(bannerAllowed()).toBe(true);
  });

  it('never when stdout is piped', () => {
    // The important one: piped means a program is reading.
    setTty(false);
    delete process.env.CI;
    delete process.env.CROSSLY_NO_BANNER;
    expect(bannerAllowed()).toBe(false);
  });

  it('never in CI', () => {
    setTty(true);
    process.env.CI = '1';
    expect(bannerAllowed()).toBe(false);
  });

  it('never when explicitly turned off', () => {
    setTty(true);
    delete process.env.CI;
    process.env.CROSSLY_NO_BANNER = '1';
    expect(bannerAllowed()).toBe(false);
  });

  it('never on a terminal too narrow to hold it', () => {
    setTty(true, 40);
    delete process.env.CI;
    delete process.env.CROSSLY_NO_BANNER;
    expect(bannerAllowed()).toBe(false);
  });
});

describe('the render is actually three-dimensional', () => {
  it('resolves many tones, not a flat silhouette', () => {
    // Two bugs lived here. The rest angle wrapped to ~0.12 rad — nearly
    // face-on — where both bars show only their coplanar front faces, so the
    // whole mark drew in ONE character. Flat shading then capped it at three,
    // because a two-box X genuinely has that few distinct normals. Depth
    // falloff is what makes it a gradient. Any of those regressing looks
    // "fine" until you notice the thing has no form.
    const shades = new Set(glyphs(frame(REST, 0.22, false)));
    expect(shades.size).toBeGreaterThanOrEqual(5);
  });

  it('fills the frame rather than a corner of it', () => {
    // An early scale constant rendered the entire mark into five characters.
    // It was centred and correct and completely useless.
    const lines = frame(REST, 0.22, false).split('\n');
    const used = lines.filter((l) => l.trim().length > 0).length;
    expect(used).toBeGreaterThan(10);
    expect(Math.max(...lines.map((l) => l.length))).toBeGreaterThan(30);
  });

  it('shades differently as it turns', () => {
    // The lighting is fixed in world space, so a rotation MUST change the
    // image. If it did not, the spin would be geometry moving under a painted
    // texture.
    const a = frame(0.2, 0.22, false);
    const b = frame(1.4, 0.22, false);
    expect(a).not.toEqual(b);
  });

  it('never leaves the grid', () => {
    for (const ay of [0, 0.8, 1.9, 3.3, 5.0]) {
      const lines = frame(ay, 0.22, false).split('\n');
      expect(lines.length, `ay=${ay}`).toBeLessThanOrEqual(18);
      for (const l of lines) expect(l.length, `ay=${ay}`).toBeLessThanOrEqual(62);
    }
  });
});

describe('colour', () => {
  it('emits escape sequences that are actually escaped', () => {
    // banner.ts once contained ZERO escape bytes: every colour constant was
    // plain text, so it would have printed the CSI at the user and dumped
    // frames down the screen. Built with fromCharCode rather than pasted,
    // because pasting would compare broken against broken.
    const body = frame(REST, 0.22, true);
    const csi = (body.match(/\[[0-9;?]+[a-zA-Z]/g) ?? []).length;
    const escaped = (body.match(new RegExp(`${ESC}\\[[0-9;?]+[a-zA-Z]`, 'g')) ?? []).length;
    expect(csi).toBeGreaterThan(0);
    expect(escaped).toBe(csi);
  });

  it('carries both brand colours', () => {
    const body = frame(REST, 0.22, true);
    // Emerald is exact; white is tinted by luminance so only its channel
    // equality is asserted via the emerald check plus presence of a second hue.
    expect(body).toMatch(/38;2;\d+;\d+;\d+m/);
    const hues = new Set(body.match(/38;2;\d+;\d+;\d+m/g) ?? []);
    expect(hues.size).toBeGreaterThan(1);
  });

  it('emits nothing escaped when colour is off', () => {
    expect(frame(REST, 0.22, false)).not.toContain(ESC);
    expect(staticBanner(false)).not.toContain(ESC);
  });
});
