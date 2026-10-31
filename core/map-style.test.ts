import { describe, expect, it } from 'vitest';
import { compactWorldDoc } from './compact';
import { sameItem } from './content/refs';
import { kindOf } from './content/registry';
import { unusedContent } from './content/unused';
import { worldDigest } from './digest';
import { Engine } from './engine';
import { DEFAULT_LOOK, FALLBACK_MAP_STYLE, type MapStyle, mapStyleKey, mapStyleSchema, styleRgba, typeColor, worldMapStyle, worldMapStyleId, worldMapStyles } from './map-style';
import { applyPackCommands, findPack, packItems, readPack } from './packs';
import { COMMON_PACK_ID, DEFAULT_WORLD_PACKS, STYLES_PATH, builtinPacks, isBuiltinSame, originOf } from './packs/builtin-tree';
import { packImportCommands } from './packs/import';
import { BUILTIN_MAP_STYLES } from './packs/map-styles';
import { continents, engineFor, seedCommands } from './testing/fixtures';

// 第三十八轮：画风是资源包里的一种内容（map-style.ts、packs/map-styles.ts）。选的画风记在世界里（set_map_style）

const [REALISTIC, ATLAS] = BUILTIN_MAP_STYLES;
const LIB = builtinPacks();
// 地图（原因、推导）的摘要：小数据里多了画风不算
const mapOnly = (w: Engine['world']) => worldDigest({ causes: w.causes, derived: w.derived, small: {} });

describe('画风的格式', () => {
  it('颜色：#rrggbb、#rrggbbaa、rgb()、rgba()（可以带小数）；写错了是 null', () => {
    expect(styleRgba('#3468a8')).toEqual([0x34, 0x68, 0xa8, 1]);
    expect(styleRgba('#34689880')).toEqual([0x34, 0x68, 0x98, 128 / 255]);
    expect(styleRgba('rgb(237.15, 221.85, 183.6)')).toEqual([237.15, 221.85, 183.6, 1]);
    expect(styleRgba('rgba(52, 104, 168, 0.92)')).toEqual([52, 104, 168, 0.92]);
    for (const bad of ['red', '#12345', 'rgb(1, 2)', 'rgba(1, 2, 3)', 'hsl(1, 2%, 3%)', 'rgb(-1, 2, 3)']) expect(styleRgba(bad), bad).toBeNull();
    // 超过 255 的只有山影的亮色能写（最多 510）
    expect(mapStyleSchema.safeParse({ id: 'x', name: 'x', tier1: 'rgb(300, 0, 0)' }).success).toBe(false);
    expect(mapStyleSchema.safeParse({ id: 'x', name: 'x', shadeLight: 'rgb(300, 0, 0)' }).success).toBe(true);
    expect(mapStyleSchema.safeParse({ id: 'x', name: 'x', shadeLight: 'rgb(600, 0, 0)' }).success).toBe(false);
  });

  it('没写的项按默认的画法（写实）补上；内置的两种照格式读出来不变', () => {
    const blank = mapStyleSchema.parse({ id: 'x', name: '新画风' });
    expect({ ...blank, id: '', name: '写实' }).toEqual(FALLBACK_MAP_STYLE);
    expect(sameItem({ ...REALISTIC, id: '', name: '写实', description: undefined }, FALLBACK_MAP_STYLE)).toBe(true);
    for (const s of BUILTIN_MAP_STYLES) expect(mapStyleSchema.parse(s), s.id).toEqual(s);
    // 字段表的每一项都在格式里，默认值按 DEFAULT_LOOK
    const kind = kindOf('mapStyle')!;
    const keys = Object.keys(mapStyleSchema.shape);
    for (const f of kind.fields) expect(keys, f.key).toContain(f.key);
    for (const k of Object.keys(DEFAULT_LOOK)) expect(kind.fields.find((f) => f.key === k)?.default, k).toEqual(DEFAULT_LOOK[k as keyof typeof DEFAULT_LOOK]);
  });

  it('签名：按画出来有关的各项，名字、说明不算；按对象记住', () => {
    expect(mapStyleKey(REALISTIC)).toBe(mapStyleKey(FALLBACK_MAP_STYLE));
    expect(mapStyleKey(REALISTIC)).not.toBe(mapStyleKey(ATLAS));
    expect(mapStyleKey({ ...ATLAS, name: '别的名字' })).toBe(mapStyleKey(ATLAS));
    expect(mapStyleKey({ ...ATLAS, tier2: '#123456' })).not.toBe(mapStyleKey(ATLAS));
    expect(typeColor({ color: '#111111', atlasColor: '#222222' }, REALISTIC)).toBe('#111111');
    expect(typeColor({ color: '#111111', atlasColor: '#222222' }, ATLAS)).toBe('#222222');
    expect(typeColor({ color: '#111111' }, ATLAS)).toBe('#111111');
  });
});

