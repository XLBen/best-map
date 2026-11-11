import type { Effects, Species, SpeciesFeature, Visual } from '../../../core/species';

// 生态编辑器“高级”里的几段怎样做补丁（第七十二轮从 SpeciesAdvanced.tsx 搬来，算法不变）。
// 每次只改动这次动了的那一项，按那时最新的这种生态做（世界里排队，见 species-scripts.ts 的 queueSpeciesEdit）：
// 资源包里超出滑块范围的值（比如降水 −78%）不会因为改了别的而被改掉

export type Patch = Record<string, unknown>;
export const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const hexRgb = (hex: string) => {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};
const rgbHex = (c: number[]) => `#${c.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('')}`;
// 花纹第二种颜色的默认：基础色调暗四成（与画面的默认一致）
export const darker = (hex: string) => rgbHex(hexRgb(hex).map((x) => x * 0.6));
// 发光颜色的默认：基础色调亮
export const lighter = (hex: string) => rgbHex(hexRgb(hex).map((x) => x + (255 - x) * 0.5));

export const pct = (x: number) => `${Math.round(x * 100)}%`;
export const signed = (x: number, unit: string) => (x === 0 ? '不变' : `${x > 0 ? '+' : '−'}${Math.abs(x)}${unit}`);

// ---------- 图案 ----------

// 外观：没有花纹也不发光时等于没有
export function cleanVisual(v: Visual): Visual | null {
  if (v.pattern === 'none' && !(v.glow && v.glow > 0)) return null;
  const out: Visual = { pattern: v.pattern };
  for (const k of ['color2', 'amount', 'size', 'glow', 'glowColor'] as const) if (v[k] !== undefined) (out as Record<string, unknown>)[k] = v[k];
  return out;
}

// 外观改一项：在这种生态现在的外观上改（不是界面上可能还没更新的那份）
export function visualPatch(cur: Species, change: Partial<Visual>): Patch | null {
  const c = cleanVisual({ ...(cur.visual ?? { pattern: 'none' }), ...change });
  return same(c, cur.visual) ? null : { visual: c };
}

// ---------- 对周围的影响 ----------

// 改一项（dP 是降水乘以 e^dP 的那个数）；没改的项照原样留着（资源包里的值可能超出滑块的范围）
export type ClimateChange = { dT?: number; dP?: number; radiusKm?: number };
export const DEFAULT_RADIUS_KM = 300;

export function withClimate(effects: Effects | undefined, change: ClimateChange): Effects | null {
  const old = effects?.climate;
  const dT = change.dT ?? old?.dT ?? 0;
  const dP = change.dP ?? old?.dP ?? 0;
  const radiusKm = change.radiusKm ?? old?.radiusKm ?? DEFAULT_RADIUS_KM;
  const climate = dT || dP ? { ...(dT ? { dT } : {}), ...(dP ? { dP } : {}), radiusKm } : undefined;
  const { climate: _, ...rest } = effects ?? {};
  const out: Effects = { ...rest, ...(climate ? { climate } : {}) };
  return Object.keys(out).length ? out : null;
}

// 降水的百分比（滑块）与 dP 互换（第九十三轮搬到 core/effect-ranges.ts：通用表单的字段表也用，照旧从这里导出）
export { dpOfPercent, percentOfDp } from '../../../core/effect-ranges';

export const effectsPatch = (cur: Species, next: Effects | null): Patch | null => (same(next, cur.effects) ? null : { effects: next });

// ---------- 侵占 ----------

export const DEFAULT_INVADE_STRENGTH = 1.5;

// 点了一种：有就去掉，没有就加上（按生态列表的顺序排，已经不在了的目标照旧留在后面）
export function toggleTarget(targets: readonly string[], id: string, order: readonly string[]): string[] {
  if (targets.includes(id)) return targets.filter((t) => t !== id);
  return [...order.filter((o) => o === id || targets.includes(o)), ...targets.filter((t) => !order.includes(t))];
}

// 侵占里改一项：toggle 点了哪一种，strength 强度
export function withInvade(effects: Effects | undefined, change: { toggle?: string; strength?: number }, order: readonly string[]): Effects | null {
  const inv = effects?.invade;
  const targets = change.toggle !== undefined ? toggleTarget(inv?.targets ?? [], change.toggle, order) : (inv?.targets ?? []);
  const strength = change.strength ?? inv?.strength ?? DEFAULT_INVADE_STRENGTH;
  const invade = targets.length ? { targets: targets.slice(0, 48), strength } : undefined;
  const { invade: _, ...rest } = effects ?? {};
  const out: Effects = { ...rest, ...(invade ? { invade } : {}) };
  return Object.keys(out).length ? out : null;
}

// ---------- 地名 ----------

// 与 schema 一样按 UTF-16 的长度算（z.string().max）
export const MAX_LABEL = 8;
const MAX_TEMPLATE = 40;
const MAX_TEMPLATES = 20;

// 截到不超过 max 个 UTF-16 单位，不截断一个字
export function clip(s: string, max: number): string {
  let out = '';
  for (const ch of s) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

// 地名的输入有什么问题（与 featureSchema 的限制一致）；没有为 null
export function namesProblem(label: string, lines: readonly string[]): string | null {
  if (label.trim().length > MAX_LABEL) return `类型名最多 ${MAX_LABEL} 个字`;
  const long = lines.findIndex((s) => s.length > MAX_TEMPLATE);
  if (long >= 0) return `第 ${long + 1} 个模板太长，最多 ${MAX_TEMPLATE} 个字`;
  if (lines.length > MAX_TEMPLATES) return `模板最多 ${MAX_TEMPLATES} 个`;
  return null;
}

// 地名：输入的类型名、模板换成 feature（只写了模板、没写类型名时类型名用生态的名字；没改的模板保留原来的权重）
export function featureOf(cur: Species, label: string, lines: readonly string[]): SpeciesFeature | null {
  const lab = label.trim() || (lines.length ? clip(cur.name || cur.id, MAX_LABEL) : '');
  if (!lab) return null;
  const old = new Map((cur.feature?.names ?? []).map((n) => [n.p, n.w]));
  return { label: lab, ...(lines.length ? { names: lines.map((p) => (old.get(p) !== undefined ? { p, w: old.get(p) } : { p })) } : {}) };
}

// 回车之后又离开框：第二次排到时已经是这个样子，不再提交
export function featurePatch(cur: Species, label: string, lines: readonly string[]): Patch | null {
  const next = featureOf(cur, label, lines);
  return same(next, cur.feature) ? null : { feature: next };
}
