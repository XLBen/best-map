import { describe, expect, it } from 'vitest';
import type { Command } from '../commands';
import { digest } from '../digest';
import { Engine } from '../engine';
import { defaultsOf } from '../testing/eras';
import { type HumanCommand, continents, humanExec, snapshot } from '../testing/fixtures';
import type { CountryMeta, World } from '../world';
import { currentRuler, loreOf } from './archive-store';
import { titleContext, typical } from './countries/records';
import { type Era, cultureById, worldEra } from './era';
import { type Government, type Title, type TitleOne, govTitles, governmentById, titled } from './government';
import { TITLE_FIELDS, derivedCountryName, retitle, titleBefore, titleInputsChanged } from './retitle';
import { worldTiers } from './tiers';

// 第九十一轮：国名、统治者的称号跟着资源库变（retitle.ts）。
// 库没改时和以前逐值相同；改了称号会读的内容，没手改过的马上跟着变，国界、人口不动；撤销、重放确定

const ERAS = ['antiquity', 'medieval', 'industrial', 'modern', 'fantasy', 'scifi'];
const eraWorld = (era: string): Engine =>
  snapshot(`retitle:${era}`, () => {
    const eng = continents({ provinces: true });
    const groups = defaultsOf({ id: era })
      .filter((g) => g.weight > 0)
      .slice(0, 6);
    humanExec(eng, { op: 'generate_human', packs: [[era]], groups, countries: {}, settlements: {} } as HumanCommand);
    return eng;
  });
const nations = () => eraWorld('medieval');

const metas = (w: World): CountryMeta[] => Object.values(w.small.countries ?? {});
const namesOf = (w: World) => Object.fromEntries(metas(w).map((m) => [m.id, [m.name, m.orig ?? '']]));
const rulerTitles = (w: World) => Object.fromEntries(metas(w).map((m) => [m.id, loreOf(w.small, m.id).rulers.map((r) => r.title ?? '')]));
const put = (eng: Engine, kind: string, item: unknown): Command => {
  const cmd: Command = { op: 'set_content', kind, id: (item as { id: string }).id, item: item as Record<string, unknown> };
  eng.exec(cmd);
  return cmd;
};
// 称号表里每一种写法都过一遍 f
const mapOne = (t: TitleOne, f: (zh: string) => string): TitleOne => (typeof t === 'string' ? f(t) : { ...t, zh: f(t.zh) });
const mapTitle = (t: Title | undefined, f: (zh: string) => string): Title | undefined =>
  t === undefined ? undefined : typeof t === 'string' || 'zh' in t ? mapOne(t as TitleOne, f) : Object.fromEntries(Object.entries(t as Record<string, TitleOne>).map(([k, v]) => [k, mapOne(v, f)]));
// 一个政体的称号、统治者称号、换说法里的字都过一遍 f
const reword = (g: Government, f: (zh: string) => string, what: { titles?: boolean; rulers?: boolean } = { titles: true, rulers: true }): Government => ({
  ...g,
  ...(what.titles ? { titles: mapTitle(g.titles, f)! } : {}),
  ...(what.rulers && g.rulers !== undefined ? { rulers: mapTitle(g.rulers, f) } : {}),
  ...(g.names ? { names: g.names.map((r) => ({ ...r, ...(what.titles && r.titles !== undefined ? { titles: mapTitle(r.titles, f) } : {}), ...(what.rulers && r.rulers !== undefined ? { rulers: mapTitle(r.rulers, f) } : {}) })) } : {}),
});
// 用得最多的政体
function commonGov(w: World): Government {
  const n = new Map<string, number>();
  for (const m of metas(w)) if (!m.nameLocked) n.set(m.government, (n.get(m.government) ?? 0) + 1);
  const id = [...n].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
  return governmentById(w.small, id)!;
}

// ---------- 第九十轮的写法（参照，不要改它）----------
// 生成国家时国名、统治者的称号是这样起的（records.ts 的 nameCountry、rulerTitleOf，rulers.ts 的 generateLore 给每一位同一个称号）：
// 国名 = 词根 + 政体按（等级、主流文化、文化组、主流文化最典型的取值）给的称号。原样抄在这里，不引用现在的 retitle.ts
function r90Name(w: World, m: CountryMeta): { zh: string; orig?: string } {
  const title = govTitles(governmentById(w.small, m.government), titleContext(w, m, worldEra(w.small))).title;
  if (!title) return { ...m.base };
  const zh = title.zh.includes('{name}') ? title.zh.replace('{name}', m.base.zh) : m.base.zh + title.zh;
  const orig = m.base.orig ? (title.orig ? title.orig.replace('{name}', m.base.orig) : m.base.orig) : undefined;
  return orig ? { zh, orig } : { zh };
}
const r90Ruler = (w: World, m: CountryMeta): string | undefined => govTitles(governmentById(w.small, m.government), titleContext(w, m, worldEra(w.small))).ruler?.zh;

