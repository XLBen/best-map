import type { Species } from '../../core/species';
import { rangeMask } from '../../core/vegetation';
import type { World } from '../../core/world';

// 第十二轮修：涂到生态的范围（只在一个岛上 / 圈的范围里）外面时怎么说。范围外的格怎么调冷暖干湿都长不出来，
// 所以这条原因排在气候的原因前面：“不在这个生态的范围里（只长在「X岛」）”。
// 岛的名字现查（改名字不重算冲突，不能写进引擎算好的冲突里）

// 范围说的是哪里：「岛名」/ 设定的岛上 / 圈的范围里；没有范围时为 null
export function rangePlace(w: World, sp: Pick<Species, 'range'>): string | null {
  const r = sp.range;
  if (!r) return null;
  if (r.kind === 'cells') return '圈的范围里';
  const f = w.derived.features.find((x) => (x.type === 'island' || x.type === 'continent') && !!x.name && Array.prototype.includes.call(x.cells, r.cell));
  return f ? `「${f.name}」` : '设定的岛上';
}

// “不在这个生态的范围里（只长在「X岛」）”；没有范围时为 null
export function outsideRangeText(w: World, sp: Pick<Species, 'range'>): string | null {
  const place = rangePlace(w, sp);
  return place ? `不在这个生态的范围里（只长在${place}）` : null;
}

// 这些格（没涂成的格）大多在生态的范围外时，返回该怎么说；不是时为 null
export function outsideRangeReason(w: World, sp: Pick<Species, 'range'> | undefined, cells: readonly number[]): string | null {
  if (!sp?.range || !cells.length) return null;
  const mask = rangeMask(w, sp);
  if (!mask) return null;
  let out = 0;
  for (const i of cells) if (!mask[i]) out++;
  return out * 2 > cells.length ? outsideRangeText(w, sp) : null;
}
