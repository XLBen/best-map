import { describe, expect, it } from 'vitest';
import type { Command } from '../../core/commands';
import type { Engine } from '../../core/engine';
import { EXPORT_PARTS } from '../../core/export';
import { countryTimeline, currentRuler, eraNow, loreOf, worldEra } from '../../core/human';
import { continents, humanExec, snapshot } from '../../core/testing/fixtures';
import { ARCHIVE_TEXT } from './copy';
import {
  addDynastyCommand,
  addEventCommand,
  addRulerCommand,
  dynastyNameCommand,
  eventLinkCommand,
  eventNoteCommand,
  eventTitleCommand,
  eventYearCommand,
  moveRulerCommand,
  noteCommand,
  parseYear,
  removeEventCommand,
  rulerLinkCommand,
  rulerNameCommand,
  rulerYearsCommand,
} from './domain/country-lore';
import { exportPartRows } from './domain/settlements';

// 第八十五轮的界面：国家档案里的备注、统治者（加一位、改名、改年份、排先后）、家族、大事年表（加一件、改、牵涉别国、删）。
// 组件只调 domain/country-lore.ts 的这些函数，这里按点的先后发命令，查世界

const nations = (): Engine =>
  snapshot('archive-ui', () => {
    const eng = continents({ provinces: true });
    humanExec(eng, { op: 'generate_human', packs: [['medieval']], groups: [{ id: 'germanic', weight: 3 }, { id: 'chinese', weight: 3 }], countries: {}, settlements: {} });
    return eng;
  });
const ids = (e: Engine) => Object.keys(e.world.small.countries!).map(Number).sort((a, b) => a - b);
const run = (e: Engine, c: Command | null) => {
  expect(c).not.toBeNull();
  e.exec(c!);
};

describe('统治者', () => {
  it('加统治者：加在最后、成为现在的统治者，上一位在位到它开始（一步，撤销一次回去）；点名字改名', () => {
    const e = nations();
    const id = ids(e)[0];
    const before = loreOf(e.world.small, id).rulers;
    const last = before[before.length - 1];
    run(e, addRulerCommand(e.world, id));
    const after = loreOf(e.world.small, id).rulers;
    expect(after.length).toBe(before.length + 1);
    const fresh = after[after.length - 1];
    expect(fresh).toMatchObject({ name: ARCHIVE_TEXT.newRuler, dynasty: last.dynasty, title: last.title });
    expect(fresh.to).toBeUndefined();
    expect(fresh.from).toBe(Math.max(last.from + 1, eraNow(worldEra(e.world.small))));
    expect(after[after.length - 2].to).toBe(fresh.from);
    expect(currentRuler(e.world.small, id)).toBe(fresh);
    // 年表里多了它的即位
    expect(countryTimeline(e.world, id).some((r) => r.kind === 'accession' && r.ruler.id === fresh.id)).toBe(true);
    run(e, rulerNameCommand(e.world, id, fresh.id, '埃德温'));
    expect(currentRuler(e.world.small, id)!.name).toBe('埃德温');
    // 没变、空着的名字不发
    expect(rulerNameCommand(e.world, id, fresh.id, '埃德温')).toBeNull();
    expect(rulerNameCommand(e.world, id, fresh.id, '  ')).toBeNull();
    e.undo();
    e.undo();
    expect(loreOf(e.world.small, id).rulers).toEqual(before);
  });

  it('年份、排先后、家族、父母', () => {
    const e = nations();
    const id = ids(e)[0];
    const [a, b] = loreOf(e.world.small, id).rulers;
    run(e, rulerYearsCommand(e.world, id, a.id, a.from - 10, a.to ?? null));
    expect(loreOf(e.world.small, id).rulers[0].from).toBe(a.from - 10);
    // 结束早于开始、没变：不发
    expect(rulerYearsCommand(e.world, id, a.id, 100, 50)).toBeNull();
    expect(rulerYearsCommand(e.world, id, a.id, a.from - 10, a.to ?? null)).toBeNull();
    expect(moveRulerCommand(e.world, id, a.id, -1)).toBeNull();
    run(e, moveRulerCommand(e.world, id, a.id, 1));
    expect(loreOf(e.world.small, id).rulers.map((r) => r.id).slice(0, 2)).toEqual([b.id, a.id]);
    run(e, addDynastyCommand(id));
    const d = loreOf(e.world.small, id).dynasties.at(-1)!;
    expect(d.name).toBe(ARCHIVE_TEXT.newDynasty);
    run(e, dynastyNameCommand(e.world, id, d.id, '白鹿家'));
    run(e, rulerLinkCommand(e.world, id, a.id, 'dynasty', d.id));
    // 开国的一位没有父母：写空着不发；写成第二位
    expect(rulerLinkCommand(e.world, id, a.id, 'parent', null)).toBeNull();
    run(e, rulerLinkCommand(e.world, id, a.id, 'parent', b.id));
    const ra = loreOf(e.world.small, id).rulers.find((r) => r.id === a.id)!;
    expect(ra.dynasty).toBe(d.id);
    expect(ra.parent).toBe(b.id);
    expect(loreOf(e.world.small, id).dynasties.at(-1)!.name).toBe('白鹿家');
  });

  it('年份的写法：-500、前 500、公元前 500 年、1203', () => {
    expect(parseYear('-500')).toBe(-500);
    expect(parseYear('前 500')).toBe(-500);
    expect(parseYear('公元前 500 年')).toBe(-500);
    expect(parseYear('1203')).toBe(1203);
    expect(parseYear('一千')).toBeNull();
    expect(parseYear('')).toBeNull();
  });
});

