import { describe, expect, it } from 'vitest';
import type { WorldDoc } from '../core/engine';
import { createMap, memoryMapStore } from './maps';
import {
  ORPHAN_WORLDS,
  TIERS,
  VERSION_BYTES,
  VERSION_EVERY_MS,
  type VersionInfo,
  addVersion,
  dropSeries,
  latestOf,
  makeRoom,
  mapSeries,
  memoryVersionIo,
  moveSeries,
  overwriteKeeping,
  planDrop,
  removeVersion,
  seriesMap,
  sortVersions,
  thin,
  versionBudget,
  versionBytes,
  versionFileName,
  worldSeries,
} from './versions';

// 第九十五轮：以前的版本——留哪些（按时间稀疏、合计的上限）、存、删、改键、盖掉“我的地图”里的一张之前留一份。
// 存储换成内存里的

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// 一个固定的“现在”（整点，免得格子的边界晃）
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);

const region = { seed: 1, cells: 40000, aspect: 2, latNorth: 60, latSouth: 20 };
const doc = (commands: number, tag = 'n'): WorldDoc => ({
  format: 'map2-world',
  version: 22,
  settings: region as WorldDoc['settings'],
  commands: Array.from({ length: commands }, (_, k) => ({ op: 'rename_feature', key: `k${k}`, name: `${tag}${k}` }) as unknown as WorldDoc['commands'][number]),
});
const text = (commands: number, tag = 'n') => JSON.stringify(doc(commands, tag));
const info = (id: string, series: string, at: number, bytes = 100, why: VersionInfo['why'] = 'auto'): VersionInfo => ({ id, series, at, steps: 1, bytes, why });

describe('留哪些：按时间稀疏', () => {
  it('四档：最近一小时 5 分钟一份、一天之内一小时一份、昨天 6 小时一份、一周之内一天一份', () => {
    expect(TIERS).toEqual([
      { within: HOUR, every: 5 * MIN },
      { within: DAY, every: HOUR },
      { within: 2 * DAY, every: 6 * HOUR },
      { within: 8 * DAY, every: DAY },
    ]);
    expect(VERSION_EVERY_MS).toBe(5 * MIN);
  });

  it('最近一小时里每 5 分钟的格子留最新的一份', () => {
    // 每分钟一份，共 60 份（1–60 分钟前）
    const list = Array.from({ length: 60 }, (_, k) => ({ at: NOW - (k + 1) * MIN }));
    const kept = thin(list, NOW).map((k) => (NOW - list[k].at) / MIN);
    // 60 分钟前的那一份已经不在“最近一小时”里（按一小时一格算，和 59…1 分钟前的不同格）
    expect(kept.filter((m) => m < 60)).toEqual([1, 6, 11, 16, 21, 26, 31, 36, 41, 46, 51, 56]);
    expect(kept.length).toBe(13);
  });

  it('隔 5 分钟留的一小时以内一份都不丢；过了一小时，每个整点的格子只剩最新的', () => {
    const list = Array.from({ length: 36 }, (_, k) => ({ at: NOW - k * 5 * MIN - MIN }));
    const kept = new Set(thin(list, NOW));
    list.forEach((v, k) => {
      if (NOW - v.at < HOUR) expect(kept.has(k)).toBe(true);
    });
    const older = list.filter((v, k) => NOW - v.at >= HOUR && kept.has(k));
    // 1–3 小时前：每个整点一格
    expect(older.length).toBe(new Set(older.map((v) => Math.floor(v.at / HOUR))).size);
    expect(older.length).toBeLessThanOrEqual(3);
    for (const v of older) {
      const slot = Math.floor(v.at / HOUR);
      const newest = Math.max(...list.filter((x) => NOW - x.at >= HOUR && Math.floor(x.at / HOUR) === slot).map((x) => x.at));
      expect(v.at).toBe(newest);
    }
  });

  it('昨天每 6 小时一份、一周之内每天一份；再早的只留最新的一份', () => {
    // 每小时一份，共 20 天
    const list = Array.from({ length: 20 * 24 }, (_, k) => ({ at: NOW - k * HOUR - 30 * MIN }));
    const kept = thin(list, NOW).map((k) => list[k].at);
    const age = (t: number) => NOW - t;
    expect(kept.filter((t) => age(t) < DAY).length).toBe(24);
    expect(kept.filter((t) => age(t) >= DAY && age(t) < 2 * DAY).length).toBe(4);
    // 六天的跨度，按日历上的天分格：跨着 6 或 7 天
    const week = kept.filter((t) => age(t) >= 2 * DAY && age(t) < 8 * DAY);
    expect(week.length).toBeGreaterThanOrEqual(6);
    expect(week.length).toBeLessThanOrEqual(7);
    expect(new Set(week.map((t) => Math.floor(t / DAY))).size).toBe(week.length);
    const old = kept.filter((t) => age(t) >= 8 * DAY);
    expect(old).toEqual([Math.max(...list.map((v) => v.at).filter((t) => age(t) >= 8 * DAY))]);
    // 一共不超过 12 + 23 + 4 + 7 + 1
    expect(kept.length).toBeLessThanOrEqual(47);
  });

  it('只有很久以前的几份：留最新的那一份，不会一份都不剩', () => {
    const list = [{ at: NOW - 40 * DAY }, { at: NOW - 30 * DAY }, { at: NOW - 90 * DAY }];
    expect(thin(list, NOW)).toEqual([1]);
    expect(thin([], NOW)).toEqual([]);
    expect(thin([{ at: NOW - 400 * DAY }], NOW)).toEqual([0]);
  });

  it('回去之前留的、被换掉之前留的：一周之内不稀疏；过了一周和别的一样', () => {
    const list = [
      { at: NOW - 2 * MIN, why: 'auto' as const },
      { at: NOW - 2 * MIN - 1000, why: 'before-restore' as const },
      { at: NOW - 2 * MIN - 2000, why: 'replaced' as const },
      { at: NOW - 2 * MIN - 3000, why: 'before-reload' as const },
      { at: NOW - 2 * MIN - 4000, why: 'opened' as const },
      { at: NOW - 2 * MIN - 5000, why: 'auto' as const },
    ];
    // 同一个 5 分钟的格子里：平常留的、打开时留的只剩最新的一份，另外三种都在
    expect(thin(list, NOW)).toEqual([0, 1, 2, 3]);
    const old = list.map((v) => ({ ...v, at: v.at - 9 * DAY }));
    expect(thin(old, NOW)).toEqual([0]);
  });

  it('时间比现在还晚的（改过电脑的钟）：当成刚留的', () => {
    expect(thin([{ at: NOW + HOUR }, { at: NOW - MIN }], NOW)).toEqual([0, 1]);
  });
});

