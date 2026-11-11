import type { ImportPreview, ImportRow } from '../../../core/packs/closure';

// 从别的库添加时每一步的一句人话（第九十二轮）：勾了一项会连带什么、清单里是什么、不能选的为什么。
// 规则都是导入的闭包算好的（core/packs/closure.ts 的清单、import-gates.ts 的原因），这里只把它们说成话。不碰界面，测试直接调

type Row = Pick<ImportRow, 'name' | 'role' | 'because'>;

// “直隶人 要它”“封建君主制 里的”里的那个名字
const causeOf = (because: string): string | null => {
  const m = /^(.*) (要它|里的)$/.exec(because);
  return m ? m[1] : null;
};

// 每个名字连带了几项（清单里因为它才来的：它用到的、它下面的）。按清单记着，列表上每一行都要问
const memo = new WeakMap<object, Map<string, number>>();
export function bringsOf(rows: Iterable<Row>, holder: object): Map<string, number> {
  let m = memo.get(holder);
  if (m) return m;
  m = new Map();
  for (const r of rows) {
    if (r.role === 'pick') continue;
    for (const name of new Set(r.because.flatMap((b) => causeOf(b) ?? []))) m.set(name, (m.get(name) ?? 0) + 1);
  }
  memo.set(holder, m);
  return m;
}

// 勾着的一行下面的灰字：“勾了它，它用到的 3 样会一起带上”
export const bringsNote = (n: number): string => `勾了它，它用到的 ${n} 样会一起带上`;

// 已经有了的一行、这一种加不了的一行
export const haveNote = (here: string): string => `${here}已经有了`;
export const unpickableNote = (here: string): string => `这一种不能加到${here}`;

// 清单最上面的一句：“勾了 2 项，它们用到的 5 项一起带上，共添加 7 项”
export function basketLine(p: Pick<ImportPreview, 'rows' | 'count'>): string | null {
  if (!p.count) return null;
  const picked = p.rows.filter((r) => r.role === 'pick').length;
  const more = p.count - picked;
  if (!picked) return `共添加 ${p.count} 项`;
  return more > 0 ? `勾了 ${picked} 项，它们用到的 ${more} 项一起带上` : `勾了 ${picked} 项，没有连带别的`;
}
