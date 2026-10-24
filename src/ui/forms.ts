import type { Command } from '../../core/commands';
import { WORLD_TYPE_INFO, type Worldgen, type WorldgenInput, type WorldType } from '../../core/generate';
import { itemKey, packForms, packIdFor, sameItem } from '../../core/packs';
import { LAYOUT_R, planetProfile } from '../../core/planet-gen';
import { type PlanetForm, planetFormSchema } from '../../core/planet-form';
import { PLANET_TYPES } from '../../core/presets';
import { type LibraryEntry, MY_PACK_NAME } from '../library';

// 星球形态的界面要用的几样（不碰界面和 Worker，测试里直接用）：
// 向导、调整面板里列出的形态（内置的示例 + 资源库里装的）、形态编辑器的滑块、改脚本、存之前定 id

// ---------- 列出来的形态 ----------

export interface FormChoice {
  // 列表里的键：资源包的键 + 形态的 id（不同的包里可以有同 id 的形态）
  key: string;
  form: PlanetForm;
  // 来自哪个包（“奇幻生态示例”“我的资源”……）
  pack: string;
  builtin: boolean;
  // 在“我的资源”这个包里（形态编辑器存进去的）：编辑它改的就是它本身。
  // 别的自己导出的包里的不算：编辑那些是一份副本，存进“我的资源”，原来的包不变
  mine: boolean;
}

// 资源库里全部的星球形态：内置的在前，之后按资源库的顺序（我的资源、导入的）。一模一样的只列一次（先出现的那个）。
// 向导、调整面板每次重画都要：按资源库的列表（读一遍资源库换一个新的）记下结果，带长脚本的形态也不每次重新比
const choicesMemo = new WeakMap<readonly LibraryEntry[], FormChoice[]>();
// 每个形态对象的比较键只算一次（键的顺序不算，见 core/packs.ts 的 sameItem）
const keyMemo = new WeakMap<object, string>();
export function formKey(form: PlanetForm): string {
  let k = keyMemo.get(form);
  if (k === undefined) keyMemo.set(form, (k = itemKey(form)));
  return k;
}
export function formChoices(entries: readonly LibraryEntry[]): FormChoice[] {
  const hit = choicesMemo.get(entries);
  if (hit) return hit;
  const out: FormChoice[] = [];
  const seen = new Set<string>();
  const myKey = packIdFor(MY_PACK_NAME);
  for (const e of entries) {
    for (const form of packForms(e.pack)) {
      const k = formKey(form);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ key: `${e.key}:${form.id}`, form, pack: e.pack.name, builtin: e.builtin, mine: e.mine && e.key === myKey });
    }
  }
  choicesMemo.set(entries, out);
  return out;
}

// 卡片上写的来处：内置的不写；“我的资源”里的写“我的资源”，别的写“来自「包名」”
export function formSource(c: FormChoice): string {
  return c.builtin ? '' : c.mine ? MY_PACK_NAME : `来自“${c.pack}”`;
}

// 一种星球的叫法：与向导里的卡片相同（像地球、一块超大陆……）；向导里没有的（内海）用生成器的名字
export function planetTypeName(type: WorldType): string {
  return PLANET_TYPES.find((p) => p.type === type && p.islands === undefined)?.name ?? WORLD_TYPE_INFO[type].name;
}

// 世界的生成参数是哪种星球：与 planetTypeName 相同，只是海洋星球、空白星球是同一种生成器，按岛多少分
// （向导里的海洋星球是“空白海洋 + 岛 0.7”）
export function planetNameOf(gen: Pick<Worldgen, 'type' | 'islands'>): string {
  if (gen.type === 'ocean' && (gen.islands ?? 0) > 0) return PLANET_TYPES.find((p) => p.key === 'ocean_islands')!.name;
  return planetTypeName(gen.type);
}

// 形态编辑器“从哪种星球改起”的六种
export const FORM_BASES: readonly WorldType[] = ['continents', 'continent', 'fragmented', 'archipelago', 'inland_sea', 'ocean'];

// 用这个形态新建的生成参数
export function formGen(seed: number, form: PlanetForm): WorldgenInput {
  return { seed, type: form.base, form };
}

// 现在的世界换成这个形态（null：不用形态）的生成参数：其余的（种子、调过的陆地多少、山多高、重画过的地方）都照旧，
// type 跟着形态的 base；去掉形态时 type 不变（还是那种星球）
export function genWithForm(gen: Worldgen, form: PlanetForm | null): Worldgen {
  const { form: _, ...rest } = gen;
  return form ? { ...rest, type: form.base, form } : rest;
}

