import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { Command } from '../commands';
import { Engine } from '../engine';
import { exportPart, exportPartAvailable } from '../export';
import { mixSeed } from '../rng';
import { continents, humanExec, snapshot, type HumanCommand } from '../testing/fixtures';
import type { World } from '../world';
import { currentRuler, eventsOf, loreOf } from './archive-store';
import { personName } from './country-names';
import { countrySeed, styleOf } from './countries/records';
import { cultureById, worldEra } from './era';
import { countryTimeline } from './events';
import { eraNow, rulersByDynasty } from './rulers';
import { safeFileName, wikiFiles } from './wiki';

// 第八十五轮：国家的档案——备注、统治者与家族、大事；重新生成时留下手写的；导出维基

const GEN: HumanCommand = { op: 'generate_human', packs: [['medieval']], groups: [{ id: 'germanic', weight: 3 }, { id: 'chinese', weight: 3 }, { id: 'altaic', weight: 1.5 }], countries: {}, settlements: {} };

const nations = (): Engine =>
  snapshot('lore-nations', () => {
    const eng = continents({ provinces: true });
    humanExec(eng, GEN);
    return eng;
  });

const ids = (w: World) => Object.keys(w.small.countries ?? {}).map(Number).sort((a, b) => a - b);
const archiveJson = (w: World) => JSON.stringify(w.small.archive ?? null);

// 整个档案冻住：改档案的地方都要换成新对象（就地改会抛错）
function deepFreeze<T>(x: T): T {
  if (x && typeof x === 'object' && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const v of Object.values(x)) deepFreeze(v);
  }
  return x;
}

describe('生成的统治者、家族、大事', () => {
  it('每国 3–8 位统治者、1–3 个家族，从建国到时代的现在；最后一位的名字和以前的 ruler 相同', () => {
    const w = nations().world;
    const now = eraNow(worldEra(w.small));
    const seed = w.small.human!.countryRules!.seed;
    expect(ids(w).length).toBeGreaterThan(3);
    for (const id of ids(w)) {
      const m = w.small.countries![id];
      const lore = loreOf(w.small, id);
      expect(lore.rulers.length, m.name).toBeGreaterThanOrEqual(3);
      expect(lore.rulers.length).toBeLessThanOrEqual(8);
      expect(lore.dynasties.length).toBeGreaterThanOrEqual(1);
      expect(lore.dynasties.length).toBeLessThanOrEqual(3);
      expect(lore.edited).toBeUndefined();
      expect(lore.rulers[0].from).toBe(m.founded);
      const last = lore.rulers[lore.rulers.length - 1];
      expect(last.to).toBeUndefined();
      expect(last.from).toBeLessThanOrEqual(now);
      for (let k = 0; k < lore.rulers.length; k++) {
        const r = lore.rulers[k];
        if (r.to !== undefined) expect(r.to).toBeGreaterThanOrEqual(r.from);
        if (k) expect(r.from).toBeGreaterThanOrEqual(lore.rulers[k - 1].to!);
        expect(lore.dynasties.some((d) => d.id === r.dynasty)).toBe(true);
        if (r.parent !== undefined) expect(lore.rulers.find((x) => x.id === r.parent)!.dynasty).toBe(r.dynasty);
      }
      for (const d of lore.dynasties) expect(lore.rulers.find((r) => r.id === d.founder)?.dynasty).toBe(d.id);
      // 以前的 ruler：同一个种子起的名字（没有和前面的重名时）
      const old = personName(styleOf(w, cultureById(w.small, m.primaryCulture)), mixSeed(countrySeed(seed, id), 0x7e1));
      if (!lore.rulers.slice(0, -1).some((r) => r.name === old.zh)) expect(last.name).toBe(old.zh || '无名');
    }
  });

  it('同样的种子生成的档案逐字相同；换种子不同', () => {
    const a = continents({ provinces: true });
    humanExec(a, GEN);
    const b = continents({ provinces: true });
    humanExec(b, GEN);
    expect(archiveJson(a.world)).toBe(archiveJson(b.world));
    expect(archiveJson(a.world)).toBe(archiveJson(nations().world));
    b.exec({ op: 'regenerate_countries', seed: 9 });
    expect(archiveJson(b.world)).not.toBe(archiveJson(a.world));
  });

  it('结盟、开战、从属各记一次（两国的年表里都有）；年表里有建国与每位统治者即位', () => {
    const w = nations().world;
    const events = Object.values(w.small.archive!.events);
    const pairs = new Set<string>();
    for (const m of Object.values(w.small.countries!)) {
      for (const x of m.allies) pairs.add(`ally:${Math.min(m.id, x)}:${Math.max(m.id, x)}`);
      for (const x of m.rivals) pairs.add(`war:${Math.min(m.id, x)}:${Math.max(m.id, x)}`);
      if (m.overlord !== undefined) pairs.add(`sub:${m.id}:${m.overlord}`);
    }
    expect(events.length).toBe(pairs.size);
    expect(events.every((e) => e.auto)).toBe(true);
    for (const e of events) {
      for (const c of e.countries) expect(eventsOf(w.small, c)).toContain(e);
      const [a, b] = e.countries;
      expect(e.year).toBeGreaterThanOrEqual(Math.max(w.small.countries![a].founded, w.small.countries![b].founded));
    }
    const id = ids(w)[0];
    const tl = countryTimeline(w, id);
    expect(tl[0]).toMatchObject({ kind: 'founded', year: w.small.countries![id].founded });
    expect(tl.filter((r) => r.kind === 'accession').length).toBe(loreOf(w.small, id).rulers.length);
    for (let k = 1; k < tl.length; k++) expect(tl[k].year).toBeGreaterThanOrEqual(tl[k - 1].year);
  });

  it('按家族列：家族按第一次出现的先后，孩子比父母往里缩一格', () => {
    const w = nations().world;
    for (const id of ids(w)) {
      const lore = loreOf(w.small, id);
      const groups = rulersByDynasty(lore);
      expect(groups.flatMap((g) => g.rows.map((r) => r.ruler.id)).sort((x, y) => x - y)).toEqual(lore.rulers.map((r) => r.id).sort((x, y) => x - y));
      for (const g of groups) for (const row of g.rows) {
        const p = lore.rulers.find((r) => r.id === row.ruler.parent);
        const pr = g.rows.find((x) => x.ruler.id === p?.id);
        expect(row.depth).toBe(pr ? Math.min(pr.depth + 1, 4) : 0);
      }
    }
  });
});

