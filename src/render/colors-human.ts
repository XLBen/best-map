// 人文、省份、国家的颜色（第八十三轮从 src/render/colors.ts 原样搬出）：平涂的人文层、国家与同盟的边界组、岩性、陆格层、省份的平涂与分组、高亮
import type { RGB, HumanFlatMode } from './color-ramps';
import { type World, provinceDisplayColor, provinceColor } from '../../core/world';
import { classColors, resourceColors, humanColors, countryMapColors, blocMapColors, worldDimensions, valueLayer, blocBorderGroups, blocCells, worldCultures, worldCultureGroups, worldPopValues } from '../../core/human';
import { codeFlags, ringCodes, ISLAND_CODE_MASK, landPixelCells, provinceLand } from '../../core/island-types';
import { type SeamLayers, type ProvinceSeam, seamsAfterCut, seamLayers } from '../../core/seams';
import type { ProvinceKind } from '../../core/provinces';
import type { ViewMode } from '../state';

// 资源底图里没有资源的陆地：中性的灰，淡淡盖住地貌
export const NO_RESOURCE: RGB = [128, 124, 118];
const HUMAN_ALPHA = 235;
const NO_RESOURCE_ALPHA = 170;
// 国家底图：陆上透一点地貌（晕渲照样有），领海淡淡的
export const COUNTRY_ALPHA = 215;
export const SEA_CLAIM_ALPHA = 70;
// 归了国家的碎岛（第二十六轮，derived.countryIslet）：A 写 ISLET_FLAT（水面照旧是海）或 ISLET_FLAT + 1（水面也是领海）。
// 着色器认这两个值：陆地像素按 COUNTRY_ALPHA 涂满国家色，水面像素不涂或按 SEA_CLAIM_ALPHA 涂（1、2 本来淡得看不出，不会和别的混）
export const ISLET_FLAT = 1;
// 同盟模式里不在集团里的国家
export const NO_BLOC: RGB = [150, 148, 144];

// 地形类别、资源底图的平涂层：按编号取颜色（core/human 的 classColors、resourceColors），水面不着色
// 文化圈、每一维（第二十二轮）：按 derived.popCulture / popCultureGroup / valueLayer 的编号取 humanColors，没有人的格不着色
export function humanFlat(world: World, mode: HumanFlatMode): Uint8Array {
  const { mesh, causes, derived: d } = world;
  const n = mesh.n;
  const flat = new Uint8Array(n * 4);
  let codes: ArrayLike<number> | undefined;
  let colors: (readonly number[] | null)[];
  if (mode === 'terrainClass' || mode === 'resource') {
    codes = mode === 'terrainClass' ? d.terrainClass : d.resource;
    colors = mode === 'terrainClass' ? classColors(world) : resourceColors(world);
  } else if (mode === 'culture' || mode === 'cultureGroup') {
    codes = mode === 'culture' ? d.popCulture : d.popCultureGroup;
    colors = humanColors(world, mode);
  } else if (mode === 'country' || mode === 'bloc') {
    codes = d.country;
    colors = mode === 'country' ? countryMapColors(world) : blocMapColors(world).map((c, k) => (k && !c ? NO_BLOC : c));
  } else {
    const dim = mode.slice(4);
    const k = worldDimensions(world.small).findIndex((x) => x.id === dim);
    codes = k >= 0 ? valueLayer(world, k) : undefined;
    colors = humanColors(world, dim);
  }
  if (!codes) return flat;
  const political = mode === 'country' || mode === 'bloc';
  const islet = political ? d.countryIslet : undefined;
  for (let i = 0; i < n; i++) {
    if (political && !causes.land[i] && codes[i]) {
      // 领海；归了国家的碎岛按 ISLET_FLAT（着色器里陆地像素涂满）
      const c = colors[codes[i]];
      if (c) flat.set([c[0], c[1], c[2], islet?.[i] ? ISLET_FLAT + islet[i] - 1 : SEA_CLAIM_ALPHA], i * 4);
      continue;
    }
    if (!causes.land[i] || d.lake[i] === 1) continue;
    const c = colors[codes[i]];
    const k = i * 4;
    if (c) {
      flat[k] = c[0];
      flat[k + 1] = c[1];
      flat[k + 2] = c[2];
      flat[k + 3] = political ? COUNTRY_ALPHA : HUMAN_ALPHA;
    } else if (mode === 'resource') {
      flat[k] = NO_RESOURCE[0];
      flat[k + 1] = NO_RESOURCE[1];
      flat[k + 2] = NO_RESOURCE[2];
      flat[k + 3] = NO_RESOURCE_ALPHA;
    }
  }
  return flat;
}

