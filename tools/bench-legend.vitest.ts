// 计时：地图左下角的图例（第七十九轮，src/ui/domain/legend.ts），主线程上每画一笔之后
//   npx vitest run -c tools/bench.vitest.config.ts bench-legend（vitest 的输出里看 console.log；BENCH_GLOBE=1 时用类地星球）
//     种子 3 的一块地区（4 万格）或类地星球（tools/r40-world.ts：人文、国家、城市）。画了一笔以后主线程收到的世界：
//     这一底图的数组是新的一份（地貌、生态分区是 derived.dominant），小数据是新的对象，内容还是同一个对象（src/content-post.ts）。
//     每种底图 41 次的中位数（毫秒）：
//       edit：画了一笔以后第一次取图例（现在：legendFor；地图上的 shownLegend 在浏览器里先留着上一份、空闲时再数，这一帧里不数）；
//       hit：同一个世界再取（每次重画图例都要：缓存的键）；
//       old：第七十八轮（8facf5e）的写法，键是两个 JSON.stringify 拼的字、逐格用 Map 数（下面 oldKey、oldCount 的原样拷贝）。
//     第七十二轮以前（第六十八轮 3d22942）默认的地貌底图没有图例：那时这一项是 0
import { it } from 'vitest';
import { PLANET_SIZES, planetCells } from '../core/presets';
import type { World } from '../core/world';
import type { ViewMode } from '../src/state';
import { legendFor } from '../src/ui/domain/legend';
import { r40Engine } from './r40-world';

const globe = !!process.env.BENCH_GLOBE;

// ---- 第七十八轮的写法（原样拷贝，只留数格与键；不要改它） ----
function oldCount(w: World, codes: ArrayLike<number>): Map<number, number> {
  const { causes, derived: d } = w;
  const out = new Map<number, number>();
  for (let i = 0; i < codes.length; i++) {
    if (!causes.land[i] || d.lake[i] === 1) continue;
    out.set(codes[i], (out.get(codes[i]) ?? 0) + 1);
  }
  return out;
}
function oldKey(w: World, mode: ViewMode): string {
  return `${mode}|${JSON.stringify(w.small.content?.terrainClass ?? null)}|${JSON.stringify(w.small.content?.resource ?? null)}|${w.small.species.map((s) => `${s.name}:${s.color}`).join(',')}`;
}

const median = (v: number[]) => Math.round([...v].sort((a, b) => a - b)[v.length >> 1] * 1000) / 1000;

it('图例', () => {
  const w = r40Engine(globe, globe ? planetCells(PLANET_SIZES.earth.radiusKm) : 40000).world;
  // 主线程收到的下一份世界
  const next = (key: 'dominant' | 'terrainClass' | 'resource'): World => {
    const arr = w.derived[key] as Int16Array | Uint8Array;
    const small = { ...JSON.parse(JSON.stringify({ ...w.small, content: 0, popGroups: 0 })), content: w.small.content, popGroups: w.small.popGroups };
    return { ...w, small, derived: { ...w.derived, [key]: arr.slice() } } as World;
  };
  const out: Record<string, number> = {};
  for (const [mode, key] of [
    ['terrain', 'dominant'],
    ['terrainClass', 'terrainClass'],
    ['resource', 'resource'],
  ] as const) {
    const edit: number[] = [];
    const hit: number[] = [];
    const oldEdit: number[] = [];
    const oldHit: number[] = [];
    for (let k = 0; k < 41; k++) {
      const w2 = next(key);
      let a = performance.now();
      legendFor(w2, mode);
      edit.push(performance.now() - a);
      a = performance.now();
      legendFor(w2, mode);
      hit.push(performance.now() - a);
      const w3 = next(key);
      a = performance.now();
      oldKey(w3, mode);
      oldCount(w3, w3.derived[key]!);
      oldEdit.push(performance.now() - a);
      a = performance.now();
      oldKey(w3, mode);
      oldHit.push(performance.now() - a);
    }
    out[`${mode}.edit`] = median(edit);
    out[`${mode}.hit`] = median(hit);
    out[`${mode}.oldEdit`] = median(oldEdit);
    out[`${mode}.oldHit`] = median(oldHit);
  }
  console.log(`${globe ? '类地星球' : '一块地区'}：${w.mesh.n} 格`);
  console.log(JSON.stringify(out, null, 1));
});
