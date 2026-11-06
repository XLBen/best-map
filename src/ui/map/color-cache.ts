import type { World } from '../../../core/world';
import { type BaseLayers, type ColorOptions, type ModeLayers, baseLayers, colorSignature, modeLayers } from '../../render/colors';
import type { Perf } from '../../render/perf';
import type { CellLayers } from '../../render/renderer';

// 着色的缓存（第三十九轮；第七十轮从 MapView.tsx 分出来）：每个世界最多留几份底子、几份模式的那一层
const BASE_CACHE = 6;
const MODE_CACHE = 10;

// 一个按插入先后淘汰的小缓存：取到的挪到最后，满了扔掉最前面的
function lruGet<K, V>(m: Map<K, V>, k: K, make: () => V, cap: number): V {
  let v = m.get(k);
  if (v !== undefined) {
    m.delete(k);
    m.set(k, v);
    return v;
  }
  v = make();
  m.set(k, v);
  while (m.size > cap) m.delete(m.keys().next().value as K);
  return v;
}

export const sameKey = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((k, i) => k === b[i]);

// 着色用到的数组都没变（只改了名字的轻快照；预览世界里没变的数组沿用当前世界的同一个对象）就不重新着色、不重画地形。
// 第三十九轮：底子（baseLayers，按 baseKey：地形类与人文的模式共用一份）与每种模式的一层（modeLayers，按 modeKey）各缓存几份，
// 拼成的图层也按这两个键记住（同一个对象：渲染器按对象是不是同一个来上传，底子没变时不重画地形层）。
// 按世界（用到的数组、小数据的签名）分开存，最近两个世界留着：预览出现、消失时来回切换不必重算
// 每个地图视图一份：给画出来的世界、着色的选项（bk、mk：colors.ts 的 baseKey、modeKey）拼好的图层；
// 与上一次的键相同（着色用到的数组都没变，选项也没变）时为 null：不重新着色、不重画地形
export function colorCache(perf: Perf | null): (w: World, o: ColorOptions, bk: string, mk: string) => CellLayers | null {
  type ColorEntry = { key: unknown[]; base: Map<string, BaseLayers>; modes: Map<string, ModeLayers>; merged: Map<string, CellLayers> };
  let colorKey: unknown[] = [];
  const colorCache: ColorEntry[] = [];
  // 小数据里着色用到的部分（colors.ts 的 colorSignature，含生态的外观）：每帧都要比，按小数据对象缓存
  const smallKeys = new WeakMap<World['small'], string>();
  function smallKey(w: World): string {
    let k = smallKeys.get(w.small);
    if (k === undefined) {
      k = colorSignature(w.small);
      smallKeys.set(w.small, k);
    }
    return k;
  }
  return (w, o, bk, mk) => {
    const arrays: unknown[] = [];
    for (const v of Object.values(w.derived)) if (ArrayBuffer.isView(v)) arrays.push(v);
    for (const v of Object.values(w.causes)) if (ArrayBuffer.isView(v)) arrays.push(v);
    arrays.push(...Object.values(w.derived.corrF), ...Object.values(w.causes.fields));
    const wkey = [w.mesh, ...arrays, smallKey(w)];
    const key = [...wkey, bk, mk];
    if (sameKey(key, colorKey)) return null;
    colorKey = key;
    let entry = colorCache.find((x) => sameKey(x.key, wkey));
    if (!entry) {
      entry = { key: wkey, base: new Map(), modes: new Map(), merged: new Map() };
      colorCache.unshift(entry);
      colorCache.length = Math.min(colorCache.length, 2);
    }
    const e = entry;
    const t0 = perf ? performance.now() : 0;
    const layers = lruGet(e.merged, `${bk}#${mk}`, () => ({ ...lruGet(e.base, bk, () => baseLayers(w, o), BASE_CACHE), ...lruGet(e.modes, mk, () => modeLayers(w, o), MODE_CACHE) }), BASE_CACHE * 2);
    if (perf) perf.cpu('cellLayers', performance.now() - t0);
    return layers;
  };
}