// 国界的分组（第二十三轮，渲染器的第二张分组纹理）：每格两个值（第二个总是 0）。陆地（湖面也算）是国家的编号（derived.country，
// 无主 0），领海是编号 + 65536，不归谁的海是 −1。着色器只在同是陆地或同是海、编号不同的相邻像素之间画国界：
// 海岸线上、陆地与它自己的领海之间不画（core 的 countryGroups 不分陆海，海岸上会多画一道，所以界面另算一份）。
// 第二十六轮：水面照旧是海的碎岛当作不归谁的海（不在海里绕着碎岛画一圈国界）。
// blocs（国家模式）：第二个值是集团的分组——帝国的格是帝国的编号，联邦的格是联邦的编号 + FEDERATION_GROUP，别的陆地 0，海 −1。
// 着色器在帝国的里侧、离边界几个像素画一道细线（帝国的外沿）；同一个联邦的成员之间的国界画得细而淡
export const FEDERATION_GROUP = 100000;
export function countryBorderGroups(world: World, blocs = false): Float32Array {
  const { mesh, causes, derived: d } = world;
  const out = new Float32Array(mesh.n * 2);
  const code = d.country;
  const islet = d.countryIslet;
  const any = blocs && !!world.small.blocs?.length;
  const empire = any ? blocBorderGroups(world, ['empire']) : null;
  const fed = any ? blocCells(world, ['federation']) : null;
  for (let i = 0; i < mesh.n; i++) {
    const c = islet?.[i] === 1 ? 0 : (code?.[i] ?? 0);
    out[2 * i] = causes.land[i] ? c : c ? c + 65536 : -1;
    if (empire) out[2 * i + 1] = fed![i] >= 0 ? fed![i] + FEDERATION_GROUP : empire[2 * i];
  }
  return out;
}

// 岛的样子（第十三轮按可蚀性；第十四轮起按每格记下的岛的种类，见 core/island-types.ts）：每格 RGBA 字节，地形着色器按它画：
//   r 不用（第十四轮去掉了火山岛的玄武岩）
//   g 沙洲（颜色选“沙洲”的岛，如低平岛：低处是沙与沼泽）
//   b 白沙（颜色选“白沙”的岛，如珊瑚岛、小礁：白沙、岸边白浪；潟湖的海格也是，海底青绿）
//   a 格里的潟湖：环礁形状、只有一格大（挨着的陆格不到两个）的岛，格心画一圈潟湖
// 没有放岛的地方（包括涂了很硬、很软的岩石的地方）全是 0，画面不变
export function lithLayer(world: World): Uint8Array {
  const { mesh, causes, derived: d, small } = world;
  const n = mesh.n;
  const out = new Uint8Array(n * 4);
  const coral = codeFlags(small, (t) => t.color === 'coral');
  const marsh = codeFlags(small, (t) => t.color === 'marsh');
  const ring = ringCodes(small);
  for (let i = 0; i < n; i++) {
    const code = causes.islandType[i] & ISLAND_CODE_MASK;
    if (!code) continue;
    const land = causes.land[i] === 1;
    if (land && d.lake[i] === 1) continue;
    if (coral[code]) out[i * 4 + 2] = 255;
    if (!land) continue;
    if (marsh[code]) out[i * 4 + 1] = 255;
    if (ring[code]) {
      let k = 0;
      for (let q = mesh.off[i]; q < mesh.off[i + 1]; q++) if (causes.land[mesh.adj[q]]) k++;
      if (k < 2) out[i * 4 + 3] = 255;
    }
  }
  return out;
}

// 画成陆地、落在水面格（海、湖）里的像素归哪一格的省（core/island-types.ts 的 landProvinceCells）：每格 RGBA 字节，
// 格号 + 1 写在 r、g、b 里（与编号层相同的编码，0 是没有）。着色器的 provCell 在附近找不到陆地格时用它
export function landCellLayer(world: World): Uint8Array {
  const table = landPixelCells(world);
  const out = new Uint8Array(table.length * 4);
  for (let i = 0; i < table.length; i++) {
    const v = table[i] + 1;
    out[i * 4] = v & 255;
    out[i * 4 + 1] = (v >> 8) & 255;
    out[i * 4 + 2] = (v >> 16) & 255;
    out[i * 4 + 3] = 255;
  }
  return out;
}

