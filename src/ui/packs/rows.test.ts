import { describe, expect, it } from 'vitest';
import type { Command } from '../../../core/commands';
import { type ContentKind, kindOf } from '../../../core/content/registry';
import { worldTiers } from '../../../core/human/tiers';
import { DEFAULT_STYLE, type NameStyle, worldStyleId } from '../../../core/name-styles';
import { PACK_FORMAT, PACK_VERSION, type PackWorld, type ResourcePack } from '../../../core/packs';
import { builtinPacks } from '../../../core/packs/builtin-tree';
import { importCommand } from '../../../core/packs/closure';
import { BUILTIN_STYLES } from '../../../core/packs/names';
import { DEFAULT_SPECIES } from '../../../core/packs/nature';
import { continents, FANTASY_PACK, NAME_STYLES_SAMPLE } from '../../../core/testing/fixtures';
import type { LibraryEntry } from '../../library';
import { defaultStyleCommand, libraryRows, removeCommand, worldRows } from './rows';

// 面板列表里的一行（第六十三轮从 repo.test.ts 改写）：库里的一项在不在本世界、世界里的一项能不能移出，移出和设为默认是哪条命令。
// 添加到本世界走导入的闭包（core/packs/closure.ts），和面板上的“添加”一样

const entry = (key: string, pack: ResourcePack, extra: Partial<LibraryEntry> = {}): LibraryEntry => ({ key, pack, builtin: false, mine: false, installedAt: 1, ...extra });
const FANTASY = entry('fantasy', FANTASY_PACK, { builtin: true, installedAt: 0 });
const NAMES = entry('name-styles', NAME_STYLES_SAMPLE, { builtin: true, installedAt: 0 });
const LIB: LibraryEntry[] = builtinPacks().map((p) => entry(p.id, p, { builtin: true, installedAt: 0 }));
const styleKind = kindOf('nameStyle')!;
const biomeKind = kindOf('biome')!;
const germanic = BUILTIN_STYLES.find((s) => s.id === 'west-germanic')!;
const pack = (id: string, extra: Partial<ResourcePack>): ResourcePack => ({ format: PACK_FORMAT, version: PACK_VERSION, id, name: id, ...extra });
const addCmd = (e: LibraryEntry, kind: ContentKind, id: string, w: PackWorld): Command => importCommand({ source: e.pack, target: { t: 'world', world: w }, picks: [{ kind: kind.id, id }] }, { path: [e.key] }).command!;

