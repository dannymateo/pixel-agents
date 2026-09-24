/**
 * Living-office furniture (DOOR, ARCADE, GAME_CONSOLE, BEANBAG) — loaded by
 * the REAL server asset loader from the bundled `webview-ui/public/assets`
 * tree. The PNGs and manifests are produced by
 * `scripts/generate-living-office-assets.mjs`; the last test pins that the
 * files on disk are exactly what the generator draws. How the webview's
 * catalog, editor and seats treat these items is covered on the webview side
 * (`webview-ui/test/livingOfficeAssets.test.ts`).
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import type { FurnitureAsset } from '../../core/src/assets/manifestUtils.js';
import { loadFurnitureAssets } from '../src/assetLoader.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PUBLIC_ROOT = path.join(REPO_ROOT, 'webview-ui', 'public');
const FURNITURE_DIR = path.join(PUBLIC_ROOT, 'assets', 'furniture');
const GENERATOR = path.join(REPO_ROOT, 'scripts', 'generate-living-office-assets.mjs');

let catalog: FurnitureAsset[];
let sprites: Map<string, string[][]>;

function asset(id: string): FurnitureAsset {
  const found = catalog.find((a) => a.id === id);
  expect(found, `asset ${id} missing from the loaded catalog`).toBeDefined();
  return found!;
}

function idsOfGroup(groupId: string): string[] {
  return catalog
    .filter((a) => a.groupId === groupId)
    .map((a) => a.id)
    .sort();
}

beforeAll(async () => {
  const loaded = await loadFurnitureAssets(PUBLIC_ROOT);
  expect(loaded).not.toBeNull();
  catalog = loaded!.catalog;
  sprites = loaded!.sprites;
});

describe('living-office assets — real asset loader', () => {
  it('loads every variant of the four new items, each with a sprite of its declared size', () => {
    const expected: Record<string, string[]> = {
      DOOR: ['DOOR_CLOSED', 'DOOR_OPEN'],
      ARCADE: ['ARCADE_OFF', 'ARCADE_ON_1', 'ARCADE_ON_2'],
      GAME_CONSOLE: ['GAME_CONSOLE_OFF', 'GAME_CONSOLE_ON_1', 'GAME_CONSOLE_ON_2'],
      BEANBAG: ['BEANBAG', 'BEANBAG_BACK'],
    };
    for (const [groupId, ids] of Object.entries(expected)) {
      expect(idsOfGroup(groupId)).toEqual([...ids].sort());
      for (const id of ids) {
        const a = asset(id);
        const sprite = sprites.get(id);
        expect(sprite, `sprite ${id}`).toBeDefined();
        expect(sprite!.length).toBe(a.height);
        expect(sprite!.every((row) => row.length === a.width)).toBe(true);
        expect(a.width).toBe(a.footprintW * 16);
        expect(a.height).toBe(a.footprintH * 16);
        // Not a blank canvas
        expect(sprite!.flat().filter((px) => px !== '').length).toBeGreaterThan(20);
      }
    }
  });

  it('DOOR: 1x2 wall item, closed/open states, front orientation', () => {
    for (const [id, state] of [
      ['DOOR_CLOSED', 'closed'],
      ['DOOR_OPEN', 'open'],
    ] as const) {
      expect(asset(id)).toMatchObject({
        category: 'wall',
        canPlaceOnWalls: true,
        canPlaceOnSurfaces: false,
        footprintW: 1,
        footprintH: 2,
        state,
        orientation: 'front',
      });
    }
    // The door covers the wall's face only: rows 0–7 (the wall's top cap) stay clear
    for (const id of ['DOOR_CLOSED', 'DOOR_OPEN']) {
      const sprite = sprites.get(id)!;
      expect(
        sprite
          .slice(0, 8)
          .flat()
          .every((px) => px === ''),
      ).toBe(true);
      expect(sprite[31].every((px) => px !== '')).toBe(true);
    }
  });

  it('ARCADE: 1x2 electronics with off state and a 2-frame animated on state', () => {
    expect(asset('ARCADE_OFF')).toMatchObject({
      category: 'electronics',
      footprintW: 1,
      footprintH: 2,
      backgroundTiles: 1,
      state: 'off',
      orientation: 'front',
    });
    expect(asset('ARCADE_ON_1')).toMatchObject({ state: 'on', frame: 0 });
    expect(asset('ARCADE_ON_2')).toMatchObject({ state: 'on', frame: 1 });
    expect(asset('ARCADE_ON_1').animationGroup).toBeDefined();
    expect(asset('ARCADE_ON_1').animationGroup).toBe(asset('ARCADE_ON_2').animationGroup);
    // The two frames must actually differ, or the "animation" is a still
    expect(sprites.get('ARCADE_ON_1')).not.toEqual(sprites.get('ARCADE_ON_2'));
    expect(sprites.get('ARCADE_OFF')).not.toEqual(sprites.get('ARCADE_ON_1'));
  });

  it('GAME_CONSOLE: 2x1 electronics (TV + console) with off and animated on states', () => {
    expect(asset('GAME_CONSOLE_OFF')).toMatchObject({
      category: 'electronics',
      footprintW: 2,
      footprintH: 1,
      canPlaceOnWalls: false,
      state: 'off',
      orientation: 'front',
    });
    expect(asset('GAME_CONSOLE_ON_1')).toMatchObject({ state: 'on', frame: 0 });
    expect(asset('GAME_CONSOLE_ON_2')).toMatchObject({ state: 'on', frame: 1 });
    expect(sprites.get('GAME_CONSOLE_ON_1')).not.toEqual(sprites.get('GAME_CONSOLE_ON_2'));
  });

  it('BEANBAG: 1x1 chair, front (bare id) and back orientations, manifest declares restSeat', () => {
    for (const [id, orientation] of [
      ['BEANBAG', 'front'],
      ['BEANBAG_BACK', 'back'],
    ] as const) {
      expect(asset(id)).toMatchObject({
        category: 'chairs',
        footprintW: 1,
        footprintH: 1,
        canPlaceOnWalls: false,
        canPlaceOnSurfaces: false,
        isDesk: false,
        orientation,
      });
    }
    const manifest = JSON.parse(
      fs.readFileSync(path.join(FURNITURE_DIR, 'BEANBAG', 'manifest.json'), 'utf-8'),
    ) as Record<string, unknown>;
    // Declared only: no loader propagates restSeat yet (the living office
    // recognises rest seats by type id today).
    expect(manifest['restSeat']).toBe(true);
  });
});

describe('living-office assets — generator', () => {
  it('the PNGs and manifests on disk are exactly what the generator draws', () => {
    // --check regenerates in memory, compares byte-for-byte, flags stray files
    // in the generated folders and verifies every colour comes from the
    // existing furniture palette; non-zero exit = drift.
    const out = execFileSync(process.execPath, [GENERATOR, '--check'], { encoding: 'utf-8' });
    expect(out).toContain('up to date');
  });
});