describe('内置的画风包', () => {
  it('“通用 ▸ 画风”里是写实、地图册，新建世界默认勾上；每一项都在树里', () => {
    expect(STYLES_PATH).toEqual([COMMON_PACK_ID, 'styles']);
    expect(DEFAULT_WORLD_PACKS).toContainEqual(STYLES_PATH);
    const common = LIB.find((p) => p.id === COMMON_PACK_ID)!;
    expect(packItems(findPack(common, ['styles'])!, 'mapStyles')).toEqual(BUILTIN_MAP_STYLES);
    for (const s of BUILTIN_MAP_STYLES) expect(originOf({}, 'mapStyle', s.id, s)).toEqual([...STYLES_PATH]);
    expect(readPack(JSON.stringify(common)).ok).toBe(true);
    // 新世界：两种都在，按第一种（写实）画
    const eng = engineFor({ cells: 2000, seed: 3 });
    const s = eng.world.small;
    expect(Object.keys(worldMapStyles(s))).toEqual(['realistic', 'atlas']);
    expect(worldMapStyleId(s)).toBe('realistic');
    expect(worldMapStyle(s)).toEqual(REALISTIC);
    for (const x of Object.values(worldMapStyles(s))) expect(isBuiltinSame('mapStyle', x)).toBe(true);
    expect(s.origin?.mapStyle?.atlas).toEqual([...STYLES_PATH]);
    expect(seedCommands()).toEqual(packImportCommands(LIB, { packs: DEFAULT_WORLD_PACKS }));
  });

  it('没有画风的世界（旧的世界、什么包都不勾）按写实画', () => {
    const eng = engineFor({ cells: 2000, seed: 3 }, { bare: true });
    expect(worldMapStyleId(eng.world.small)).toBe('');
    expect(worldMapStyle(eng.world.small)).toBe(FALLBACK_MAP_STYLE);
    expect(() => eng.exec({ op: 'set_map_style', id: 'atlas' })).toThrow(/没有画风/);
    // 加上画风包
    eng.exec(applyPackCommands(eng.world, findPack(LIB.find((p) => p.id === COMMON_PACK_ID)!, ['styles'])!));
    expect(worldMapStyle(eng.world.small)).toEqual(REALISTIC);
  });
});