// 小数据里着色用到的部分连成一个字符串（MapView 着色缓存的键之一）：省份类型、切线、生态的颜色与外观（花纹、发光、种子）、海岸曲折。
// 只改生态外观的一步什么都不重算（轻快照，推导数组不变），靠外观这一段重新着色；只改名字、地名设定时不变，不重新着色
export function colorSignature(small: World['small']): string {
  const kinds = Object.entries(small.provinces).map(([p, m]) => `${p}:${m.kind}${m.color ? `:${m.color}` : ''}`);
  const seams = (small.provinceSeams ?? []).map((s) => s.id);
  const colors = small.species.map((s) => s.color);
  const looks = small.species.map((s) => (s.visual ? `${s.id}:${s.seedKey ?? ''}:${JSON.stringify(s.visual)}` : ''));
  // 岛的种类：颜色、形状（一格的环礁画潟湖）、归哪种省（省份的着色、省界）
  const isles = (small.islandTypes ?? []).map((t) => `${t.color ?? ''}:${t.shape}:${t.province}`);
  // 地形类别、资源的颜色（第二十一轮）：改过、加过时才有
  const human = small.content?.terrainClass || small.content?.resource ? `|${classColors({ small }).join(';')}|${resourceColors({ small }).join(';')}` : '';
  // 文化、文化组、取值的颜色（第二十二轮）：有人文时才有
  const pop = small.human ? `|${[...worldCultures(small), ...worldCultureGroups(small), ...worldPopValues(small)].map((x) => x.color).join(';')}|${small.human.era}` : '';
  // 国家的颜色（第二十三轮，地图上的：宗主变了附庸的颜色跟着变）：有国家时才有
  const countries = small.countries ? `|${countryMapColors({ small }).join(';')}` : '';
  // 集团（第二十六轮：同盟模式的颜色、帝国的外沿、联邦的成员）：set_bloc 只改它
  const blocs = small.blocs?.length ? `|${small.blocs.map((b) => `${b.id}:${b.kind}:${b.color}:${b.members.join('.')}`).join(',')}` : '';
  return `${kinds.join(',')}|${seams.join(',')}|${colors.join(',')}|${small.terrain.coastRoughness}|${looks.join(',')}|${isles.join(',')}${human}${pop}${countries}${blocs}`;
}

// 省份着色的平涂：每省一种颜色；无人区偏灰、湖省偏蓝，一眼能和普通省份分开。
// 海上的省份默认不着色（看得到海本来的样子），用户给它选了颜色（ProvinceMeta.color）才涂；陆地省选了颜色就用那个颜色。
// kindOf：省的类型（预览里还没有的新省，取它切出来的那个省的类型）。每个省的颜色只算一次：
// 剪刀、涂省拖动时每动一下都要整张重算，十万格的星球上逐格查类型、建颜色数组要几十毫秒
export function provinceFlat(world: World, province: Int32Array, kindOf = (p: number) => world.small.provinces[p]?.kind): Uint8Array {
  const { mesh } = world;
  // 归海省的岛（小礁）按海上的不透明度：海省默认不着色，礁上照样看得到白沙
  const pland = provinceLand(world);
  const flat = new Uint8Array(mesh.n * 4);
  // 每个省：颜色与陆地、海上的不透明度
  const look = new Map<number, [number, number, number, number, number]>();
  for (let i = 0; i < mesh.n; i++) {
    const p = province[i];
    if (p < 0) continue;
    let v = look.get(p);
    if (!v) {
      const kind = kindOf(p);
      const own = world.small.provinces[p]?.color;
      const c = own ? provinceDisplayColor(world, p) : provinceColor(p);
      if (kind === 'wasteland') v = [(c[0] + 2 * 150) / 3, (c[1] + 2 * 150) / 3, (c[2] + 2 * 150) / 3, 170, 170];
      else if (kind === 'lake') v = own ? [c[0], c[1], c[2], 150, 150] : [70, 125, 190, 150, 150];
      else v = [c[0], c[1], c[2], 140, own ? 120 : 0];
      look.set(p, v);
    }
    flat[i * 4] = v[0];
    flat[i * 4 + 1] = v[1];
    flat[i * 4 + 2] = v[2];
    flat[i * 4 + 3] = pland[i] ? v[3] : v[4];
  }
  return flat;
}

// 分组（画省界）：每格两个值。第一个：陆地省份 = 编号 + 1，海域省份 = −(编号 + 1)，未划分 = 0；
// 第二个：切线附近这一格能不能按切线换（seams.ts 的 ok，没有切线时都是 0）
export function provinceGroups(world: World, province: Int32Array, seams: SeamLayers | null = null): Float32Array {
  const { mesh } = world;
  const pland = provinceLand(world);
  const group = new Float32Array(mesh.n * 2);
  for (let i = 0; i < mesh.n; i++) {
    const p = province[i];
    group[2 * i] = p < 0 ? 0 : pland[i] ? p + 1 : -(p + 1);
    if (seams) group[2 * i + 1] = seams.ok[i];
  }
  return group;
}