describe('一行的状态和命令', () => {
  it('地名风格：中文·默认在世界里、是默认；添加、设为默认、移出默认都是一步，可以撤销', () => {
    const eng = continents();
    const w = eng.world;
    const zh = worldRows(styleKind, w).find((r) => r.id === DEFAULT_STYLE)!;
    expect(zh.status).toMatchObject({ on: true, isDefault: true });
    expect(zh.status.locked).toBeUndefined();
    const row = () => libraryRows(NAMES, styleKind, eng.world).find((r) => r.id === 'west-germanic')!;
    expect(row().status).toEqual({ on: false });
    eng.exec(addCmd(NAMES, styleKind, 'west-germanic', w));
    expect(row().status).toEqual({ on: true, worldId: 'west-germanic', isDefault: false });
    expect(worldRows(styleKind, w).length).toBe(2);
    // 设为默认
    expect(defaultStyleCommand(row(), w)).toEqual({ op: 'set_name_style', id: 'west-germanic' });
    eng.exec(defaultStyleCommand(row(), w)!);
    expect(row().status.isDefault).toBe(true);
    expect(defaultStyleCommand(row(), w)).toBeNull();
    // 移出默认：世界默认一起换回内置中文
    const off = removeCommand(worldRows(styleKind, w).find((r) => r.id === 'west-germanic')!, w)!;
    expect(off).toMatchObject({ op: 'batch', commands: [{ op: 'set_name_style', id: null }, { op: 'set_content', item: null }] });
    eng.exec(off);
    expect([worldStyleId(w.small), row().status.on]).toEqual([DEFAULT_STYLE, false]);
    eng.undo();
    expect([worldStyleId(w.small), row().status.on]).toEqual(['west-germanic', true]);
    // 没加的直接设为默认：加和设为默认一起
    eng.undo();
    eng.undo();
    expect(row().status.on).toBe(false);
    expect(defaultStyleCommand(row(), w)).toMatchObject({ op: 'batch', commands: [{ op: 'set_content' }, { op: 'set_name_style', id: 'west-germanic' }] });
  });

  it('有问题的地名风格：不能动，写着原因', () => {
    const bad: NameStyle = { ...germanic, id: 'bad', name: '坏的', types: { island: { patterns: [{ p: '{root}{nope}' }] } } } as NameStyle;
    const r = libraryRows(entry('x', pack('x', { nameStyles: [bad] })), styleKind, continents().world).find((x) => x.id === 'bad')!;
    expect(r.status.on).toBe(false);
    expect(r.status.locked).toMatch(/nope/);
  });

  it('生态：内置的本来就在世界里；示例包的添加后在；世界里自己做的没有来源；同 id 不同内容的不算在', () => {
    const eng = continents();
    const w = eng.world;
    const rows = libraryRows(FANTASY, biomeKind, w);
    expect(DEFAULT_SPECIES.every((s) => worldRows(biomeKind, w).some((r) => r.id === s.id && r.status.on))).toBe(true);
    const crystal = rows.find((r) => !r.status.on)!;
    expect(crystal).toBeDefined();
    eng.exec(addCmd(FANTASY, biomeKind, crystal.id, w));
    expect(libraryRows(FANTASY, biomeKind, w).find((r) => r.key === crystal.key)!.status.on).toBe(true);
    eng.exec({ op: 'add_species', species: { ...DEFAULT_SPECIES[0], id: 'mine_x', name: '我的林' } });
    const own = worldRows(biomeKind, w).find((r) => r.id === 'mine_x')!;
    expect([own.source, own.path, own.status.on]).toEqual(['world', undefined, true]);
    // 导入的包里有同 id、不同内容的
    const clash = { ...DEFAULT_SPECIES[0], color: '#123456' };
    const r = libraryRows(entry('c', pack('c', { biomes: [clash] })), biomeKind, w)[0];
    expect(r.status.on).toBe(false);
  });

  it('没有世界时不能动；星球形态只列出来', () => {
    const w = continents().world;
    expect(libraryRows(NAMES, styleKind, null)[0].status).toEqual({ on: false, locked: '先新建或打开世界' });
    const forms = LIB.flatMap((e) => libraryRows(e, kindOf('planetForm')!, w));
    expect(forms.length).toBeGreaterThan(0);
    expect(forms.every((r) => r.status.locked && removeCommand(r, w) === null)).toBe(true);
  });

  it('画风：在用的写着；移出它时一起不选（一步）', () => {
    const mapKind = kindOf('mapStyle')!;
    const eng = continents();
    const rows = () => worldRows(mapKind, eng.world);
    expect(rows().map((r) => r.id)).toEqual(['realistic', 'atlas']);
    expect(rows().find((r) => r.id === 'realistic')!.status).toMatchObject({ on: true, isDefault: true });
    expect(rows().find((r) => r.id === 'atlas')!.status).toMatchObject({ on: true, isDefault: false });
    eng.exec({ op: 'set_map_style', id: 'atlas' });
    const atlas = rows().find((r) => r.id === 'atlas')!;
    expect(atlas.status.isDefault).toBe(true);
    const off = removeCommand(atlas, eng.world)!;
    expect(off).toMatchObject({ op: 'batch', commands: [{ op: 'set_map_style', id: null }, { op: 'set_content', kind: 'mapStyle', id: 'atlas', item: null }] });
    eng.exec(off);
    expect(eng.world.small.mapStyle).toBeUndefined();
    expect(worldRows(mapKind, eng.world).find((r) => r.id === 'realistic')!.status.isDefault).toBe(true);
    eng.undo();
    expect(eng.world.small.mapStyle).toBe('atlas');
  });

  it('世界里改过的内置项：库里那一行在本世界、写着改过，不是“添加后叫 X 2”；改回去就不写了', () => {
    const eng = continents();
    const kind = kindOf('countryTier')!;
    const tier = worldTiers(eng.world.small)[0];
    const row = () => libraryRows(LIB.find((e) => e.key === 'medieval')!, kind, eng.world).find((r) => r.id === tier.id)!;
    expect(row().status.modified).toBeFalsy();
    eng.exec({ op: 'set_content', kind: 'countryTier', id: tier.id, item: { ...tier, area: tier.area + 1 } });
    expect([row().status.on, row().status.modified]).toEqual([true, true]);
    // 我的库里同 id 的不算这一项
    const mine = entry('m', pack('m', { countryTiers: [tier] } as Partial<ResourcePack>), { mine: true });
    expect(libraryRows(mine, kind, eng.world)[0].status.on).toBe(false);
    eng.undo();
    expect([row().status.on, row().status.modified]).toEqual([true, undefined]);
  });
});
