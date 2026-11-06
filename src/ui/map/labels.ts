import type { GeoFeature } from '../../../core/features';
import type { ProvinceMeta, World } from '../../../core/world';
import type { ProvinceLabel } from '../../render/overlay';

// 地图上的名字（第七十轮从 MapView.tsx 分出来）：省名标签放在哪；工具选中的东西自己的地名先不标

// 省名标签：每个省放在它的格的中心。province、metas 可以是预览里将来的（重划、重新划分时先看新的省名）
export function provinceLabelsOf(w: World, province: Int32Array, metas: Record<number, ProvinceMeta>): ProvinceLabel[] {
  if (w.mesh.kind === 'sphere') {
    // 整个星球：经度取圆周平均，跨过经度 180° 的省份名字也落在省份上
    const sums = new Map<number, [number, number, number, number]>();
    for (let i = 0; i < w.mesh.n; i++) {
      const p = province[i];
      if (p < 0) continue;
      const s = sums.get(p) ?? [0, 0, 0, 0];
      s[0] += Math.sin(Math.PI * w.mesh.x[i]);
      s[1] += Math.cos(Math.PI * w.mesh.x[i]);
      s[2] += w.mesh.y[i];
      s[3]++;
      sums.set(p, s);
    }
    return [...sums]
      .filter(([p]) => metas[p])
      .map(([p, [sn, cs, y, c]]) => {
        const x = Math.atan2(sn, cs) / Math.PI;
        return { x: x < 0 ? x + 2 : x, y: y / c, text: metas[p].name || String(p), kind: metas[p].kind };
      });
  }
  const sums = new Map<number, [number, number, number]>();
  for (let i = 0; i < w.mesh.n; i++) {
    const p = province[i];
    if (p < 0) continue;
    const s = sums.get(p) ?? [0, 0, 0];
    s[0] += w.mesh.x[i];
    s[1] += w.mesh.y[i];
    s[2]++;
    sums.set(p, s);
  }
  return [...sums].filter(([p]) => metas[p]).map(([p, [x, y, c]]) => ({ x: x / c, y: y / c, text: metas[p].name || String(p), kind: metas[p].kind }));
}

// 工具选中的东西自己的地名（key）先不标：画河时选中的河不盖住它的控制点、“+”。同样的输入给同一个数组（每个地图视图一份）
export function hiddenLabelFilter(): (list: GeoFeature[], key: string) => GeoFeature[] {
  let labelMemo: { from: GeoFeature[]; key: string; out: GeoFeature[] } | null = null;
  function labelsShown(list: GeoFeature[], key: string): GeoFeature[] {
    if (!key) return list;
    if (labelMemo?.from === list && labelMemo.key === key) return labelMemo.out;
    labelMemo = { from: list, key, out: list.filter((f) => f.key !== key) };
    return labelMemo.out;
  }
  return labelsShown;
}
