import type { FieldDesc } from '../../../core/content/registry';
import type { Segment } from './page-segments';

// 常用 / 更多设置（第九十三轮）：一项的页面默认只露新手第一次打开最想改的——名字、颜色、两三个滑块和预览；
// 别的（字段表里写了 more 的）收起来：
//   - 一段里有常用的、也有 more 的：more 的几个在这一段最下面折叠着（“更多设置”）；
//   - 一段的字段全是 more（规则、脚本、换说法……）：整段收进页面底下的“更多设置”，和 id 放在一起。
// 哪些字段算 more 写在登记表（FieldDesc.more），一段是不是整个算 more 从字段推（自己画的段在 page-segments.ts 写 more）。
// 要不要都摊开只问一个函数（lib-prefs.ts 的 showAllSettings：第九十九轮的“完整界面”开关）。
// 哪里展开过照旧记在 panel-store.ts 的 openSegments 里（多两种键，见下）。不碰界面，测试直接调

// 页面底下的“更多设置”展开着
export const MORE_ID = '@more';
// 一段里的“更多设置”展开着
export const moreKey = (segId: string): string => `@more:${segId}`;

export interface FieldSplit {
  common: FieldDesc[];
  more: FieldDesc[];
}

// 一组字段分成常用的和更多的。all：都摊开（都算常用，先后不变）
export function splitMore(fields: readonly FieldDesc[], all: boolean): FieldSplit {
  if (all) return { common: [...fields], more: [] };
  return { common: fields.filter((f) => !f.more), more: fields.filter((f) => f.more) };
}

// 这一段整个算“更多设置”：自己写了的，或者有字段、而且全是 more 的（没有字段的自己画的段——示例——是常用的）
export const segmentIsMore = (seg: Pick<Segment, 'fields' | 'more'>): boolean => seg.more ?? (seg.fields.length > 0 && seg.fields.every((f) => f.more));

export interface SegmentSplit {
  // 平时就在页面上的几段
  main: Segment[];
  // 收进页面底下“更多设置”的几段
  more: Segment[];
}

export function splitSegments(segs: readonly Segment[], all: boolean): SegmentSplit {
  if (all) return { main: [...segs], more: [] };
  return { main: segs.filter((s) => !segmentIsMore(s)), more: segs.filter((s) => segmentIsMore(s)) };
}

// 页面底下的“更多设置”是不是展开着：自己点开过，或者里面有一段展开着（从别处直达那一段、“在地图上”的按钮要看那一段）
export function moreOpen(open: ReadonlySet<string>, more: readonly Pick<Segment, 'id'>[]): boolean {
  return open.has(MORE_ID) || more.some((s) => open.has(s.id));
}

// 点页面底下的“更多设置”：收起时里面展开着的几段也收起（不然它马上又算“展开着”）
export function toggleMore(open: ReadonlySet<string>, more: readonly Pick<Segment, 'id'>[]): Set<string> {
  const next = new Set(open);
  if (moreOpen(open, more)) {
    next.delete(MORE_ID);
    for (const s of more) next.delete(s.id);
  } else next.add(MORE_ID);
  return next;
}

// 收着时写的一句：里面是什么（最多三样）。“换说法、限谁用、偏海岸 等 9 项”
export function moreBrief(labels: readonly string[]): string {
  const uniq = [...new Set(labels.filter(Boolean))];
  if (!uniq.length) return '';
  const head = uniq.slice(0, 3).join('、');
  return uniq.length > 3 ? `${head} 等 ${uniq.length} 项` : head;
}

// 页面底下的“更多设置”收着时写的一句：各段的标题
export const moreSegmentsBrief = (more: readonly Pick<Segment, 'title'>[], withId: boolean): string => moreBrief([...more.map((s) => s.title), ...(withId ? ['id'] : [])]);
