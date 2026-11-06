import type { Command } from '../../core/commands';
import type { Timings } from '../../core/engine';
import { world } from './world';

// 成本闸门（第七十轮从 state.ts 分出来）：换上快照（worker-host.ts）、执行（edits.ts）时记下算了多久，确切预览（exact-preview.ts）据此决定要不要自动预览

// ---- 成本闸门 ----
// 每类命令最近一次预览（或执行）算了多久（毫秒）。超过约 600 毫秒的那类不再自动预览（拖动中停顿时）：
// Worker 一次只做一件事，松手时的执行要排在还没算完的预览后面；改为说一句“松手后约 N 秒出结果”
// 按网格分开记：换了一个世界（比如从大星球换到小地图）就重新量，不沿用别的世界上的慢
const COST_LIMIT = 600;
const costsByMesh = new WeakMap<object, Map<string, number>>();
const noMesh = {};
function costs(): Map<string, number> {
  const key = world.value?.mesh ?? noMesh;
  let c = costsByMesh.get(key);
  if (!c) costsByMesh.set(key, (c = new Map()));
  return c;
}

// 哪一类命令（代价相近的算一类）
function costKey(cmd: Command): string {
  if (cmd.op === 'set_planet') return `set_planet:${Object.keys(cmd.patch).sort().join(',')}`;
  if (cmd.op === 'paint') return `paint:${cmd.field.startsWith('field:') ? 'field' : cmd.field}`;
  if (cmd.op === 'batch') return `batch:${cmd.commands.map(costKey).join('+')}`;
  return cmd.op;
}

export function noteCost(cmd: Command, ms: number) {
  costs().set(costKey(cmd), ms);
}

// 要从气候重算起的整体参数（没算过这一类时，按最近一次从气候算起用了多久估计）
const CLIMATE_KEYS = ['tilt', 'solar', 'lapse', 'humidity', 'latShift', 'currents', 'terrainWind', 'mountainScale', 'rotation', 'outsideOcean'];
const CLIMATE = 'climate';
export function noteTimings(t: Timings) {
  if (t.climate !== undefined) costs().set(CLIMATE, t.total - (t.elevation ?? 0));
}

// 这条命令自动预览太慢：返回大约几秒（“松手后约 N 秒出结果”）；不慢、或者还不知道时为 null
export function slowPreview(cmd: Command): number | null {
  let ms = costs().get(costKey(cmd));
  if (ms === undefined && cmd.op === 'set_planet' && Object.keys(cmd.patch).some((k) => CLIMATE_KEYS.includes(k))) ms = costs().get(CLIMATE);
  return ms !== undefined && ms > COST_LIMIT ? Math.max(1, Math.round(ms / 1000)) : null;
}

// 太慢不自动预览时说的那一句（滑块下的小字、鼠标旁都用它）
export const slowHint = (sec: number) => `松手后约 ${sec} 秒出结果`;
