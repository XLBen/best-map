import { type World, longitudeOf, worldLatitude } from '../world';
import { countryList } from './countries';
import { allCountryStats, countryFactions } from './country-layers';
import { cultureById, cultureGroupById, worldEra } from './era';
import { categoryName, governmentById } from './government';
import { landmarkList } from './landmarks';
import { populationSummary } from './layers';
import { pointList } from './points';
import { roadKm } from './roads';
import { type CityArchive, cityArchive, cityTable, popText } from './settlements';

// 导出用的表与档案全文（第二十四轮）：cities.csv、roads.csv、roads.geojson、landmarks.csv、points.csv、archive.md、archive.json。
// 都只读世界，不改；没有城市、道路、地标、自定义点时整合包里没有它们（见 export.ts）

const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csv = (rows: (string | number)[][]) => `${rows.map((r) => r.map((v) => (typeof v === 'number' ? String(v) : esc(v))).join(',')).join('\n')}\n`;

// 一格的经纬度（整个星球是真的经纬度；一块地区按赤道尺度把 x 换成相对地图中心的经度，同 features.csv）
export function cellLatLon(world: World, x: number, y: number): [number, number] {
  const { mesh } = world;
  const lat = worldLatitude(world, y);
  const lonSpan = (mesh.width * world.kmPerUnit) / 111.2;
  const lon = world.settings.globe ? longitudeOf(x) : (x / mesh.width - 0.5) * lonSpan;
  return [lat, lon];
}
const ll = (world: World, x: number, y: number) => cellLatLon(world, x, y).map((v) => Number(v.toFixed(3)));

export const hasSettlements = (world: Pick<World, 'small'>): boolean => {
  const s = world.small;
  return !!(s.cities && Object.keys(s.cities).length) || !!(s.roads && Object.keys(s.roads).length) || !!(s.landmarks && Object.keys(s.landmarks).length) || !!(s.points && Object.keys(s.points).length);
};

// cities.csv：id, name, orig, rank, capital（1 首都、2 陪都）, country, country_name, population, share, cell, lat, lon, province, founded, auto
export function citiesCsv(world: World): string {
  const rows: (string | number)[][] = [['id', 'name', 'orig', 'rank', 'capital', 'country', 'country_name', 'population', 'share', 'cell', 'lat', 'lon', 'province', 'founded', 'auto']];
  for (const c of cityTable(world).list) {
    if (c.point) continue;
    const a = cityArchive(world, c.id)!;
    const [lat, lon] = ll(world, c.x, c.y);
    rows.push([c.id, c.name, c.orig ?? '', c.rank.id, c.capital ? 1 : c.secondCapital ? 2 : 0, c.country ?? '', a.countryName ?? '', Math.round(c.population), Number(c.share.toFixed(5)), c.cell, lat, lon, a.province >= 0 ? a.province : '', a.founded, c.auto ? 1 : 0]);
  }
  return csv(rows);
}

// roads.csv：id, kind, name, from, to, km, auto, cells（格的编号，空格隔开）
export function roadsCsv(world: World): string {
  const rows: (string | number)[][] = [['id', 'kind', 'name', 'from', 'to', 'km', 'auto', 'cells']];
  for (const r of Object.values(world.small.roads ?? {}).sort((a, b) => a.id - b.id)) {
    rows.push([r.id, r.kind, r.name ?? '', r.from ?? '', r.to ?? '', Math.round(roadKm(world, r.cells)), r.auto ? 1 : 0, r.cells.join(' ')]);
  }
  return csv(rows);
}

// roads.geojson：每条路一个 LineString（[经度, 纬度]，格心连成的折线；星球上跨过 ±180° 时断开成 MultiLineString）
export function roadsGeojson(world: World): string {
  const { mesh } = world;
  const features = Object.values(world.small.roads ?? {})
    .sort((a, b) => a.id - b.id)
    .map((r) => {
      const parts: [number, number][][] = [[]];
      let prev: number | undefined;
      for (const c of r.cells) {
        const [lat, lon] = cellLatLon(world, mesh.x[c], mesh.y[c]);
        if (prev !== undefined && Math.abs(lon - prev) > 180) parts.push([]);
        parts[parts.length - 1].push([Number(lon.toFixed(4)), Number(lat.toFixed(4))]);
        prev = lon;
      }
      const lines = parts.filter((p) => p.length >= 2);
      const geometry = lines.length === 1 ? { type: 'LineString', coordinates: lines[0] } : { type: 'MultiLineString', coordinates: lines };
      return {
        type: 'Feature',
        properties: { id: r.id, kind: r.kind, ...(r.name ? { name: r.name } : {}), ...(r.from !== undefined ? { from: r.from } : {}), ...(r.to !== undefined ? { to: r.to } : {}), km: Math.round(roadKm(world, r.cells)), auto: !!r.auto },
        geometry,
      };
    });
  return `${JSON.stringify({ type: 'FeatureCollection', features })}\n`;
}

