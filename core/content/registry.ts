import type { z } from 'zod';
import type { Command } from '../commands';
import type { World } from '../world';

// 内容种类的登记表（第二十轮）：一种内容（地名风格、生态、河流类型……以后的文化、时代、政体、资源……）在这里登记一次，
// 就同时有了：格式（schema）、在世界里放在哪里、启用 / 停用的命令、重算到哪一层、资源包文件里的一段（数、列表的一行、
// 检查、撞 id 改名、从世界导出）、仓库里的分类和内置的几项、通用编辑器的字段表。
//
// 两种放法：
//   - 新的种类（store: 'content'）放在 small.content[种类 id]: Record<id, 一项>，命令是通用的 set_content {kind, id, item | null}，
//     重算到哪一层由 dirty 定；
//   - 以前就有的种类（生态、河 / 湖 / 岛的种类、星球形态、自定义场）照旧放在原来的地方、用原来的命令，
//     登记表只经 inWorld、enable、disable 适配（重放结果不变，旧的世界文件照旧打得开）。
// 资源包的格式不变：每种一段（pack.key），旧文件里的别名（aliases）读进同一种。

// 重算到哪一层（与 commands.ts 的 Dirty 一一对应；这里不引用 commands.ts，免得循环引用）
export type DirtyLevel = 'none' | 'names' | 'vegetation' | 'solve' | 'climate' | 'elevation';

// 通用编辑器的一个字段
export type FieldType =
  // 一行字、几行字
  | 'text'
  | 'longtext'
  | 'number'
  | 'bool'
  // #rrggbb
  | 'color'
  // 几个里选一个（options）
  | 'enum'
  // 一组字（字符串数组）
  | 'tags'
  // 一组带权重的字：'k' 或 ['k', 3]
  | 'weighted'
  // 一组对象（每一项的字段是 of）
  | 'list'
  // 键 → 值（值是 value；值是对象时字段是 of）
  | 'map'
  // 脚本（{api, src}）
  | 'script'
  // 太复杂、只给高级编辑的（原样的 JSON）
  | 'json';

