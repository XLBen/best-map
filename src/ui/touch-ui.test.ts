import { afterEach, describe, expect, it } from 'vitest';
import { continents } from '../../core/testing/fixtures';
import { tool, world } from '../state';
import { TOUCH_TEXT } from './copy';
import { TOOL_DEFS, type ToolId, setTool } from './defs/tools';
import { HELP_KEYS, HELP_TOUCH } from './help-data';
import { helpTools, searchHelp } from './help-search';
import { NARROW_PX, fingerPans, held, howForTouch, noteTouch, parseTouch, penPressure, penSeen, releaseHeld, resetTouchUi, setFingerPans, setHeld, setPenPressure, touchUi } from './touch-ui';
// 每个工具的吸管、橡皮擦登记在这里
import './tools/bind';

// 第一百轮：触摸与平板。这台设备是不是在用手指 / 笔、用笔的人的两个偏好、屏幕上代替 Shift / Alt 的开关，
// 和“没有键盘的人做不了的事都有按钮”的那张表

afterEach(() => {
  resetTouchUi();
  tool.value = 'land';
});

describe('存着的偏好', () => {
  it('读回来：不认识的、坏了的都当没开', () => {
    expect(parseTouch(null)).toEqual({ pen: false, fingerPans: false, penPressure: false });
    expect(parseTouch('{')).toEqual({ pen: false, fingerPans: false, penPressure: false });
    expect(parseTouch('null')).toEqual({ pen: false, fingerPans: false, penPressure: false });
    expect(parseTouch(JSON.stringify({ pen: true, fingerPans: 1, penPressure: true, more: 3 }))).toEqual({ pen: true, fingerPans: false, penPressure: true });
  });

  it('没用过笔时两个偏好不起作用（手指不画了又没有笔：会被困住）；用过笔才算', () => {
    setFingerPans(true);
    setPenPressure(true);
    expect(penSeen()).toBe(false);
    expect(fingerPans()).toBe(false);
    expect(penPressure()).toBe(false);
    noteTouch('pen');
    expect(penSeen()).toBe(true);
    expect(fingerPans()).toBe(true);
    expect(penPressure()).toBe(true);
    setFingerPans(false);
    expect(fingerPans()).toBe(false);
  });

  it('默认都关', () => {
    noteTouch('pen');
    expect(fingerPans()).toBe(false);
    expect(penPressure()).toBe(false);
  });
});

describe('该不该露出给触摸补的按钮', () => {
  it('鼠标下不露；手指或笔点过一次就露；主要的指针是粗的也露', () => {
    expect(touchUi()).toBe(false);
    noteTouch('mouse');
    noteTouch('');
    expect(touchUi()).toBe(false);
    noteTouch('touch');
    expect(touchUi()).toBe(true);
    expect(penSeen()).toBe(false);
    resetTouchUi({ coarse: true });
    expect(touchUi()).toBe(true);
  });

  it('手机的宽度有名字', () => {
    expect(NARROW_PX).toBe(600);
    expect(TOUCH_TEXT.narrow).toContain('平板或电脑');
  });
});

describe('屏幕上代替 Shift / Alt 的开关', () => {
  it('开、关；换工具就关上', () => {
    world.value = continents().world;
    setTool('pselect');
    setHeld('shift', true);
    expect(held.value).toEqual({ shift: true, alt: false });
    // 值没变不换对象（地图上每个事件都读它）
    const same = held.value;
    setHeld('shift', true);
    expect(held.value).toBe(same);
    setTool('pselect');
    expect(held.value.shift).toBe(true);
    setTool('land');
    expect(held.value).toEqual({ shift: false, alt: false });
    setHeld('alt', true);
    releaseHeld();
    expect(held.value).toEqual({ shift: false, alt: false });
  });

  it('工具表里写了 mods 的：开关上的字短、悬停里有一句', () => {
    const withMods = (Object.keys(TOOL_DEFS) as ToolId[]).filter((id) => TOOL_DEFS[id].mods);
    expect(withMods.sort()).toEqual(['hearth', 'pselect', 'river']);
    for (const id of withMods) {
      for (const m of Object.values(TOOL_DEFS[id].mods!)) {
        expect(m.label.length).toBeLessThanOrEqual(4);
        expect(m.title.length).toBeGreaterThan(4);
        expect(m.title).not.toMatch(/Shift|Alt/);
      }
    }
    expect(TOOL_DEFS.pselect.mods?.shift?.label).toBe('多选');
    expect(TOOL_DEFS.river.mods?.alt?.label).toBe('汇入');
  });
});