describe('合计的上限', () => {
  it('默认 400 MB；浏览器说得出给多少时不超过四分之一；快满了减半', () => {
    expect(VERSION_BYTES).toBe(400 * 1024 * 1024);
    expect(versionBudget(null)).toBe(VERSION_BYTES);
    expect(versionBudget({})).toBe(VERSION_BYTES);
    expect(versionBudget({ quota: 100e9, usage: 1e9 })).toBe(VERSION_BYTES);
    expect(versionBudget({ quota: 400e6, usage: 1e6 })).toBe(100e6);
    expect(versionBudget({ quota: 400e6, usage: 380e6 })).toBe(50e6);
    expect(versionBudget({ quota: 100e9, usage: 95e9 })).toBe(VERSION_BYTES / 2);
  });

  it('超过上限从最旧的丢起，不分是哪个世界的；刚写的那一份不丢', () => {
    const list = [info('a1', 'w:a', NOW - 50 * MIN, 300), info('a2', 'w:a', NOW - 40 * MIN, 300), info('b1', 'm:b', NOW - 45 * MIN, 300), info('a3', 'w:a', NOW - 10 * MIN, 300), info('new', 'w:a', NOW, 300)];
    expect(planDrop(list, NOW, 1500)).toEqual([]);
    expect(planDrop(list, NOW, 1200).sort()).toEqual(['a1']);
    expect(planDrop(list, NOW, 700).sort()).toEqual(['a1', 'a2', 'b1']);
    // 上限比一份还小：别的都丢，刚写的那一份留着
    expect(planDrop(list, NOW, 10, { protect: 'new' }).sort()).toEqual(['a1', 'a2', 'a3', 'b1']);
    // 最旧的那一份正好是刚写的（钟往回拨过）：跳过它，丢下一份
    expect(planDrop(list, NOW, 1200, { protect: 'a1' }).sort()).toEqual(['b1']);
  });

  it('先按时间稀疏（各个世界各算各的），再看合计', () => {
    const list = [info('a1', 'w:a', NOW - 3 * MIN), info('a2', 'w:a', NOW - 2 * MIN), info('b1', 'm:b', NOW - 3 * MIN), info('b2', 'm:b', NOW - 2 * MIN)];
    expect(planDrop(list, NOW, Infinity).sort()).toEqual(['a1', 'b1']);
  });

  it(`没存进“我的地图”的旧世界只留最近 ${ORPHAN_WORLDS} 个；现在开着的、“我的地图”里的不算`, () => {
    expect(ORPHAN_WORLDS).toBe(6);
    const list = [
      ...Array.from({ length: 9 }, (_, k) => info(`o${k}`, `w:o${k}`, NOW - (k + 1) * DAY)),
      info('o8b', 'w:o8', NOW - 9 * DAY - HOUR),
      info('cur', 'w:cur', NOW - 30 * DAY),
      info('map', 'm:x', NOW - 30 * DAY),
    ];
    // o0…o5 是最近的 6 个；o6、o7、o8（两份）整串丢掉；现在开着的那个再旧也留
    expect(planDrop(list, NOW, Infinity, { current: 'w:cur' }).sort()).toEqual(['o6', 'o7', 'o8', 'o8b']);
    // 不说现在开着的是哪个：它也按没存的旧世界算（排在最后，丢掉）
    expect(planDrop(list, NOW, Infinity).sort()).toEqual(['cur', 'o6', 'o7', 'o8', 'o8b']);
    // 刚写的那一份所在的那一串不算旧世界
    expect(planDrop(list, NOW, Infinity, { protect: 'o8b' }).sort()).toEqual(['cur', 'o6', 'o7']);
  });
});

