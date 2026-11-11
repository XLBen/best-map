import type { Command } from '../../../core/commands';
import type { IslandType } from '../../../core/island-types';
import { type MapStyle, styleRgba } from '../../../core/map-style';
import { packFileName } from '../../../core/packs';
import { type NoteAction, askUser, download, execAdjust, knowIsolation, openPanel, openWaterTypeEditor } from '../../state';
import { trustScripts, untrustedScripts } from '../../trust';
import { scriptTrustText } from '../copy';
import { category, setTool } from '../defs/tools';
import { islandSwatch, requestIslandTypeEditor } from '../panels/island-types';
import { type ItemRow, itemPack } from './rows';
import { isolationNote } from './script-trust';

// 面板里一行的样子（色块、示例名字）和按钮做的事（先问脚本、存进资源库、导出、打开详细编辑）

// 没信任过的脚本先问，然后做这条命令
export async function runTrusted(cmd: Command, busy: string, note?: { head?: string; action?: NoteAction }): Promise<boolean> {
  const list = await untrustedScripts(cmd);
  if (list.length) {
    await knowIsolation();
    const v = await askUser({
      title: '信任脚本',
      text: `${scriptTrustText(list.length)}${isolationNote()}`,
      scripts: list,
      choices: [
        { value: 'ok', label: '信任并启用', primary: true },
        { value: 'cancel', label: '取消' },
      ],
    });
    if (v !== 'ok') return false;
    await trustScripts(list);
  }
  return execAdjust(cmd, busy, note);
}

// ---------- 一行的样子 ----------

// 画风的色块（第三十八轮）：左上是陆地（平常的陆地色混上底色），右下是海（分层的海取第二层，不然取平常的海色）
const PLAIN_LAND = [157, 176, 122];
const PLAIN_SEA = '#4f7fa8';
function mapStyleSwatch(s: MapStyle): string {
  const t = styleRgba(s.landTint);
  const k = t ? s.landTintAmount : 0;
  const land = PLAIN_LAND.map((v, i) => Math.round(v + ((t?.[i] ?? v) - v) * k));
  const sea = s.sea === 'tiers' ? s.tier2 : PLAIN_SEA;
  return `linear-gradient(135deg, rgb(${land.join(', ')}) 50%, ${sea} 50%)`;
}

export function swatchOf(row: Pick<ItemRow, 'kind' | 'item'>): string | null {
  if (row.kind.id === 'islandType') return islandSwatch(row.item as IslandType);
  if (row.kind.id === 'mapStyle') return mapStyleSwatch(row.item as MapStyle);
  const c = (row.item as { color?: unknown }).color;
  return typeof c === 'string' && c.startsWith('#') ? c : null;
}

// 几个示例名字（地名风格）：每类地物的第一个，最多三类
const sampleCache = new WeakMap<object, string>();
export function sampleLine(row: ItemRow): string {
  const it = row.item as object;
  let s = sampleCache.get(it);
  if (s === undefined) {
    try {
      s = (row.kind.samples?.(row.item, 1) ?? [])
        .slice(0, 3)
        .map((g) => g.lines[0])
        .filter(Boolean)
        .join('、');
    } catch {
      s = '';
    }
    sampleCache.set(it, s);
  }
  return s;
}

// ---------- 一项 ----------

// 单独这一项导出成文件
export const exportRow = (row: ItemRow) => {
  const pack = itemPack(row);
  download(packFileName(pack), JSON.stringify(pack, null, 2), 'application/json');
};

// 生态、河、湖、岛的详细编辑（图表、脚本检查；改的是世界里的那一项）
export function openDedicated(row: ItemRow) {
  const wid = row.status.worldId ?? row.id;
  switch (row.kind.id) {
    case 'riverType':
    case 'lakeType':
      openWaterTypeEditor(row.kind.id === 'riverType' ? 'river' : 'lake', wid);
      return;
    case 'islandType':
      if (category.value !== 'terrain') setTool('island');
      requestIslandTypeEditor(wid);
      openPanel.value = 'cat:terrain';
      return;
  }
}
