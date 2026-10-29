import { describe, expect, it } from 'vitest';

import { continents, engineFor, snapshot, type HumanCommand, humanExec } from '../testing/fixtures';
import type { World } from '../world';
import { countryList } from './countries';
import { type CountryLabel, countryLabels, labelGeometry, regionLabels } from './country-layers';

// 第二十五轮：片区名的位置（regionLabels）。国名改成调用它以后与原来逐值相同；文化等片区的第二片

// 第二十三轮的 countryLabels，原样留在这里对照
function oldCountryLabels(world: World): CountryLabel[] {
  const { mesh, causes } = world;
  const c = causes.country;
  if (!c || !world.small.countries) return [];
  const n = mesh.n;
  const seen = new Uint8Array(n);
  const main = new Map<number, number[]>();
  const stack: number[] = [];
  for (let s = 0; s < n; s++) {
    if (seen[s] || !causes.land[s] || c[s] < 0) continue;
    const id = c[s];
    const comp: number[] = [];
    seen[s] = 1;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const j = mesh.adj[e];
        if (!seen[j] && causes.land[j] && c[j] === id) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    const cur = main.get(id);
    if (!cur || comp.length > cur.length) main.set(id, comp);
  }
  const out: CountryLabel[] = [];
  for (const m of countryList(world.small)) {
    const cells = main.get(m.id);
    if (!cells) continue;
    cells.sort((a, b) => a - b);
    out.push({ id: m.id, cells: cells.length, ...labelGeometry(world, cells) });
  }
  return out;
}

const GEN: HumanCommand = {
  op: 'generate_human',
  era: 'medieval',
  groups: [
    { id: 'western', weight: 3 },
    { id: 'eastern', weight: 3 },
    { id: 'steppe', weight: 1.5 },
  ],
  countries: { fragmentation: 1 },
};
const nations = () =>
  snapshot('region:nations', () => {
    const eng = continents();
    humanExec(eng, GEN);
    return eng;
  });

describe('片区名的位置', () => {
  it('国名改成调用 regionLabels 后与原来逐值相同（地区、整个星球）', () => {
    const w = nations().world;
    const now = countryLabels(w);
    expect(now.length).toBeGreaterThan(3);
    expect(JSON.stringify(now)).toBe(JSON.stringify(oldCountryLabels(w)));
    const eng = engineFor({ seed: 3, cells: 6000, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
    eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
    humanExec(eng, GEN);
    expect(JSON.stringify(countryLabels(eng.world))).toBe(JSON.stringify(oldCountryLabels(eng.world)));
  });

  it('按 ids 的先后，每种取最大的一片；够大的第二片也标（part 1），太小的不标', () => {
    const w = nations().world;
    const n = w.mesh.n;
    // 陆地按 x 分成左右两半，编号 1；右边再挖出一块编号 2
    const codes = new Int32Array(n).fill(-1);
    const land: number[] = [];
    for (let i = 0; i < n; i++) if (w.causes.land[i]) land.push(i);
    for (const i of land) codes[i] = 1;
    const one = regionLabels(w, codes, { ids: [1] });
    expect(one.every((l) => l.part === 0)).toBe(true);
    expect(one.length).toBe(1);
    // 大陆不止一块：允许第二片时多一个 part 1，小于 second 的倍数时不标
    const two = regionLabels(w, codes, { ids: [1], second: 0 });
    expect(two.length).toBe(2);
    expect(two[1].part).toBe(1);
    expect(two[1].cells).toBeLessThanOrEqual(two[0].cells);
    expect(regionLabels(w, codes, { ids: [1], second: 1.01 }).length).toBe(1);
    // minCells：大的那片也不够时不标
    expect(regionLabels(w, codes, { ids: [1], minCells: two[0].cells + 1 })).toEqual([]);
    // 不在 ids 里的编号不标；先后按 ids
    for (const i of land) if (w.mesh.x[i] > 0.5) codes[i] = 2;
    expect(regionLabels(w, codes, { ids: [2, 1] }).map((l) => l.id)).toEqual([2, 1]);
    expect(regionLabels(w, codes, { ids: [2] }).map((l) => l.id)).toEqual([2]);
  });
});
