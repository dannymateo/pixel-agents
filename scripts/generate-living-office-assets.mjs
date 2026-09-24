#!/usr/bin/env node
/**
 * Generates the "living office" furniture — DOOR, ARCADE, GAME_CONSOLE and
 * BEANBAG — into webview-ui/public/assets/furniture/<ID>/ (PNG + manifest.json).
 *
 * Every sprite is a readable pixel matrix below: one character per pixel,
 * '.' = transparent, any other character = a PALETTE entry. Edit a matrix,
 * run the script, review the PNG. Nothing here is drawn by hand elsewhere.
 *
 * The palette is not invented: each colour is taken from an existing bundled
 * furniture PNG (source noted next to it), and the script refuses to write if
 * a colour does not appear in at least one of them — so new items can only
 * use the set's own wood, metal, fabric, screen and shadow tones.
 *
 * Usage:
 *   node scripts/generate-living-office-assets.mjs           # (re)write the files
 *   node scripts/generate-living-office-assets.mjs --check   # exit 1 if disk differs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PNG } from 'pngjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FURNITURE_DIR = path.join(ROOT, 'webview-ui', 'public', 'assets', 'furniture');
const TILE = 16;

// ── Palette (hex from existing furniture PNGs) ──────────────────────────────
// A sprite palette is pixel data, not UI styling: the webview colour rule
// (colours only in constants.ts) does not apply here.
/* eslint-disable pixel-agents/no-inline-colors */
const PALETTE = {
  // Wood — DESK / BOOKSHELF / WOODEN_CHAIR
  woodDark: '#532e3d', // DESK front edge, WOODEN_CHAIR outline
  woodMid: '#885c47', // DESK outline
  wood: '#b38857', // DESK top
  woodLight: '#cfa86d', // DESK top highlight
  woodDeep: '#301c1c', // BOOKSHELF shelf outline
  // Metal / plastic — PC / BIN / COFFEE
  ink: '#3f3740', // PC outline
  steelDark: '#595e60', // PC bezel shade
  steel: '#757b7c', // PC / BIN outline
  steelLight: '#b5bfc7', // PC body
  steelPale: '#e1e3e9', // PC top face
  white: '#ffffff', // PC highlight
  screenOff: '#391624', // PC_FRONT_OFF screen
  glare: '#535568', // PC_FRONT_OFF glare
  // Screen content — PC_FRONT_ON / BOOKSHELF spines / CLOCK
  green: '#60c677', // PC screen text
  greenMid: '#63a159', // BOOKSHELF spine
  navy: '#232941', // SMALL_PAINTING_2
  night: '#131524', // SMALL_PAINTING_2
  sky: '#658eb1', // BOOKSHELF spine
  skyDark: '#40668d', // SMALL_PAINTING_2
  skyPale: '#afc1d9', // SMALL_PAINTING_2
  red: '#eb4c3f', // CLOCK face
  redDark: '#8c323a', // CLOCK rim
  gold: '#e3c66a', // LARGE_PAINTING
  goldDim: '#8b7336', // DOUBLE_BOOKSHELF spine
  cream: '#fff0c7', // LARGE_PAINTING highlight
  // Fabric — SOFA
  fabricDark: '#420517', // SOFA outline
  fabric: '#972651', // SOFA body
  fabricLight: '#c25769', // SOFA cushion top
  fabricPale: '#e2c2c9', // DOUBLE_BOOKSHELF pink (fabric sheen)
  // Doorway interior — SMALL_PAINTING dark tones
  voidDeep: '#1e0a20',
  void: '#2c192d',
  voidLight: '#37222e',
  // Floor shadow — DESK / chairs
  shadow: '#00000033',
};
/* eslint-enable pixel-agents/no-inline-colors */

// ── Sprites ─────────────────────────────────────────────────────────────────
// Each sprite: legend (char → PALETTE key) + rows. Sprites are front-facing,
// seen from the same 3/4 top-down angle as the rest of the set: a sliver of
// top surface, the front face below it, a one-row floor shadow under objects
// that stand on the floor.

