import type { Command } from '../../core/commands';
import { classOfKind } from '../../core/provinces';
import type { World } from '../../core/world';

// 省份面板（provincePanel.tsx）的逻辑：多选的几个省能做什么（第七十八轮去掉了省份大小的滑块，大小在资源库的“省份划分”里）

// 几个省一起：合并（并进第一个选的）、整个划给某国、重新划分。陆地省与海省、湖省混着时不能合并
export function provinceMultiCommands(w: World, ids: readonly number[]) {
  const metas = ids.map((id) => w.small.provinces[id]).filter(Boolean);
  const into = ids[0];
  const first = w.small.provinces[into];
  const same = !!first && metas.every((m) => m.land === first.land && classOfKind(m.kind) === classOfKind(first.kind));
  const locked = metas.some((m) => m.locked);
  const set = new Set(ids);
  const cells: number[] = [];
  for (let i = 0; i < w.mesh.n; i++) if (set.has(w.causes.province[i])) cells.push(i);
  const merge: Command | null =
    same && !locked && ids.length > 1 ? { op: 'batch', label: `合并 ${ids.length} 个省份`, commands: ids.slice(1).map((from) => ({ op: 'merge_province' as const, from, into })) } : null;
  return { cells, merge, why: !same ? '陆地省份、海省、湖省不能合并' : locked ? '有省份已锁定' : null, land: cells.filter((i) => w.causes.land[i] === 1) };
}