describe('库没改时：国名、称号和第九十轮逐值相同', () => {
  for (const era of ERAS) {
    it(`${era}：存着的国名、每一位统治者的称号就是按第九十轮的写法起的；现算的和存着的一样`, () => {
      const w = eraWorld(era).world;
      expect(metas(w).length).toBeGreaterThan(5);
      let free = 0;
      for (const m of metas(w)) {
        // 联邦的成员邦、殖民地的名字是格局起的（nameLocked），不按政体的称号
        if (!m.nameLocked) {
          free++;
          const n = r90Name(w, m);
          expect([m.name, m.orig], `${era} ${m.name}`).toEqual([n.zh, n.orig]);
        }
        expect(derivedCountryName(w, m)).toEqual({ zh: m.name, ...(m.orig ? { orig: m.orig } : {}) });
        const t = r90Ruler(w, m);
        for (const r of loreOf(w.small, m.id).rulers) {
          expect(r.title, `${era} ${m.name}`).toBe(t);
          expect(r.titleLocked).toBeUndefined();
        }
      }
      expect(free).toBeGreaterThan(3);
    });
  }

  it('改不相干的内容（派系、城市等级、政体的国土、文化的颜色、等级的面积）：国家的档案一字不差，统治者的档案还是同一个对象', () => {
    const eng = nations();
    const w = eng.world;
    const before = JSON.stringify(w.small.countries);
    const g = commonGov(w);
    const m = metas(w)[0];
    const culture = cultureById(w.small, m.primaryCulture)!;
    const tier = worldTiers(w.small)[0];
    const edits: [string, unknown][] = [
      ['government', { ...g, size: g.size + 1, description: '改', weight: 3 }],
      ['culture', { ...culture, color: '#123456', weight: 5 }],
      ['countryTier', { ...tier, area: tier.area * 2, name: '改名' }],
      ['faction', { ...(Object.values(w.small.content!.faction!)[0] as object), amount: 9 }],
      ['cityRank', { ...(Object.values(w.small.content!.cityRank!)[0] as object), name: '改' }],
    ];
    for (const [kind, item] of edits) {
      const archive = w.small.archive;
      const t = titleBefore(w.small);
      put(eng, kind, item);
      expect(titleInputsChanged(t, w.small), kind).toBe(false);
      expect(w.small.archive, kind).toBe(archive);
      expect(JSON.stringify(w.small.countries), kind).toBe(before);
    }
  });

  it('称号会读的那几项都在登记的字段表里', () => {
    const fields: Record<string, string[]> = { government: ['titles', 'rulers', 'names'], countryTier: ['order'], culture: ['group', 'tendencies', 'eraTendencies'], cultureGroup: ['tendencies', 'eraTendencies'], popValue: ['dimension', 'group'], era: ['dimensions', 'relations'] };
    expect(TITLE_FIELDS).toEqual(fields);
  });
});