describe('档案的命令（撤销、重做）', () => {
  const steps = (w: World, id: number, other: number): Command[] => {
    const lore = loreOf(w.small, id);
    const r0 = lore.rulers[0];
    const last = lore.rulers[lore.rulers.length - 1];
    return [
      { op: 'set_country_note', id, note: '北方的王国，冬天很长。' },
      { op: 'add_ruler', id, ruler: { name: '阿尔文', title: '女王', from: last.from + 1, dynasty: last.dynasty, parent: last.id, note: '最后一位' } },
      { op: 'set_ruler', id, ruler: r0.id, patch: { name: '开国者', from: r0.from, to: r0.to ?? null, note: '开国' } },
      { op: 'move_ruler', id, ruler: r0.id, to: 1 },
      { op: 'add_dynasty', id, name: '新家' },
      { op: 'set_dynasty', id, dynasty: lore.dynasties[0].id, patch: { name: '老家' } },
      { op: 'set_ruler', id, ruler: last.id, patch: { dynasty: null, parent: null } },
      { op: 'remove_ruler', id, ruler: r0.id },
      { op: 'remove_dynasty', id, dynasty: lore.dynasties[0].id },
      { op: 'add_event', event: { year: 1100, title: '大会盟', note: '在河边', countries: [id, other] } },
      { op: 'set_event', event: Object.values(w.small.archive!.events)[0].id, patch: { title: '改过的', year: 1000 } },
      { op: 'remove_event', event: Object.values(w.small.archive!.events)[0].id },
      { op: 'set_country_note', id, note: null },
    ];
  };

  it('每一步都改档案（不改地图）；撤销回到原样，重做回到改后（对象冻住也行：不就地改）', () => {
    const eng = nations();
    const w = eng.world;
    const [id, other] = ids(w);
    deepFreeze(w.small.archive);
    const before: string[] = [];
    const after: string[] = [];
    const land = Array.from(w.causes.country!);
    for (const cmd of steps(w, id, other)) {
      before.push(archiveJson(eng.world));
      eng.exec(cmd);
      after.push(archiveJson(eng.world));
      expect(after[after.length - 1], cmd.op).not.toBe(before[before.length - 1]);
      deepFreeze(eng.world.small.archive);
    }
    expect(Array.from(eng.world.causes.country!)).toEqual(land);
    for (let k = before.length - 1; k >= 0; k--) {
      eng.undo();
      expect(archiveJson(eng.world), `undo ${k}`).toBe(before[k]);
    }
    for (let k = 0; k < after.length; k++) {
      eng.redo();
      expect(archiveJson(eng.world), `redo ${k}`).toBe(after[k]);
    }
    // 世界文件重放出来一样
    const again = Engine.fromDoc(eng.toDoc(), eng.world.mesh);
    expect(archiveJson(again.world)).toBe(archiveJson(eng.world));
  });

  it('改过的一位标出 edited；加的大事两国的年表里都有、只存一份；别的命令不换档案对象', () => {
    const eng = nations();
    const [id, other] = ids(eng.world);
    eng.exec({ op: 'set_ruler', id, ruler: loreOf(eng.world.small, id).rulers[0].id, patch: { name: '某某' } });
    expect(loreOf(eng.world.small, id).edited).toBe(true);
    eng.exec({ op: 'add_event', event: { year: 1000, title: '联姻', countries: [id, other] } });
    const e = Object.values(eng.world.small.archive!.events).find((x) => x.title === '联姻')!;
    expect(e.auto).toBeUndefined();
    expect(countryTimeline(eng.world, id).some((r) => r.kind === 'event' && r.event === e)).toBe(true);
    expect(countryTimeline(eng.world, other).some((r) => r.kind === 'event' && r.event === e)).toBe(true);
    const a = eng.world.small.archive;
    eng.exec({ op: 'set_country', id, patch: { name: '测试国' } });
    expect(eng.world.small.archive).toBe(a);
    // 改了生成的大事：不再是生成的
    const auto = Object.values(a!.events).find((x) => x.auto);
    if (auto) {
      eng.exec({ op: 'set_event', event: auto.id, patch: { note: '写了几句' } });
      expect(eng.world.small.archive!.events[auto.id].auto).toBeUndefined();
    }
  });

  it('不对的输入报错、什么都不改：父母不能是自己的后代，结束早于开始，找不到的家族', () => {
    const eng = nations();
    const id = ids(eng.world)[0];
    const lore = loreOf(eng.world.small, id);
    const was = archiveJson(eng.world);
    const child = lore.rulers.find((r) => r.parent !== undefined);
    if (child) expect(() => eng.exec({ op: 'set_ruler', id, ruler: child.parent!, patch: { parent: child.id } })).toThrow(/后代/);
    expect(() => eng.exec({ op: 'set_ruler', id, ruler: lore.rulers[0].id, patch: { from: 2000, to: 1000 } })).toThrow(/早于/);
    expect(() => eng.exec({ op: 'set_ruler', id, ruler: lore.rulers[0].id, patch: { dynasty: 99 } })).toThrow(/家族/);
    expect(() => eng.exec({ op: 'add_event', event: { year: 1, title: 'x', countries: [9999] } })).toThrow();
    expect(archiveJson(eng.world)).toBe(was);
  });

  it('删除、合并国家：档案跟着整理（合并时大事归并进去的那一国）', () => {
    const eng = nations();
    const [a, b, c] = ids(eng.world);
    eng.exec({ op: 'add_event', event: { year: 1000, title: '三国会盟', countries: [a, b, c] } });
    eng.exec({ op: 'add_event', event: { year: 1001, title: 'b 的事', countries: [b] } });
    eng.exec({ op: 'merge_countries', a, b });
    const ev = Object.values(eng.world.small.archive!.events);
    expect(ev.find((e) => e.title === '三国会盟')!.countries).toEqual([a, c]);
    expect(ev.find((e) => e.title === 'b 的事')!.countries).toEqual([a]);
    expect(eng.world.small.archive!.countries[b]).toBeUndefined();
    eng.exec({ op: 'remove_country', id: c });
    expect(eng.world.small.archive!.countries[c]).toBeUndefined();
    expect(Object.values(eng.world.small.archive!.events).some((e) => e.countries.includes(c))).toBe(false);
    eng.exec({ op: 'remove_countries' });
    expect(eng.world.small.archive).toBeUndefined();
  });

  it('新建、拆分出来的国家也有统治者', () => {
    const eng = nations();
    const id = ids(eng.world)[0];
    eng.exec({ op: 'split_country', id });
    const fresh = Math.max(...ids(eng.world));
    expect(loreOf(eng.world.small, fresh).rulers.length).toBeGreaterThanOrEqual(3);
    expect(currentRuler(eng.world.small, fresh)?.to).toBeUndefined();
  });
});