describe('大事年表、备注', () => {
  it('加大事：在最后（时代的现在），点标题改、改年份、写备注、牵涉别国（两国的年表里都有）、删除', () => {
    const e = nations();
    const [id, other] = ids(e);
    run(e, addEventCommand(e.world, id));
    const ev = Object.values(e.world.small.archive!.events).find((x) => x.title === ARCHIVE_TEXT.newEvent)!;
    expect(ev.countries).toEqual([id]);
    expect(ev.year).toBe(Math.max(eraNow(worldEra(e.world.small)), e.world.small.countries![id].founded));
    run(e, eventTitleCommand(e.world, ev.id, '北境大雪'));
    run(e, eventYearCommand(e.world, ev.id, 1200));
    run(e, eventNoteCommand(e.world, ev.id, '三年不化'));
    run(e, eventLinkCommand(e.world, ev.id, other, true));
    const now = e.world.small.archive!.events[ev.id];
    expect(now).toMatchObject({ title: '北境大雪', year: 1200, note: '三年不化', countries: [id, other] });
    const inTl = (c: number) => countryTimeline(e.world, c).find((r) => r.kind === 'event' && r.event.id === ev.id);
    expect(inTl(id)).toBeDefined();
    expect(inTl(other)).toMatchObject({ others: [id] });
    // 写它的那一国去不掉
    expect(eventLinkCommand(e.world, ev.id, id, false)).toBeNull();
    run(e, eventLinkCommand(e.world, ev.id, other, false));
    expect(inTl(other)).toBeUndefined();
    run(e, removeEventCommand(ev.id));
    expect(e.world.small.archive!.events[ev.id]).toBeUndefined();
  });

  it('备注：写、清空是删除；没变不发', () => {
    const e = nations();
    const id = ids(e)[0];
    expect(noteCommand(e.world, id, '')).toBeNull();
    run(e, noteCommand(e.world, id, '王都在湖边'));
    expect(loreOf(e.world.small, id).note).toBe('王都在湖边');
    expect(noteCommand(e.world, id, '王都在湖边')).toBeNull();
    run(e, noteCommand(e.world, id, ''));
    expect(loreOf(e.world.small, id).note).toBeUndefined();
  });

  it('单独导出里有“导出维基”（wiki.zip）', () => {
    expect(EXPORT_PARTS.find((p) => p.id === 'wiki')).toMatchObject({ label: '导出维基', files: ['wiki.zip'] });
    expect(exportPartRows(nations().world).find((r) => r.id === 'wiki')?.available).toBe(true);
  });

  it('说明不超过 20 个字', () => {
    for (const [k, v] of Object.entries(ARCHIVE_TEXT)) expect([...v].length, k).toBeLessThanOrEqual(20);
  });
});
