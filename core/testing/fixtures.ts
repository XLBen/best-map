import { Engine } from '../engine';
import type { Mesh } from '../mesh';
import { type Settings, buildMeshFor, meshKey, settingsSchema } from '../world';

// 测试共用的世界：网格按设置缓存；建好的世界按名字留一份模板，每次给出它的副本（Engine.clone），
// 不必每个测试都从头生成一遍。副本与重新生成的世界逐值相同（推导只取决于原因）

const meshes = new Map<string, Mesh>();

export function meshFor(raw: Partial<Settings>): Mesh {
  const s = settingsSchema.parse(raw);
  const key = meshKey(s);
  let m = meshes.get(key);
  if (!m) meshes.set(key, (m = buildMeshFor(s)));
  return m;
}

export function engineFor(settings: Partial<Settings>): Engine {
  return new Engine(settings, meshFor(settings));
}

const templates = new Map<string, Engine>();

export function snapshot(key: string, build: () => Engine): Engine {
  let t = templates.get(key);
  if (!t) templates.set(key, (t = build()));
  return t.clone();
}

// 几个测试文件共用的大陆世界：1.2 万格、北纬 20°–72°、陆地 40%；provinces：再划好省份
export function continents(opts: { cells?: number; latNorth?: number; latSouth?: number; provinces?: boolean } = {}): Engine {
  const { cells = 12000, latNorth = 72, latSouth = 20, provinces = false } = opts;
  return snapshot(`continents:${cells}:${latNorth}:${latSouth}:${provinces}`, () => {
    const eng = engineFor({ cells, seed: 1, latNorth, latSouth });
    eng.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continents', landFraction: 0.4 }, reset: true });
    if (provinces) eng.exec({ op: 'generate_provinces', rules: { seed: 5 } });
    return eng;
  });
}
