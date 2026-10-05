// Clawd, the Claude Code mascot, holding a steaming mug: the pane's animation.
// Half blocks draw the sprite and braille dots draw the steam, packed as
// RasterProps cells. A frame depends on time and mood alone, so dropped frames
// never put it out of step.

import type { Mood } from "../types";

export const MASCOT_COLUMNS = 28;
export const MASCOT_ROWS = 7;

const WIDTH = MASCOT_COLUMNS;
const HEIGHT = MASCOT_ROWS * 2;
const NONE = -1;
export const TERMINAL_DEFAULT = 0x01000000;
const SPACE = 0x20;
const UPPER_HALF = 0x2580;
const LOWER_HALF = 0x2584;
const BRAILLE = 0x2800;
// Braille dot bits, row by row, left dot first.
const DOTS = [0x01, 0x08, 0x02, 0x10, 0x04, 0x20, 0x40, 0x80];

// Clawd's top-left while standing, in half-block pixels: one column wide, half a row tall.
const X0 = 0;
const Y0 = 4;

const BODY = 0xd77757;
const BODY_LIT = 0xe8916f;
const BODY_SHADE = 0xb75f41;
const BODY_DEEP = 0x9c4f35;
const EYE = 0x1d1512;
const CERAMIC_LIT = 0xfdfaf5;
const COFFEE = 0x452818;
const CREMA = 0x96643f;

type Eyes = "open" | "shut" | "happy";

type Pose = {
  lift: number;
  dip: number;
  eyes: Eyes;
  look: number;
  wave: number;
  sip: number;
};

type Cell = [glyph: number, foreground: number, background: number];
type Rect = [x: number, y: number, w: number, h: number];
type Tones = [
  edge: number,
  lit: number,
  base: number,
  shade: number,
  deep: number,
];

export type Theme = "dark" | "light";

// What sits against the terminal's background. On a light one the mug gets a
// dark outline, and steam darkens where a dark one has it brighten.
type Palette = {
  ceramic: Tones;
  rim: number;
  handle: number;
  steam: [faint: number, dense: number];
  spark: [bright: number, dim: number];
  snore: [bright: number, dim: number];
};
const DARK: Palette = {
  ceramic: [0xeee8de, CERAMIC_LIT, 0xeee8de, 0xd3cabd, 0xb3a99b],
  rim: 0xd6cdbf,
  handle: 0xd9d1c4,
  steam: [0x5d6570, 0xf6efe6],
  spark: [0xffd88a, 0xa77c34],
  snore: [0xa9bccd, 0x4f5965],
};
const LIGHT: Palette = {
  ceramic: [0x9a9084, CERAMIC_LIT, 0xf1ebe1, 0xcfc5b7, 0x8a8074],
  rim: 0x9a9084,
  handle: 0x9a9084,
  steam: [0xd2d6dc, 0x6a7380],
  spark: [0xc0820f, 0xe9d3a0],
  snore: [0x557089, 0xc5ced8],
};
// A steam particle in half-block pixels, and how bright it is from 0 to 1.
type Speck = { x: number; y: number; glow: number };
// The coffee's top-left and the steam's strength: 1 while hot, 0 once cold.
type Source = { x: number; y: number; heat: number };

// The mug's width; its handle hangs off the left, where Clawd grips it.
const MUG_WIDTH = 8;

// Particles from one point on the coffee follow one swaying strand.
const EMITTERS = [
  { offset: 1 + 0.2 * (MUG_WIDTH - 2), phase: 0 },
  { offset: 1 + 0.5 * (MUG_WIDTH - 2), phase: 2.1 },
  { offset: 1 + 0.8 * (MUG_WIDTH - 2), phase: 4.2 },
];
// Seconds between one emitter's particles, and the longest a particle lives.
const SPAWN = 0.11;
const LIFE = 2.3;
const HEART_POINTS = 28;

const SPARKS = [
  { column: 1, row: 1, delay: 0.1 },
  { column: 7, row: 0, delay: 0.5 },
  { column: 13, row: 1, delay: 0.9 },
  { column: 3, row: 0, delay: 1.5 },
  { column: 11, row: 0, delay: 1.9 },
];
const SPARK_GLYPHS = [0xb7, 0x2b, 0x2a, 0x2b, 0xb7];

const hash = (n: number): number => {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
};

const smoothstep = (from: number, to: number, x: number): number => {
  const f = Math.min(1, Math.max(0, (x - from) / (to - from)));
  return f * f * (3 - 2 * f);
};

const mix = (from: number, to: number, f: number): number => {
  const channel = (shift: number) => {
    const a = (from >> shift) & 0xff;
    const b = (to >> shift) & 0xff;
    return Math.round(a + (b - a) * f) << shift;
  };
  return channel(16) | channel(8) | channel(0);
};

