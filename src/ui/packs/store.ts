import { signal } from '@preact/signals';
import type { PackPicks, PackRead, ResourcePack } from '../../../core/packs';
import type { FoundScript } from '../../../core/script';
import { refreshLibrary } from '../../library';

// 资源包的界面状态：资源库弹窗（列表、导入、导出）、“用到这个世界”的卡片、信任的问话。
// 都是点了才开（世界菜单的“资源包…”、生态抽屉的“添加示例生态…”、导入文件），不会自己弹出来

export type DialogView =
  | { view: 'library' }
  // 导入：读好的文件（只解析、检查过，没运行任何脚本）；installed：已经装进资源库
  | { view: 'import'; read: PackRead; file: string; installed?: string }
  | { view: 'export' };

export const packDialog = signal<DialogView | null>(null);

export function openPackLibrary() {
  void refreshLibrary();
  packDialog.value = { view: 'library' };
}

// 文件名去掉 .map2pack.json、.json：旧的生态文件没有名字，用它
export const fileLabel = (name: string) => name.replace(/(\.map2pack)?\.json$/i, '');

// 导入一个读好的文件（资源包，或旧的生态、文字包文件）：列出内容、问题和脚本，等用户确认
export function openPackImport(read: PackRead, file: string) {
  void refreshLibrary();
  packDialog.value = { view: 'import', read, file };
}

// 用到这个世界：一张不挡地图的卡片（地图上画出用了之后的样子）。
// only：只列生态（生态抽屉里的“添加示例生态…”）
export interface ApplyState {
  pack: ResourcePack;
  picks: PackPicks;
  only?: 'biomes';
}

export const packApply = signal<ApplyState | null>(null);

export function openPackApply(pack: ResourcePack, picks: PackPicks, only?: 'biomes') {
  packDialog.value = null;
  packApply.value = { pack, picks, ...(only ? { only } : {}) };
}

// 信任的问话（旧的生态文件里带脚本时）：列出脚本，答“信任”或“取消”。what：问的是什么（“生态文件”）
export interface TrustAsk {
  what: string;
  scripts: FoundScript[];
  ok: string;
  resolve: (yes: boolean) => void;
}

export const trustAsk = signal<TrustAsk | null>(null);

export function askTrust(scripts: FoundScript[], what = '文件', ok = '信任并导入'): Promise<boolean> {
  trustAsk.value?.resolve(false);
  return new Promise((resolve) => {
    trustAsk.value = {
      what,
      scripts,
      ok,
      resolve: (yes) => {
        trustAsk.value = null;
        resolve(yes);
      },
    };
  });
}
