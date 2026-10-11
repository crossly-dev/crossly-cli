#!/usr/bin/env node
/**
 * Watch the banner, on demand.
 *
 * `crossly` with no arguments plays the intro once and then prints the command
 * list, which is the right behaviour and a poor way to judge motion. This runs
 * just the banner.
 *
 *   node scripts/banner-demo.mjs           the intro: spin up, cruise, settle
 *   node scripts/banner-demo.mjs --spin    spins until Ctrl-C
 *   node scripts/banner-demo.mjs --still   one frame, no motion
 *   node scripts/banner-demo.mjs --frames  twelve frames, for pasting
 *
 * Forces the animation on: the TTY and CI suppressions exist to protect other
 * people's pipelines, and somebody who ran this has asked for it.
 */
import { animate, spin, frame, staticBanner } from '../dist/render/banner.js';

const ESC = String.fromCharCode(27);
const args = new Set(process.argv.slice(2));

if (args.has('--still')) {
  process.stdout.write(staticBanner(!process.env.NO_COLOR));
  process.exit(0);
}

if (args.has('--frames')) {
  // Plain frames, no cursor tricks — for a bug report, or for looking at the
  // geometry one step at a time.
  for (let i = 0; i < 12; i += 1) {
    process.stdout.write(`\n--- ${i} ---\n`);
    process.stdout.write(frame(0.55 + (i / 12) * Math.PI * 2, 0.22, false));
    process.stdout.write('\n');
  }
  process.exit(0);
}

// Ctrl-C mid-animation would otherwise leave the cursor hidden for the rest of
// the shell session.
const controller = new AbortController();
let stopping = false;
process.on('SIGINT', () => {
  if (stopping) {
    process.stdout.write(`${ESC}[?25h\n`);
    process.exit(0);
  }
  stopping = true;
  // Let `spin` finish its current frame and run its own cleanup, which leaves
  // the finished mark on screen rather than a half-drawn one.
  controller.abort();
});

if (args.has('--spin') || args.has('--loop')) {
  await spin({ signal: controller.signal });
} else {
  await animate();
}
