import type { FieldDesc } from '../../../core/content/registry';
import { type CountryPattern, patternModule } from '../../../core/human';
import { AMOUNT_MAX } from '../../../core/human/countries/patterns/index';
import type { Obj } from './fields';

// 资源库里时代页面的“国家”一段（第七十五轮）：时代列的国家格局一种一个“多少”的滑块，能加、能去掉；“文化的倒向”（nationalism）一个滑块。
// 改了都是整个时代换掉（page-actions.ts 的 commitItem：本世界一条命令，我的库走它的撤销，只读的不动）。不碰界面，测试直接调

// 能加的格局（本世界的、这个库里的）
export type PatternChoice = Pick<CountryPattern, 'id' | 'name' | 'module' | 'amount' | 'description'>;

export interface EraPatternRow {
  // 时代的 patterns 里第几条
  index: number;
  id: string;
  name: string;
  // 现在的多少：时代写的，没写时格局自己的
  amount: number;
  // 时代自己写了多少
  own: boolean;
  // “多少”是什么意思（模块的）
  hint: string;
  // 这里没有这一种格局（生成时不算）
  missing: boolean;
}

export const MAX_ERA_PATTERNS = 16;

type EraPatternEntry = { pattern: string; amount?: number };
const listOf = (era: Obj): EraPatternEntry[] => (Array.isArray(era.patterns) ? (era.patterns as EraPatternEntry[]) : []);

export function eraPatternRows(era: Obj, choices: readonly PatternChoice[]): EraPatternRow[] {
  return listOf(era).map((e, index) => {
    const p = choices.find((c) => c.id === e.pattern);
    const m = p ? patternModule(p.module) : undefined;
    return {
      index,
      id: e.pattern,
      name: p?.name ?? e.pattern,
      amount: e.amount ?? p?.amount ?? 0,
      own: e.amount !== undefined,
      hint: m ? `${m.name}：${m.amountHint}` : '这里没有这一种格局，生成时不算',
      missing: !p,
    };
  });
}

// 还能加的（没列的）；满了时没有
export function addablePatterns(era: Obj, choices: readonly PatternChoice[]): PatternChoice[] {
  const list = listOf(era);
  if (list.length >= MAX_ERA_PATTERNS) return [];
  const listed = new Set(list.map((e) => e.pattern));
  return choices.filter((c) => !listed.has(c.id));
}

const withList = (era: Obj, list: EraPatternEntry[]): Obj => {
  const next: Obj = { ...era, patterns: list };
  if (!list.length) delete next.patterns;
  return next;
};

// 第 index 条的多少（时代自己写下来）
export function withPatternAmount(era: Obj, index: number, amount: number): Obj {
  return withList(
    era,
    listOf(era).map((e, k) => (k === index ? { pattern: e.pattern, amount } : e)),
  );
}

// 去掉第 index 条（都去掉时不写 patterns：没有帝国、联邦、同盟，附庸照旧）
export function withoutPattern(era: Obj, index: number): Obj {
  return withList(
    era,
    listOf(era).filter((_, k) => k !== index),
  );
}

// 加一种（多少用格局自己的）；已经列了、满了时 null
export function withPattern(era: Obj, id: string): Obj | null {
  const list = listOf(era);
  if (list.length >= MAX_ERA_PATTERNS || list.some((e) => e.pattern === id)) return null;
  return withList(era, [...list, { pattern: id }]);
}

export function withNationalism(era: Obj, v: number | undefined): Obj {
  const next: Obj = { ...era };
  if (v === undefined) delete next.nationalism;
  else next.nationalism = v;
  return next;
}

// 滑块的字段（画成和别的字段一样的滑块）
export const amountField = (r: Pick<EraPatternRow, 'name' | 'hint'>): FieldDesc => ({ key: 'amount', label: r.name, type: 'number', min: 0, max: AMOUNT_MAX, step: 0.1, hint: r.hint });
export const NATIONALISM_FIELD: FieldDesc = { key: 'nationalism', label: '文化的倒向', type: 'number', optional: true, min: 0, max: 1, step: 0.05, hint: '民族主义：越大，国界越跟着文化走' };