// landmarks.csv：id, type, type_name, category, name, orig, cell, lat, lon, country, elevation_m, auto
export function landmarksCsv(world: World): string {
  const rows: (string | number)[][] = [['id', 'type', 'type_name', 'category', 'name', 'orig', 'cell', 'lat', 'lon', 'country', 'elevation_m', 'auto']];
  for (const l of landmarkList(world)) {
    const [lat, lon] = ll(world, l.x, l.y);
    rows.push([l.id, l.type, l.typeName, l.category, l.name, l.orig ?? '', l.cell, lat, lon, l.country ?? '', l.elevation, l.auto ? 1 : 0]);
  }
  return csv(rows);
}

// points.csv：id, type, type_name, name, cell, lat, lon, attached_city, note
export function pointsCsv(world: World): string {
  const rows: (string | number)[][] = [['id', 'type', 'type_name', 'name', 'cell', 'lat', 'lon', 'attached_city', 'note']];
  for (const p of pointList(world)) {
    const [lat, lon] = ll(world, p.x, p.y);
    rows.push([p.id, p.type, p.typeName, p.name, p.cell, lat, lon, p.attachedCity ?? '', p.note ?? '']);
  }
  return csv(rows);
}

const pct = (v: number) => `${(v * 100).toFixed(v < 0.01 ? 2 : 1)}%`;
const km2 = (v: number) => `${Math.round(v).toLocaleString('en-US')} km²`;

