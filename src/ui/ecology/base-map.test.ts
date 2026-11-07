import { afterEach, describe, expect, it } from 'vitest';
import { focusSpecies, mode } from '../../state';
import { VIEWS } from '../defs/layers';
import { EDITOR_VIEWS, editorOpened, editorView, restoreEditorView, showEditorView, shownEditorView } from './base-map';

// 第七十二轮：和生态有关的几张底图从“图层”挪到生态编辑器的“在地图上看”：编辑器开着时临时换底图，关上换回原来的

const tick = () => new Promise<void>((r) => queueMicrotask(r));

afterEach(() => {
  restoreEditorView();
  mode.value = 'terrain';
  focusSpecies.value = null;
});

describe('在地图上看', () => {
  it('图层里和生态有关的只留地貌、生态分区；挪走的几张都在编辑器里', () => {
    const moved = ['moisture', 'wetness', 'continentality', 'corrT', 'corrP', 'suitability'];
    expect(VIEWS.map((v) => v.id).filter((id) => moved.includes(id))).toEqual([]);
    expect(VIEWS.map((v) => v.id)).toEqual(['terrain', 'dominant', 'provinces', 'terrainClass', 'resource', 'temperature', 'precip', 'elevation', 'seaTemp', 'uplift']);
    expect(EDITOR_VIEWS.map((v) => v.id).sort()).toEqual([...moved].sort());
  });

  it('换上、关上编辑器换回原来的', async () => {
    mode.value = 'elevation';
    const close = editorOpened('taiga');
    showEditorView('moisture', 'taiga');
    expect([mode.value, shownEditorView()]).toEqual(['moisture', 'moisture']);
    // 换一张：关上时还是回到编辑器换之前的那张
    showEditorView('wetness', 'taiga');
    expect(mode.value).toBe('wetness');
    close();
    await tick();
    expect(mode.value).toBe('elevation');
    expect(editorView.value).toBeNull();
  });

  it('选“不换底图”也换回去', () => {
    mode.value = 'temperature';
    showEditorView('continentality', null);
    showEditorView(null, null);
    expect(mode.value).toBe('temperature');
  });

  it('适宜程度看的是编辑器里的那一种；换到别的生态的页面（先关后开）不换回去，跟着换', async () => {
    const close = editorOpened('taiga');
    showEditorView('suitability', 'taiga');
    expect([mode.value, focusSpecies.value]).toEqual(['suitability', 'taiga']);
    // 换一页：旧的编辑器关上、新的打开，在同一轮里
    close();
    const close2 = editorOpened('desert');
    await tick();
    expect([mode.value, focusSpecies.value, shownEditorView()]).toEqual(['suitability', 'desert', 'suitability']);
    close2();
    await tick();
    expect(mode.value).toBe('terrain');
  });

  it('编辑器开着时在图层里换过底图：关上时不动', async () => {
    mode.value = 'precip';
    const close = editorOpened('taiga');
    showEditorView('corrT', 'taiga');
    mode.value = 'provinces';
    expect(shownEditorView()).toBeNull();
    close();
    await tick();
    expect(mode.value).toBe('provinces');
  });
});