// DOOR — hangs on a wall: the 16×32 sprite covers the wall's face (rows 8–31
// of a wall piece; rows 0–7 are the wall's top cap and stay transparent).
const DOOR_LEGEND = {
  D: 'woodDark',
  A: 'woodMid',
  B: 'wood',
  l: 'woodLight',
  K: 'gold',
  o: 'void',
  O: 'voidDeep',
  q: 'voidLight',
};
const DOOR_TOP = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  'DDDDDDDDDDDDDDDD',
  'DllllllllllllllD',
  'DADDDDDDDDDDDDAD',
];
const DOOR_CLOSED = [
  ...DOOR_TOP,
  'DADBBBBBBBBBBDAD',
  'DADBAAAAAAAABDAD',
  'DADBABBBBBBlBDAD',
  'DADBABBBBBBlBDAD',
  'DADBABBBBBBlBDAD',
  'DADBABBBBBBlBDAD',
  'DADBABBBBBBlBDAD',
  'DADBllllllllBDAD',
  'DADBBBBBBBBBBDAD',
  'DADBBBBBBBBKBDAD',
  'DADBBBBBBBBABDAD',
  'DADBAAAAAAAABDAD',
  'DADBABBBBBBlBDAD',
  'DADBABBBBBBlBDAD',
  'DADBABBBBBBlBDAD',
  'DADBABBBBBBlBDAD',
  'DADBABBBBBBlBDAD',
  'DADBllllllllBDAD',
  'DADBBBBBBBBBBDAD',
  'DADBBBBBBBBBBDAD',
  'DADDDDDDDDDDDDAD',
];
// Open: the leaf has swung inward and shows as a narrow strip on the hinge
// side; the rest of the frame is the dark room beyond.
const DOOR_OPEN = [
  ...DOOR_TOP,
  'DADBADOOOOOOODAD',
  'DADBADOOOOOOODAD',
  'DADBADooooooODAD',
  'DADBADoooooooDAD',
  'DADBADoooooooDAD',
  'DADBADoooooooDAD',
  'DADBADoooooooDAD',
  'DADBADoooooooDAD',
  'DADBADoooooooDAD',
  'DADKADoooooooDAD',
  'DADAADoooooooDAD',
  'DADBADoooooooDAD',
  'DADBADoooooooDAD',
  'DADBADoooooooDAD',
  'DADBADoooooooDAD',
  'DADBADqqqqqqqDAD',
  'DADBADqqqqqqqDAD',
  'DADBADqqqqqqqDAD',
  'DADBADqqqqqqqDAD',
  'DADBADqqqqqqqDAD',
  'DADDDDDDDDDDDDAD',
];