// 向导里选的这一种叫什么（历史里的“新世界：像地球”“新世界：双子大陆”）：
// 整个星球按星球的叫法（像地球、海洋星球……）或形态的名字，一块地区按世界类型
export function wizardWorldName(kind: 'region' | 'planet', ptype: string, choices: readonly FormChoice[], type: WorldType): string {
  if (kind === 'region') return WORLD_TYPE_INFO[type].name;
  const form = choices.find((c) => c.key === ptype)?.form;
  return form?.name ?? (PLANET_TYPES.find((t) => t.key === ptype) ?? PLANET_TYPES[0]).name;
}

// 向导新建的命令：生成（标签“新世界：X”，山挡风默认就是打开的），再划分省份。
// before：向导“地形”里动过的海岸曲折、最高的山（见 wizardTerrain.ts），在生成之前设好，同在这一步里
export function newWorldCommands(gen: WorldgenInput, name: string, seed: number, before: Command[] = []): Command[] {
  return [
    { op: 'batch', label: `新世界“${name}”`, commands: [...before, { op: 'set_worldgen', params: gen, reset: true }] },
    { op: 'generate_provinces', rules: { seed } },
  ];
}

// ---------- 形态编辑器 ----------

type Pair = [number, number];

// 一对数（个数、大小的范围）整体缩放到中间是 v：保持原来的比例（6–9 块 → 中间 7.5；调到 10 → 8–12）；
// 原来是 0–0 时上下各 20%；碰到上下限时两头一起收窄，中间还是 v。int：取整
function scalePair([a, b]: Pair, v: number, [lo, hi]: Pair, int: boolean): Pair {
  const mid = (a + b) / 2;
  const half = Math.max(0, Math.min(mid > 0 ? ((b - a) / 2) * (v / mid) : v * 0.2, hi - v, v - lo));
  const r = (x: number) => Math.min(hi, Math.max(lo, int ? Math.round(x) : Math.round(x * 1000) / 1000));
  return [r(v - half), r(v + half)];
}
const midOf = ([a, b]: Pair) => (a + b) / 2;

export type FormKnobId = 'landFraction' | 'islands' | 'plates' | 'blocks' | 'radius' | 'beltWidth';

export interface FormKnob {
  id: FormKnobId;
  label: string;
  hint: string;
  range: [number, number];
  step: number;
  // 现在的值：形态改过就是形态的，没改过是 base 那种星球的
  read(form: PlanetForm): number;
  // 改成 v（新的形态，原来的不动）
  write(form: PlanetForm, v: number): PlanetForm;
  // radiusKm：星球的半径（“每块约 4800 公里宽”）
  format(v: number, radiusKm: number): string;
}

const level = (v: number, words: [string, string, string, string]) => (v < 0.25 ? words[0] : v < 0.5 ? words[1] : v < 0.8 ? words[2] : words[3]);

function profileKnob(id: 'landFraction' | 'islands', label: string, hint: string, range: Pair, format: FormKnob['format']): FormKnob {
  return {
    id,
    label,
    hint,
    range,
    step: 0.01,
    read: (f) => f.profile?.[id] ?? planetProfile(f.base)[id],
    write: (f, v) => ({ ...f, profile: { ...f.profile, [id]: v } }),
    format,
  };
}

function pairKnob(id: 'plates' | 'blocks' | 'radius', label: string, hint: string, range: Pair, limits: Pair, step: number, int: boolean, format: FormKnob['format']): FormKnob {
  return {
    id,
    label,
    hint,
    range,
    step,
    read: (f) => midOf((f.profile?.[id] as Pair | undefined) ?? planetProfile(f.base)[id]),
    write: (f, v) => ({ ...f, profile: { ...f.profile, [id]: scalePair((f.profile?.[id] as Pair | undefined) ?? planetProfile(f.base)[id], v, limits, int) } }),
    format,
  };
}

