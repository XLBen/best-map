import { afterEach, describe, expect, it, vi } from 'vitest';

// ⌘S / Ctrl+S：不让浏览器弹出“存储网页”，存进“我的地图”；⇧⌘S 另存为；向导开着时不保存

const saved = vi.hoisted(() => ({ save: vi.fn(async () => true), saveAs: vi.fn(async () => true) }));
vi.mock('../maps/store', async () => {
  const { signal } = await import('@preact/signals');
  return { mapsDialog: signal(false), saveMap: saved.save, saveMapAs: saved.saveAs };
});

const { onKeyDown } = await import('./keys');
const { helpOpen, openPanel, world, wizardOpen } = await import('../../state');

const key = (k: string, mods: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; repeat?: boolean; target?: unknown } = {}) => {
  const e = { key: k, code: `Key${k.toUpperCase()}`, target: null, repeat: false, altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, ...mods, preventDefault: vi.fn() };
  onKeyDown(e as unknown as KeyboardEvent);
  return e;
};

afterEach(() => {
  saved.save.mockClear();
  saved.saveAs.mockClear();
  wizardOpen.value = false;
  world.value = null;
  helpOpen.value = false;
  openPanel.value = null;
});

describe('⌘S', () => {
  it('没有世界时也不弹出浏览器的“存储网页”', () => {
    expect(key('s', { metaKey: true }).preventDefault).toHaveBeenCalled();
    expect(saved.save).not.toHaveBeenCalled();
  });

  it('⌘S、Ctrl+S 保存，⇧⌘S 另存为', () => {
    world.value = {} as never;
    expect(key('s', { metaKey: true }).preventDefault).toHaveBeenCalled();
    expect(key('s', { ctrlKey: true }).preventDefault).toHaveBeenCalled();
    expect(saved.save).toHaveBeenCalledTimes(2);
    expect(key('S', { metaKey: true, shiftKey: true }).preventDefault).toHaveBeenCalled();
    expect(saved.saveAs).toHaveBeenCalledTimes(1);
  });

  it('向导开着时不保存；不按 ⌘ 的 S 不管', () => {
    world.value = {} as never;
    wizardOpen.value = true;
    expect(key('s', { metaKey: true }).preventDefault).toHaveBeenCalled();
    expect(saved.save).not.toHaveBeenCalled();
    wizardOpen.value = false;
    expect(key('s').preventDefault).not.toHaveBeenCalled();
    expect(saved.save).not.toHaveBeenCalled();
  });
});

// 第九十八轮：? 开关帮助——没有世界、向导开着时也行；正在框里打字时是打字
describe('? 键', () => {
  it('没有世界、向导开着时也能开；再按关上', () => {
    wizardOpen.value = true;
    expect(key('?', { shiftKey: true }).preventDefault).toHaveBeenCalled();
    expect(helpOpen.value).toBe(true);
    key('?', { shiftKey: true });
    expect(helpOpen.value).toBe(false);
  });

  it('有世界时也一样；开的时候把弹出面板关上；全角的 ？ 也算', () => {
    world.value = {} as never;
    openPanel.value = 'more';
    key('？');
    expect(helpOpen.value).toBe(true);
    expect(openPanel.value).toBeNull();
    key('?');
    expect(helpOpen.value).toBe(false);
  });

  it('在输入框、文本域、下拉、可编辑的地方打 ? 不触发，也不拦这个键', () => {
    for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true }]) {
      const e = key('?', { shiftKey: true, target });
      expect(helpOpen.value).toBe(false);
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
  });

  it('带 ⌘、Ctrl、Alt 的不算；按住不放只算一次', () => {
    key('?', { metaKey: true });
    key('?', { ctrlKey: true });
    key('?', { altKey: true });
    expect(helpOpen.value).toBe(false);
    key('?');
    key('?', { repeat: true });
    key('?', { repeat: true });
    expect(helpOpen.value).toBe(true);
  });
});

// 第九十九轮：数字键按完整的那一排数。简单界面里藏着的工具按了它的键照样换过去，并且露在那一排上
describe('数字键（简单界面）', () => {
  it('地形里按 3 换到岛链（简单界面里它藏着）：换过去了、露出来了；按 1 回到画陆地，它又收回去；按 4 还是堆山', async () => {
    const { continents } = await import('../../../core/testing/fixtures');
    const { barTools, setTool } = await import('../defs/tools');
    const { tool } = await import('../../state');
    const { fullUi } = await import('../ui-prefs');
    expect(fullUi()).toBe(false);
    const w = (world.value = continents().world);
    try {
      setTool('land');
      expect(barTools('terrain', w).shown).toEqual(['land', 'island', 'relief']);
      key('3');
      expect(tool.value).toBe('chain');
      expect(barTools('terrain', w).shown).toEqual(['land', 'island', 'chain', 'relief']);
      key('4');
      expect(tool.value).toBe('relief');
      expect(barTools('terrain', w).shown).toEqual(['land', 'island', 'relief']);
      key('7');
      expect(tool.value).toBe('terrainClass');
      key('1');
      expect(tool.value).toBe('land');
      // 没有那么多工具的键不管
      key('8');
      expect(tool.value).toBe('land');
    } finally {
      setTool('land');
    }
  });
});
