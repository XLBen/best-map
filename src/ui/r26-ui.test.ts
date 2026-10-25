import { strFromU8 } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Command } from '../../core/commands';
import type { Engine } from '../../core/engine';
import { blocsCsv, countriesCsv, exportPart } from '../../core/export';
import { ISLET_FRAG } from '../../core/features';
import { autoBlocName, blocById, blocCells, blocList, blocOf, blocsOf, countryList } from '../../core/human';
import { brushCells } from '../../core/select';
import { continents, snapshot } from '../../core/testing/fixtures';
import type { Bloc, World } from '../../core/world';
import { COUNTRY_ALPHA, FEDERATION_GROUP, ISLET_FLAT, NO_BLOC, SEA_CLAIM_ALPHA, colorSignature, countryBorderGroups, humanFlat } from '../render/colors';
import { exec, mode, parsePrefs, selectedBloc, selectedCountry, setPrefs, sheet, world } from '../state';
import {
  blocHereText,
  blocNamePatch,
  joinBlocCommand,
  joinableBlocs,
  leaveBlocCommand,
  newBlocCommand,
  removeBlocCommand,
  selectBloc,
  shownBloc,
  subjectCommand,
} from './blocs';
import { countryAt, fragTitle, generateCountriesCommand, layoutOf, regenerateCountriesCommand } from './countries';
import { humanViews, viewAvailable } from './defs/layers';
import { setTool } from './defs/tools';
import { defaultChoice, generateCommand } from './human';
import { hereLine } from './Inspector';
import { legendFor } from './legend';
import { kindOfView, mapModes, modeDef, modeOf } from './map/modes';
import { REGION_KEY, countryDraws, regionDraws } from './map/political';
import { pointerText, pointerTool } from './tools';

// 第二十六轮的界面：同盟模式（表、按钮、只在有集团时）、联邦的名字、帝国的外沿与联邦成员的国界、碎岛的着色、
// 档案里的从属与集团的命令、格局、缓存跟着 set_bloc 变、导出的表

vi.mock('../state', async (importOriginal) => ({ ...(await importOriginal<typeof import('../state')>()), exec: vi.fn(async () => true) }));

afterEach(() => {
  setTool('land');
  mode.value = 'terrain';
  selectedCountry.value = null;
  selectedBloc.value = null;
  sheet.value = null;
  setPrefs({ map: 'geo' });
  vi.mocked(exec).mockClear();
});

const GROUPS = [
  { id: 'western', weight: 3 },
  { id: 'eastern', weight: 3 },
  { id: 'steppe', weight: 1.5 },
];
// 中世纪（有帝国）与现代（联邦、同盟）
const nations = (): Engine =>
  snapshot('nations', () => {
    const eng = continents({ provinces: true });
    eng.exec({ op: 'generate_human', era: 'medieval', groups: GROUPS, countries: {} });
    return eng;
  });
const moderns = (): Engine =>
  snapshot('r26-modern', () => {
    const eng = continents({ provinces: true });
    eng.exec({ op: 'generate_human', era: 'modern', groups: GROUPS, countries: {}, settlements: { roads: false, landmarks: false } });
    return eng;
  });
// 删掉全部集团
function noBlocs(eng: Engine): Engine {
  for (const b of [...blocList(eng.world.small)]) eng.exec({ op: 'set_bloc', id: b.id, patch: null });
  return eng;
}
const cellsOfBloc = (w: World, b: Bloc) => {
  const c = blocCells(w);
  return [...Array(w.mesh.n).keys()].filter((i) => c[i] === b.id && w.causes.land[i] && w.derived.lake[i] !== 1);
};
const pointer = (w: World, c: number) => ({ x: w.mesh.x[c], y: w.mesh.y[c], cell: c, sx: 0, sy: 0, shift: false, alt: false });