describe('改政体的称号：不用重新生成，国名马上跟着变', () => {
  it('用这个政体的国家都换了名字；别的国家、词根、国界、人口、颜色、旗一个不动；历史那一段不改', () => {
    const eng = nations();
    const w = eng.world;
    const g = commonGov(w);
    const was = structuredClone(w.small.countries!);
    const country = digest(w.causes.country!);
    const pop = digest([w.causes.popTotal, w.causes.popGroup, w.causes.popShare]);
    put(eng, 'government', reword(g, (zh) => `${zh}改`, { titles: true }));
    let changed = 0;
    for (const m of metas(w)) {
      const o = was[m.id];
      if (m.government === g.id && !o.nameLocked) {
        changed++;
        expect(m.name).toBe(`${o.name}改`);
        expect(m.name).toBe(r90Name(w, m).zh);
      } else expect(m.name).toBe(o.name);
      expect({ ...m, name: '', orig: '' }).toEqual({ ...o, name: '', orig: '' });
      expect(m.history).toBe(o.history);
    }
    expect(changed).toBeGreaterThan(1);
    expect(changed).toBeLessThan(metas(w).length);
    expect(digest(w.causes.country!)).toBe(country);
    expect(digest([w.causes.popTotal, w.causes.popGroup, w.causes.popShare])).toBe(pop);
    // 只改了国家称号：统治者的称号不动
    expect(rulerTitles(w)).toEqual(Object.fromEntries(Object.entries(was).map(([id]) => [id, loreOf(nations().world.small, Number(id)).rulers.map((r) => r.title ?? '')])));
  });

  it('外文名跟着称号的外文写法变', () => {
    const eng = nations();
    const w = eng.world;
    const g = commonGov(w);
    const m = metas(w).find((x) => x.government === g.id && !x.nameLocked && x.base.orig && x.orig)!;
    expect(m).toBeTruthy();
    const next = { ...g, titles: mapTitleOrig(g.titles, 'The {name} Realm'), names: (g.names ?? []).map((r) => ({ ...r, ...(r.titles !== undefined ? { titles: mapTitleOrig(r.titles, 'The {name} Realm') } : {}) })) };
    const zh = m.name;
    put(eng, 'government', next);
    expect(w.small.countries![m.id].name).toBe(zh);
    expect(w.small.countries![m.id].orig).toBe(`The ${m.base.orig} Realm`);
  });

  it('只改一个等级的称号：只有这一级的国家改名', () => {
    const eng = nations();
    const w = eng.world;
    const g = commonGov(w);
    const mine = metas(w).filter((m) => m.government === g.id && !m.nameLocked);
    const tier = mine[0].tier!;
    const titles = g.titles as Record<string, TitleOne>;
    expect(typeof titles).toBe('object');
    const was = namesOf(w);
    // 这一级在默认的表和每一条换说法里都换掉
    const at = (t: Title | undefined): Title | undefined => (t !== undefined && typeof t === 'object' && !('zh' in t) && tier in t ? { ...t, [tier]: mapOne((t as Record<string, TitleOne>)[tier], (zh) => `${zh}乙`) } : t);
    put(eng, 'government', { ...g, titles: at(g.titles)!, names: (g.names ?? []).map((r) => ({ ...r, ...(r.titles !== undefined ? { titles: at(r.titles) } : {}) })) });
    for (const m of metas(w)) {
      const hit = m.government === g.id && !m.nameLocked && m.tier === tier;
      if (hit) expect(m.name).toBe(`${was[m.id][0]}乙`);
      else expect(m.name).toBe(was[m.id][0]);
    }
  });

  it('撤销回到原来的名字和称号，重做再变；重放（Engine.fromDoc）结果一样', () => {
    const eng = nations();
    const w = eng.world;
    const g = commonGov(w);
    const names0 = namesOf(w);
    const titles0 = rulerTitles(w);
    const archive0 = w.small.archive;
    put(eng, 'government', reword(g, (zh) => `新${zh}`));
    const names1 = namesOf(eng.world);
    const titles1 = rulerTitles(eng.world);
    expect(names1).not.toEqual(names0);
    expect(titles1).not.toEqual(titles0);
    eng.undo();
    expect(namesOf(eng.world)).toEqual(names0);
    expect(rulerTitles(eng.world)).toEqual(titles0);
    expect(eng.world.small.archive).toBe(archive0);
    eng.redo();
    expect(namesOf(eng.world)).toEqual(names1);
    expect(rulerTitles(eng.world)).toEqual(titles1);
    const again = Engine.fromDoc(eng.toDoc(), w.mesh).world;
    expect(JSON.stringify(again.small.countries)).toBe(JSON.stringify(eng.world.small.countries));
    expect(JSON.stringify(again.small.archive)).toBe(JSON.stringify(eng.world.small.archive));
  });

  it('改完和“改完再重新生成国家”起出来的国名、称号一样（不用重新生成）', () => {
    const eng = nations();
    put(eng, 'government', reword(commonGov(eng.world), (zh) => `${zh}丙`));
    const now = eng.world;
    const regen = eng.clone();
    regen.exec({ op: 'regenerate_countries' });
    const list = (w: World) =>
      metas(w)
        .map((m) => `${m.name}|${m.orig ?? ''}|${loreOf(w.small, m.id).rulers.map((r) => r.title ?? '').join(',')}`)
        .sort();
    expect(list(now)).toEqual(list(regen.world));
  });
});