const isBlinking = (t: number): boolean => {
  const slot = Math.floor(t / 3.7);
  const at = slot * 3.7 + 0.5 + hash(slot) * 2.6;
  return t >= at && t < at + 0.14;
};

const idleOf = (t: number): Pose => ({
  lift: 0,
  dip: t % 2.8 > 1.6 ? 1 : 0,
  eyes: isBlinking(t) ? "shut" : "open",
  look: 0,
  wave: 0,
  sip: 0,
});

// Every 5.6 s: glance at the mug, raise it, sip with eyes shut, lower it.
const sippingOf = (t: number): Pose => {
  const pose = idleOf(t);
  const p = (t + 5.6 - 1.4) % 5.6;
  if (p >= 1.9) return pose;
  const raise =
    p < 0.65 ? smoothstep(0.35, 0.65, p) : 1 - smoothstep(1.45, 1.75, p);
  return {
    ...pose,
    dip: 0,
    look: p < 0.5 ? 1 : 0,
    eyes: p >= 0.7 && p < 1.45 ? "shut" : pose.eyes,
    sip: Math.round(raise * 3),
  };
};

// One hop in 0.7 s: crouch, rise two pixels, land in a crouch.
const hopOf = (x: number): Pick<Pose, "lift" | "dip"> => {
  if (x < 0.1) return { lift: 0, dip: 1 };
  if (x < 0.17) return { lift: 1, dip: 0 };
  if (x < 0.36) return { lift: 2, dip: 0 };
  if (x < 0.43) return { lift: 1, dip: 0 };
  if (x < 0.55) return { lift: 0, dip: 1 };
  return { lift: 0, dip: 0 };
};

const poseOf = (t: number, mood: Mood, m: number): Pose => {
  if (mood === "warming") return sippingOf(t);
  const pose = idleOf(t);
  if (mood === "cold")
    return {
      ...pose,
      dip: m > 0.5 ? 1 : 0,
      eyes: m > 0.7 ? "shut" : pose.eyes,
    };
  if (m < 1.4) return { ...pose, ...hopOf(m % 0.7), eyes: "happy", wave: 2 };
  return { ...pose, eyes: m < 2.6 ? "happy" : pose.eyes };
};

// The heart takes the place of most of the steam while it floats up.
const heatOf = (mood: Mood, m: number): number => {
  if (mood === "warmed") return 0.15 + 0.85 * smoothstep(2.2, 3.2, m);
  if (mood === "cold") return Math.max(0, 1 - m / 1.8);
  return 1;
};

const fill = (pixels: Int32Array, [x, y, w, h]: Rect, color: number) => {
  for (let row = Math.max(0, y); row < Math.min(HEIGHT, y + h); row++)
    for (let column = Math.max(0, x); column < Math.min(WIDTH, x + w); column++)
      pixels[row * WIDTH + column] = color;
};

const eyeOf = (eyes: Eyes, x: number, top: number, inward: number): Rect[] => {
  if (eyes === "open") return [[x, top + 2, 1, 2]];
  if (eyes === "shut") return [[Math.min(x, x + inward), top + 3, 2, 1]];
  return [
    [x - 1, top + 3, 1, 1],
    [x, top + 2, 1, 1],
    [x + 1, top + 3, 1, 1],
  ];
};

const drawClawd = (pixels: Int32Array, pose: Pose) => {
  const top = Y0 - pose.lift + pose.dip;
  for (const x of [3, 5, 10, 12])
    fill(pixels, [X0 + x, top + 8, 1, 2 - pose.dip], BODY_SHADE);
  fill(pixels, [X0 + 2, top, 12, 8], BODY);
  fill(pixels, [X0 + 2, top, 12, 1], BODY_LIT);
  fill(pixels, [X0 + 2, top, 1, 7], BODY_LIT);
  fill(pixels, [X0 + 3, top + 7, 11, 1], BODY_SHADE);
  fill(pixels, [X0, top + 4 - pose.wave, 2, 2], BODY);
  for (const [x, inward] of [
    [4, 1],
    [11, -1],
  ] as const)
    for (const rect of eyeOf(pose.eyes, X0 + x + pose.look, top, inward))
      fill(pixels, rect, EYE);
};

// The mug's top-left: the back of its rim, one row above the coffee.
const mugOf = (pose: Pose) => ({
  x: X0 + 17,
  y: Y0 - pose.lift + pose.dip + 1 - pose.sip,
});