describe('重新生成时留下手写的', () => {
  it('锁定的国家整份不动；按编号留下来的国家留着备注、改过的统治者、自己写的大事；生成的重新生成', () => {
    const eng = nations();
    const w0 = eng.world;
    const [a, b, c] = ids(w0);
    eng.exec({ op: 'set_country', id: a, patch: { locked: true } });
    eng.exec({ op: 'set_country_note', id: a, note: 'A 的设定' });
    eng.exec({ op: 'set_country_note', id: b, note: 'B 的设定' });
    eng.exec({ op: 'set_ruler', id: b, ruler: loreOf(eng.world.small, b).rulers[0].id, patch: { name: 'B 的开国者' } });
    eng.exec({ op: 'add_event', event: { year: 1000, title: '手写的', countries: [a, c] } });
    const loreA = loreOf(eng.world.small, a);
    const loreB = loreOf(eng.world.small, b);
    const autoBefore = Object.values(eng.world.small.archive!.events).filter((e) => e.auto && !e.countries.every((x) => x === a));
    // 只重新生成人文（国家不动）：档案一个都不动
    const arch = eng.world.small.archive;
    humanExec(eng, { op: 'regenerate_human' });
    expect(eng.world.small.archive).toBe(arch);
    // 重新生成国家（锁定的留着）
    eng.exec({ op: 'regenerate_countries', seed: 11 });
    const w = eng.world;
    expect(loreOf(w.small, a)).toBe(loreA);
    const hand = Object.values(w.small.archive!.events).find((e) => e.title === '手写的')!;
    expect(hand.countries[0]).toBe(a);
    expect(hand.countries.every((x) => !!w.small.countries![x])).toBe(true);
    if (w.small.countries![b]) {
      expect(loreOf(w.small, b).note).toBe('B 的设定');
      expect(loreOf(w.small, b).rulers).toEqual(loreB.rulers);
      expect(loreOf(w.small, b).edited).toBe(true);
    }
    // 生成的大事（两头不都是锁定的）是新生成的
    for (const e of autoBefore) expect(Object.values(w.small.archive!.events)).not.toContain(e);
    for (const id of ids(w)) expect(loreOf(w.small, id).rulers.length).toBeGreaterThan(0);
    // 撤销回到原来的
    eng.undo();
    expect(eng.world.small.archive).toBe(arch);
  });

  it('不留锁定的（编号从 1 起）：同一个编号的国家留着备注', () => {
    const eng = nations();
    const [a] = ids(eng.world);
    eng.exec({ op: 'set_country_note', id: a, note: '留着' });
    eng.exec({ op: 'regenerate_countries', seed: 3, keepLocked: false });
    if (eng.world.small.countries![a]) expect(loreOf(eng.world.small, a).note).toBe('留着');
  });
});