describe('留一份', () => {
  it('留下：小条里是时间、几步、多大、为什么留的、名字和概况；世界文件的字原样', async () => {
    const io = memoryVersionIo();
    const t = text(3);
    const r = await addVersion(io, { series: mapSeries('m1'), text: t, steps: 3, why: 'auto', name: '赤原', summary: { kind: 'region', sizeKm: 4400, cells: 40000 }, thumb: 'data:x' }, { now: NOW });
    expect(r.kind).toBe('kept');
    if (r.kind !== 'kept') return;
    expect(r.info).toEqual({ id: r.info.id, series: 'm:m1', at: NOW, steps: 3, bytes: t.length * 2 + 6, why: 'auto', name: '赤原', kind: 'region', sizeKm: 4400, cells: 40000, thumb: 'data:x' });
    expect(await io.text(r.info.id)).toBe(t);
    expect(versionBytes(t, 'data:x')).toBe(r.info.bytes);
    expect(seriesMap('m:m1')).toBe('m1');
    expect(seriesMap(worldSeries('abc'))).toBeNull();
  });

  it('和这个世界最新的那一份一字不差：不再留；差一个字就留；别的世界的不算', async () => {
    const io = memoryVersionIo();
    const a = await addVersion(io, { series: 'w:a', text: text(3), steps: 3, why: 'auto' }, { now: NOW });
    const same = await addVersion(io, { series: 'w:a', text: text(3), steps: 3, why: 'before-restore' }, { now: NOW + MIN });
    expect(same.kind).toBe('same');
    expect(same.kind === 'same' && a.kind === 'kept' && same.info.id === a.info.id).toBe(true);
    expect(io.infos.size).toBe(1);
    // 一样长、一样多步，只差一个字
    const other = await addVersion(io, { series: 'w:a', text: text(3, 'm'), steps: 3, why: 'auto' }, { now: NOW + 6 * MIN });
    expect(other.kind).toBe('kept');
    // 别的世界里同样的字：照留
    expect((await addVersion(io, { series: 'w:b', text: text(3, 'm'), steps: 3, why: 'auto' }, { now: NOW + 6 * MIN })).kind).toBe('kept');
    expect(io.infos.size).toBe(3);
  });

  it('连着留：一小时以内每 5 分钟一份都在，更早的自己稀疏掉；最新的那一份总在', async () => {
    const io = memoryVersionIo();
    for (let k = 0; k < 40; k++) await addVersion(io, { series: 'w:a', text: text(k + 1), steps: k + 1, why: 'auto' }, { now: NOW + k * 5 * MIN });
    const end = NOW + 39 * 5 * MIN;
    const list = sortVersions(await io.list());
    expect(list[0].steps).toBe(40);
    expect(list.filter((v) => end - v.at < HOUR).length).toBe(12);
    // 3 小时 15 分钟里：12 份 + 每个整点一份
    expect(list.length).toBeLessThanOrEqual(12 + 4);
    expect(io.texts.size).toBe(list.length);
    expect(latestOf(list, 'w:a')!.steps).toBe(40);
    expect(latestOf(list, 'w:none')).toBeNull();
  });

  it('超过合计的上限：最旧的丢掉，刚留的在', async () => {
    const io = memoryVersionIo();
    const one = versionBytes(text(5, 't0'));
    for (let k = 0; k < 6; k++) await addVersion(io, { series: `m:${k}`, text: text(5, `t${k}`), steps: 5, why: 'auto' }, { now: NOW + k * MIN, budget: one * 3 + 10 });
    const list = sortVersions(await io.list());
    expect(list.map((v) => v.series)).toEqual(['m:5', 'm:4', 'm:3']);
  });

  it('存储满了：先丢掉一半旧的再试一次，留成了；丢了也放不下：没留成，不抛错', async () => {
    const io = memoryVersionIo();
    const one = versionBytes(text(5, 't0'));
    for (let k = 0; k < 4; k++) await addVersion(io, { series: `m:${k}`, text: text(5, `t${k}`), steps: 5, why: 'auto' }, { now: NOW + k * MIN });
    io.quota = one * 4 + 10;
    const r = await addVersion(io, { series: 'm:new', text: text(5, 'zz'), steps: 5, why: 'auto' }, { now: NOW + 10 * MIN });
    expect(r.kind).toBe('kept');
    expect(r.kind === 'kept' && r.dropped.length).toBe(2);
    expect(sortVersions(await io.list()).map((v) => v.series)).toEqual(['m:new', 'm:3', 'm:2']);
    // 一份都放不下
    io.quota = 10;
    const bad = await addVersion(io, { series: 'm:big', text: text(5, 'yy'), steps: 5, why: 'auto' }, { now: NOW + 20 * MIN });
    expect(bad.kind).toBe('failed');
    // 存储用不了
    io.down = true;
    expect((await addVersion(io, { series: 'm:x', text: text(1), steps: 1, why: 'auto' })).kind).toBe('failed');
  });
});