// Columns shade from a highlight at the left to a shadow at the right, so the
// mug reads as a cylinder; the near lip below the coffee catches the light.
const toneOf = (i: number, [edge, lit, base, shade, deep]: Tones): number => {
  if (i === 0) return edge;
  if (i === 1) return lit;
  if (i === MUG_WIDTH - 2) return shade;
  if (i === MUG_WIDTH - 1) return deep;
  return base;
};
const STRIPE_TONES: Tones = [BODY, BODY_LIT, BODY, BODY_SHADE, BODY_DEEP];

// Drawn after the mug, Clawd's right hand covers the outer side of the handle.
const drawMug = (
  pixels: Int32Array,
  pose: Pose,
  t: number,
  { ceramic, rim, handle }: Palette,
) => {
  const { x, y } = mugOf(pose);
  fill(pixels, [x + 1, y, MUG_WIDTH - 2, 1], rim);
  for (let i = 0; i < MUG_WIDTH; i++) {
    fill(pixels, [x + i, y + 1, 1, 5], toneOf(i, ceramic));
    fill(pixels, [x + i, y + 4, 1, 1], toneOf(i, STRIPE_TONES));
  }
  fill(pixels, [x + 1, y + 1, MUG_WIDTH - 2, 1], COFFEE);
  const glint = Math.floor(t * 0.8) % (MUG_WIDTH - 2);
  fill(pixels, [x + 1 + glint, y + 1, 1, 1], CREMA);
  fill(pixels, [x + 1, y + 2, MUG_WIDTH - 3, 1], CERAMIC_LIT);
  fill(pixels, [x + 1, y + 6, MUG_WIDTH - 2, 1], ceramic[4]);
  fill(pixels, [x - 2, y + 2, 2, 1], handle);
  fill(pixels, [x - 2, y + 3, 1, 2], handle);
  fill(pixels, [x - 2, y + 5, 2, 1], handle);
  const top = Y0 - pose.lift + pose.dip;
  fill(pixels, [X0 + 14, top + 4 - pose.sip, 2, 2], BODY);
};

// Particles leave the coffee at random speeds and ride one sway field, so
// those at one height bend together into strands that widen and fade as they rise.
const steamOf = (t: number, source: Source): Speck[] =>
  EMITTERS.flatMap(({ offset, phase }, e) => {
    const specks: Speck[] = [];
    for (let n = Math.floor((t - LIFE) / SPAWN); n <= t / SPAWN; n++) {
      const seed = (n * EMITTERS.length + e) * 8;
      const life = 1.1 + hash(seed + 1) * (LIFE - 1.1);
      const age = t - (n + 0.7 * hash(seed + 2)) * SPAWN;
      if (hash(seed) >= source.heat || age <= 0 || age >= life) continue;
      const h = (2.6 + 1.6 * hash(seed + 3)) * age * (1 - 0.12 * age);
      const sway =
        (0.2 + 0.17 * h) * Math.sin(0.85 * h - 2.9 * t + phase) +
        0.05 * h * Math.sin(0.37 * h - 1.1 * t + 2.3 * phase);
      const spread = (hash(seed + 4) - 0.5) * (0.2 + 0.3 * h);
      specks.push({
        x: source.x + offset + sway + spread + 0.14 * h,
        y: source.y - h,
        glow: 0.85 * smoothstep(0, 0.25, age) * (1 - age / life),
      });
    }
    return specks;
  });

// A steam heart that floats up from the standing mug after a warm refresh,
// then comes apart.
const heartOf = (m: number): Speck[] => {
  const age = m - 0.3;
  if (age <= 0 || age >= 2.4) return [];
  const scatter = smoothstep(1.4, 2.4, age);
  const glow = 0.9 * smoothstep(0, 0.4, age) * (1 - scatter);
  const cx = X0 + 17 + MUG_WIDTH / 2 + 0.35 * Math.sin(2.2 * age);
  const cy = Y0 + 0.4 - 1.25 * age;
  return Array.from({ length: HEART_POINTS }, (_, k) => {
    const a = (k / HEART_POINTS) * 2 * Math.PI;
    const hx = 16 * Math.sin(a) ** 3;
    const hy =
      13 * Math.cos(a) -
      5 * Math.cos(2 * a) -
      2 * Math.cos(3 * a) -
      Math.cos(4 * a);
    return {
      x: cx + 0.14 * hx + scatter * 2.5 * (hash(k * 2) - 0.5),
      y: cy - 0.125 * hy - scatter * 2 * hash(k * 2 + 1),
      glow,
    };
  });
};

