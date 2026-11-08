import { describe, expect, it } from 'vitest';
import { coastStyle, fjordData } from './coast-style';
import type { Command } from './commands';
import { fjordLayer } from './fjords';
import type { Mesh } from './mesh';
import { packMesh, unpackMesh } from './mesh-pack';
import { meshFor, seededEngine } from './testing/fixtures';

// 第八十八轮（提速）：冰盖变了（挪纬度、涂冷暖）时海岸类型只重算冰盖强度变了的格，谷网要重建的块里一带的格没变时照用几何、
// 只按新的峡湾权重重算三个预算（core/fjords.ts 的 reweighTile），谷网的点与连线按网格记着（core/fjord-cells.ts）；
// 只涂了冷暖时冰盖只重算涂过的格（core/glacial.ts 的 iceStrengthAt）。这里查：与在新的网格上从头算的（没有缓存）逐值相同，
// 而且真的有块照用了几何

const fresh = (mesh: Mesh) => unpackMesh(structuredClone(packMesh(mesh).packed));

const SMALL = [
  ['一块地区（北纬 40°–78°）', { cells: 6000, seed: 7, latNorth: 78, latSouth: 40 }],
  ['整个星球（2 万格）', { cells: 20000, seed: 7, globe: true, aspect: 2, latNorth: 90, latSouth: -90 }],
] as const;

const DERIVED = ['ice', 'elevation', 'discharge', 'lake'] as const;
const STYLE_KEYS = ['packed', 'fjord', 'barrier', 'ria', 'speck'] as const;
const NET_KEYS = ['pos', 'mid', 'owner', 'recv', 'order', 'len', 'lc', 'lsea', 'lcs', 'hw', 'isMain', 'dirOk', 'rank', 'ring', 'watch', 'wz'] as const;

describe('冰盖变了：海岸类型、谷网与从头算的逐值相同，块的几何照用', () => {
  for (const [label, settings] of SMALL) {
    it(label, () => {
      const mesh = meshFor(settings);
      const e = seededEngine(settings, fresh(mesh));
      e.exec({ op: 'set_worldgen', params: { seed: 7, type: 'continents' }, reset: true });
      const cmds: Command[] = [];
      const w0 = e.world;
      // 冷暖笔刷：冰盖南界附近的一片涂冷（冰盖往南推），再在冰盖以外的一片涂暖（冰盖不变）
      const cold: number[] = [];
      const warm: number[] = [];
      for (let i = 0; i < w0.mesh.n; i++) {
        if (w0.derived.ice[i] > 0 && w0.derived.ice[i] < 4 && i % 3 === 0) cold.push(i);
        if (w0.derived.ice[i] === 0 && i % 7 === 0) warm.push(i);
      }
      expect(cold.length).toBeGreaterThan(20);
      cmds.push({ op: 'paint', field: 'tempOffset', cells: cold, values: cold.map(() => -3), mode: 'add' });
      cmds.push({ op: 'paint', field: 'tempOffset', cells: warm, values: warm.map(() => 2), mode: 'add' });
      // 地区挪纬度、星球改太阳：整片的冰盖都变
      cmds.push(w0.mesh.kind === 'sphere' ? { op: 'set_planet', patch: { solar: 0.97 } } : { op: 'set_planet', patch: { latShift: 3 } });
      // 先在同一个引擎上一步步做完（冰盖的记忆只记最近一个世界：中间不能插进别的世界），记下每一步的结果
      let reused = 0;
      const got: { d: Record<string, number[]>; st: Record<string, number[]>; tex: number[] }[] = [];
      for (const c of cmds) {
        const before = coastStyle(e.world)!;
        const oldPos = new Set(before.net!.tiles.map((t) => t.pos));
        const oldTiles = new Set(before.net!.tiles);
        e.exec(c);
        const w = e.world;
        const st = coastStyle(w)!;
        reused += st.net!.tiles.filter((t) => !oldTiles.has(t) && oldPos.has(t.pos)).length;
        const rec = (o: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, Array.from(o[k] as ArrayLike<number>)]));
        got.push({ d: rec(w.derived as never, DERIVED), st: { ...rec(st as never, STYLE_KEYS), ...rec(st.net! as never, NET_KEYS) }, tex: Array.from(fjordData(w)!.tex) });
      }
      // 同样的命令在新的网格上（按网格的缓存都是空的）从头算
      cmds.forEach((_, k) => {
        const ref = seededEngine(settings, fresh(mesh));
        ref.exec({ op: 'set_worldgen', params: { seed: 7, type: 'continents' }, reset: true });
        for (const d of cmds.slice(0, k + 1)) ref.exec(d);
        const full = coastStyle(ref.world)!;
        for (const key of DERIVED) expect(got[k].d[key], `${k} ${key}`).toEqual(Array.from(ref.world.derived[key]));
        for (const key of STYLE_KEYS) expect(got[k].st[key], `${k} ${key}`).toEqual(Array.from(full[key]));
        for (const key of NET_KEYS) expect(got[k].st[key], `${k} ${key}`).toEqual(Array.from(full.net![key] as ArrayLike<number>));
        expect(got[k].tex).toEqual(Array.from(fjordLayer(full.net!, ref.world.causes.land, ref.world.mesh.n).tex));
      });
      expect(reused).toBeGreaterThan(0);
    });
  }
});
