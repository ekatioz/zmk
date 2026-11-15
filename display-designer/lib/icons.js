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

// Weather icons are composed from a few shapes.
function compose(w, h, layers) {
  const g = Array.from({ length: h }, () => new Array(w).fill("."));
  for (const { art, x, y, halo } of layers) {
    if (halo) {
      // clear a one pixel border around the shape so it stands out from what is behind it
      for (let j = 0; j < art.length; j++)
        for (let i = 0; i < art[j].length; i++)
          if (art[j][i] === "#")
            for (let dy = -1; dy <= 1; dy++)
              for (let dx = -1; dx <= 1; dx++) {
                const gx = x + i + dx;
                const gy = y + j + dy;
                if (gx >= 0 && gy >= 0 && gx < w && gy < h) g[gy][gx] = ".";
              }
    }
    for (let j = 0; j < art.length; j++)
      for (let i = 0; i < art[j].length; i++)
        if (art[j][i] === "#") g[y + j][x + i] = "#";
  }
  return g.map((r) => r.join(""));
}

const CLOUD = [
  "....###........",
  "..#######..###.",
  ".#########.####",
  "###############",
  "###############",
  ".#############.",
  "..###########..",
];
const SUN_SMALL = [
  "....#....",
  ".#.....#.",
  "...###...",
  "..#####..",
  "#.#####.#",
  "..#####..",
  "...###...",
  ".#.....#.",
  "....#....",
];

ART.weather_clear = [
  "......#......",
  ".#....#....#.",
  "..#.......#..",
  "....#####....",
  "...#######...",
  "...#######...",
  "##.#######.##",
  "...#######...",
  "...#######...",
  "....#####....",
  "..#.......#..",
  ".#....#....#.",
  "......#......",
];
ART.weather_partly = compose(17, 13, [
  { art: SUN_SMALL, x: 0, y: 0 },
  { art: CLOUD, x: 2, y: 6, halo: true },
]);
ART.weather_cloud = compose(15, 7, [{ art: CLOUD, x: 0, y: 0 }]);
ART.weather_fog = [
  ".##########....",
  "...............",
  "...###########.",
  "...............",
  ".#############.",
  "...............",
  "....#########..",
];
ART.weather_rain = compose(15, 12, [
  { art: CLOUD, x: 0, y: 0 },
  {
    art: [
      ".#...#...#...#.",
      "#...#...#...#..",
      ".#...#...#...#.",
      "#...#...#...#..",
    ],
    x: 0,
    y: 8,
  },
]);
ART.weather_snow = compose(15, 12, [
  { art: CLOUD, x: 0, y: 0 },
  {
    art: [
      ".#...#...#...#.",
      "...............",
      "...#...#...#...",
      "...............",
    ],
    x: 0,
    y: 8,
  },
]);
ART.weather_storm = compose(15, 13, [
  { art: CLOUD, x: 0, y: 0 },
  {
    art: [
      "......###......",
      ".....###.......",
      "....#####......",
      "......##.......",
      ".....##........",
      ".....#.........",
    ],
    x: 0,
    y: 7,
  },
]);

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
