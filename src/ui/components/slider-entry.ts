// 滑块能打字（第九十三轮）：点滑块右边的数就能输入确切的数。滑块只认识位置（0–1）和写出来的字，
// 所以打的数换成位置是在“每个位置写出来的数”里找最接近的那一个——直径、力度、百分比、带单位的都一样，不用每个滑块另写一遍反过来的换算。
// 只在回车、离开框时算一次（最多几百次 textAt），拖动的路上什么都不多做。不碰界面，测试直接调

// 字里的第一个数：“−4 °C”“约 120 km”“35%”“12,000 人/km²”“±0.30”。没有数时 null（“不限”“自动”）
export function firstNumber(text: string): number | null {
  const m = /[-−–]?\s*\d[\d,]*(?:\.\d+)?|[-−–]?\s*\.\d+/.exec(text);
  if (!m) return null;
  const s = m[0].replace(/[−–]/, '-').replace(/[\s,]/g, '');
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

// 框里先写的字：现在的数（没有数时空着）
export function entryText(text: string): string {
  const v = firstNumber(text);
  return v === null ? '' : String(v);
}

// 打的字是不是一个数：全角的数字、负号、小数点、逗号都认，后面带单位也行（“35%”“120km”）；不是数时 null
export function parseEntry(raw: string): number | null {
  const s = raw
    .trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[．。]/g, '.')
    .replace(/，/g, ',')
    .replace(/[－—]/g, '-');
  if (!/^[+\-−–]?\s*(\d|\.\d)/.test(s)) return null;
  return firstNumber(s.replace(/^\+/, ''));
}

export interface EntryHit {
  pos: number;
  // 停到的地方写的字
  text: string;
  // 打的数超出了滑块的范围：停在哪一头
  clamped: 'low' | 'high' | null;
}

const GRID = 64;
const ROUNDS = 3;

// 打的数 x 停在滑块的哪个位置：textAt(p) 是滑块在位置 p 写的字。先粗看一遍（也就知道了范围），再在最近的一格两边细看三遍。
// 写的字里没有数的位置（最左边的“不限”“自动”）不算。整条滑块都没有数时 null
export function posForNumber(textAt: (pos: number) => string, x: number): EntryHit | null {
  let lo = 0;
  let hi = 1;
  let best: { pos: number; d: number } | null = null;
  let min = Infinity;
  let max = -Infinity;
  for (let round = 0; round < ROUNDS; round++) {
    let at: { pos: number; d: number } | null = null;
    for (let k = 0; k <= GRID; k++) {
      const pos = lo + ((hi - lo) * k) / GRID;
      const v = firstNumber(textAt(pos));
      if (v === null) continue;
      if (round === 0) {
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
      const d = Math.abs(v - x);
      // 一样近时取先碰到的（一段位置写同一个数时停在这一段的开头，再细看时往里收）
      if (!at || d < at.d) at = { pos, d };
    }
    if (!at) break;
    if (!best || at.d <= best.d) best = at;
    const step = (hi - lo) / GRID;
    lo = Math.max(0, best.pos - step);
    hi = Math.min(1, best.pos + step);
  }
  if (!best) return null;
  return { pos: best.pos, text: textAt(best.pos), clamped: x < min ? 'low' : x > max ? 'high' : null };
}

// 超出范围时说的一句
export const clampNote = (hit: Pick<EntryHit, 'text' | 'clamped'>): string | null => (hit.clamped === 'low' ? `最小 ${hit.text}` : hit.clamped === 'high' ? `最大 ${hit.text}` : null);
