/**
 * CROSSLY, as letterforms.
 *
 * ── WHY NOT JUST PRINT THE WORD ──────────────────────────────────────
 * It was `C R O S S L Y` — capitals with spaces between them. Under a
 * rendered 3D mark that reads as a placeholder somebody forgot to finish: the
 * image above it is doing real work and the word underneath is doing none.
 *
 * A block font costs one small table and puts the two at the same weight.
 *
 * ── THE SPLIT IS THE LOGO'S ──────────────────────────────────────────
 * `CROSS` in white, `LY` in emerald — the mark's two colours carried into the
 * word, so the whole banner is one idea rather than a picture with a caption.
 */

/** 5 rows, 4 columns per glyph. `#` is ink. */
const GLYPHS: Record<string, string[]> = {
  C: ['####', '#   ', '#   ', '#   ', '####'],
  R: ['### ', '#  #', '### ', '# # ', '#  #'],
  O: ['####', '#  #', '#  #', '#  #', '####'],
  S: ['####', '#   ', '####', '   #', '####'],
  L: ['#   ', '#   ', '#   ', '#   ', '####'],
  Y: ['#  #', '#  #', ' ## ', ' #  ', ' #  '],
};

const ROWS = 5;
/** One blank column between letters; two between the two colour groups. */
const TRACKING = 1;

export interface WordmarkColours {
  /** ANSI sequence for the `CROSS` half, or '' for none. */
  primary: string;
  /** ANSI sequence for the `LY` half. */
  accent: string;
  reset: string;
}

/**
 * Render the wordmark.
 *
 * Returns exactly `ROWS` lines so the caller's cursor arithmetic stays
 * predictable — the animation moves the cursor by a computed number of rows,
 * and a wordmark of variable height would silently break that.
 */
export function wordmarkLines(colours?: WordmarkColours, indent = 2): string[] {
  const word = 'CROSSLY';
  // Where the colour changes: CROSS | LY.
  const accentFrom = 5;

  const lines: string[] = [];

  for (let row = 0; row < ROWS; row += 1) {
    let line = ' '.repeat(indent);
    let active = '';

    for (let i = 0; i < word.length; i += 1) {
      const glyph = GLYPHS[word[i]!];
      if (!glyph) continue;

      if (colours) {
        const want = i < accentFrom ? colours.primary : colours.accent;
        if (want !== active) {
          line += want;
          active = want;
        }
      }

      // `#` becomes a solid block; the font table stays readable as ASCII in
      // the source, which is the point of writing it that way.
      line += glyph[row]!.replace(/#/g, '█');
      if (i < word.length - 1) line += ' '.repeat(TRACKING);
    }

    if (colours && active) line += colours.reset;
    lines.push(line.replace(/\s+$/, ''));
  }

  return lines;
}

/** Height in rows, so callers can do cursor arithmetic without guessing. */
export const WORDMARK_ROWS = ROWS;