function mapTitleOrig(t: Title, orig: string): Title {
  const one = (x: TitleOne): TitleOne => ({ zh: typeof x === 'string' ? x : x.zh, orig });
  return typeof t === 'string' || 'zh' in t ? one(t as TitleOne) : Object.fromEntries(Object.entries(t as Record<string, TitleOne>).map(([k, v]) => [k, one(v)]));
}

describe('统治者的称号', () => {
  it('改政体的统治者称号：这个政体的国家里还用着原来那个词的统治者（在位的、以前的）都换；国名不动', () => {
    const eng = nations();
    const w = eng.world;
    const g = commonGov(w);
    const names0 = namesOf(w);
    const titles0 = rulerTitles(w);
    const lores0 = Object.fromEntries(metas(w).map((m) => [m.id, loreOf(w.small, m.id)]));
    put(eng, 'government', reword(g, (zh) => `${zh}汗`, { rulers: true }));
    expect(namesOf(w)).toEqual(names0);
    let other = 0;
    for (const m of metas(w)) {
      const now = loreOf(w.small, m.id);
      if (m.government === g.id) {
        expect(now.rulers.length).toBeGreaterThan(2);
        expect(now.rulers.map((r) => r.title)).toEqual(titles0[m.id].map((t) => `${t}汗`));
        expect(currentRuler(w.small, m.id)!.title).toBe(r90Ruler(w, m));
        // 不算“自己改过名单”
        expect(now.edited).toBeUndefined();
      } else {
        // 别的国家的档案还是原来的对象
        other++;
        expect(now).toBe(lores0[m.id]);
      }
    }
    expect(other).toBeGreaterThan(0);
  });

  it('自己改过的称号不动；改成空的恢复自动、之后又跟着变', () => {
    const eng = nations();
    const w = eng.world;
    const g = commonGov(w);
    const m = metas(w).find((x) => x.government === g.id)!;
    const list = loreOf(w.small, m.id).rulers;
    const first = list[0];
    const last = list[list.length - 1];
    const auto = last.title!;
    eng.exec({ op: 'set_ruler', id: m.id, ruler: first.id, patch: { title: '女王' } });
    expect(loreOf(w.small, m.id).rulers[0]).toMatchObject({ title: '女王', titleLocked: true });
    put(eng, 'government', reword(g, (zh) => `${zh}甲`, { rulers: true }));
    const after = loreOf(w.small, m.id).rulers;
    expect(after[0]).toMatchObject({ title: '女王', titleLocked: true });
    expect(after[after.length - 1].title).toBe(`${auto}甲`);
    // 手改的词正好和政体以前的一样，也不动（记着是手改的）
    eng.exec({ op: 'set_ruler', id: m.id, ruler: first.id, patch: { title: `${auto}甲` } });
    put(eng, 'government', reword(governmentById(w.small, g.id)!, (zh) => `${zh}乙`, { rulers: true }));
    expect(loreOf(w.small, m.id).rulers[0]).toMatchObject({ title: `${auto}甲`, titleLocked: true });
    expect(currentRuler(w.small, m.id)!.title).toBe(`${auto}甲乙`);
    // 改成空的：恢复自动
    eng.exec({ op: 'set_ruler', id: m.id, ruler: first.id, patch: { title: null } });
    const back = loreOf(w.small, m.id).rulers[0];
    expect(back.title).toBe(`${auto}甲乙`);
    expect(back.titleLocked).toBeUndefined();
    put(eng, 'government', reword(governmentById(w.small, g.id)!, (zh) => zh.replace('甲乙', ''), { rulers: true }));
    expect(loreOf(w.small, m.id).rulers[0].title).toBe(auto);
    const again = Engine.fromDoc(eng.toDoc(), w.mesh).world;
    expect(JSON.stringify(again.small.archive)).toBe(JSON.stringify(w.small.archive));
  });

  it('加统治者：称号照抄政体给的就跟着变，写了别的就是手改的', () => {
    const eng = nations();
    const w = eng.world;
    const g = commonGov(w);
    const m = metas(w).find((x) => x.government === g.id)!;
    const auto = currentRuler(w.small, m.id)!.title!;
    eng.exec({ op: 'add_ruler', id: m.id, ruler: { name: '甲', title: auto, from: 2000 } });
    eng.exec({ op: 'add_ruler', id: m.id, ruler: { name: '乙', title: '摄政', from: 2001 } });
    const [a, b] = loreOf(w.small, m.id).rulers.slice(-2);
    expect(a.titleLocked).toBeUndefined();
    expect(b.titleLocked).toBe(true);
    put(eng, 'government', reword(g, (zh) => `大${zh}`, { rulers: true }));
    const [a2, b2] = loreOf(w.small, m.id).rulers.slice(-2);
    expect(a2.title).toBe(`大${auto}`);
    expect(b2.title).toBe('摄政');
  });

  it('给一个国家换政体：在位的统治者换称号，以前的不动；手改过的在位者不动', () => {
    const eng = nations();
    const w = eng.world;
    const m = metas(w).find((x) => x.government !== 'merchant-republic' && !x.nameLocked)!;
    const before = loreOf(w.small, m.id).rulers.map((r) => r.title);
    eng.exec({ op: 'set_country', id: m.id, patch: { government: 'merchant-republic' } });
    const now = loreOf(w.small, m.id).rulers.map((r) => r.title);
    const want = r90Ruler(w, w.small.countries![m.id]);
    expect(want).not.toBe(before[before.length - 1]);
    expect(now.slice(0, -1)).toEqual(before.slice(0, -1));
    expect(now[now.length - 1]).toBe(want);
    expect(loreOf(w.small, m.id).edited).toBeUndefined();
    // 另一国：先手改在位者的称号，再换政体
    const o = metas(w).find((x) => x.id !== m.id && x.government !== 'merchant-republic')!;
    eng.exec({ op: 'set_ruler', id: o.id, ruler: currentRuler(w.small, o.id)!.id, patch: { title: '护国公' } });
    eng.exec({ op: 'set_country', id: o.id, patch: { government: 'merchant-republic' } });
    expect(currentRuler(w.small, o.id)!.title).toBe('护国公');
    // 撤销两步回到原来
    eng.undo();
    eng.undo();
    eng.undo();
    expect(loreOf(w.small, m.id).rulers.map((r) => r.title)).toEqual(before);
  });
});