describe('删、改键、腾地方', () => {
  async function filled() {
    const io = memoryVersionIo();
    for (const [s, k] of [['w:a', 1], ['w:a', 2], ['m:b', 3]] as const) await addVersion(io, { series: s, text: text(k, s), steps: k, why: 'auto' }, { now: NOW + k * 6 * MIN });
    return io;
  }

  it('删一份：小条和世界文件一起没', async () => {
    const io = await filled();
    const id = latestOf(await io.list(), 'w:a')!.id;
    await removeVersion(io, id);
    expect(io.infos.has(id)).toBe(false);
    expect(io.texts.has(id)).toBe(false);
    expect(io.infos.size).toBe(2);
  });

  it('第一次存进“我的地图”：这个世界的版本都改到那一张上，世界文件不动', async () => {
    const io = await filled();
    expect(await moveSeries(io, 'w:a', 'm:new')).toBe(2);
    const list = await io.list();
    expect(list.map((v) => v.series).sort()).toEqual(['m:b', 'm:new', 'm:new']);
    expect(io.texts.size).toBe(3);
    expect(await moveSeries(io, 'w:none', 'm:x')).toBe(0);
    expect(await moveSeries(io, 'm:b', 'm:b')).toBe(0);
  });

  it('删掉一张地图：它的版本一起删，别的不动', async () => {
    const io = await filled();
    expect(await dropSeries(io, 'w:a')).toBe(2);
    expect((await io.list()).map((v) => v.series)).toEqual(['m:b']);
    expect(io.texts.size).toBe(1);
  });

  it('腾地方（自动保存写不进去时）：丢掉一半旧的，至少一份；没有版本时 0', async () => {
    const io = await filled();
    expect(await makeRoom(io, NOW + HOUR)).toBeGreaterThanOrEqual(1);
    const left = await io.list();
    expect(left.length).toBeLessThan(3);
    // 留下的是新的
    expect(left.some((v) => v.series === 'm:b')).toBe(true);
    const one = memoryVersionIo();
    await addVersion(one, { series: 'w:a', text: text(1), steps: 1, why: 'auto' }, { now: NOW });
    expect(await makeRoom(one, NOW)).toBe(1);
    expect(await makeRoom(one, NOW)).toBe(0);
  });

  it('文件名：名字、日期、几点几分', () => {
    const at = new Date(2026, 10, 11, 14, 5).getTime();
    expect(versionFileName({ at, name: '赤原' })).toBe('赤原 2026-11-11 1405.json');
    expect(versionFileName({ at })).toBe('世界 2026-11-11 1405.json');
    expect(versionFileName({ at, name: 'a/b:c' })).toBe('a_b_c 2026-11-11 1405.json');
  });
});

