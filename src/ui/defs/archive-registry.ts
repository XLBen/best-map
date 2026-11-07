import type { ComponentType } from 'preact';
import type { sheet } from '../../state';

// 右边抽屉里的档案（第七十轮）：国家、城市（地标、点）、集团（第七十二轮：生态类型不在抽屉里了，是资源库里那种生态的页面）。shell/Sheet.tsx 按 sheet 的值从这里取标题和内容，
// 不引用具体的档案；各档案在自己的模块末尾 registerArchive 登记，register-all.tsx 把它们都引用一次（与 panel-registry.ts 一样）

export type SheetKind = NonNullable<(typeof sheet)['value']>;
export const SHEET_KINDS = ['country', 'settle', 'bloc'] as const satisfies readonly SheetKind[];

// title：抽屉顶上写的（画的时候取，可以看选中的是哪一种）；body：抽屉里的内容
export interface ArchiveDef {
  title: () => string;
  body: ComponentType;
}

const archives = new Map<SheetKind, ArchiveDef>();

export function registerArchive(kind: SheetKind, def: ArchiveDef) {
  archives.set(kind, def);
}

export function archiveOf(kind: SheetKind): ArchiveDef {
  const a = archives.get(kind);
  if (!a) throw new Error(`没有登记的档案：${kind}（见 register-all.tsx）`);
  return a;
}

// 登记了的（测试查全不全）
export const registeredArchives = (): SheetKind[] => [...archives.keys()];
