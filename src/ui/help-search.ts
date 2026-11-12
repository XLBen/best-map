import type { World } from '../../core/world';
import type { Category, ToolId } from '../state';
import { CATEGORY_DEFS, TOOL_DEFS, toolKey } from './defs/tools';
import { HELP_KEYS, HELP_START, HELP_STEPS, HELP_TOUCH, type HelpItem } from './help-data';

// 帮助的两件事（第九十九轮，不碰界面的部件）：
//   - searchHelp：按字过滤步骤、工具、按键。几个词用空格隔开，都出现才算；不分大小写；
//   - nowHelp：帮助一打开最上面“现在这个工具”——这个工具自己的那一句，加上讲它、讲这一类的那几条

// 工具表里的一条，帮助要用到的那几样（由用的地方从工具表、类别表拿）
export interface HelpTool {
  id: ToolId;
  category: Category;
  // 类别的名字：地形、气候……
  group: string;
  name: string;
  short: string;
  how: string;
  // 数字键（没有的 0）
  key: number;
  // 平时收在这一排末尾的“还有 N 个”里
  more: boolean;
}

// 工具表里的每个工具。从不在那一排上的（“选生态的范围”：只从生态编辑器进）不列；“涂自定义场”没有场时也列着（搜得到，没有键）
export function helpTools(w: World | null): HelpTool[] {
  return (Object.keys(TOOL_DEFS) as ToolId[])
    .filter((id) => id !== 'range')
    .map((id) => {
      const d = TOOL_DEFS[id];
      return { id, category: d.category, group: CATEGORY_DEFS[d.category].label, name: d.name, short: d.short, how: d.how, key: toolKey(id, w), more: !!d.more };
    });
}

// 工具的那一行怎么写：“地形 · 画岛链：拖一条线，沿线长出一串岛（数字键 3；平时在这一排末尾的“还有 N 个”里）”
export function toolLine(t: HelpTool): string {
  const notes = [...(t.key ? [`数字键 ${t.key}`] : []), ...(t.more ? ['平时在这一排末尾的“还有 N 个”里'] : [])];
  return `${t.name}：${t.how}${notes.length ? `（${notes.join('；')}）` : ''}`;
}

const itemText = (it: string | HelpItem): string => (typeof it === 'string' ? it : it.text);
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

export interface HelpHits {
  // 搜的词（去掉两头的空格）
  q: string;
  start: string[];
  tools: HelpTool[];
  steps: { title: string; items: string[] }[];
  keys: (readonly [string, string])[];
  // 第一百轮：“触摸”一段里的
  touch: (readonly [string, string])[];
  total: number;
}

export function searchHelp(query: string, tools: readonly HelpTool[]): HelpHits {
  const q = query.trim();
  const words = norm(q).split(' ').filter(Boolean);
  const hit = (...texts: string[]) => {
    const hay = norm(texts.join(' '));
    return words.every((w) => hay.includes(w));
  };
  if (!words.length) return { q, start: [], tools: [], steps: [], keys: [], touch: [], total: 0 };
  const start = HELP_START.filter((t) => hit(t));
  const foundTools = tools.filter((t) => hit(t.group, t.name, t.short, t.how));
  // 步骤：标题对上的整步都算；不然看每一条
  const steps = HELP_STEPS.map((s) => ({ title: s.title, items: s.items.map(itemText).filter((t) => hit(t) || hit(s.title, t)) })).filter((s) => s.items.length > 0);
  const keys = HELP_KEYS.filter(([what, k]) => hit(what, k));
  const touch = HELP_TOUCH.filter(([what, how]) => hit('触摸 手指', what, how));
  return { q, start, tools: foundTools, steps, keys, touch, total: start.length + foundTools.length + steps.reduce((n, s) => n + s.items.length, 0) + keys.length + touch.length };
}

// 没搜到时说什么
export const noHitsText = (q: string): string => `没有找到“${q}”。换个短一点的词试试，比如“河”“保存”“撤销”`;

// “现在这个工具”最多列几条
export const NOW_MAX = 6;

export interface HelpNow {
  tool: HelpTool;
  // 讲这个工具、这一类的几条（先后：讲这个工具的、讲这一类的、这一类的那一步里没单独标的）
  items: string[];
}

export function nowHelp(tool: HelpTool, max = NOW_MAX): HelpNow {
  const own: string[] = [];
  const cat: string[] = [];
  const loose: string[] = [];
  for (const s of HELP_STEPS) {
    const about = !!s.cats?.includes(tool.category);
    for (const it of s.items) {
      if (typeof it === 'string') {
        if (about) loose.push(it);
      } else if (it.for.includes(tool.id)) own.push(it.text);
      else if (it.for.includes(tool.category)) cat.push(it.text);
    }
  }
  return { tool, items: [...own, ...cat, ...loose].slice(0, max) };
}
