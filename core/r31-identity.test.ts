import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { coastalStroke, digest, digestWorld } from '../tools/hash';
import * as Climate from './climate';
import type { Command } from './commands';
import type { Engine } from './engine';
import { seededEngine } from './testing/fixtures';

// 第三十一轮的提速（气候：地区的分层缓存、边的方向与梯度的几何按网格缓存、输运图少扫几遍；水文：面积按网格缓存、
// 放的湖的标记表；高程记忆的快路）与以前的代码逐值相同：一组加工（各种会碰到这些缓存的键的改动）每一步之后整个世界的哈希，
// 与 r31-digests.json 里第三十一轮之前的代码（1421485）记下的相同。分层缓存关掉（每次现算）时也相同。
// 重新记录（只在旧的代码上做）：R31_RECORD=1 npx vitest run core/r31-identity.test.ts。
// 第三十二轮地形变了（大格局），用第三十二轮的代码重录过一次：之后的提速与第三十二轮逐值相同

const FILE = new URL('./r31-digests.json', import.meta.url);
const record = !!process.env.R31_RECORD;
const saved: Record<string, string[]> = record ? {} : JSON.parse(readFileSync(FILE, 'utf8'));

const SETTINGS = {
  region: { cells: 6000, seed: 8 },
  planet: { cells: 6000, seed: 8, globe: true, aspect: 2, latNorth: 90, latSouth: -90, radiusKm: 6371 },
} as const;

function scenario(kind: keyof typeof SETTINGS): string[] {
  const eng = seededEngine(SETTINGS[kind]);
  // 撤销也重算（不用撤销缓存），记忆、分层缓存才用得上
  eng.undoCache = 0;
  const out: string[] = [];
  const step = (f: (e: Engine) => void) => {
    f(eng);
    out.push(digest(digestWorld(eng.world)));
  };
  const run = (cmd: Command) => step((e) => e.exec(cmd));
  run({ op: 'set_worldgen', params: { seed: 8, type: 'continents' }, reset: true });
  const w = eng.world;
  const land = () => [...Array(w.mesh.n).keys()].filter((i) => w.causes.land[i]);
  const near = (c: number, r: number) => [...Array(w.mesh.n).keys()].filter((i) => Math.hypot(w.mesh.x[i] - w.mesh.x[c], w.mesh.y[i] - w.mesh.y[c]) < w.mesh.spacing * r);
  const L = land();
  const hill = near(L[Math.floor(L.length * 0.35)], 4);
  run({ op: 'paint_relief', cells: hill, t: hill.map(() => 0), strength: 0.7 });
  const soft = near(L[Math.floor(L.length * 0.6)], 4);
  run({ op: 'paint', field: 'erodDelta', cells: soft, value: 0.5, mode: 'add' });
  run({ op: 'paint', field: 'tempOffset', cells: soft, value: -2, mode: 'add' });
  const coast = coastalStroke(w, 0.3, 5);
  run({ op: 'paint_land', cells: coast, t: coast.map(() => 0), mode: 'land' });
  const cut = coastalStroke(w, 0.7, 4);
  run({ op: 'paint_land', cells: cut, t: cut.map(() => 0), mode: 'sea' });
  let sea = 0;
  for (let i = Math.floor(w.mesh.n * 0.45); i < w.mesh.n; i++) if (!w.causes.land[i] && Math.abs(w.mesh.y[i] - 0.5) < 0.3) {
    sea = i;
    break;
  }
  run({ op: 'add_island', island: { x: w.mesh.x[sea], y: w.mesh.y[sea], kind: 'continental', size: 250, variant: 0 } });
  const lc = land()[400];
  run({ op: 'add_lake', lake: { cell: lc, radius: 150, depth: 100 } });
  // 一条从内陆往下走的河
  const src = land()[900];
  const path = [src];
  for (let k = 0; k < 8; k++) {
    const c = path[path.length - 1];
    let best = -1;
    for (let e = w.mesh.off[c]; e < w.mesh.off[c + 1]; e++) {
      const j = w.mesh.adj[e];
      if (w.causes.land[j] && !path.includes(j) && (best < 0 || w.mesh.x[j] > w.mesh.x[best])) best = j;
    }
    if (best < 0) break;
    path.push(best);
  }
  if (path.length >= 2) run({ op: 'add_guide', guide: { cells: path, locked: true, spring: true, flow: 3, name: '' } });
  run({ op: 'set_planet', patch: { humidity: 1.3 } });
  if (kind === 'region') run({ op: 'set_planet', patch: { latShift: 6 } });
  else run({ op: 'set_planet', patch: { currents: 0 } });
  run({ op: 'set_planet', patch: { tilt: 30 } });
  run({ op: 'set_planet', patch: { solar: 1.1 } });
  run({ op: 'set_planet', patch: { rotation: -1 } });
  run({ op: 'set_planet', patch: { terrainWind: 0 } });
  run({ op: 'paint_relief', cells: hill, t: hill.map(() => 0.3), strength: -0.5 });
  step((e) => e.undo());
  step((e) => e.undo());
  step((e) => e.undo());
  step((e) => e.redo());
  const c = L[Math.floor(L.length * 0.5)];
  run({ op: 'reroll_region', x: w.mesh.x[c], y: w.mesh.y[c], radius: 0.1, variant: 1 });
  run({ op: 'set_worldgen', params: { ...w.small.terrain.gen!, landFraction: 0.45 } });
  return out;
}

describe('第三十一轮的提速与以前逐值相同', () => {
  for (const kind of ['region', 'planet'] as const) {
    it(kind === 'region' ? '一块地区' : '整个星球', () => {
      const got = scenario(kind);
      if (record) {
        const all = JSON.parse(readFileSync(FILE, 'utf8').toString() || '{}') as Record<string, string[]>;
        all[kind] = got;
        writeFileSync(FILE, `${JSON.stringify(all, null, 1)}\n`);
        return;
      }
      expect(got).toEqual(saved[kind]);
      // 地区的分层缓存关掉（每次现算）：同样
      const layers = (Climate as unknown as { planeLayers?: { on: boolean } }).planeLayers;
      if (layers && kind === 'region') {
        layers.on = false;
        try {
          expect(scenario(kind)).toEqual(saved[kind]);
        } finally {
          layers.on = true;
        }
      }
    }, 120000);
  }
});