// ARCADE — standing cabinet, 16×32, footprint 1×2 with a background top row
// (like PLANT / CACTUS) so it can back onto a wall.
const ARCADE_LEGEND = {
  O: 'navy',
  T: 'skyPale',
  B: 'sky',
  d: 'skyDark',
  M: 'goldDim', // marquee, unlit
  S: 'screenOff',
  G: 'glare',
  P: 'steelLight',
  p: 'steelPale',
  s: 'ink',
  r: 'red',
  b: 'green',
  c: 'redDark', // coin slot, unlit
  x: 'shadow',
};
const arcade = (marquee, screen, coin) => [
  '................',
  '.OOOOOOOOOOOOOO.',
  '.OTTTTTTTTTTTTO.',
  marquee[0],
  marquee[1],
  marquee[2],
  '.OBBBBBBBBBBBdO.',
  '.OBOOOOOOOOOOdO.',
  ...screen.map((row) => `.OBO${row}OdO.`),
  '.OBOOOOOOOOOOdO.',
  '.OBBBBBBBBBBBdO.',
  'OOOOOOOOOOOOOOOO',
  'OppppppppppppppO',
  'OPrPPPPPPPrPbPPO',
  'OPsPPPPPPPPPPPPO',
  'OddddddddddddddO',
  'OOOOOOOOOOOOOOOO',
  '.OBBBBBBBBBBBdO.',
  '.OBBBBBBBBBBBdO.',
  '.OBBBOOOOOOBBdO.',
  `.OBBBO${coin}OO${coin}OBBdO.`,
  '.OBBBOOOOOOBBdO.',
  '.OBBBBBBBBBBBdO.',
  '.OBBBBBBBBBBBdO.',
  '.OddddddddddddO.',
  '.OOOOOOOOOOOOOO.',
  '.xxxxxxxxxxxxxx.',
];
const ARCADE_MARQUEE_OFF = ['.OMMMMMMMMMMMMO.', '.OMMMMMMMMMMMMO.', '.OMMMMMMMMMMMMO.'];
const ARCADE_MARQUEE_ON = ['.OKKKKKKKKKKKKO.', '.OKwKwwKwKKwwKO.', '.OKKKKKKKKKKKKO.'];
const ARCADE_SCREEN_OFF = ['SSSSSSSS', 'SSSSGSSS', 'SSSGSSSS', 'SSGSSSSS', 'SSSSSSSS', 'SSSSSSSS'];
// Screen 8×6: stars, an invader, the player ship — frame 2 moves them and
// fires a shot.
const ARCADE_SCREEN_ON_1 = ['kkkkkkkk', 'kykkkkyk', 'kkkrrkkk', 'kkkkkkkk', 'kkkkgkkk', 'kkkgggkk'];
const ARCADE_SCREEN_ON_2 = ['kkykkkky', 'kkkkkkkk', 'kkkkrrkk', 'kkkkwkkk', 'kkkkgkkk', 'kkkgggkk'];
const ARCADE_ON_LEGEND = {
  ...ARCADE_LEGEND,
  K: 'gold',
  w: 'cream',
  k: 'night',
  y: 'gold',
  g: 'green',
  c: 'red', // coin slot lit
};

// GAME_CONSOLE — TV on a low wooden cabinet with the console and a pad on top,
// 32×16, footprint 2×1.
const CONSOLE_LEGEND = {
  E: 'ink',
  N: 'steelDark',
  S: 'screenOff',
  G: 'glare',
  A: 'woodMid',
  B: 'wood',
  l: 'woodLight',
  D: 'woodDark',
  C: 'steelPale',
  b: 'steelLight',
  L: 'redDark', // standby LED
  h: 'red',
  g: 'greenMid',
  x: 'shadow',
};
const gameConsole = (screen, led) => [
  '.......EEEEEEEEEEEEEEEEEE.......',
  '.......ENNNNNNNNNNNNNNNNE.......',
  ...screen.map((row) => `.......EN${row}NE.......`),
  '.......ENNNNNNNNNNNNNNNNE.......',
  '.......EEEEEEEEEEEEEEEEEE.......',
  '..AAAAAAAAAAAAAEEAAAAECCCCCEAA..',
  `..AllllEhEgElllllllllEbb${led}bbElA..`,
  '..DBBBBBBBBBBlBDDBlBBBBBBBBBBD..',
  '..DDDDDDDDDDDDDDDDDDDDDDDDDDDD..',
  '...xxxxxxxxxxxxxxxxxxxxxxxxxx...',
];
const CONSOLE_SCREEN_OFF = [
  'SSSSSSSSSSSSSS',
  'SSSSGSSSSSSSSS',
  'SSSGSSSSSSSSSS',
  'SSGSSSSSSSSSSS',
  'SSSSSSSSSSSSSS',
  'SSSSSSSSSSSSSS',
  'SSSSSSSSSSSSSS',
];
// Screen 14×7: a platformer — sky, a cloud, a coin, the hero on the ground by
// a block; frame 2 has the hero jump toward the coin while the cloud drifts.
const CONSOLE_SCREEN_ON_1 = [
  'kkkkkkwwwkkkkk',
  'kkkkkkkkkkkykk',
  'kkkkkkkkkkkkkk',
  'kkkkkkkkkkkkkk',
  'kkhkkkkkkkttkk',
  'kkhkkkkkkkttkk',
  'gggggggggggggg',
];
const CONSOLE_SCREEN_ON_2 = [
  'kkkkkkkwwwkkkk',
  'kkkkkkkkkkkykk',
  'kkkkhkkkkkkkkk',
  'kkkkhkkkkkkkkk',
  'kkkkkkkkkkttkk',
  'kkkkkkkkkkttkk',
  'gggggggggggggg',
];
const CONSOLE_ON_LEGEND = {
  ...CONSOLE_LEGEND,
  k: 'sky',
  w: 'white',
  y: 'gold',
  t: 'goldDim',
  L: 'green', // LED on
};