describe('自己起的国名不动', () => {
  it('改过名字的国家不跟着变；名字改成空的恢复自动，之后又跟着变', () => {
    const eng = nations();
    const w = eng.world;
    const g = commonGov(w);
    const [a, b] = metas(w)
      .filter((x) => x.government === g.id && !x.nameLocked)
      .map((x) => ({ id: x.id, name: x.name }));
    eng.exec({ op: 'set_country', id: a.id, patch: { name: '我的国', orig: 'Mine' } });
    expect(w.small.countries![a.id].nameLocked).toBe(true);
    put(eng, 'government', reword(g, (zh) => `${zh}丁`));
    expect(w.small.countries![a.id]).toMatchObject({ name: '我的国', orig: 'Mine' });
    expect(w.small.countries![b.id].name).toBe(`${b.name}丁`);
    // 手改的名字正好和政体以前起的一样，也不动
    eng.exec({ op: 'set_country', id: b.id, patch: { name: `${b.name}丁` } });
    put(eng, 'government', reword(governmentById(w.small, g.id)!, (zh) => `${zh}戊`));
    expect(w.small.countries![b.id].name).toBe(`${b.name}丁`);
    eng.exec({ op: 'set_country', id: a.id, patch: { name: '' } });
    expect(w.small.countries![a.id].name).toBe(`${a.name}丁戊`);
    put(eng, 'government', g);
    expect(w.small.countries![a.id].name).toBe(a.name);
    expect(w.small.countries![b.id].name).toBe(`${b.name}丁`);
  });

  it('联邦的成员邦、殖民地（格局起的名字）不按政体的称号，不动；它们的统治者照样跟着', () => {
    const eng = eraWorld('modern');
    const w = eng.world;
    const locked = metas(w).filter((m) => m.nameLocked);
    expect(locked.length).toBeGreaterThan(3);
    const was = namesOf(w);
    const m = locked[0];
    const g = governmentById(w.small, m.government)!;
    const title = currentRuler(w.small, m.id)!.title;
    put(eng, 'government', reword(g, (zh) => `${zh}己`));
    for (const x of locked) expect(w.small.countries![x.id].name).toBe(was[x.id][0]);
    if (title) expect(currentRuler(w.small, m.id)!.title).toBe(`${title}己`);
  });
});

