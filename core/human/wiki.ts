import type { World } from '../world';
import { loreOf } from './archive-store';
import { countryList, subjectText } from './countries';
import { allCountryStats, countryFaith } from './country-layers';
import { BLOC_NAMES, blocsOf } from './blocs';
import { cultureById } from './era';
import { countryTimeline } from './events';
import { governmentById } from './government';
import { reignText, rulersByDynasty } from './rulers';
import { SEA_LANE, roadKm } from './roads';
import { type CityInfo, cityArchive, cityTable, popText } from './settlements';
import { tierOfCountry, tierShort } from './tiers';

// 导出维基（第八十五轮）：一包 Markdown，index.md 加每国一页（countries/）、每座有名字的城市一页（cities/），页与页之间是相对的链接。
// 国家：概览（政体、等级、文化、宗教、首都、人口、面积）、备注、统治者（按家族）、大事年表、关系、城市、省份；
// 城市：国家、人口、备注、连着的道路（另一头的城市）。文件名去掉不能用的字、太长的截短、重名的加 -2、-3……（不分大小写）。
// 只读世界，不改；打包（zip）在 export.ts 的“单独导出”

// 文件名里不能有的（Windows、macOS、Markdown 链接里会出问题的）字
const UNSAFE = /[\u0000-\u001f\u007f<>:"/\\|?*#%&{}$!'`@+=^~[\]()；;,\s]+/g;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

export function safeFileName(name: string, fallback: string): string {
  let s = name.normalize('NFC').replace(UNSAFE, '_').replace(/_+/g, '_').replace(/^[_.]+|[_.]+$/g, '');
  if ([...s].length > 60) s = [...s].slice(0, 60).join('').replace(/[_.]+$/, '');
  if (!s) s = fallback;
  if (RESERVED.test(s)) s = `_${s}`;
  return s;
}

// 一组名字 → 文件名（同一组里不重名，不分大小写）
function uniqueNames<T>(items: readonly T[], name: (x: T) => string, fallback: (x: T) => string): Map<T, string> {
  const used = new Set<string>();
  const out = new Map<T, string>();
  for (const x of items) {
    const base = safeFileName(name(x), fallback(x));
    let s = base;
    for (let k = 2; used.has(s.toLowerCase()); k++) s = `${base}-${k}`;
    used.add(s.toLowerCase());
    out.set(x, s);
  }
  return out;
}

// Markdown 里的字：换行变空格，链接的方括号转义
const inline = (s: string) => s.replace(/\s*\n\s*/g, ' ').replace(/([[\]])/g, '\\$1');
const link = (text: string, href: string) => `[${inline(text)}](${href})`;
const yearOf = (y: number) => (y < 0 ? `前 ${-y} 年` : `${y} 年`);
const pct = (v: number) => `${(v * 100).toFixed(v < 0.01 ? 2 : 1)}%`;

export function wikiFiles(world: World): Record<string, string> {
  const { small } = world;
  const countries = countryList(small);
  const stats = allCountryStats(world);
  const table = cityTable(world);
  const cities = table.list.filter((c) => !c.point && c.name.trim());
  const cFile = uniqueNames(countries.map((m) => m.id), (id) => small.countries![id].name, (id) => `country-${id}`);
  const tFile = uniqueNames(cities, (c) => c.name, (c) => `city-${c.id}`);
  const cityById = new Map(cities.map((c) => [c.id, c]));
  // 从 countries/ 或 cities/ 里的一页链到别处
  const toCountry = (id: number, from: 'countries' | 'cities' | 'root') => {
    const f = cFile.get(id);
    const name = small.countries?.[id]?.name ?? String(id);
    if (!f) return inline(name);
    return link(name, `${from === 'root' ? 'countries/' : from === 'cities' ? '../countries/' : ''}${f}.md`);
  };
  const toCity = (c: CityInfo, from: 'countries' | 'cities' | 'root') => {
    const f = tFile.get(c);
    if (!f) return inline(c.name);
    return link(c.name, `${from === 'root' ? 'cities/' : from === 'countries' ? '../cities/' : ''}${f}.md`);
  };
  // 省份：这一国的陆地格最多的那些省（按格数）
  const provincesOf = new Map<number, Map<number, number>>();
  const cc = world.causes.country;
  if (cc) {
    for (let i = 0; i < cc.length; i++) {
      const p = world.causes.province[i];
      if (cc[i] < 0 || p < 0 || !world.small.provinces[p]?.land) continue;
      let m = provincesOf.get(cc[i]);
      if (!m) provincesOf.set(cc[i], (m = new Map()));
      m.set(p, (m.get(p) ?? 0) + 1);
    }
  }
  const files: Record<string, string> = {};

  for (const m of countries) {
    const st = stats.get(m.id);
    const gov = governmentById(small, m.government);
    const tier = tierOfCountry(small, m);
    const culture = cultureById(small, m.primaryCulture);
    const faith = countryFaith(world, m.id, st);
    const lore = loreOf(small, m.id);
    const out: string[] = [`# ${inline(m.name)}${m.orig ? `（${inline(m.orig)}）` : ''}`, '', '[← 目录](../index.md)', '', '## 概览', ''];
    out.push(`- 政体：${gov?.name ?? m.government}`);
    if (tier) out.push(`- 等级：${tierShort(tier)}`);
    out.push(`- 主流文化：${culture?.name ?? m.primaryCulture}`);
    if (faith) out.push(`- 国教：${faith.name}`);
    const caps = (st?.capitals ?? []).map((id) => cityById.get(id)).filter((c): c is CityInfo => !!c);
    if (caps.length) out.push(`- 首都：${caps.map((c) => toCity(c, 'countries')).join('、')}`);
    if (st) out.push(`- 人口：${popText(st.population)}`, `- 面积：${Math.round(st.areaKm2).toLocaleString('en-US')} km²`);
    out.push(`- 建国：${yearOf(m.founded)}`, '');
    if (lore.note?.trim()) out.push('## 备注', '', lore.note.trim(), '');
    if (m.history) out.push('## 历史', '', m.history, '');
    if (lore.rulers.length) {
      out.push('## 统治者', '');
      for (const g of rulersByDynasty(lore)) {
        out.push(`### ${g.dynasty ? `${inline(g.dynasty.name)}${g.dynasty.orig ? `（${inline(g.dynasty.orig)}）` : ''}` : '不属于家族'}`, '');
        for (const row of g.rows) {
          const r = row.ruler;
          const note = r.note?.trim() ? ` — ${inline(r.note.trim())}` : '';
          out.push(`${'  '.repeat(row.depth)}- ${inline(`${r.title ?? ''}${r.name}`)}${r.orig ? `（${inline(r.orig)}）` : ''}：${reignText(r, (y) => (y < 0 ? `前 ${-y}` : String(y)))}${note}`);
        }
        out.push('');
      }
    }
    const tl = countryTimeline(world, m.id);
    if (tl.length) {
      out.push('## 大事年表', '');
      for (const row of tl) {
        const others = row.kind === 'event' && row.others.length ? `（${row.others.map((id) => toCountry(id, 'countries')).join('、')}）` : '';
        const note = row.kind === 'event' && row.event.note?.trim() ? ` — ${inline(row.event.note.trim())}` : '';
        out.push(`- **${yearOf(row.year)}** ${inline(row.title)}${others}${note}`);
      }
      out.push('');
    }
    const rel: string[] = [];
    if (m.overlord !== undefined && small.countries?.[m.overlord]) rel.push(`- ${subjectText(m.subject, toCountry(m.overlord, 'countries'))}`);
    const vassals = countries.filter((x) => x.overlord === m.id);
    if (vassals.length) rel.push(`- 附庸：${vassals.map((x) => toCountry(x.id, 'countries')).join('、')}`);
    if (m.allies.length) rel.push(`- 同盟：${m.allies.map((id) => toCountry(id, 'countries')).join('、')}`);
    if (m.rivals.length) rel.push(`- 敌对：${m.rivals.map((id) => toCountry(id, 'countries')).join('、')}`);
    for (const b of blocsOf(world, m.id)) rel.push(`- ${BLOC_NAMES[b.kind]}：${inline(b.name)}（${b.members.map((id) => (id === m.id ? inline(m.name) : toCountry(id, 'countries'))).join('、')}）`);
    if (rel.length) out.push('## 关系', '', ...rel, '');
    const mine = cities.filter((c) => c.country === m.id).sort((a, b) => b.population - a.population || a.id - b.id);
    if (mine.length) {
      out.push('## 城市', '');
      for (const c of mine) out.push(`- ${toCity(c, 'countries')}${c.capital ? '（首都）' : ''}${c.population > 0 ? ` · 约 ${popText(c.population)}` : ''}`);
      out.push('');
    }
    const provs = [...(provincesOf.get(m.id) ?? new Map<number, number>())].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([p]) => small.provinces[p]?.name).filter(Boolean);
    if (provs.length) out.push('## 省份', '', provs.map((p) => inline(p!)).join('、'), '');
    files[`countries/${cFile.get(m.id)}.md`] = `${out.join('\n').trimEnd()}\n`;
  }

  const roads = Object.values(small.roads ?? {}).sort((a, b) => a.id - b.id);
  for (const c of cities) {
    const a = cityArchive(world, c.id, table);
    const out: string[] = [`# ${inline(c.name)}${c.orig ? `（${inline(c.orig)}）` : ''}`, '', '[← 目录](../index.md)', ''];
    const role = c.capital ? '首都' : c.secondCapital ? '陪都' : c.rank.name;
    out.push(`- ${role}${c.country !== null ? ` · ${toCountry(c.country, 'cities')}` : ''}`);
    if (c.population > 0) out.push(`- 人口：约 ${popText(c.population)}${c.country !== null ? `（占本国 ${pct(c.share)}）` : ''}`);
    if (a) out.push(`- 建城：${yearOf(a.founded)}`);
    if (a?.provinceName) out.push(`- 省份：${inline(a.provinceName)}`);
    out.push('');
    if (a?.description) out.push(a.description, '');
    if (a?.notes?.trim()) out.push('## 备注', '', a.notes.trim(), '');
    const links: string[] = [];
    for (const r of roads) {
      if (r.from !== c.id && r.to !== c.id) continue;
      const other = r.from === c.id ? r.to : r.from;
      const there = other !== undefined ? cityById.get(other) : undefined;
      const kind = r.kind === 'major' ? '大道' : r.kind === 'minor' ? '小路' : r.kind === SEA_LANE ? '海路' : r.kind;
      links.push(`- ${kind}${r.name ? `“${inline(r.name)}”` : ''} → ${there ? toCity(there, 'cities') : '路网'}（约 ${Math.round(roadKm(world, r.cells))} km）`);
    }
    if (links.length) out.push('## 道路', '', ...links, '');
    files[`cities/${tFile.get(c)}.md`] = `${out.join('\n').trimEnd()}\n`;
  }

  const index: string[] = ['# 世界维基', ''];
  if (countries.length) {
    index.push('## 国家', '');
    for (const m of countries) index.push(`- ${toCountry(m.id, 'root')}`);
    index.push('');
  }
  if (cities.length) {
    index.push('## 城市', '');
    for (const c of [...cities].sort((a, b) => b.population - a.population || a.id - b.id)) index.push(`- ${toCity(c, 'root')}${c.country !== null && small.countries?.[c.country] ? ` · ${inline(small.countries[c.country].name)}` : ''}`);
    index.push('');
  }
  files['index.md'] = `${index.join('\n').trimEnd()}\n`;
  return files;
}