// BEANBAG — a slouched fabric sack in the SOFA's upholstery, 16×16, 1×1.
// The darker dip in the top is where the character sits; the sack bulges to
// the full tile width so its sides still show around a seated character
// (a seated character is drawn in front of every non-back chair).
const BEANBAG_LEGEND = {
  V: 'fabricDark',
  T: 'fabric',
  U: 'fabricLight',
  W: 'fabricPale',
  x: 'shadow',
};
const BEANBAG_FRONT = [
  '................',
  '................',
  '.....VVVVVV.....',
  '...VVUUUUUUVV...',
  '..VUUWWUUUUUUV..',
  '.VUUWUUUUUUUUUV.',
  '.VUUUUTTTTUUUUV.',
  'VUUUTTTTTTTTUUUV',
  'VTUUUTTTTTTUUUTV',
  'VTUUUUUUUUUUUUTV',
  'VTTUUUUUUUUUUTTV',
  'VTTTUUUUUUUUTTTV',
  'VVTTTTTTTTTTTTVV',
  '.VVVTTTTTTTTVVV.',
  '.xxVVVVVVVVVVxx.',
  '..xxxxxxxxxxxx..',
];
// Back view (the sitter faces UP, away from the viewer). A back-facing chair
// is drawn IN FRONT of its sitter, so this is kept low — just the sack's rear
// bulge — and the character's head and shoulders stay visible above it.
const BEANBAG_BACK = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '....VVVVVVVV....',
  '..VVUUUUUUUUVV..',
  '.VUUUUUUUUUUUUV.',
  'VUUUUUUUUUUUUUUV',
  'VTUUUUUUUUUUUUTV',
  'VTTUUUUUUUUUUTTV',
  'VTTTUUUUUUUUTTTV',
  'VVTTTTTTTTTTTTVV',
  '.VVVTTTTTTTTVVV.',
  '.xxVVVVVVVVVVxx.',
];

// ── Items (files + manifests) ───────────────────────────────────────────────
const asset = (id, w, h, extra = {}) => ({
  type: 'asset',
  id,
  file: `${id}.png`,
  width: w,
  height: h,
  footprintW: w / TILE,
  footprintH: h / TILE,
  ...extra,
});

