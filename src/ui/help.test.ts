import { afterEach, describe, expect, it } from 'vitest';
import { continents } from '../../core/testing/fixtures';
import { CATEGORIES, TOOL_DEFS, type ToolId } from './defs/tools';
import { HELP_KEYS, HELP_START, HELP_STEPS } from './help-data';
import { NOW_MAX, helpTools, noHitsText, nowHelp, searchHelp, toolLine } from './help-search';
import { HELP_START as FROM_HELP } from './Help';
import { setFullUi } from './ui-prefs';

// 第九十九轮：帮助能搜、一打开先看现在这个工具（help-search.ts）；字在 help-data.ts，Help.tsx 照旧导出 HELP_START

afterEach(() => setFullUi(false));

const tools = () => helpTools(continents().world);
const tool = (id: ToolId) => tools().find((t) => t.id === id)!;

describe('帮助里的字', () => {
  it('“怎么开始”还是四句，Help.tsx 照旧导出它', () => {
    expect(HELP_START).toHaveLength(4);
    expect(FROM_HELP).toBe(HELP_START);
  });

  it('每一步的标题不重复；标的工具、类别都是真的', () => {
    const titles = HELP_STEPS.map((s) => s.title);
    expect(new Set(titles).size).toBe(titles.length);
    const known = new Set<string>([...Object.keys(TOOL_DEFS), ...CATEGORIES.map((c) => c.id)]);
    for (const s of HELP_STEPS) {
      for (const c of s.cats ?? []) expect(known.has(c), `${s.title} 的 ${c}`).toBe(true);
      for (const it of s.items) if (typeof it !== 'string') for (const f of it.for) expect(known.has(f), `${it.text} 的 ${f}`).toBe(true);
    }
  });

  it('写着简单界面和完整界面：藏着什么、怎么打开', () => {
    const all = HELP_STEPS.flatMap((s) => s.items.map((it) => (typeof it === 'string' ? it : it.text))).join('\n');
    expect(all).toContain('还有 N 个');
    expect(all).toContain('更多 → 偏好 → 完整界面');
    expect(all).toContain('只留常用的');
    expect(all).toContain('划分过省份');
  });

  it('字里没有过时的叫法', () => {
    const all = [...HELP_START, ...HELP_STEPS.flatMap((s) => [s.title, ...s.items.map((it) => (typeof it === 'string' ? it : it.text))]), ...HELP_KEYS.flat()].join('\n');
    for (const old of ['上手说明', '资源包', '新' + '世界…', '新' + '建地图', '新' + '地图', '比重', '原文', '维度', '高级']) expect(all, old).not.toContain(old);
  });
});

describe('搜帮助', () => {
  it('空的、只有空格：什么都不算搜', () => {
    expect(searchHelp('', tools()).total).toBe(0);
    expect(searchHelp('   ', tools()).total).toBe(0);
  });

  it('搜工具：名字、类别、怎么用都搜得到；写着数字键和“平时收在哪”', () => {
    const h = searchHelp('岛链', tools());
    expect(h.tools.map((t) => t.id)).toContain('chain');
    expect(toolLine(tool('chain'))).toBe('画岛链：拖一条线，沿线长出一串岛（数字键 3；平时在这一排末尾的“还有 N 个”里）');
    expect(toolLine(tool('land'))).toBe('画陆地 / 海：按住涂陆地或海；Shift 反过来（数字键 1）');
    expect(searchHelp('水系', tools()).tools.map((t) => t.id)).toEqual(['river', 'lake', 'unwater']);
    expect(searchHelp('吸取', tools()).tools.length).toBeGreaterThan(3);
    // 从不在那一排上的不列；没有场时“涂自定义场”也搜得到（没有键）
    expect(tools().some((t) => t.id === 'range')).toBe(false);
    expect(searchHelp('自定义场', tools()).tools.map((t) => [t.id, t.key])).toEqual([['field', 0]]);
  });

  it('搜步骤和按键；几个词都出现才算；不分大小写', () => {
    const undo = searchHelp('撤销', tools());
    expect(undo.keys.map((k) => k[0])).toContain('撤销 / 重做');
    expect(undo.steps.length).toBeGreaterThan(0);
    expect(searchHelp('esc', tools()).keys.map((k) => k[0])).toContain('关闭、取消、取消选择');
    const two = searchHelp('完整界面 偏好', tools());
    expect(two.steps.flatMap((s) => s.items).every((t) => t.includes('完整界面') && t.includes('偏好'))).toBe(true);
    expect(two.total).toBeGreaterThan(0);
    // 标题对上的那一步，整步的每一条都算
    const rivers = searchHelp('河与湖', tools());
    expect(rivers.steps.find((s) => s.title === '河与湖')!.items).toHaveLength(HELP_STEPS.find((s) => s.title === '河与湖')!.items.length);
    expect(searchHelp('缩略图', tools()).start).toHaveLength(1);
  });

  it('没搜到：数是 0，说一句人话', () => {
    const h = searchHelp('  量子纠缠 ', tools());
    expect(h.total).toBe(0);
    expect(noHitsText(h.q)).toBe('没有找到“量子纠缠”。换个短一点的词试试，比如“河”“保存”“撤销”');
  });
});

describe('现在这个工具', () => {
  it('画河：先是讲画河的几条，不超过六条', () => {
    const now = nowHelp(tool('river'));
    expect(now.items).toHaveLength(NOW_MAX);
    expect(now.items[0]).toBe('从河上起笔改河，别处起笔画新河');
    expect(now.items).not.toContain('用“放湖”点湖选中它');
  });

  it('放湖：先是讲它的那一条，再是讲水系的', () => {
    expect(nowHelp(tool('lake')).items.slice(0, 2)).toEqual(['用“放湖”点湖选中它', '“水系 ⋯”里有河流列表和水体类型；点一种、“新建类型…”都是打开资源库里的那一页来改']);
  });

  it('省份的工具只看省份的几条，不带地名的；剪刀自己的那一条在最前面', () => {
    const cut = nowHelp(tool('pcut')).items;
    expect(cut[0]).toBe('剪刀画线切开省份');
    expect(cut.some((t) => t.includes('地名”里点名字'))).toBe(false);
    expect(nowHelp(tool('rename')).items.every((t) => t.includes('地名'))).toBe(true);
  });

  it('每个工具都有自己的那一句；有世界时每一类至少有一条可看的（指针也有）', () => {
    for (const t of tools()) {
      expect(toolLine(t).startsWith(`${t.name}：`), t.id).toBe(true);
      expect(nowHelp(t).items.length, t.id).toBeGreaterThan(0);
    }
  });
});
