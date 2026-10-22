import { describe, expect, it } from 'vitest';
import { PLAIN_RIVER, riverNet } from '../../core/river-types';
import { continents } from '../../core/testing/fixtures';
import { setOptions, world } from '../state';
import { riverTypeChoiceCommand, riverTypeOfRiver, riverTypeScriptCommand, newRiverType } from './panels/riverTypes';
import { chosenRiverType, pinCommand, riverInfo } from './riverCourse';

// 给河选类型：自然的河固定下来并带上类型（一步，名字照旧）；画的河改它自己的 type；新画的河用工具条上选的

const blood = { id: 'blood', name: '血河', color: '#8f1414' };
const rule = { api: 1 as const, src: 'return 流量 > 3 * 河流门槛;' };

describe('给河选类型', () => {
  it('按规则成了血河的自然的河：显示“按规则”；换成别的类型 = 固定并带上类型，名字照旧', () => {
    const eng = continents();
    eng.exec({ op: 'set_river_type', type: { ...blood, scripts: { match: rule } } });
    eng.exec({ op: 'set_river_type', type: { id: 'crystal', name: '晶川', color: '#79e6ff' } });
    const w = eng.world;
    world.value = w;
    const net = riverNet(w, w.derived);
    // 一条有名字、按规则是血河的自然的河
    const f = w.derived.features.find((x) => x.type === 'river' && x.tags.includes('rtype:blood'));
    const cell = f ? f.cells[0] : net.stems.find((s) => w.derived.riverType![s[0]] === 1)![0];
    const ref = { kind: 'natural' as const, cell };
    expect(riverTypeOfRiver(w, ref)).toEqual({ type: w.small.riverTypes![0], chosen: null });
    const cmd = riverTypeChoiceCommand(w, ref, 'crystal')!;
    expect(cmd.op).toBe('add_guide');
    if (cmd.op !== 'add_guide') return;
    expect(cmd.guide.type).toBe('crystal');
    expect(cmd.guide.carve).toBe('bed');
    if (f) expect(cmd.guide.nameKey).toBe(f.key);
    const name = riverInfo(w, ref)?.name;
    expect(cmd.label).toBe(`${name ? `「${name}」` : '这条河'}改成晶川`);
    eng.exec(cmd);
    const g = w.small.guides.at(-1)!;
    world.value = eng.world;
    expect(riverTypeOfRiver(eng.world, { kind: 'guide', id: g.id })).toEqual({ type: eng.world.small.riverTypes![1], chosen: 'type' });
    // 画的河：改它自己的 type（普通的河在有规则时写成 plain，按规则是去掉这一项）
    expect(riverTypeChoiceCommand(eng.world, { kind: 'guide', id: g.id }, PLAIN_RIVER)).toMatchObject({ op: 'update_guide', id: g.id, patch: { type: PLAIN_RIVER } });
    expect(riverTypeChoiceCommand(eng.world, { kind: 'guide', id: g.id }, null)).toMatchObject({ op: 'update_guide', id: g.id, patch: { type: null } });
    // 已经是它了：不用改
    expect(riverTypeChoiceCommand(eng.world, { kind: 'guide', id: g.id }, 'crystal')).toBeNull();
    // 自然的河选“按规则”：本来就是，不用改；选它已经是的类型也不用改
    expect(riverTypeChoiceCommand(w, ref, null)).toBeNull();
  });

  it('没有规则时“普通的河”就是不选；新画的河用工具条上选的（删掉了的类型不算）', () => {
    const eng = continents();
    eng.exec({ op: 'set_river_type', type: blood });
    const w = eng.world;
    world.value = w;
    const stem = riverNet(w, w.derived).stems.find((s) => s.length >= 3)!;
    const ref = { kind: 'natural' as const, cell: stem[0] };
    expect(riverTypeChoiceCommand(w, ref, PLAIN_RIVER)).toBeNull();
    setOptions({ riverType: 'blood' });
    expect(chosenRiverType(w)).toEqual({ type: 'blood' });
    setOptions({ riverType: 'gone' });
    expect(chosenRiverType(w)).toEqual({});
    setOptions({ riverType: '' });
    expect(chosenRiverType(w)).toEqual({});
  });

  it('新建的类型 id 不重复；规则脚本的命令只带 match（空的去掉）', () => {
    const eng = continents();
    const w = eng.world;
    expect(newRiverType(w).id).toBe('river-type-1');
    eng.exec({ op: 'set_river_type', type: newRiverType(w) });
    expect(newRiverType(w).id).toBe('river-type-2');
    const t = w.small.riverTypes![0];
    const cmd = riverTypeScriptCommand(t, 'return 河长 > 500;');
    expect(cmd).toEqual({ op: 'set_river_type', type: { ...t, scripts: { match: { api: 1, src: 'return 河长 > 500;' } } } });
    eng.exec(cmd);
    expect(riverTypeScriptCommand(w.small.riverTypes![0], '   ')).toEqual({ op: 'set_river_type', type: t });
  });

  it('按规则成了血河、用血河的模板起名的自然的河：换成别的类型（或普通的河）时名字照旧', () => {
    for (const choice of ['crystal', PLAIN_RIVER]) {
      const eng = continents();
      eng.exec({ op: 'set_river_type', type: { ...blood, names: [{ p: '{color}血河' }], scripts: { match: rule } } });
      eng.exec({ op: 'set_river_type', type: { id: 'crystal', name: '晶川', color: '#79e6ff', names: [{ p: '{myth}晶河' }] } });
      const w = eng.world;
      world.value = w;
      const f = w.derived.features.filter((x) => x.type === 'river' && x.guide === undefined && x.tags.includes('rtype:blood')).sort((a, b) => b.importance - a.importance)[0];
      expect(f.name.endsWith('血河')).toBe(true);
      const old = f.name;
      const cmd = riverTypeChoiceCommand(w, { kind: 'natural', cell: f.cells[0] }, choice)!;
      expect(cmd.op === 'add_guide' && cmd.guide.name).toBe(old);
      eng.exec(cmd);
      const g = eng.world.small.guides.at(-1)!;
      expect(g.type).toBe(choice);
      expect(eng.world.derived.features.find((x) => x.guide === g.id)?.name, choice).toBe(old);
    }
    // 已经固定下来（没选类型、按规则成了血河）的自然河再选类型：名字也照旧
    {
      const eng = continents();
      eng.exec({ op: 'set_river_type', type: { ...blood, names: [{ p: '{color}血河' }], scripts: { match: rule } } });
      eng.exec({ op: 'set_river_type', type: { id: 'crystal', name: '晶川', color: '#79e6ff', names: [{ p: '{myth}晶河' }] } });
      const w = eng.world;
      world.value = w;
      const f = w.derived.features.filter((x) => x.type === 'river' && x.guide === undefined && x.tags.includes('rtype:blood')).sort((a, b) => b.importance - a.importance)[0];
      eng.exec(pinCommand(w, f.cells[0])!.cmd);
      const g = w.small.guides.at(-1)!;
      const pinned = w.derived.features.find((x) => x.guide === g.id)!;
      expect(pinned.tags).toContain('rtype:blood');
      const old = pinned.name;
      // 主线程上每次快照是新的世界对象（按世界缓存的地物索引跟着换）：这里复制一份
      const cmd = riverTypeChoiceCommand({ ...w }, { kind: 'guide', id: g.id }, 'crystal')!;
      expect(cmd).toMatchObject({ op: 'update_guide', patch: { type: 'crystal', name: old } });
      eng.exec(cmd);
      expect(w.derived.features.find((x) => x.guide === g.id)?.name).toBe(old);
    }
    // 名字不是按模板起的（普通的名字）：不写名字，照那条自然河的地名键起（不算自己改过的）
    const eng = continents();
    eng.exec({ op: 'set_river_type', type: { ...blood, scripts: { match: rule } } });
    const w = eng.world;
    world.value = w;
    const f = w.derived.features.find((x) => x.type === 'river' && x.guide === undefined && x.tags.includes('rtype:blood'))!;
    const cmd = riverTypeChoiceCommand(w, { kind: 'natural', cell: f.cells[0] }, PLAIN_RIVER)!;
    expect(cmd.op === 'add_guide' && cmd.guide.name).toBeUndefined();
  });
});