const ITEMS = [
  {
    manifest: {
      id: 'DOOR',
      name: 'Door',
      category: 'wall',
      type: 'group',
      groupType: 'state',
      canPlaceOnWalls: true,
      canPlaceOnSurfaces: false,
      backgroundTiles: 0,
      members: [
        asset('DOOR_CLOSED', 16, 32, { orientation: 'front', state: 'closed' }),
        asset('DOOR_OPEN', 16, 32, { orientation: 'front', state: 'open' }),
      ],
    },
    sprites: {
      DOOR_CLOSED: [DOOR_LEGEND, DOOR_CLOSED],
      DOOR_OPEN: [DOOR_LEGEND, DOOR_OPEN],
    },
  },
  {
    manifest: {
      id: 'ARCADE',
      name: 'Arcade',
      category: 'electronics',
      type: 'group',
      groupType: 'state',
      canPlaceOnWalls: false,
      canPlaceOnSurfaces: false,
      backgroundTiles: 1,
      members: [
        {
          type: 'group',
          groupType: 'animation',
          orientation: 'front',
          state: 'on',
          members: [
            asset('ARCADE_ON_1', 16, 32, { orientation: 'front', frame: 0 }),
            asset('ARCADE_ON_2', 16, 32, { orientation: 'front', frame: 1 }),
          ],
        },
        asset('ARCADE_OFF', 16, 32, { orientation: 'front', state: 'off' }),
      ],
    },
    sprites: {
      ARCADE_OFF: [ARCADE_LEGEND, arcade(ARCADE_MARQUEE_OFF, ARCADE_SCREEN_OFF, 'c')],
      ARCADE_ON_1: [ARCADE_ON_LEGEND, arcade(ARCADE_MARQUEE_ON, ARCADE_SCREEN_ON_1, 'c')],
      ARCADE_ON_2: [ARCADE_ON_LEGEND, arcade(ARCADE_MARQUEE_ON, ARCADE_SCREEN_ON_2, 'c')],
    },
  },
  {
    manifest: {
      id: 'GAME_CONSOLE',
      name: 'Game Console',
      category: 'electronics',
      type: 'group',
      groupType: 'state',
      canPlaceOnWalls: false,
      canPlaceOnSurfaces: false,
      backgroundTiles: 0,
      members: [
        {
          type: 'group',
          groupType: 'animation',
          orientation: 'front',
          state: 'on',
          members: [
            asset('GAME_CONSOLE_ON_1', 32, 16, { orientation: 'front', frame: 0 }),
            asset('GAME_CONSOLE_ON_2', 32, 16, { orientation: 'front', frame: 1 }),
          ],
        },
        asset('GAME_CONSOLE_OFF', 32, 16, { orientation: 'front', state: 'off' }),
      ],
    },
    sprites: {
      GAME_CONSOLE_OFF: [CONSOLE_LEGEND, gameConsole(CONSOLE_SCREEN_OFF, 'L')],
      GAME_CONSOLE_ON_1: [CONSOLE_ON_LEGEND, gameConsole(CONSOLE_SCREEN_ON_1, 'L')],
      GAME_CONSOLE_ON_2: [CONSOLE_ON_LEGEND, gameConsole(CONSOLE_SCREEN_ON_2, 'L')],
    },
  },
  {
    manifest: {
      id: 'BEANBAG',
      name: 'Beanbag',
      category: 'chairs',
      type: 'group',
      groupType: 'rotation',
      canPlaceOnWalls: false,
      canPlaceOnSurfaces: false,
      backgroundTiles: 0,
      // Rest seat: a lounge seat, never assigned as a work desk. Optional;
      // readers that don't know it treat the beanbag as an ordinary chair.
      restSeat: true,
      members: [
        // The front variant keeps the bare id BEANBAG (the living-office
        // composition places it by that id).
        asset('BEANBAG', 16, 16, { orientation: 'front' }),
        asset('BEANBAG_BACK', 16, 16, { orientation: 'back' }),
      ],
    },
    sprites: {
      BEANBAG: [BEANBAG_LEGEND, BEANBAG_FRONT],
      BEANBAG_BACK: [BEANBAG_LEGEND, BEANBAG_BACK],
    },
  },
];

// ── Rendering ───────────────────────────────────────────────────────────────
function parseHex(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
    h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255,
  ];
}

function renderPng(id, legend, rows, width, height) {
  if (rows.length !== height) {
    throw new Error(`${id}: ${rows.length} rows, expected ${height}`);
  }
  const png = new PNG({ width, height });
  rows.forEach((row, y) => {
    if (row.length !== width) {
      throw new Error(`${id}: row ${y} is ${row.length} px wide, expected ${width}: "${row}"`);
    }
    for (let x = 0; x < width; x++) {
      const ch = row[x];
      const i = (y * width + x) * 4;
      if (ch === '.') {
        png.data[i] = png.data[i + 1] = png.data[i + 2] = png.data[i + 3] = 0;
        continue;
      }
      const key = legend[ch];
      if (!key || !PALETTE[key]) {
        throw new Error(`${id}: row ${y} col ${x} uses '${ch}', which is not in its legend`);
      }
      const [r, g, b, a] = parseHex(PALETTE[key]);
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = a;
    }
  });
  return PNG.sync.write(png, { colorType: 6 });
}

