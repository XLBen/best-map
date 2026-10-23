import { afterEach, describe, expect, it, vi } from 'vitest';

// ⌘S / Ctrl+S：不让浏览器弹出“存储网页”，存进“我的地图”；⇧⌘S 另存为；向导开着时不保存

const saved = vi.hoisted(() => ({ save: vi.fn(async () => true), saveAs: vi.fn(async () => true) }));
vi.mock('../maps/store', async () => {
  const { signal } = await import('@preact/signals');
  return { mapsDialog: signal(false), saveMap: saved.save, saveMapAs: saved.saveAs };
});

const { onKeyDown } = await import('./keys');
const { world, wizardOpen } = await import('../../state');

const key = (k: string, mods: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean } = {}) => {
  const e = { key: k, code: `Key${k.toUpperCase()}`, target: null, repeat: false, altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, ...mods, preventDefault: vi.fn() };
  onKeyDown(e as unknown as KeyboardEvent);
  return e;
};

afterEach(() => {
  saved.save.mockClear();
  saved.saveAs.mockClear();
  wizardOpen.value = false;
  world.value = null;
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