describe('可以预料：只有适用的称号真的变了的国家才改名', () => {
  it('最典型的取值按资源库里文化的倾向算，不看地图上的人口：涂人口、改国界以后改一个词，改名的还是那几个国家', () => {
    const plain = nations();
    const g = commonGov(plain.world);
    put(plain, 'government', reword(g, (zh) => `${zh}庚`));
    const eng = nations();
    const w = eng.world;
    const m = metas(w).find((x) => x.government !== g.id)!;
    const other = metas(w).find((x) => x.government === g.id)!;
    const cells: number[] = [];
    for (let i = 0; i < w.causes.country!.length && cells.length < 40; i++) if (w.causes.country![i] === m.id) cells.push(i);
    // 把这一国涂成别的文化的人、人数翻几倍，再划给别国几格
    const foreign = metas(w).find((x) => x.primaryCulture !== m.primaryCulture)!.primaryCulture;
    const names0 = namesOf(w);
    eng.exec({ op: 'paint_culture', cells, culture: foreign, amount: 1 });
    eng.exec({ op: 'paint_country', cells: cells.slice(0, 10), country: other.id });
    expect(namesOf(w)).toEqual(names0);
    put(eng, 'government', reword(g, (zh) => `${zh}庚`));
    expect(namesOf(w)).toEqual(namesOf(plain.world));
    expect(rulerTitles(w)).toEqual(rulerTitles(plain.world));
  });

  it('typical 只读内容，不读人口的数组', () => {
    const w = nations().world;
    const era = worldEra(w.small)!;
    const c = metas(w)[0].primaryCulture;
    const a = typical(w, era, c);
    expect(typical({ small: { content: w.small.content, human: w.small.human } } as never, era, c)).toEqual(a);
  });

  it('改一个国家用不到的那条换说法：谁也不改名', () => {
    const eng = nations();
    const w = eng.world;
    const g = commonGov(w);
    const names0 = namesOf(w);
    const titles0 = rulerTitles(w);
    // 给一个世界里没有国家属于的文化组加一条换说法
    const rule = { cultureGroups: ['no-such-group'], titles: '某某国', rulers: '某某' };
    put(eng, 'government', { ...g, names: [rule, ...(g.names ?? [])] });
    expect(namesOf(w)).toEqual(names0);
    expect(rulerTitles(w)).toEqual(titles0);
  });

  it('加一条换说法、等级的高低、文化换文化组：适用的称号变了的国家跟着变，结果就是现算的', () => {
    const eng = nations();
    const w = eng.world;
    const g = commonGov(w);
    const m = metas(w).find((x) => x.government === g.id && !x.nameLocked)!;
    const culture = cultureById(w.small, m.primaryCulture)!;
    // 一条排在最前面的换说法：这个文化组的国家叫“某某邦”
    put(eng, 'government', { ...g, names: [{ cultureGroups: [culture.group], titles: '邦', rulers: '邦主' }, ...(g.names ?? [])] });
    const hit = metas(w).filter((x) => x.government === g.id && !x.nameLocked && cultureById(w.small, x.primaryCulture)!.group === culture.group);
    expect(hit.length).toBeGreaterThan(0);
    for (const x of hit) {
      expect(x.name).toBe(`${x.base.zh}邦`);
      expect(currentRuler(w.small, x.id)!.title).toBe('邦主');
    }
    for (const x of metas(w)) if (!x.nameLocked) expect(x.name).toBe(r90Name(w, x).zh);
    // 这个文化换到别的文化组：那条换说法不再适用，回到政体默认的
    const otherGroup = Object.keys(w.small.content!.cultureGroup!).find((id) => id !== culture.group)!;
    put(eng, 'culture', { ...culture, group: otherGroup });
    for (const x of metas(w)) {
      if (x.nameLocked) continue;
      expect(x.name, x.name).toBe(r90Name(w, x).zh);
      for (const r of loreOf(w.small, x.id).rulers) expect(r.title).toBe(r90Ruler(w, x));
    }
    expect(metas(w).find((x) => x.id === m.id)!.name).not.toBe(`${m.base.zh}邦`);
    // 等级的高低倒过来：没写到的等级取“最近的一级”会变，现算的和存着的仍然一样
    const tiers = worldTiers(w.small);
    for (const t of tiers) put(eng, 'countryTier', { ...t, order: -t.order });
    for (const x of metas(w)) if (!x.nameLocked) expect(x.name).toBe(r90Name(w, x).zh);
  });

  it('retitle 什么都没变时返回 0、不换档案的对象', () => {
    const w = nations().world;
    const archive = w.small.archive;
    expect(retitle(w, titleBefore(w.small))).toBe(0);
    expect(w.small.archive).toBe(archive);
  });
});

