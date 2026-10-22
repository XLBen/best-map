import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FANTASY_BIOMES } from '../../core/packs/fantasy-biomes';
import type { ScriptIssue } from '../../core/script';
import { continents } from '../../core/testing/fixtures';

// 第三批几处口子接上以后（connect.ts）：
// - 脚本框提交的脚本记进信任列表（trust.ts），同一步里被换掉的中间版本去掉，留着的是现在的、被它换掉的（出错时换回它）、
//   历史里的、世界上还用着的；本来就信任的从不去掉；安全模式下不记；
// - 拖滑块时地图上临时换掉外观；
// - 出错提示的“编辑”打开那个脚本框，星球形态的脚本没有“编辑”。
// 没有浏览器：IndexedDB 的 kv 换成内存里的表，Worker 不会用到（不发请求）

const kv = new Map<string, unknown>();
vi.mock('../idb', () => ({
  openDb: () => Promise.reject(new Error('没有 IndexedDB')),
  idbTx: () => Promise.reject(new Error('没有 IndexedDB')),
  idbGet: () => Promise.reject(new Error('没有 IndexedDB')),
  idbAll: () => Promise.reject(new Error('没有 IndexedDB')),
  kvGet: async (k: string) => structuredClone(kv.get(k)),
  kvPut: async (k: string, v: unknown) => void kv.set(k, structuredClone(v)),
  kvDelete: async (k: string) => void kv.delete(k),
}));
vi.stubGlobal(
  'Worker',
  class {
    postMessage() {}
  },
);

const state = await import('../state');
const trust = await import('../trust');
const hooks = await import('./editor-hooks');
const { scriptCommitted } = await import('./connect');

const trusted = (src: string) => trust.isTrusted(src);
const w0 = continents({ cells: 2000 }).world;
const sp0 = w0.small.species[0];

beforeEach(() => {
  kv.clear();
  trust.forgetTrustCache();
  trust.forgetDrafts();
  state.safeMode.value = null;
  state.world.value = w0;
  state.worldEpoch.value++;
});

// 一次提交：src 换掉 before
const commit = (src: string, before: string, mode: 'exec' | 'replace') => scriptCommitted({ species: sp0.id, kind: 'placement', src, before, mode });

describe('脚本框提交的脚本与信任列表', () => {
  it('同一步里换掉的中间版本去掉；被换掉的那一段留到下一次（出错时换回它）', async () => {
    await commit('return 0.1;', '', 'exec');
    await commit('return 0.2;', 'return 0.1;', 'replace');
    expect([await trusted('return 0.1;'), await trusted('return 0.2;')]).toEqual([true, true]);
    await commit('return 0.3;', 'return 0.2;', 'replace');
    expect([await trusted('return 0.1;'), await trusted('return 0.2;'), await trusted('return 0.3;')]).toEqual([false, true, true]);
    // 存着的列表也去掉了
    trust.forgetTrustCache();
    expect(await trusted('return 0.1;')).toBe(false);
  });

  it('出错后换回旧写法（不报）再写：换回的那一段留着，出错的那一段去掉', async () => {
    await commit('return 0.1;', '', 'exec');
    // 0.2 在地图上出错，编辑器换回 0.1（不报给信任列表）
    await commit('return 0.2;', 'return 0.1;', 'replace');
    await commit('return 0.3;', 'return 0.1;', 'replace');
    expect([await trusted('return 0.1;'), await trusted('return 0.2;'), await trusted('return 0.3;')]).toEqual([true, false, true]);
  });

  it('新的一步之前的那一段留在历史里，之后不再去掉', async () => {
    await commit('return 0.1;', '', 'exec');
    await commit('return 0.2;', 'return 0.1;', 'replace');
    // 离开框又回来：新的一步。0.2 留在历史里（撤销会回到它），0.1 早就不在世界上了
    await commit('return 0.3;', 'return 0.2;', 'exec');
    await commit('return 0.4;', 'return 0.3;', 'replace');
    await commit('return 0.5;', 'return 0.4;', 'replace');
    expect(await Promise.all(['0.1', '0.2', '0.3', '0.4', '0.5'].map((x) => trusted(`return ${x};`)))).toEqual([false, true, false, true, true]);
  });

  it('本来就信任的、世界上还用着的不去掉；去掉了这段（空的）也照样整理', async () => {
    const builtin = FANTASY_BIOMES.find((b) => b.scripts?.placement)!.scripts!.placement!.src;
    await trust.trustScripts([{ src: 'return 0.7;' }]);
    state.world.value = { ...w0, small: { ...w0.small, species: [{ ...w0.small.species[1], scripts: { placement: { api: 1, src: 'return 0.8;' } } }, ...w0.small.species.slice(2)] } };
    await commit('return 0.7;', '', 'exec');
    await commit(builtin, 'return 0.7;', 'replace');
    await commit('return 0.8;', builtin, 'replace');
    await commit('return 0.9;', 'return 0.8;', 'replace');
    await commit('', 'return 0.9;', 'replace');
    expect(await Promise.all(['return 0.7;', builtin, 'return 0.8;'].map(trusted))).toEqual([true, true, true]);
  });

  it('安全模式下不记', async () => {
    state.safeMode.value = { reason: '打开时选了不运行脚本' };
    await commit('return 0.6;', '', 'exec');
    expect(await trusted('return 0.6;')).toBe(false);
  });

  it('换了世界：上一个世界里的草稿不再去掉', async () => {
    await commit('return 0.1;', '', 'exec');
    await commit('return 0.2;', 'return 0.1;', 'replace');
    state.worldEpoch.value++;
    await commit('return 0.3;', 'return 0.2;', 'replace');
    expect([await trusted('return 0.1;'), await trusted('return 0.2;')]).toEqual([true, true]);
  });
});

describe('别的口子', () => {
  it('拖滑块时地图上临时换上外观，传 null 去掉', () => {
    expect(hooks.previewVisual(sp0.id, { pattern: 'spots', amount: 0.4 })).toBe(true);
    expect(state.visualOverrides.value.get(sp0.id)).toEqual({ pattern: 'spots', amount: 0.4 });
    hooks.previewVisual(sp0.id, null);
    expect(state.visualOverrides.value.has(sp0.id)).toBe(false);
  });

  it('出错提示的“编辑”打开那种生态的那个脚本框；星球形态的脚本没有“编辑”', () => {
    const issue: ScriptIssue = { kind: 'color', owner: '别的名字', id: sp0.id, reason: 'runtime', text: '没有变量 x', raw: 'x is not defined', message: '「x」的颜色脚本：没有变量 x' };
    expect(state.canEditScript(issue)).toBe(true);
    state.editScript(issue);
    expect(hooks.scriptEditorRequest.value).toEqual({ species: sp0.id, kind: 'color' });
    expect(state.sheet.value).toBe('species');
    expect(state.focusSpecies.value).toBe(sp0.id);
    const form: ScriptIssue = { kind: 'crust', owner: '双子大陆', reason: 'runtime', text: '没有变量 x', raw: 'x is not defined', message: '「双子大陆」的地形脚本：没有变量 x' };
    expect(state.canEditScript(form)).toBe(false);
  });
});