export interface FieldDesc {
  key: string;
  label: string;
  type: FieldType;
  // 悬停的说明（一句话）
  hint?: string;
  // 可以不写
  optional?: boolean;
  options?: readonly { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  // list 每一项、map 每个值（是对象时）的字段
  of?: readonly FieldDesc[];
  // map 的值不是对象时的样子
  value?: FieldDesc;
  // 只在同一层的另一个字段是某个值时才有（地名风格的模板式 / 音译式）
  when?: { key: string; is: string };
}

export type ContentWorld = Pick<World, 'small' | 'causes'>;

// 资源包里一段（packs.ts 用）
export interface PackSpec<T> {
  // 文件里的段名（“riverTypes”）与读旧文件时也认的别名（“textPacks”）
  key: string;
  aliases?: readonly string[];
  // 一个文件里最多几项
  max: number;
  // 列在“生态 5 · 河流 4”里、可以勾选（自定义场跟着生态、类型自动加，不列）
  listed: boolean;
  // 用到世界时默认勾上
  checked: boolean;
  // 不能用到世界时的说明（列出来，不能勾）
  note?: string;
  // 文件里的一项 → 校验前的一项（读旧写法：文字包补上 kind，自定义场的名字变成对象……）。alias 是从哪个别名读的
  read?(raw: unknown, alias?: string): unknown;
  // 写进文件的样子（省略时原样）
  write?(item: T): unknown;
  // 默认勾不勾这一项（省略时都勾）
  defaultPick?(item: T): boolean;
  // 撞 id 改名：换 id（种子要用原来的，花纹、匹配才不变），名字带上编号
  withId?(item: T, id: string, from: string): T;
  // 包里别的项改了名时，这一项里的引用跟着改
  rewrite?(item: T, renames: Renames): T;
  // 加进世界之前最后一步（没写“自然生成”的关掉、引用的生态按新名字……）
  finalize?(item: T, renames: Renames): T;
  // 加进世界时要先有的自定义场
  fieldsOf?(item: T): string[];
  // 从世界导出的项（省略时是 inWorld 里不是内置原样的）与导出时的样子
  fromWorld?(world: ContentWorld): T[];
  exportItem?(item: T): T;
  // 这一段的问题（不挡导入，列出来）
  problems?(items: readonly T[], ctx: PackContext): string[];
}

// 改名表：段名 → 包里的 id → 用到世界时的 id
export interface Renames {
  biomes: ReadonlyMap<string, string>;
  riverTypes: ReadonlyMap<string, string>;
  lakeTypes?: ReadonlyMap<string, string>;
  [key: string]: ReadonlyMap<string, string> | undefined;
}

// 检查资源包时各段都能看到的：包里各段的 id、自定义场、词表
export interface PackContext {
  ids(key: string): ReadonlySet<string>;
  fields: ReadonlySet<string>;
  // 模板式起名能用的词表（内置中文 + 包里模板式风格的）
  lists: ReadonlySet<string>;
}

export interface ContentKind<T = unknown> {
  // 种类的 id（命令、small.content 里用）：'nameStyle'
  id: string;
  // 全称（仓库的分类、出错的位置）：'地名风格'
  label: string;
  // 简称（列表里的一行：“河流 4”）
  short: string;
  // 用到世界时的先后（小的先：自定义场 → 河、湖、岛的种类 → 生态 → 地名风格）
  order: number;
  // 一项的格式
  schema: z.ZodType<T>;
  // 一项的 id（省略时是 item.id）
  idOf?(item: T): string;
  // 一项的名字（省略时是 item.name，没有时是 id）
  nameOf?(item: T): string;
  // 放法：'content' 是 small.content[id]；省略时由 inWorld / enable / disable 适配原来的放法
  store?: 'content';
  // 世界里已有（启用）的项
  inWorld(world: ContentWorld): readonly T[];
  // 内置的项（仓库里总在；内置的生态本来就在世界里）
  builtin?(): readonly T[];
  // 启用（新建或整份换掉）、停用的命令。没有 enable 的种类只能列出来
  enable?(item: T, world: ContentWorld): Command;
  disable?(id: string, world: ContentWorld): Command;
  // store 为 'content' 的种类：改了一项重算到哪一层（before / after 为 undefined 是新加 / 停用）
  dirty?(before: T | undefined, after: T | undefined, world: ContentWorld): DirtyLevel;
  // store 为 'content' 的种类：启用前的检查（不行就抛 CommandError），一个世界最多几项
  check?(item: T, world: ContentWorld): void;
  maxInWorld?: number;
  // 通用编辑器的字段表
  fields: readonly FieldDesc[];
  // 新建一项时的样子（编辑器的“新建”）
  blank?(): T;
  pack: PackSpec<T>;
}

const KINDS = new Map<string, ContentKind>();
let version = 0;

// 登记一种内容（同一个 id 再登记一次是整份换掉）
export function registerKind<T>(kind: ContentKind<T>): void {
  KINDS.set(kind.id, kind as unknown as ContentKind);
  version++;
}

// 改一种已登记的内容的几项（测试、以后的轮次补上命令时用）
export function updateKind(id: string, patch: Partial<ContentKind>): void {
  const cur = KINDS.get(id);
  if (!cur) throw new Error(`没有登记的内容种类：${id}`);
  KINDS.set(id, { ...cur, ...patch, pack: { ...cur.pack, ...patch.pack } });
  version++;
}

// 去掉一种（测试用）
export function unregisterKind(id: string): void {
  if (KINDS.delete(id)) version++;
}

// 登记表变了没有（packs.ts 按它缓存顶层格式）
export const registryVersion = (): number => version;

// 全部种类，按登记的先后（列表、检查的先后）
export function allKinds(): ContentKind[] {
  return [...KINDS.values()];
}

export function kindOf(id: string): ContentKind | undefined {
  return KINDS.get(id);
}

// 资源包里的段名（或别名）是哪一种
export function kindByPackKey(key: string): ContentKind | undefined {
  for (const k of KINDS.values()) if (k.pack.key === key || k.pack.aliases?.includes(key)) return k;
  return undefined;
}

export const itemId = (kind: ContentKind, item: unknown): string => (kind.idOf ? kind.idOf(item) : String((item as { id?: unknown }).id ?? ''));
export const itemName = (kind: ContentKind, item: unknown): string => {
  if (kind.nameOf) return kind.nameOf(item);
  const n = (item as { name?: unknown }).name;
  return typeof n === 'string' && n ? n : itemId(kind, item);
};

// ---------- small.content 里的种类 ----------

// 世界里这一种启用的项（store 为 'content' 的种类）
export function contentItems<T = unknown>(small: Pick<Partial<World['small']>, 'content'>, kind: string): Record<string, T> {
  return (small.content?.[kind] ?? {}) as Record<string, T>;
}

// 启用（或整份换掉）一项的命令
export function enableCommand(kind: ContentKind, item: unknown, world: ContentWorld): Command {
  if (kind.enable) return kind.enable(item, world);
  if (kind.store === 'content') return { op: 'set_content', kind: kind.id, id: itemId(kind, item), item: item as Record<string, unknown> };
  throw new Error(`${kind.label}不能启用`);
}

// 停用一项的命令
export function disableCommand(kind: ContentKind, id: string, world: ContentWorld): Command {
  if (kind.disable) return kind.disable(id, world);
  if (kind.store === 'content') return { op: 'set_content', kind: kind.id, id, item: null };
  throw new Error(`${kind.label}不能停用`);
}

// 这一项在世界里启用了没有
export function isEnabled(kind: ContentKind, world: ContentWorld, id: string): boolean {
  return kind.inWorld(world).some((x) => itemId(kind, x) === id);
}