// 档案全文（Markdown）：世界、国家（档案、统计、派系、历史）、城市、地标、自定义点
export function archiveMarkdown(world: World): string {
  const { small } = world;
  const out: string[] = ['# 世界档案', ''];
  const era = worldEra(small);
  const pop = populationSummary(world);
  if (era || pop) {
    out.push(...[era ? `- 时代：${era.name}` : '', pop ? `- 总人口：${popText(pop.total)}` : ''].filter(Boolean));
    if (pop?.cultures.length) out.push(`- 文化：${pop.cultures.slice(0, 12).map((c) => `${c.name} ${pct(pop.total > 0 ? c.pop / pop.total : 0)}`).join('、')}`);
    out.push('');
  }
  const countries = countryList(small);
  const stats = allCountryStats(world);
  const table = cityTable(world);
  const cityName = (id: number) => table.byId.get(id)?.name ?? String(id);
  const countryName = (id: number) => small.countries?.[id]?.name ?? String(id);
  if (countries.length) {
    out.push('## 国家', '');
    for (const m of countries) {
      const st = stats.get(m.id);
      const gov = governmentById(small, m.government);
      const culture = cultureById(small, m.primaryCulture);
      out.push(`### ${m.name}${m.orig ? `（${m.orig}）` : ''}`, '');
      const lines: string[] = [];
      lines.push(`- 政体：${gov?.name ?? m.government}${gov?.category.length ? `（${gov.category.map(categoryName).join('、')}）` : ''}`);
      if (st?.capitals.length) lines.push(`- 首都：${st.capitals.map(cityName).join('、')}`);
      lines.push(`- 主流文化：${culture?.name ?? m.primaryCulture}；兼容的文化组：${m.acceptedGroups.map((g) => cultureGroupById(small, g)?.name ?? g).join('、')}`);
      if (st) lines.push(`- 人口：${popText(st.population)}；面积：${km2(st.areaKm2)}；城市：${st.cities} 座；省份：${st.provinces} 个`);
      if (st?.cultures.length) lines.push(`- 人口构成：${st.cultures.slice(0, 6).map((c) => `${c.name} ${pct(c.share)}`).join('、')}`);
      const fac = countryFactions(world, m.id, st);
      if (fac.length) lines.push(`- 派系：${fac.map((f) => `${f.name} ${pct(f.influence)}`).join('、')}`);
      lines.push(`- 统治者：${m.ruler.title ? `${m.ruler.title} ` : ''}${m.ruler.name}${m.ruler.orig ? `（${m.ruler.orig}）` : ''}`);
      lines.push(`- 建国：${m.founded} 年`);
      if (m.overlord !== undefined) lines.push(`- 宗主：${countryName(m.overlord)}`);
      const vassals = countries.filter((x) => x.overlord === m.id);
      if (vassals.length) lines.push(`- 附庸：${vassals.map((x) => x.name).join('、')}`);
      if (m.allies.length) lines.push(`- 同盟：${m.allies.map(countryName).join('、')}`);
      if (m.rivals.length) lines.push(`- 敌对：${m.rivals.map(countryName).join('、')}`);
      out.push(...lines, '');
      if (m.history) out.push(m.history, '');
    }
  }
  const cities = table.list.filter((c) => !c.point);
  if (cities.length) {
    out.push('## 城市', '');
    for (const c of cities) {
      const a = cityArchive(world, c.id)!;
      const role = c.capital ? '首都' : c.secondCapital ? '陪都' : c.rank.name;
      out.push(`### ${c.name}${c.orig ? `（${c.orig}）` : ''}`, '');
      out.push(`- ${role}${a.countryName ? ` · ${a.countryName}` : ''}`);
      if (c.population > 0) out.push(`- 人口：约 ${popText(c.population)}（占本国 ${pct(c.share)}）`);
      out.push(`- 建城：${a.founded} 年`);
      if (a.cultures.length) out.push(`- 文化：${a.cultures.slice(0, 4).map((x) => `${x.name} ${pct(x.share)}`).join('、')}`);
      if (a.provinceName) out.push(`- 省份：${a.provinceName}`);
      out.push('', a.description, '');
      if (a.notes) out.push(a.notes, '');
    }
  }
  const landmarks = landmarkList(world);
  if (landmarks.length) {
    out.push('## 地标', '');
    for (const l of landmarks) {
      out.push(`### ${l.name}${l.orig ? `（${l.orig}）` : ''}`, '');
      out.push(`- ${l.typeName}${l.country !== null ? ` · ${countryName(l.country)}` : ''}${l.category === 'natural' ? ` · 海拔 ${l.elevation} m` : ''}`);
      if (l.description) out.push('', l.description);
      out.push('');
    }
  }
  const points = pointList(world);
  if (points.length) {
    out.push('## 自定义点', '');
    for (const p of points) {
      out.push(`### ${p.name}`, '', `- ${p.typeName}${p.attachedCity !== undefined ? ` · ${cityName(p.attachedCity)}` : ''}`);
      if (p.note) out.push('', p.note);
      out.push('');
    }
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

// 全部人文数据（JSON）：时代、人口、国家（档案、统计、派系）、城市（档案）、道路、地标、自定义点
export function archiveJson(world: World): string {
  const { small } = world;
  const era = worldEra(small);
  const pop = populationSummary(world);
  const stats = allCountryStats(world);
  const cities: CityArchive[] = cityTable(world)
    .list.filter((c) => !c.point)
    .map((c) => cityArchive(world, c.id)!);
  const data = {
    format: 'map2-archive',
    version: 1,
    ...(era ? { era: { id: era.id, name: era.name } } : {}),
    ...(pop ? { population: Math.round(pop.total), cultures: pop.cultures.map((c) => ({ id: c.id, name: c.name, population: Math.round(c.pop) })) } : {}),
    countries: countryList(small).map((m) => ({ ...m, stats: stats.get(m.id), factions: countryFactions(world, m.id, stats.get(m.id)) })),
    cities: cities.map((a) => ({
      id: a.id,
      name: a.name,
      ...(a.orig ? { orig: a.orig } : {}),
      cell: a.cell,
      lat: ll(world, a.x, a.y)[0],
      lon: ll(world, a.x, a.y)[1],
      rank: a.rank.id,
      capital: a.capital,
      secondCapital: a.secondCapital,
      country: a.country,
      population: Math.round(a.population),
      share: Number(a.share.toFixed(5)),
      cultures: a.cultures,
      founded: a.founded,
      description: a.description,
      ...(a.notes ? { notes: a.notes } : {}),
      province: a.province,
      auto: a.auto,
      locked: a.locked,
    })),
    roads: Object.values(small.roads ?? {})
      .sort((a, b) => a.id - b.id)
      .map((r) => ({ ...r, km: Math.round(roadKm(world, r.cells)) })),
    landmarks: landmarkList(world),
    points: pointList(world),
  };
  return `${JSON.stringify(data, null, 1)}\n`;
}