describe('同盟模式', () => {
  it('表：按集团着色、国界淡、写集团的名字、只画首都；只在有集团时', () => {
    expect(modeDef('bloc')).toEqual({ ...modeDef('culture'), regions: 'bloc' });
    expect(kindOfView('bloc')).toBe('bloc');
    expect(parsePrefs(JSON.stringify({ map: 'bloc' })).map).toBe('bloc');
    const w = nations().world;
    expect(blocList(w.small).length).toBeGreaterThan(0);
    expect(mapModes(w).map((m) => m.id).slice(0, 3)).toEqual(['geo', 'country', 'bloc']);
    expect(humanViews(w).map((v) => v.id).slice(0, 2)).toEqual(['country', 'bloc']);
    expect(modeOf(w, 'bloc')).toBe('bloc');
    const bare = noBlocs(nations()).world;
    expect(mapModes(bare).map((m) => m.id)).not.toContain('bloc');
    expect(humanViews(bare).map((v) => v.id)).not.toContain('bloc');
    expect(viewAvailable(bare, 'bloc')).toBe(false);
    expect(modeOf(bare, 'bloc')).toBe('geo');
  });

  it('删掉了最后一个集团：底图回到国家', () => {
    world.value = nations().world;
    mode.value = 'bloc';
    world.value = noBlocs(nations()).world;
    expect(mode.value).toBe('country');
  });

  it('平涂：集团的颜色，不在集团里的国家灰色，无主地不涂；片区名是集团的名字', () => {
    const w = moderns().world;
    const flat = humanFlat(w, 'bloc');
    const list = blocList(w.small);
    for (const b of list) {
      const c = cellsOfBloc(w, b)[0];
      if (c === undefined) continue;
      const hex = `#${[...flat.subarray(c * 4, c * 4 + 3)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
      // 同盟优先（一个国家可以同时在联邦与同盟里）
      if (shownBloc(w, w.causes.country![c])!.id === b.id) expect(hex).toBe(b.color);
      expect(flat[c * 4 + 3]).toBe(COUNTRY_ALPHA);
    }
    const loner = countryList(w.small).find((m) => !blocsOf(w, m.id).length);
    if (loner) {
      const c = [...Array(w.mesh.n).keys()].find((i) => w.causes.land[i] && w.derived.lake[i] !== 1 && w.causes.country![i] === loner.id)!;
      expect([...flat.subarray(c * 4, c * 4 + 3)]).toEqual(NO_BLOC);
    }
    const labels = regionDraws(w, 'bloc', 'zh');
    expect(labels.length).toBeGreaterThan(0);
    for (const l of labels) {
      expect(l.key.startsWith(`${REGION_KEY}bloc:`)).toBe(true);
      expect(blocById(w.small, Number(l.key.split(':')[2]))!.name).toBe(l.lines[0]);
    }
    expect(regionDraws(w, 'bloc', 'zh')).toBe(labels);
    // 图例：每个集团一行
    const lg = legendFor(w, 'bloc')!;
    expect(lg.title).toBe('同盟');
    expect(lg.items.length).toBeGreaterThanOrEqual(1);
  });

  it('指针：鼠标旁写集团与国名；点到集团打开集团的档案', () => {
    const eng = nations();
    const w = eng.world;
    world.value = w;
    mode.value = 'bloc';
    const b = blocList(w.small).find((x) => x.kind === 'empire')!;
    const c = cellsOfBloc(w, b)[0];
    const m = w.small.countries![countryAt(w, c)!];
    expect(blocHereText(w, c)).toBe(`${b.name} · ${m.name}`);
    expect(pointerText(w, c, 'bloc')).toBe(`${b.name} · ${m.name}`);
    const t = pointerTool(() => 20 / w.mesh.spacing);
    t.click!(pointer(w, c));
    expect(selectedBloc.value).toBe(b.id);
    expect(sheet.value).toBe('bloc');
    selectBloc(null);
    expect(sheet.value).toBeNull();
  });
});

describe('国家模式里的集团', () => {
  it('联邦整片写联邦的名字（与国名一起排，比成员的大）；改名后跟着换', () => {
    const eng = moderns();
    const w = eng.world;
    const fed = blocList(w.small).find((b) => b.kind === 'federation')!;
    expect(fed).toBeDefined();
    const draws = countryDraws(w, 'zh');
    const label = draws.find((d) => d.key === `${REGION_KEY}bloc:${fed.id}`)!;
    expect(label.lines).toEqual([fed.name]);
    for (const id of fed.members) {
      const own = draws.find((d) => d.key === `country:${id}`);
      if (own) expect(own.area).toBeLessThan(label.area);
    }
    eng.exec({ op: 'set_bloc', id: fed.id, patch: { name: '北方合众国' } });
    const again = countryDraws(eng.world, 'zh');
    expect(again).not.toBe(draws);
    expect(again.find((d) => d.key === `${REGION_KEY}bloc:${fed.id}`)!.lines).toEqual(['北方合众国']);
  });

  it('国界的第二个值：帝国的编号、联邦的编号 + FEDERATION_GROUP；别的模式里没有', () => {
    const med = nations().world;
    const emp = blocList(med.small).find((b) => b.kind === 'empire')!;
    const g = countryBorderGroups(med, true);
    const c = cellsOfBloc(med, emp)[0];
    expect(g[c * 2 + 1]).toBe(emp.id);
    const out = [...Array(med.mesh.n).keys()].find((i) => med.causes.land[i] && !blocsOf(med, med.causes.country![i]).length)!;
    expect(g[out * 2 + 1]).toBe(0);
    expect(countryBorderGroups(med)[c * 2 + 1]).toBe(0);
    const mod = moderns().world;
    const fed = blocList(mod.small).find((b) => b.kind === 'federation')!;
    const gm = countryBorderGroups(mod, true);
    for (const id of fed.members.slice(0, 2)) {
      const cell = [...Array(mod.mesh.n).keys()].find((i) => mod.causes.land[i] && mod.causes.country![i] === id)!;
      expect(gm[cell * 2 + 1]).toBe(fed.id + FEDERATION_GROUP);
    }
  });

  it('图例：联邦合成一行，写联邦的名字', () => {
    const w = moderns().world;
    const fed = blocList(w.small).find((b) => b.kind === 'federation')!;
    const items = legendFor(w, 'country')!.items;
    const names = items.map((x) => x.label);
    const members = new Set(fed.members.map((id) => w.small.countries![id].name));
    // 联邦大，排在前面
    expect(names).toContain(fed.name);
    expect(names.some((n) => members.has(n))).toBe(false);
  });
});

describe('碎岛', () => {
  it('平涂：归了国家的碎岛写 ISLET_FLAT（水面是领海时 + 1），国界不绕着它画；悬停写国名', () => {
    const eng = nations();
    const w = eng.world;
    const near = (a: number, r: number) => [...Array(w.mesh.n).keys()].filter((i) => Math.hypot(w.mesh.x[i] - w.mesh.x[a], w.mesh.y[i] - w.mesh.y[a]) < r * w.mesh.spacing);
    const c0 = [...Array(w.mesh.n).keys()].find(
      (i) => w.causes.country![i] >= 0 && !w.mesh.boundary[i] && [...w.mesh.adj.subarray(w.mesh.off[i], w.mesh.off[i + 1])].some((j) => !w.causes.land[j]) && near(i, 4).filter((j) => !w.causes.land[j]).length > 10,
    )!;
    const km = w.mesh.spacing * w.kmPerUnit;
    const b = brushCells(w, w.mesh.x[c0], w.mesh.y[c0], km * 5);
    eng.exec({ op: 'fragment', cells: b.cells, t: b.t, strength: 0.7, mode: 'coast', size: km * 5 });
    const islet = w.derived.countryIslet!;
    const flat = humanFlat(w, 'country');
    const groups = countryBorderGroups(w);
    let seen = 0;
    for (let i = 0; i < w.mesh.n; i++) {
      if (!islet[i]) continue;
      seen++;
      expect(w.causes.fragment![i]).toBeGreaterThanOrEqual(ISLET_FRAG);
      expect(flat[i * 4 + 3]).toBe(ISLET_FLAT + islet[i] - 1);
      if (islet[i] === 1) expect(groups[i * 2]).toBe(-1);
      else expect(groups[i * 2]).toBe(w.derived.country![i] + 65536);
      const m = countryList(w.small)[w.derived.country![i] - 1];
      expect(hereLine(w, i)).toContain(`${m.name} · `);
      expect(hereLine(w, i)).not.toContain(`${m.name}领海`);
    }
    expect(seen).toBeGreaterThan(0);
    // 别的领海照旧
    for (let i = 0; i < w.mesh.n; i++) if (!w.causes.land[i] && w.derived.country![i] && !islet[i]) expect(flat[i * 4 + 3]).toBe(SEA_CLAIM_ALPHA);
  });
});

describe('档案：从属与集团', () => {
  it('从属的种类：没有宗主时没有命令；附庸写 null', () => {
    const w = nations().world;
    const free = countryList(w.small).find((m) => m.overlord === undefined)!;
    expect(subjectCommand(free, 'protectorate')).toBeNull();
    const sub = { ...free, overlord: 1 };
    expect(subjectCommand(sub, 'protectorate')).toEqual({ op: 'set_country', id: free.id, patch: { subject: 'protectorate' } });
    expect(subjectCommand(sub, 'vassal')).toBeNull();
    expect(subjectCommand({ ...sub, subject: 'tributary' }, 'vassal')).toEqual({ op: 'set_country', id: free.id, patch: { subject: null } });
  });

  it('加入、退出、新建（这一国是盟主）、删除；最后一国退出时删掉', () => {
    const eng = moderns();
    const w = eng.world;
    const loner = countryList(w.small).find((m) => !blocsOf(w, m.id).length)!;
    const ally = blocList(w.small).find((b) => b.kind === 'alliance')!;
    expect(joinableBlocs(w, loner.id).map((b) => b.id)).toContain(ally.id);
    eng.exec(joinBlocCommand(ally, loner.id));
    expect(blocById(w.small, ally.id)!.members).toContain(loner.id);
    eng.exec(leaveBlocCommand(blocById(w.small, ally.id)!, loner.id));
    expect(blocById(w.small, ally.id)!.members).not.toContain(loner.id);
    const before = blocList(w.small).length;
    eng.exec(newBlocCommand('empire', loner.id));
    const mine = blocOf(w, loner.id, 'empire')!;
    expect(mine.leader).toBe(loner.id);
    expect(mine.members).toEqual([loner.id]);
    expect(blocList(w.small).length).toBe(before + 1);
    expect(leaveBlocCommand(mine, loner.id)).toEqual(removeBlocCommand(mine.id));
    eng.exec(leaveBlocCommand(mine, loner.id));
    expect(blocById(w.small, mine.id)).toBeUndefined();
    eng.undo();
    expect(blocById(eng.world.small, mine.id)).toBeDefined();
  });

  it('名字：空着恢复自动，没变时没有改动', () => {
    const b: Bloc = { id: 1, kind: 'alliance', name: '北约', leader: 1, members: [1], color: '#000000' };
    expect(blocNamePatch(b, '北约', '')).toBeNull();
    expect(blocNamePatch(b, '', '')).toBeNull();
    expect(blocNamePatch({ ...b, nameLocked: true }, ' ', '')).toEqual({ name: '' });
    expect(blocNamePatch(b, '华约', 'Warsaw Pact')).toEqual({ name: '华约', orig: 'Warsaw Pact' });
  });

  it('自动的名字不和别的集团用同一个地名（联邦的首府又是同盟的盟主）', () => {
    const w = moderns().world;
    const [a, c] = countryList(w.small).filter((m) => m.base?.zh);
    const fed: Bloc = { id: 50, kind: 'federation', name: `${a.base.zh}联邦`, leader: a.id, members: [a.id], color: '#000000' };
    const nm = autoBlocName(w, { id: 51, kind: 'alliance', leader: a.id, members: [a.id, c.id] }, undefined, [fed]);
    expect(nm.zh).toContain(c.base.zh);
    expect(nm.zh).not.toContain(a.base.zh);
    // 只有盟主时照用它的
    expect(autoBlocName(w, { id: 51, kind: 'alliance', leader: a.id, members: [a.id] }, undefined, [fed]).zh).toContain(a.base.zh);
    // 生成的：同盟的名字不和联邦同一个地名
    const list = blocList(w.small);
    for (const f of list.filter((b) => b.kind === 'federation')) {
      const base = w.small.countries![f.leader].base.zh;
      for (const al of list.filter((b) => b.kind === 'alliance')) expect(al.name.includes(base)).toBe(false);
    }
  });
});

describe('格局', () => {
  it('生成、重新生成国家带上格局；与现在的一样时不写', () => {
    const w = nations().world;
    expect(layoutOf(w)).toBe('era');
    expect(generateCountriesCommand(0.5)).toEqual({ op: 'generate_countries' });
    expect(generateCountriesCommand(0.5, 'petty')).toEqual({ op: 'generate_countries', layout: 'petty' });
    expect(regenerateCountriesCommand(w, 0.5, true)).toEqual({ op: 'regenerate_countries' });
    expect(regenerateCountriesCommand(w, 0.5, true, 'powers')).toEqual({ op: 'regenerate_countries', layout: 'powers' });
    const eng = nations();
    eng.exec(regenerateCountriesCommand(eng.world, 0.5, true, 'unified'));
    expect(layoutOf(eng.world)).toBe('unified');
    expect(regenerateCountriesCommand(eng.world, 0.5, true, 'unified')).toEqual({ op: 'regenerate_countries' });
    expect(regenerateCountriesCommand(eng.world, 0.5, true, 'era')).toEqual({ op: 'regenerate_countries', layout: 'era' });
    expect(defaultChoice(eng.world.small).countries.layout).toBe('unified');
  });

  it('生成人文：格局写进 countries（按时代时不写）', () => {
    const c = defaultChoice(null);
    expect((generateCommand(c) as Extract<Command, { op: 'generate_human' }>).countries).toEqual({});
    const mixed = generateCommand({ ...c, countries: { ...c.countries, layout: 'mixed' } }) as Extract<Command, { op: 'generate_human' }>;
    expect(mixed.countries).toEqual({ layout: 'mixed' });
  });

  it('滑块的说明：会生成联邦的时代说一句成员邦另算', () => {
    expect(fragTitle('medieval')).not.toContain('联邦');
    expect(fragTitle('modern')).toContain('联邦的成员邦另算');
  });
});

describe('缓存跟着 set_bloc 变', () => {
  it('着色的键、图例、片区名', () => {
    const eng = moderns();
    const w0 = eng.world;
    const ally = blocList(w0.small).find((b) => b.kind === 'alliance')!;
    const sig = colorSignature(w0.small);
    const legend = legendFor(w0, 'bloc');
    const labels = regionDraws(w0, 'bloc', 'zh');
    eng.exec({ op: 'set_bloc', id: ally.id, patch: { color: '#123456', name: '海上同盟' } });
    const w = eng.world;
    expect(colorSignature(w.small)).not.toBe(sig);
    expect(legendFor(w, 'bloc')).not.toBe(legend);
    expect(legendFor(w, 'bloc')!.items.some((x) => x.color === '#123456' && x.label === '海上同盟')).toBe(true);
    const again = regionDraws(w, 'bloc', 'zh');
    expect(again).not.toBe(labels);
    if (again.some((l) => l.key === `${REGION_KEY}bloc:${ally.id}`)) expect(again.find((l) => l.key === `${REGION_KEY}bloc:${ally.id}`)!.lines).toEqual(['海上同盟']);
    const hex = (c: number) => `#${[...humanFlat(w, 'bloc').subarray(c * 4, c * 4 + 3)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    const c = cellsOfBloc(w, blocById(w.small, ally.id)!)[0];
    if (c !== undefined) expect(hex(c)).toBe('#123456');
  });
});

describe('导出', () => {
  it('countries.csv 有等级、从属、集团；blocs.csv 一个集团一行', () => {
    const w = moderns().world;
    const rows = countriesCsv(w).trim().split('\n');
    expect(rows[0]).toBe('id,name,orig,red,green,blue,government,culture,capital,population,area_km2,overlord,tier,subject,blocs');
    const head = rows[0].split(',');
    const list = blocList(w.small);
    const fed = list.find((b) => b.kind === 'federation')!;
    const row = rows.find((r) => r.startsWith(`${fed.leader},`))!.split(',');
    expect(row[head.indexOf('blocs')].split(';').map(Number)).toContain(fed.id);
    expect(['city', 'small', 'medium', 'large', 'empire']).toContain(row[head.indexOf('tier')]);
    const bl = blocsCsv(w).trim().split('\n');
    expect(bl[0]).toBe('id,kind,name,orig,red,green,blue,leader,members');
    expect(bl.length).toBe(1 + list.length);
    expect(bl[1].split(',')[1]).toBe(list[0].kind);
    expect(Object.keys(exportPart(w, 'countries'))).toEqual(['countries.csv', 'blocs.csv']);
    expect(strFromU8(exportPart(noBlocs(moderns()).world, 'countries')['blocs.csv']).trim()).toBe('id,kind,name,orig,red,green,blue,leader,members');
  });
});
