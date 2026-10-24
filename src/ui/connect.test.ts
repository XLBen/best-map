import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FANTASY_BIOMES } from '../../core/packs/fantasy-biomes';
import type { ScriptIssue } from '../../core/script';
import type { Command } from '../../core/commands';
import type { Species } from '../../core/species';
import { continents } from '../../core/testing/fixtures';
import type { LightSnapshot, Request } from '../protocol';

// 第三批几处口子接上以后（connect.ts）：
// - 脚本框提交的脚本记进信任列表（trust.ts），同一步里被换掉的中间版本去掉，留着的是现在的、被它换掉的（出错时换回它）、
//   历史里的、世界上还用着的；本来就信任的从不去掉；安全模式下不记；
// - 拖滑块时地图上临时换掉外观；
// - 出错提示的“编辑”打开那个脚本框（河流类型的规则打开“水系 ⋯”里那种河），星球形态的脚本没有“编辑”。
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
// 假的 Worker：记下请求，测试里用 answerLast 回一个轻快照（把 update_species 的补丁用到那种生态上）
class FakeWorker {
  static last: FakeWorker | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  sent: { id: number; req: Request }[] = [];
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(m: { id: number; req: Request }) {
    this.sent.push(m);
  }
}
vi.stubGlobal('Worker', FakeWorker);

const state = await import('../state');
const trust = await import('../trust');
const hooks = await import('./editor-hooks');
const { scriptCommitted } = await import('./connect');
const { applySpeciesScript } = await import('./species-scripts');

let nextState = 100;
function answerLast(): Request {
  const fw = FakeWorker.last!;
  const m = fw.sent[fw.sent.length - 1];
  const w = state.world.value!;
  const cmd = (m.req as { cmd: Extract<Command, { op: 'update_species' }> }).cmd;
  const species = w.small.species.map((s) => {
    if (s.id !== cmd.id) return s;
    const next = { ...s, ...cmd.patch } as Record<string, unknown>;
    for (const [k, v] of Object.entries(cmd.patch)) if (v === null) delete next[k];
    return next as Species;
  });
  const snap: LightSnapshot = { light: true, small: { ...w.small, species }, features: w.derived.features, province: w.causes.province.slice(), islandType: w.causes.islandType.slice(), history: [], canUndo: true, canRedo: false, timings: { total: 0 }, stateId: ++nextState };
  fw.onmessage!({ data: { id: m.id, ok: true, summary: '修改了生态', snapshot: snap } });
  return m.req;
}

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

  it('出错提示的“编辑”：河流类型的规则打开“水系 ⋯”里那种河；类型删掉了就没有“编辑”', () => {
    state.world.value = { ...w0, small: { ...w0.small, riverTypes: [{ id: 'blood', name: '血河', color: '#8f1414', scripts: { match: { api: 1, src: 'return o.x;' } } }] } };
    const issue: ScriptIssue = { kind: 'match', owner: '血河', id: 'blood', reason: 'runtime', text: '没有变量 o', raw: 'o is not defined', message: '「血河」的脚本：没有变量 o' };
    expect(state.canEditScript(issue)).toBe(true);
    const tool = state.tool.value;
    state.editScript(issue);
    expect(state.tool.value).toBe('river');
    expect(state.waterTypeEditorRequest.value).toEqual({ kind: 'river', id: 'blood' });
    expect(state.openPanel.value).toBe('cat:water');
    expect(state.canEditScript({ ...issue, id: 'gone' })).toBe(false);
    state.waterTypeEditorRequest.value = null;
    state.openPanel.value = null;
    state.tool.value = tool;
  });

  it('世界上还用着的不去掉：在用的星球形态里的脚本也算', async () => {
    // 星球形态的地形脚本与框里写过的一段相同（没信任过：框提交时才记为信任）
    const crust = 'return height + 1;';
    const gen = { seed: 1, type: 'continents', form: { id: 'f', name: '形态', api: 1, base: 'continents', scripts: { crust: { api: 1, src: crust } } } };
    state.world.value = { ...w0, small: { ...w0.small, terrain: { ...w0.small.terrain, gen } } } as typeof w0;
    await commit(crust, '', 'exec');
    await commit('return 0.2;', crust, 'replace');
    await commit('return 0.3;', 'return 0.2;', 'replace');
    await commit('return 0.4;', 'return 0.3;', 'replace');
    expect(await Promise.all([crust, 'return 0.2;', 'return 0.3;', 'return 0.4;'].map(trusted))).toEqual([true, false, true, true]);
  });
});

describe('真的走 exec / replaceLast（Worker 换成假的）', () => {
  it('脚本框的提交只记框里写的这一段：补丁里整份带着的另一段不顺带信任；同一步里换掉的中间版本去掉', async () => {
    // 另一段是别人的、没信任过的脚本（比如自动保存里留下的）
    const theirs = 'return [9, 8, 7];';
    state.world.value = { ...w0, small: { ...w0.small, species: w0.small.species.map((s, i) => (i === 0 ? { ...s, scripts: { color: { api: 1, src: theirs } } } : s)) } };
    const commit = async (src: string, mode: 'exec' | 'replace') => {
      const p = applySpeciesScript(sp0.id, 'placement', src, mode);
      const req = answerLast() as { kind: string; cmd: Extract<Command, { op: 'update_species' }> };
      expect(await p).toEqual({ ok: true });
      return req;
    };
    const first = await commit('return 0.41;', 'exec');
    expect(first.kind).toBe('exec');
    // 命令里两段都在（scripts 是整份）
    expect(first.cmd.patch.scripts).toEqual({ placement: { api: 1, src: 'return 0.41;' }, color: { api: 1, src: theirs } });
    await vi.waitFor(async () => expect(await trusted('return 0.41;')).toBe(true));
    await commit('return 0.42;', 'replace');
    await commit('return 0.43;', 'replace');
    await vi.waitFor(async () => expect(await trusted('return 0.41;')).toBe(false));
    expect([await trusted('return 0.42;'), await trusted('return 0.43;')]).toEqual([true, true]);
    expect(await trusted(theirs)).toBe(false);
  });

  it('别的命令（不是脚本框的）照旧整条记为信任', async () => {
    const sp = w0.small.species[1];
    const p = state.exec({ op: 'update_species', id: sp.id, patch: { scripts: { placement: { api: 1, src: 'return 0.51;' } } } });
    answerLast();
    expect(await p).toBe(true);
    await vi.waitFor(async () => expect(await trusted('return 0.51;')).toBe(true));
  });
});