describe('盖掉“我的地图”里的一张之前', () => {
  async function setup() {
    const store = memoryMapStore();
    const io = memoryVersionIo();
    const e = await createMap(store, { name: '赤原', doc: doc(3), thumb: 'data:t', now: NOW });
    return { store, io, e };
  }

  it('存着的就是这个页面上一次写的：直接盖，不留', async () => {
    const { store, io, e } = await setup();
    const r = await overwriteKeeping(store, io, e.id, { doc: doc(4, 'x'), now: NOW + MIN, known: e.savedAt });
    expect(r!.kept).toBeNull();
    expect(r!.entry.steps).toBe(4);
    expect(io.infos.size).toBe(0);
  });

  it('别的页面写过、而且不是要写的这一份的开头：先把存着的那一份留成一个版本，再盖', async () => {
    const { store, io, e } = await setup();
    // 别的页面写了一份不一样的
    await store.write({ ...e, savedAt: NOW + MIN, steps: 5 }, doc(5, 'other'));
    const r = await overwriteKeeping(store, io, e.id, { doc: doc(4, 'mine'), now: NOW + 2 * MIN, known: e.savedAt });
    expect(r!.kept).not.toBeNull();
    expect(r!.kept).toMatchObject({ series: mapSeries(e.id), why: 'replaced', steps: 5, name: '赤原', thumb: 'data:t' });
    expect(await io.text(r!.kept!.id)).toBe(JSON.stringify(doc(5, 'other')));
    expect((await store.doc(e.id))!.commands).toEqual(doc(4, 'mine').commands);
  });

  it('别的页面写过，但它写的正是这一份的开头（同一个世界往前做了）：盖掉什么都不丢，不留', async () => {
    const { store, io, e } = await setup();
    await store.write({ ...e, savedAt: NOW + MIN, steps: 4 }, doc(4));
    const r = await overwriteKeeping(store, io, e.id, { doc: doc(6), now: NOW + 2 * MIN, known: e.savedAt });
    expect(r!.kept).toBeNull();
    expect(io.infos.size).toBe(0);
    expect((await store.doc(e.id))!.commands.length).toBe(6);
  });

  it('两个页面来回：不写的那一页 ⌘S 盖之前留着写的那一页的，写的那一页再盖之前留着 ⌘S 的那一份', async () => {
    const { store, io, e } = await setup();
    // 甲（写的那一页）自动保存跟着写了 5 步
    const a1 = await overwriteKeeping(store, io, e.id, { doc: doc(5, '甲'), now: NOW + MIN, known: e.savedAt });
    // 乙（不写的那一页，打开时看到的是最初那一份）⌘S：甲的那 5 步留一份
    const b1 = await overwriteKeeping(store, io, e.id, { doc: doc(4, '乙'), now: NOW + 2 * MIN, known: e.savedAt });
    expect(await io.text(b1!.kept!.id)).toBe(JSON.stringify(doc(5, '甲')));
    // 甲接着做，自动保存再跟着写：乙 ⌘S 的那一份留一份
    const a2 = await overwriteKeeping(store, io, e.id, { doc: doc(6, '甲'), now: NOW + 3 * MIN, known: a1!.entry.savedAt });
    expect(await io.text(a2!.kept!.id)).toBe(JSON.stringify(doc(4, '乙')));
    expect(sortVersions(await io.list()).map((v) => v.why)).toEqual(['replaced', 'replaced']);
  });

  it('不知道上一次是什么时候（没给 known）：照旧直接盖；那一张不在了：null；留不下来（满了）也照样盖', async () => {
    const { store, io, e } = await setup();
    await store.write({ ...e, savedAt: NOW + MIN }, doc(5, 'other'));
    expect((await overwriteKeeping(store, io, e.id, { doc: doc(2, 'm'), now: NOW + 2 * MIN }))!.kept).toBeNull();
    expect(await overwriteKeeping(store, io, 'none', { doc: doc(2), known: 1 })).toBeNull();
    await store.write({ ...e, savedAt: NOW + 3 * MIN }, doc(5, 'other2'));
    io.quota = 1;
    const r = await overwriteKeeping(store, io, e.id, { doc: doc(2, 'm2'), now: NOW + 4 * MIN, known: e.savedAt });
    expect(r!.kept).toBeNull();
    expect((await store.doc(e.id))!.commands).toEqual(doc(2, 'm2').commands);
  });
});