describe('时代的“集团的称号”：帝国、联邦、同盟的名字和联邦成员邦的名字跟着变', () => {
  const reRelations = (era: Era, f: (zh: string) => string): Era => ({
    ...era,
    relations: { titles: Object.fromEntries(Object.entries(era.relations?.titles ?? {}).map(([k, list]) => [k, (list ?? []).map((t) => mapOne(t, f))])) },
  });
  const blocNames = (w: World) => (w.small.blocs ?? []).map((b) => `${b.kind}:${b.name}|${b.orig ?? ''}`).sort();

  for (const eraId of ['industrial', 'modern', 'scifi']) {
    it(`${eraId}：改了马上变；和“改完再重新生成国家”起出来的一样；撤销回去`, () => {
      const eng = eraWorld(eraId);
      const w = eng.world;
      const era = worldEra(w.small)!;
      expect(Object.keys(era.relations?.titles ?? {}).length).toBeGreaterThan(0);
      const blocs0 = structuredClone(w.small.blocs ?? []);
      expect(blocs0.length).toBeGreaterThan(0);
      const names0 = namesOf(w);
      put(eng, 'era', reRelations(era, (zh) => `${zh}新`));
      const blocs1 = w.small.blocs!;
      // 每个集团都换了名字（生成的集团没有手改过的）
      for (const b of blocs1) {
        const o = blocs0.find((x) => x.id === b.id)!;
        expect(b.name, `${b.kind} ${o.name}`).toBe(`${o.name}新`);
      }
      // 联邦的成员邦换了称号；别的国家不动
      const members = new Set(blocs1.filter((b) => b.kind === 'federation').flatMap((b) => b.members));
      let fed = 0;
      for (const m of metas(w)) {
        if (members.has(m.id) && m.nameLocked && m.name !== names0[m.id][0]) {
          fed++;
          expect(m.name).toBe(`${names0[m.id][0]}新`);
        } else expect(m.name).toBe(names0[m.id][0]);
      }
      if (members.size) expect(fed).toBeGreaterThan(0);
      // 和重新生成起出来的一样
      const regen = eng.clone();
      regen.exec({ op: 'regenerate_countries' });
      expect(blocNames(w)).toEqual(blocNames(regen.world));
      expect(metas(w).map((m) => m.name).sort()).toEqual(metas(regen.world).map((m) => m.name).sort());
      const again = Engine.fromDoc(eng.toDoc(), w.mesh).world;
      expect(JSON.stringify(again.small.blocs)).toBe(JSON.stringify(w.small.blocs));
      expect(JSON.stringify(again.small.countries)).toBe(JSON.stringify(w.small.countries));
      eng.undo();
      expect(eng.world.small.blocs).toEqual(blocs0);
      expect(namesOf(eng.world)).toEqual(names0);
    });
  }

  it('手改过名字的集团不动；改时代别的项（人口密度）谁也不改名', () => {
    const eng = eraWorld('modern');
    const w = eng.world;
    const b = w.small.blocs![0];
    eng.exec({ op: 'set_bloc', id: b.id, patch: { name: '我的同盟' } });
    const names0 = namesOf(w);
    const blocs0 = structuredClone(w.small.blocs!);
    put(eng, 'era', { ...worldEra(w.small)!, popDensity: 9 });
    expect(w.small.blocs).toEqual(blocs0);
    expect(namesOf(w)).toEqual(names0);
    put(eng, 'era', reRelations(worldEra(w.small)!, (zh) => `${zh}新`));
    expect(w.small.blocs!.find((x) => x.id === b.id)!.name).toBe('我的同盟');
    expect(w.small.blocs!.filter((x) => x.id !== b.id).every((x) => x.name.endsWith('新'))).toBe(true);
  });
});

describe('titled 的写法没变', () => {
  it('中文接在后面或换进 {name}；外文按称号的写法', () => {
    expect(titled({ zh: '青岚', orig: 'Qinglan' }, { zh: '王国', orig: 'Kingdom of {name}' })).toEqual({ zh: '青岚王国', orig: 'Kingdom of Qinglan' });
    expect(titled({ zh: '青岚' }, { zh: '大{name}朝' })).toEqual({ zh: '大青岚朝' });
  });
});