export const FORM_KNOBS: FormKnob[] = [
  profileKnob('landFraction', '陆地多少', '陆地占星球表面多少', [0.03, 0.7], (v) => `${Math.round(v * 100)}%`),
  profileKnob('islands', '岛多少', '火山岛和小岛的多少', [0, 1], (v) => level(v, ['很少', '较少', '较多', '很多'])),
  pairKnob('plates', '板块数', '越多，山脉越多越碎', [2, 40], [2, 40], 1, true, (v) => `约 ${Math.round(v)} 块`),
  pairKnob('blocks', '大陆块数', '拼成陆地的大块，不算岛', [0, 60], [0, 60], 1, true, (v) => (v < 0.5 ? '没有' : `约 ${Math.round(v)} 块`)),
  pairKnob('radius', '大陆大小', '每块大陆有多大', [0.04, 0.5], [0.02, 0.6], 0.01, false, (v, km) => `每块约 ${(Math.round(((2 * v) / LAYOUT_R) * km / 100) * 100).toLocaleString()} 公里宽`),
  {
    id: 'beltWidth',
    label: '山脉宽窄',
    hint: '板块碰撞处、大陆边的山脉宽度',
    range: [0.3, 3],
    step: 0.05,
    read: (f) => f.tuning?.beltWidth ?? 1,
    write: (f, v) => ({ ...f, tuning: { ...f.tuning, beltWidth: v } }),
    format: (v) => `${v < 0.8 ? '窄' : v > 1.3 ? '宽' : '适中'}（×${v.toFixed(2)}）`,
  },
];

// 滑块旁边的数说的是什么：大陆块数、大小只管配方里的块，布局脚本加的块按脚本里写的
// （双子大陆的“大陆块数”是“没有”，两块大陆都是脚本加的），有布局脚本时说一声
export function knobText(k: FormKnob, form: PlanetForm, radiusKm: number): string {
  const text = k.format(k.read(form), radiusKm);
  return form.scripts?.setup && (k.id === 'blocks' || k.id === 'radius') ? `${text}（不含布局脚本加的）` : text;
}

export type FormScriptKind = 'setup' | 'crust';

// 改一段脚本（空的去掉；两段都没有时去掉整个 scripts）
export function withScript(form: PlanetForm, kind: FormScriptKind, src: string): PlanetForm {
  const scripts = { ...form.scripts };
  if (src.trim()) scripts[kind] = { api: 1, src };
  else delete scripts[kind];
  const out: PlanetForm = { ...form, scripts };
  if (!scripts.setup && !scripts.crust) delete out.scripts;
  return out;
}

// 地形脚本是在原来的地形上改（默认，不写），还是完全由脚本决定
export function withCrustMode(form: PlanetForm, mode: 'modify' | 'replace'): PlanetForm {
  const out: PlanetForm = { ...form };
  if (mode === 'replace') out.crustMode = 'replace';
  else delete out.crustMode;
  return out;
}

// 从头做一个（向导里“自己做一个…”）
export function blankForm(base: WorldType = 'continents'): PlanetForm {
  return { id: 'my_form', name: '我的星球', api: 1, base };
}

// 形态写得对不对（名字空了、太长……）：有问题时给第一条
export function formProblem(form: PlanetForm): string | null {
  const r = planetFormSchema.safeParse(form);
  return r.success ? null : (r.error.issues[0]?.message ?? '形态写得不对');
}

// 要存进资源库、用来新建的那一份：
// - 没改过：原样（内置的还是内置的那个 id）；
// - 自己的（我的资源里的）改过：id 不变，存进去替换原来的；
// - 内置的、导入的改过：是一份副本，另起 id（taken 里的不用），种子沿用原来的（seedKey），同一个种子的样子不变；
//   名字与列表里别的形态重名时加上编号（“双子大陆 2”）。
// 种子沿用编辑时的（seedKey，没有时是编辑时的 id）：存好的、新建出来的与编辑器里的缩略图同一个样子
export function finalForm(form: PlanetForm, original: PlanetForm | null, mine: boolean, others: readonly PlanetForm[], now = Date.now()): PlanetForm {
  if (original && sameItem(form, original)) return original;
  if (mine) return form;
  const taken = new Set(others.map((f) => f.id));
  let id = `my_${now.toString(36)}`;
  for (let k = 2; taken.has(id); k++) id = `my_${now.toString(36)}_${k}`;
  const seedKey = form.seedKey ?? form.id;
  const names = new Set(others.map((f) => f.name));
  let name = form.name;
  for (let k = 2; names.has(name); k++) name = `${form.name.slice(0, 12 - String(k).length - 1)} ${k}`;
  return { ...form, id, name, seedKey };
}