// Braille cells holding steam: dot bits and the brightest particle in each.
const dotsOf = (
  specks: Speck[],
): Map<number, { bits: number; glow: number }> => {
  const cells = new Map<number, { bits: number; glow: number }>();
  for (const { x, y, glow } of specks) {
    const dx = Math.floor(x * 2);
    const dy = Math.floor(y * 2);
    const column = Math.floor(dx / 2);
    const row = Math.floor(dy / 4);
    if (
      glow < 0.06 ||
      column < 0 ||
      column >= WIDTH ||
      row < 0 ||
      row >= MASCOT_ROWS
    )
      continue;
    const index = row * WIDTH + column;
    const cell = cells.get(index) ?? { bits: 0, glow: 0 };
    cell.bits |= DOTS[(dy - row * 4) * 2 + (dx - column * 2)] ?? 0;
    cell.glow = Math.max(cell.glow, glow);
    cells.set(index, cell);
  }
  return cells;
};

const cellOf = (
  pixels: Int32Array,
  column: number,
  row: number,
  steam: { bits: number; glow: number } | undefined,
  [faint, dense]: Palette["steam"],
  background: number,
): Cell => {
  const top = pixels[row * 2 * WIDTH + column] ?? NONE;
  const bottom = pixels[(row * 2 + 1) * WIDTH + column] ?? NONE;
  if (top !== NONE)
    return [UPPER_HALF, top, bottom === NONE ? background : bottom];
  if (bottom !== NONE) return [LOWER_HALF, bottom, background];
  if (!steam) return [SPACE, TERMINAL_DEFAULT, background];
  const tone = mix(faint, dense, Math.sqrt(steam.glow));
  return [BRAILLE + steam.bits, tone, background];
};

// Glyphs drawn over empty cells: sparkles after a warm refresh, and a rising
// "z" once the cache has gone cold.
const glyphsOf = (
  mood: Mood,
  m: number,
  { spark, snore }: Palette,
  background: number,
): [index: number, cell: Cell][] => {
  if (mood === "warmed")
    return SPARKS.flatMap(({ column, row, delay }) => {
      const life = (m - delay) / 0.8;
      if (life < 0 || life >= 1) return [];
      const glyph =
        SPARK_GLYPHS[Math.floor(life * SPARK_GLYPHS.length)] ?? SPACE;
      const tone = mix(...spark, Math.abs(life - 0.5) * 2);
      return [[row * WIDTH + column, [glyph, tone, background]]];
    });
  if (mood !== "cold" || m < 1) return [];
  return [0, 0.9].map((delay) => {
    const life = ((m - 1 + delay) % 1.8) / 1.8;
    const index = (1 - Math.round(life)) * WIDTH + 14 + Math.round(life * 2);
    const glyph = life < 0.5 ? 0x7a : 0x5a;
    return [index, [glyph, mix(...snore, life), background]];
  });
};

const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// Cells are twelve bytes each, so the length is a multiple of three and needs no padding.
const base64Of = (bytes: Uint8Array): string => {
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const n =
      ((bytes[i] ?? 0) << 16) |
      ((bytes[i + 1] ?? 0) << 8) |
      (bytes[i + 2] ?? 0);
    out.push(
      BASE64.charAt((n >> 18) & 63),
      BASE64.charAt((n >> 12) & 63),
      BASE64.charAt((n >> 6) & 63),
      BASE64.charAt(n & 63),
    );
  }
  return out.join("");
};

// `t` counts seconds since the scene started and `m` seconds since the mood
// began; `background` fills the cells around Clawd.
export const cellsOf = (
  t: number,
  mood: Mood,
  m: number,
  theme: Theme,
  background: number,
): string => {
  const palette = theme === "light" ? LIGHT : DARK;
  const pose = poseOf(t, mood, m);
  const pixels = new Int32Array(WIDTH * HEIGHT).fill(NONE);
  drawClawd(pixels, pose);
  drawMug(pixels, pose, t, palette);
  const mug = mugOf(pose);
  const source = { x: mug.x, y: mug.y + 1, heat: heatOf(mood, m) };
  const steam = dotsOf([
    ...steamOf(t, source),
    ...(mood === "warmed" ? heartOf(m) : []),
  ]);
  const words = new Uint32Array(WIDTH * MASCOT_ROWS * 3);
  for (let row = 0; row < MASCOT_ROWS; row++)
    for (let column = 0; column < WIDTH; column++) {
      const index = row * WIDTH + column;
      words.set(
        cellOf(
          pixels,
          column,
          row,
          steam.get(index),
          palette.steam,
          background,
        ),
        index * 3,
      );
    }
  for (const [index, cell] of glyphsOf(mood, m, palette, background)) {
    const current = words[index * 3] ?? SPACE;
    if (current !== UPPER_HALF && current !== LOWER_HALF)
      words.set(cell, index * 3);
  }
  return base64Of(new Uint8Array(words.buffer));
};
