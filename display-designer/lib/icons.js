// 1-bit icons as ASCII art ('#' = pixel set). Single source of truth: the renderer uses them
// directly and codegen packs them into the C asset table (see codegen.js).

const ART = {
  bluetooth: [
    "....#....",
    "....##...",
    "....#.#..",
    ".#..#..#.",
    "..#.#.#..",
    "...###...",
    "....#....",
    "...###...",
    "..#.#.#..",
    ".#..#..#.",
    "....#.#..",
    "....##...",
    "....#....",
  ],
  usb: [
    ".....#.....",
    "....###....",
    ".....#.....",
    "..#..#.....",
    ".###.#..###",
    "..#..#..###",
    "..#..#..###",
    "..##.#.##..",
    "...#.##.#..",
    "....###....",
    ".....#.....",
    "....###....",
    "....###....",
  ],
  sunrise: [
    "...#....",
    "..###...",
    ".#.#.#..",
    "...#....",
    "........",
    "..####..",
    ".######.",
    "########",
  ],
  sunset: [
    "...#....",
    ".#.#.#..",
    "..###...",
    "...#....",
    "........",
    "..####..",
    ".######.",
    "########",
  ],
  bolt: [
    "...##",
    "..##.",
    ".##..",
    "#####",
    "..##.",
    ".##..",
    ".#...",
    "#....",
    "#....",
  ],
};

export const ICON_NAMES = Object.keys(ART);

export function packRows(rows) {
  const w = rows[0].length;
  const h = rows.length;
  const stride = (w + 7) >> 3;
  const bits = new Array(stride * h).fill(0);
  rows.forEach((row, y) => {
    if (row.length !== w) throw new Error("ragged bitmap row");
    for (let x = 0; x < w; x++) {
      if (row[x] === "#") bits[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  });
  return { w, h, bits };
}

export const ICONS = Object.fromEntries(
  ICON_NAMES.map((n) => [n, packRows(ART[n])]),
);