/** Every RGBA colour used by the bundled furniture, excluding the items generated here. */
function existingFurnitureColours() {
  const ours = new Set(ITEMS.map((item) => item.manifest.id));
  const colours = new Set();
  for (const dir of fs.readdirSync(FURNITURE_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory() || ours.has(dir.name)) continue;
    for (const file of fs.readdirSync(path.join(FURNITURE_DIR, dir.name))) {
      if (!file.endsWith('.png')) continue;
      const png = PNG.sync.read(fs.readFileSync(path.join(FURNITURE_DIR, dir.name, file)));
      for (let i = 0; i < png.data.length; i += 4) {
        if (png.data[i + 3] === 0) continue;
        colours.add(Array.from(png.data.subarray(i, i + 4)).join(','));
      }
    }
  }
  return colours;
}

function checkPalette() {
  const existing = existingFurnitureColours();
  const foreign = Object.entries(PALETTE).filter(
    ([, hex]) => !existing.has(parseHex(hex).join(',')),
  );
  if (foreign.length > 0) {
    throw new Error(
      `Colours not found in any existing furniture PNG: ${foreign
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')}`,
    );
  }
}

/** Every file this script owns, as [absolute path, Buffer]. */
function buildOutputs() {
  const outputs = [];
  for (const item of ITEMS) {
    const dir = path.join(FURNITURE_DIR, item.manifest.id);
    const declared = new Map();
    const collect = (node) => {
      if (node.type === 'asset' && node !== item.manifest) declared.set(node.id, node);
      for (const m of node.members ?? []) collect(m);
    };
    collect(item.manifest);
    if (item.manifest.type === 'asset') declared.set(item.manifest.id, item.manifest);

    for (const [id, [legend, rows]] of Object.entries(item.sprites)) {
      const spec = declared.get(id);
      if (!spec) throw new Error(`${id}: sprite has no manifest entry`);
      outputs.push([
        path.join(dir, spec.file ?? `${id}.png`),
        renderPng(id, legend, rows, spec.width, spec.height),
      ]);
    }
    for (const id of declared.keys()) {
      if (!item.sprites[id]) throw new Error(`${id}: manifest entry has no sprite`);
    }
    outputs.push([
      path.join(dir, 'manifest.json'),
      Buffer.from(JSON.stringify(item.manifest, null, 2), 'utf-8'),
    ]);
  }
  return outputs;
}

function main() {
  const check = process.argv.includes('--check');
  checkPalette();
  const outputs = buildOutputs();

  // Files in the generator-owned folders that the generator no longer
  // produces (e.g. a renamed sprite) — the loader would ignore them silently.
  const expected = new Set(outputs.map(([file]) => path.resolve(file)));
  const strays = ITEMS.flatMap((item) => {
    const dir = path.join(FURNITURE_DIR, item.manifest.id);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .map((name) => path.resolve(dir, name))
      .filter((file) => !expected.has(file));
  });

  if (check) {
    const stale = outputs
      .filter(([file, buf]) => !fs.existsSync(file) || !fs.readFileSync(file).equals(buf))
      .map(([file]) => file)
      .concat(strays);
    if (stale.length > 0) {
      console.error(
        `Living-office assets are out of date (run node scripts/generate-living-office-assets.mjs):\n${stale
          .map((file) => `  ${path.relative(ROOT, file)}`)
          .join('\n')}`,
      );
      process.exit(1);
    }
    console.log(`Living-office assets up to date (${outputs.length} files).`);
    return;
  }

  for (const file of strays) {
    fs.rmSync(file);
    console.log(`removed ${path.relative(ROOT, file)}`);
  }
  for (const [file, buf] of outputs) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    console.log(`wrote ${path.relative(ROOT, file)}`);
  }
}

main();