// 没有键盘的人做不了的事：每一项在屏幕上有什么。工具的那一句里提到 Shift / Alt 的，都要对得上一种屏幕上的做法
describe('修饰键在屏幕上都有按钮', () => {
  // Shift：画笔的“反过来”在底部条上有模式选择（那个选项的键），人口笔刷的力度能拖到负的；选省份的多选是这一轮补的开关
  const SHIFT: Partial<Record<ToolId, string>> = { land: 'landMode', temp: 'tempMode', moist: 'moistMode', pselect: 'mods' };
  it('那一句里写着 Shift 的工具：底部条上有模式选择，或有开关', () => {
    const w = continents().world;
    const mention = (Object.keys(TOOL_DEFS) as ToolId[]).filter((id) => /Shift/.test(TOOL_DEFS[id].how));
    expect(mention.sort()).toEqual(Object.keys(SHIFT).sort());
    for (const id of mention) {
      const d = TOOL_DEFS[id];
      if (SHIFT[id] === 'mods') expect(d.mods?.shift, id).toBeTruthy();
      else expect((d.bar?.(w) ?? []).some((it) => it.kind === 'choice' && it.key === SHIFT[id]), id).toBe(true);
    }
  });

  it('那一句里写着 Alt 的工具：都是吸取，底部条上有吸管', () => {
    const mention = (Object.keys(TOOL_DEFS) as ToolId[]).filter((id) => /Alt/.test(TOOL_DEFS[id].how));
    expect(mention.length).toBeGreaterThan(5);
    for (const id of mention) {
      expect(TOOL_DEFS[id].how, id).toMatch(/Alt\+点击吸取/);
      expect(typeof TOOL_DEFS[id].pick, id).toBe('function');
    }
  });

  it('底部条最下面的那一句（手指没有悬停）不讲键盘', () => {
    for (const id of Object.keys(TOOL_DEFS) as ToolId[]) {
      const t = howForTouch(TOOL_DEFS[id].how);
      expect(t.length, id).toBeGreaterThan(3);
      expect(t, id).not.toMatch(/Shift|Alt|Delete|Esc/);
    }
    expect(howForTouch('按住涂陆地或海；Shift 反过来')).toBe('按住涂陆地或海');
    expect(howForTouch('点击选中省份；Shift+点击多选，合并或划给某国')).toBe('点击选中省份');
    expect(howForTouch('拖一条线，沿线长出一串岛')).toBe('拖一条线，沿线长出一串岛');
    // 整句都在讲键盘的不删成空的
    expect(howForTouch('按住 Shift 拖')).toBe('按住 Shift 拖');
  });
});

describe('帮助里的“触摸”一段', () => {
  it('写着怎么画、怎么移动缩放、画到一半不要了、长按、笔', () => {
    const all = HELP_TOUCH.map(([a, b]) => `${a} ${b}`).join('\n');
    for (const word of ['一根手指', '两根手指', '捏合', '第二根手指', '长按', '钉住', '笔', '手指只移动地图', '多选', '汇入', '看全图']) expect(all, word).toContain(word);
    // 左边一栏不重复，也不和“按键”的那一栏撞名
    const names = HELP_TOUCH.map(([a]) => a);
    expect(new Set(names).size).toBe(names.length);
    for (const [k] of HELP_KEYS) expect(names).not.toContain(k);
  });

  it('搜得到', () => {
    const tools = helpTools(continents().world);
    expect(searchHelp('长按', tools).touch.map(([a]) => a)).toEqual(['长按']);
    expect(searchHelp('触摸', tools).touch.length).toBe(HELP_TOUCH.length);
    expect(searchHelp('手指', tools).touch.length).toBe(HELP_TOUCH.length);
    const h = searchHelp('捏合', tools);
    expect(h.touch.length).toBe(1);
    expect(h.total).toBeGreaterThanOrEqual(h.touch.length + h.keys.length);
    expect(searchHelp('', tools).touch).toEqual([]);
  });
});

describe('这一轮的字', () => {
  it('短、不写“系统”“其实”这些', () => {
    for (const [k, v] of Object.entries(TOUCH_TEXT)) {
      expect(v, k).not.toMatch(/真的|直接|其实|系统|一下|真正/);
    }
    for (const k of ['fit', 'measureBack', 'hideUi', 'showUi', 'fingerPans', 'penPressure'] as const) expect(TOUCH_TEXT[k].length, k).toBeLessThanOrEqual(9);
  });
});