describe('导出维基', () => {
  it('index.md、每国一页、每座城市一页；链接都指向包里的文件；文件名安全、不重名', () => {
    const eng = nations();
    const w = eng.world;
    const [a, b] = ids(w);
    // 重名、不能用的字
    eng.exec({ op: 'set_country', id: a, patch: { name: 'A/B:国*?' } });
    eng.exec({ op: 'set_country', id: b, patch: { name: 'a/b:国' } });
    eng.exec({ op: 'set_country_note', id: a, note: '第一行\n第二行' });
    const files = wikiFiles(eng.world);
    const names = Object.keys(files);
    expect(names).toContain('index.md');
    const countryPages = names.filter((f) => f.startsWith('countries/'));
    const cityPages = names.filter((f) => f.startsWith('cities/'));
    expect(countryPages.length).toBe(ids(eng.world).length);
    expect(cityPages.length).toBe(Object.keys(eng.world.small.cities ?? {}).length);
    expect(cityPages.length).toBeGreaterThan(0);
    expect(new Set(names.map((f) => f.toLowerCase())).size).toBe(names.length);
    for (const f of names) {
      const base = f.split('/').pop()!;
      expect(base, f).not.toMatch(/[<>:"/\\|?*#%\s()]/);
      expect(base.length).toBeLessThanOrEqual(64);
    }
    // 链接
    let count = 0;
    for (const [f, text] of Object.entries(files)) {
      const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/') + 1) : '';
      for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
        const parts = (dir + m[1]).split('/');
        const out: string[] = [];
        for (const p of parts) {
          if (p === '..') out.pop();
          else out.push(p);
        }
        expect(files[out.join('/')], `${f} → ${m[1]}`).toBeDefined();
        count++;
      }
    }
    expect(count).toBeGreaterThan(countryPages.length);
    const pa = files[countryPages.find((f) => files[f].startsWith('# A/B:国*?'))!];
    for (const h of ['## 概览', '## 备注', '## 统治者', '## 大事年表', '## 省份']) expect(pa).toContain(h);
    expect(pa).toContain('第一行\n第二行');
    // 打成 zip：解开是同样的文件
    expect(exportPartAvailable(eng.world, 'wiki')).toBe(true);
    const zip = exportPart(eng.world, 'wiki')['wiki.zip'];
    const un = unzipSync(zip);
    expect(Object.keys(un).sort()).toEqual(names.sort());
    expect(strFromU8(un['index.md'])).toBe(files['index.md']);
  });

  it('文件名：去掉不能用的字，空的、保留的名字换掉，太长的截短', () => {
    expect(safeFileName('a/b\\c:d*e?f"g<h>i|j', 'x')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(safeFileName('  ..  ', 'country-3')).toBe('country-3');
    expect(safeFileName('CON', 'x')).toBe('_CON');
    expect([...safeFileName('名'.repeat(100), 'x')].length).toBe(60);
    expect(safeFileName('奥斯特 王国 (北)', 'x')).toBe('奥斯特_王国_北');
  });
});