describe('选画风（set_map_style）', () => {
  it('只能选世界里有的；不重算；能撤销、重做；存盘再打开、重放都是那一种', () => {
    const eng = continents();
    eng.update();
    const digest = worldDigest(eng.world);
    expect(() => eng.exec({ op: 'set_map_style', id: 'nope' })).toThrow(/世界里没有画风/);
    expect(eng.exec({ op: 'set_map_style', id: 'atlas' })).toBe('画风改为“地图册”');
    expect(eng.world.small.mapStyle).toBe('atlas');
    expect(worldMapStyle(eng.world.small)).toEqual(ATLAS);
    // 只是画法：地图（原因、推导、地名）不变（摘要里的小数据多了选的画风，去掉再比）
    eng.update();
    const { mapStyle: _, ...small } = eng.world.small;
    expect(worldDigest({ ...eng.world, small })).toBe(digest);
    expect(eng.undo()).toBe(true);
    expect(worldMapStyleId(eng.world.small)).toBe('realistic');
    expect(eng.redo()).toBe(true);
    expect(worldMapStyleId(eng.world.small)).toBe('atlas');
    const doc = JSON.parse(JSON.stringify(eng.toDoc()));
    const back = Engine.fromDoc(doc, eng.world.mesh);
    expect(worldMapStyle(back.world.small)).toEqual(ATLAS);
    // null 是不选：按第一种
    eng.exec({ op: 'set_map_style', id: null });
    expect(eng.world.small.mapStyle).toBeUndefined();
    expect(worldMapStyleId(eng.world.small)).toBe('realistic');
  });

  it('选的画风移出世界后按剩下的第一种；加回来又是它', () => {
    const eng = continents();
    eng.exec({ op: 'set_map_style', id: 'atlas' });
    eng.exec({ op: 'set_content', kind: 'mapStyle', id: 'atlas', item: null });
    expect(worldMapStyleId(eng.world.small)).toBe('realistic');
    eng.exec({ op: 'set_map_style', id: 'realistic' });
    eng.exec({ op: 'set_content', kind: 'mapStyle', id: 'realistic', item: null });
    expect(worldMapStyle(eng.world.small)).toBe(FALLBACK_MAP_STYLE);
    eng.undo();
    eng.undo();
    eng.undo();
    expect(worldMapStyle(eng.world.small)).toEqual(ATLAS);
  });

  it('复制一份改海的颜色：渲染器拿到的就是改过的（签名跟着变）；改画风不重算', () => {
    const eng = continents();
    eng.update();
    const before = mapOnly(eng.world);
    const mine: MapStyle = { ...ATLAS, id: 'my-atlas', name: '我的地图册', tier2: '#204060' };
    eng.exec({ op: 'set_content', kind: 'mapStyle', id: mine.id, item: mine as unknown as Record<string, unknown> });
    eng.exec({ op: 'set_map_style', id: 'my-atlas' });
    const got = worldMapStyle(eng.world.small);
    expect(got.tier2).toBe('#204060');
    expect(mapStyleKey(got)).not.toBe(mapStyleKey(ATLAS));
    // 来源：本世界做的（没有记来源，也不是内置原样）
    expect(originOf(eng.world.small, 'mapStyle', 'my-atlas', got)).toBeUndefined();
    eng.exec({ op: 'set_content', kind: 'mapStyle', id: mine.id, item: { ...mine, tier2: '#305070' } as unknown as Record<string, unknown> });
    expect(worldMapStyle(eng.world.small).tier2).toBe('#305070');
    eng.update();
    expect(mapOnly(eng.world)).toBe(before);
  });
});

describe('整理、压缩：只留在用的画风', () => {
  it('没选时第一种算用到，选了时选的那一种算用到，别的都是没用到的', () => {
    const eng = continents();
    eng.update();
    const styles = () => unusedContent(eng.world).filter((x) => x.kind === 'mapStyle').map((x) => x.id);
    expect(styles()).toEqual(['atlas']);
    eng.exec({ op: 'set_map_style', id: 'atlas' });
    expect(styles()).toEqual(['realistic']);
    const plan = eng.planTidy();
    expect(plan.command?.items).toContainEqual({ kind: 'mapStyle', id: 'realistic' });
    expect(plan.kept.filter((k) => k.kind === 'mapStyle')).toEqual([]);
    eng.exec(plan.command!);
    expect(Object.keys(worldMapStyles(eng.world.small))).toEqual(['atlas']);
    expect(worldMapStyle(eng.world.small)).toEqual(ATLAS);
  });

  it('压缩世界文件：没用上的画风加的那条去掉，重放出来还是选的那一种', () => {
    const eng = continents();
    eng.exec({ op: 'set_map_style', id: 'atlas' });
    const doc = eng.toDoc();
    const r = compactWorldDoc(doc, { mesh: eng.world.mesh });
    expect(r.verified).toBe(true);
    const back = Engine.fromDoc(r.doc, eng.world.mesh);
    expect(Object.keys(worldMapStyles(back.world.small))).toEqual(['atlas']);
    expect(worldMapStyle(back.world.small)).toEqual(ATLAS);
  });
});