// 省份预览（剪刀、涂省、合并、重划）：这些格换成将来的省（剪刀还多几条将来的切线 seams），返回整份分组、
// （省份着色时的）平涂与切线，交给 Renderer.setGroupPreview。着色器照此画出将来真实的省界，用的是和结果相同的编码、扭曲与切线规则。
// 重划、重新划分时给整份将来的省份数组 province、将来全部的切线 seamList 与各省 metas（Worker 里的省份预览算好的），
// cells、ids 再改在它上面
export function groupPreview(
  world: World,
  change: {
    cells: ArrayLike<number>;
    ids: ArrayLike<number>;
    seams?: Omit<ProvinceSeam, 'id'>[];
    province?: Int32Array;
    seamList?: readonly ProvinceSeam[] | null;
    metas?: Record<number, { kind: ProvinceKind }>;
  },
  mode: ViewMode,
): { group: Float32Array; flat: Uint8Array | null; seams: SeamLayers | null } {
  const base = change.province ?? world.causes.province;
  const province = base.slice();
  for (let k = 0; k < change.cells.length; k++) province[change.cells[k]] = change.ids[k];
  const known = (p: number) => (change.metas ? change.metas[p] : undefined) ?? world.small.provinces[p];
  // 还没有的新省（剪刀切出来的几块）：类型随它切出来的那个省（与 cut_province 里按多数取的相同：一块只来自一个省）
  const born = new Map<number, ProvinceKind | undefined>();
  for (let k = 0; k < change.cells.length; k++) {
    const id = change.ids[k];
    if (!known(id) && !born.has(id)) born.set(id, known(base[change.cells[k]])?.kind);
  }
  const kindOf = (p: number) => known(p)?.kind ?? born.get(p);
  // 剪刀：与切线命令记下的一样（seamsAfterCut：原有的切线也管切出来的新省，再加这一刀的几条）
  let k = 0;
  const existing = change.seamList !== undefined ? (change.seamList ?? undefined) : world.small.provinceSeams;
  const list = seamsAfterCut(existing, change.seams ?? [], () => `preview-${k++}`);
  const seams = seamLayers(world, province, list);
  return { group: provinceGroups(world, province, seams), flat: mode === 'provinces' ? provinceFlat(world, province, kindOf) : null, seams };
}

export interface HighlightLayer {
  cells: number[];
  values?: number[];
  color: RGB;
  alpha?: number;
  // hatch：斜线（没能做到的格）；outline：只描出这些格的外沿，不填色（alpha、values 用不上）
  pattern?: 'fill' | 'hatch' | 'outline';
}

// 高亮层：选区、预览、没涂成的格、变化。后面的层盖住前面的层。
// alpha 字节的编码：1–127 为平涂的不透明度，128 为只描边，129–255 为斜线的不透明度（着色器按此解码）
export function highlightColors(world: World, layers: HighlightLayer[]): Uint8Array | null {
  if (!layers.length) return null;
  const n = world.mesh.n;
  const out = new Uint8Array(n * 4);
  for (const l of layers) {
    const a = l.alpha ?? 0.45;
    const hatch = l.pattern === 'hatch';
    const outline = l.pattern === 'outline';
    l.cells.forEach((i, k) => {
      if (i < 0 || i >= n) return;
      const v = Math.max(0, Math.min(1, l.values ? l.values[k] : 1));
      const level = outline ? 0 : Math.round(127 * a * v);
      if (level <= 0 && !outline) return;
      out[i * 4] = l.color[0];
      out[i * 4 + 1] = l.color[1];
      out[i * 4 + 2] = l.color[2];
      out[i * 4 + 3] = outline ? 128 : hatch ? 128 + level : level;
    });
  }
  return out;
}

// 每个省大约几格宽：√（省份格数的中位数）。缩小看时省界按它淡出（大省的边界留得久，小省的先淡）；没有省份时为 1
export function provinceScale(province: Int32Array): number {
  const counts = new Map<number, number>();
  for (let i = 0; i < province.length; i++) {
    const p = province[i];
    if (p >= 0) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  if (!counts.size) return 1;
  const sizes = [...counts.values()].sort((a, b) => a - b);
  return Math.sqrt(sizes[Math.floor(sizes.length / 2)]);
}
