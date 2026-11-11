import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command } from '../../../core/commands';
import { builtinPacks } from '../../../core/packs/builtin-tree';
import { continents, generateHuman, snapshot } from '../../../core/testing/fixtures';
import type { Engine } from '../../../core/engine';

// 第九十八轮：重新生成之前——没有会被换掉的手改时不问就做；有就问一次，话里写着数，按钮写动作；点“先不”不做。
// 删除人文的问话里写着一起没了的国家、城市的个数

const asked: { title: string; text?: string; choices: { value: string; label: string; primary?: boolean }[] }[] = [];
const done: Command[] = [];
let answer = 'ok';
let eng: Engine;

vi.mock('../../state', () => ({
  askUser: (a: (typeof asked)[number]) => {
    asked.push(a);
    return Promise.resolve(answer);
  },
  exec: (cmd: Command) => {
    done.push(cmd);
    return Promise.resolve(true);
  },
  commandsNow: () => eng.toDoc().commands,
  world: {
    get value() {
      return eng.world;
    },
  },
}));

const { confirmRegen, execRegen, execRemoval, lossText, removalText } = await import('./regen-ask');

const groups = () => ((builtinPacks().find((p) => p.id === 'medieval')?.packs ?? []).find((p) => p.id === 'cultures')?.packs ?? []).slice(0, 3).map((n) => ({ id: n.id, weight: n.weight ?? 1 }));
const fresh = () =>
  snapshot('regen-ask', () => {
    const e = continents({ cells: 2500, provinces: true });
    generateHuman(e, 'medieval', groups(), { countries: {}, settlements: {} });
    return e;
  });

beforeEach(() => {
  asked.length = 0;
  done.length = 0;
  answer = 'ok';
  eng = fresh();
});

describe('问话里的字', () => {
  it('写清楚数；第一项带着“手改过的”时不重复', () => {
    expect(lossText([])).toBeNull();
    expect(lossText([{ key: 'pop', count: 37 }, { key: 'borders', count: 2 }])).toBe('会换掉你手改过的 37 格人口、2 个国家手画的边界。可以撤销。');
    expect(lossText([{ key: 'countries', count: 3 }, { key: 'cities', count: 1 }])).toBe('会换掉你的 3 个改过的国家、1 座改过的城市。可以撤销。');
    expect(lossText([{ key: 'provinces', count: 4 }])).toBe('会换掉你的 4 个手改过的省份。可以撤销。');
  });

  it('删除：一起没了的按个数写', () => {
    const n = { countries: 17, blocs: 2, archive: 40, cities: 35, roads: 32, landmarks: 0, points: 0, pop: 9 };
    expect(removalText({ op: 'remove_human' }, n)).toBe('人口和文化圈都删除，一起删除的还有 17 个国家、2 个集团、35 座城市、32 条道路、档案里的 40 条统治者、家族和大事。手改过的 9 格人口也没了。地标、资源库里的内容留着。可以撤销。');
    expect(removalText({ op: 'remove_human' }, { ...n, countries: 0, blocs: 0, archive: 0, cities: 0, roads: 0, pop: 0 })).toBe('人口和文化圈都删除。地标、资源库里的内容留着。可以撤销。');
    expect(removalText({ op: 'remove_countries' }, { ...n, blocs: 0 })).toBe('17 个国家都删除，一起删除的还有档案里的 40 条统治者、家族和大事。人口、城市留着。可以撤销。');
    expect(removalText({ op: 'remove_settlements', cities: true }, { ...n, landmarks: 0 })).toBe('35 座城市、32 条道路都删除。可以撤销。');
  });
});

describe('重新生成：有手改会被换掉时才问', () => {
  it('没有手改：不问就做', async () => {
    expect(await execRegen({ op: 'regenerate_human' }, '正在生成…')).toBe(true);
    expect(await execRegen({ op: 'regenerate_countries' }, '正在生成…')).toBe(true);
    expect(await execRegen({ op: 'generate_provinces', seed: 3 }, '正在划分…')).toBe(true);
    expect(asked).toEqual([]);
    expect(done.map((c) => c.op)).toEqual(['regenerate_human', 'regenerate_countries', 'generate_provinces']);
  });

  it('改了一个国名：重新生成国家时问，写着 1 个；重新生成人文（国家不动）不问', async () => {
    const id = Object.keys(eng.world.small.countries!).map(Number)[0];
    eng.exec({ op: 'set_country', id, patch: { name: '测试之国' } });
    expect(await execRegen({ op: 'regenerate_human' }, '正在生成…')).toBe(true);
    expect(asked).toEqual([]);
    expect(await execRegen({ op: 'regenerate_countries' }, '正在生成…')).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0].title).toBe('重新生成');
    expect(asked[0].text).toBe('会换掉你的 1 个改过的国家。可以撤销。');
    // 主要的写在前面：问话框里它在最右边
    expect(asked[0].choices).toEqual([
      { value: 'ok', label: '重新生成', primary: true },
      { value: 'cancel', label: '先不' },
    ]);
  });

  it('点“先不”：不做', async () => {
    const id = Object.keys(eng.world.small.countries!).map(Number)[0];
    eng.exec({ op: 'set_country', id, patch: { color: '#123456' } });
    answer = 'cancel';
    expect(await execRegen({ op: 'regenerate_countries' }, '正在生成…')).toBe(false);
    expect(asked).toHaveLength(1);
    expect(done).toEqual([]);
    // 锁定它：这一次留着，不问
    eng.exec({ op: 'set_country', id, patch: { locked: true } });
    expect(await confirmRegen({ op: 'regenerate_countries' })).toBe(true);
    expect(asked).toHaveLength(1);
    // “锁定的也换”：又要问了
    expect(await confirmRegen({ op: 'regenerate_countries', keepLocked: false })).toBe(false);
    expect(asked).toHaveLength(2);
  });

  it('标题、按钮可以换（重新划分省份）', async () => {
    const id = Object.keys(eng.world.small.provinces).map(Number).find((p) => eng.world.small.provinces[p].land)!;
    eng.exec({ op: 'set_province', id, name: '甲省' });
    await execRegen({ op: 'generate_provinces', seed: 9 }, '正在划分…', { title: '重新划分省份', action: '重新划分' });
    expect(asked[0]).toMatchObject({ title: '重新划分省份', text: '会换掉你的 1 个手改过的省份。可以撤销。' });
    expect(asked[0].choices[0].label).toBe('重新划分');
  });
});

describe('删除', () => {
  it('删除人文：问话里写着国家、城市的个数；点了才删', async () => {
    const s = eng.world.small;
    const countries = Object.keys(s.countries!).length;
    const cities = Object.keys(s.cities!).length;
    answer = 'cancel';
    expect(await execRemoval({ op: 'remove_human' }, '删除人文')).toBe(false);
    expect(done).toEqual([]);
    expect(asked[0].title).toBe('删除人文');
    expect(asked[0].text).toContain(`${countries} 个国家`);
    expect(asked[0].text).toContain(`${cities} 座城市`);
    expect(asked[0].choices.map((c) => c.label)).toEqual(['删除', '先不']);
    answer = 'ok';
    expect(await execRemoval({ op: 'remove_human' }, '删除人文')).toBe(true);
    expect(done).toEqual([{ op: 'remove_human' }]);
  });
});
