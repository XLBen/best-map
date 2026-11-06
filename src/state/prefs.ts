import { signal } from '@preact/signals';
import { DEFAULT_NAME_MODE, NAME_MODES, type NameMode } from '../../core/name-display';
import { kvRequest } from '../idb';

// 存在本浏览器里、不写进世界的（第七十轮从 state.ts 分出来）：偏好（localStorage）、参考图（IndexedDB）

// 偏好（存在本浏览器里）：滚轮 / 双指滑动是缩放还是平移
export type WheelPref = 'auto' | 'zoom' | 'pan';
// 整个星球用哪种投影看（第十三轮 G4）：等距圆柱（平铺图）、等面积（椭圆形）、球形（从太空看）。只是看的方式，不写进世界文件
export type ProjectionPref = 'equirect' | 'equalEarth' | 'globe';
const PREFS_KEY = 'map2.prefs';
// 地图模式（第二十五轮，像 EU4：地理、国家、文化、文化组、时代的每一维、人口；第二十三轮的“人文图”就是“国家”）。
// 每种模式画什么见 ui/map/modes.ts 的表
export type MapKind = 'geo' | 'country' | 'bloc' | 'culture' | 'cultureGroup' | 'popDensity' | `dim:${string}`;
// 存着的模式读回来：第二十三轮的 political 读作 country，不认识的是地理（第四十六到四十七轮存下的 wind 也在其中：这种模式没有了）
export function parseMapKind(v: unknown): MapKind {
  if (v === 'political') return 'country';
  if (v === 'country' || v === 'bloc' || v === 'culture' || v === 'cultureGroup' || v === 'popDensity') return v;
  if (typeof v === 'string' && /^dim:[\w-]{1,64}$/.test(v)) return v as MapKind;
  return 'geo';
}
// names：地名显示中文、原文还是两者（第二十轮）；map：地图模式（第二十五轮）
export type Prefs = { wheel: WheelPref; projection: ProjectionPref; names: NameMode; map: MapKind };
// 存着的偏好（JSON）读回来：不认识的值用默认的
export function parsePrefs(raw: string | null): Prefs {
  let p: Partial<Prefs> = {};
  try {
    p = raw ? (JSON.parse(raw) as Partial<Prefs>) : {};
  } catch {
    // 坏了就全用默认的
  }
  return {
    wheel: p.wheel === 'zoom' || p.wheel === 'pan' ? p.wheel : 'auto',
    projection: p.projection === 'equalEarth' || p.projection === 'globe' ? p.projection : 'equirect',
    names: NAME_MODES.some((m) => m.id === p.names) ? (p.names as NameMode) : DEFAULT_NAME_MODE,
    map: parseMapKind(p.map),
  };
}
function readPrefs(): Prefs {
  try {
    return parsePrefs(typeof localStorage !== 'undefined' ? localStorage.getItem(PREFS_KEY) : null);
  } catch {
    return parsePrefs(null);
  }
}
export const prefs = signal(readPrefs());
export function setPrefs(patch: Partial<Prefs>) {
  prefs.value = { ...prefs.value, ...patch };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs.value));
  } catch {
    // 存不了就只在这次打开时有效
  }
}

// 地名显示中文、原文还是两者（第二十轮，见 core/name-display.ts）：屏幕与导出的图片都按它。存在这个浏览器里，不写进世界
export const nameMode = signal<NameMode>(prefs.value.names);
export function setNameMode(m: NameMode) {
  nameMode.value = m;
  setPrefs({ names: m });
}

// 参考图（手绘草图）：铺在地图上照着画。只存在这个浏览器里（IndexedDB，不占自动保存的空间），不写进世界文件
export interface Reference {
  url: string;
  blob: Blob;
  // 浓淡：0.1 很淡，1 不透明
  opacity: number;
  // contain：保持比例放在地图中间；stretch：拉伸铺满整张地图
  fit: 'contain' | 'stretch';
  visible: boolean;
}
export const reference = signal<Reference | null>(null);

type StoredReference = Omit<Reference, 'url'>;

export async function loadReference() {
  try {
    const r = await kvRequest<StoredReference | undefined>('readonly', (s) => s.get('reference'));
    if (r?.blob) reference.value = { ...r, url: URL.createObjectURL(r.blob) };
  } catch {
    // 读不了就当没有
  }
}

// 换参考图或改设置；persist 为 false 时只改这次打开（拖浓淡时不必每一下都存）。存不下返回 false
export async function setReference(r: Reference | null, persist = true): Promise<boolean> {
  const old = reference.value;
  if (old && old.url !== r?.url) URL.revokeObjectURL(old.url);
  reference.value = r;
  if (!persist) return true;
  try {
    if (r) await kvRequest('readwrite', (s) => s.put({ blob: r.blob, opacity: r.opacity, fit: r.fit, visible: r.visible } satisfies StoredReference, 'reference'));
    else await kvRequest('readwrite', (s) => s.delete('reference'));
    return true;
  } catch {
    return false;
  }
}
