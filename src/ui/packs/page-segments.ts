import type { ContentKind, FieldDesc } from '../../../core/content/registry';
import { DEFAULT_KEY } from '../../../core/content/link-rules';
import { isObj, shownFields } from './fields';
import { patternModules } from '../../../core/human';

// 国家格局的参数（各模块的，键平铺在项里）
const PATTERN_PARAM_KEYS: readonly string[] = [...new Set(patternModules().flatMap((m) => (m.params ?? []).map((p) => p.key)))];

// 一项的页面分成几段可折叠的卡片（第五十九轮）：每种内容的字段归到哪一段，收起时标题旁写一句当前内容。
// 表单还是字段表（FieldsBox 按这一段的字段画），这里只分段。id 不列：改了 id 别的内容就找不到它了。
// custom：这一段不是字段表画的（水系的勾选，同一份数据见 core/water-table.ts）

export interface Segment {
  id: string;
  title: string;
  fields: readonly FieldDesc[];
  custom?: 'biomeWater' | 'waterBiomes' | 'samples' | 'eraDims';
  // 写在这一段里的一句说明（断流、按多数显示的类型……）
  hint?: string;
}

interface SegDef {
  id: string;
  title: string;
  keys: readonly string[];
  custom?: Segment['custom'];
  hint?: string;
}

const BASIC = '基本';

const WATER_NOTE = '一条河可以分段不同；地图底部写的类型是占一半以上的那一种，没有时写普通河';
const riverSegs = (noun: '河' | '湖'): SegDef[] => [
  { id: 'basic', title: BASIC, keys: noun === '河' ? ['name', 'color', 'atlasColor', 'style', 'width'] : ['name', 'color', 'atlasColor', 'style'] },
  { id: 'where', title: '出现在哪些地形', keys: ['natural', 'biomes', 'when'], custom: 'waterBiomes', hint: noun === '河' ? WATER_NOTE : '按湖岸一圈的生态、整个湖的条件看' },
  { id: 'bank', title: noun === '河' ? '两岸' : '湖岸', keys: ['bank'] },
  { id: 'names', title: '起名', keys: ['names'] },
  { id: 'scripts', title: '规则', keys: ['scripts'], hint: noun === '河' ? '每条河算一次，返回真就是这一种' : '每个湖算一次，返回真就是这一种' },
];

const TABLE: Record<string, readonly SegDef[]> = {
  era: [
    { id: 'basic', title: BASIC, keys: ['name', 'color', 'description', 'years'] },
    { id: 'dims', title: '变量', keys: ['dimensions'], custom: 'eraDims' },
    { id: 'people', title: '人口', keys: ['popDensity', 'sparsity', 'urbanization', 'unclaimed'] },
    { id: 'state', title: '国家', keys: ['seaClaimKm', 'countryKm2', 'tiers'] },
    { id: 'relations', title: '国家关系', keys: ['patterns', 'nationalism', 'relations'] },
  ],
  valueGroup: [{ id: 'basic', title: BASIC, keys: ['name', 'orig', 'color', 'dimension', 'description'] }],
  popValue: [
    { id: 'basic', title: BASIC, keys: ['name', 'orig', 'color', 'dimension', 'group', 'description'] },
    { id: 'prefs', title: '喜欢的地方', keys: ['prefs'] },
  ],
  cultureGroup: [
    { id: 'basic', title: BASIC, keys: ['name', 'orig', 'color', 'weight', 'description'] },
    { id: 'names', title: '地名', keys: ['nameStyle'] },
    { id: 'tend', title: '倾向', keys: ['tendencies', 'eraTendencies'] },
    { id: 'prefs', title: '喜欢的地方', keys: ['prefs'] },
  ],
  culture: [
    { id: 'basic', title: BASIC, keys: ['name', 'orig', 'color', 'group', 'weight', 'description'] },
    { id: 'names', title: '地名', keys: ['nameStyle'] },
    { id: 'tend', title: '倾向', keys: ['tendencies', 'eraTendencies'] },
    { id: 'prefs', title: '喜欢的地方', keys: ['prefs'] },
  ],
  government: [
    { id: 'basic', title: BASIC, keys: ['name', 'category', 'factions', 'color', 'weight', 'description'] },
    { id: 'titles', title: '称号', keys: ['titles', 'rulers', 'names'] },
    { id: 'only', title: '限谁用', keys: ['only'] },
    { id: 'shape', title: '国家的样子', keys: ['size', 'expansion', 'coastal', 'urbanization', 'cohesion', 'vassals', 'nomadic'] },
    { id: 'flag', title: '旗', keys: ['emblems', 'layouts'] },
  ],
  faction: [
    { id: 'basic', title: BASIC, keys: ['name', 'color', 'amount', 'description'] },
    { id: 'drivers', title: '来自人口', keys: ['drivers'] },
  ],
  countryTier: [
    { id: 'basic', title: BASIC, keys: ['name', 'short', 'order', 'area', 'weight', 'govSize', 'description'] },
    { id: 'join', title: '附庸与联邦', keys: ['vassal', 'federation', 'fedMember', 'confedCentre', 'confedMember'] },
    { id: 'capital', title: '首都', keys: ['capitalIcon', 'capitalAlpha', 'capitalLabel', 'capitalBold'] },
  ],
  countryLayout: [
    { id: 'basic', title: BASIC, keys: ['name', 'description'] },
    { id: 'weights', title: '各等级占多少', keys: ['weights'] },
  ],
  // 第七十三轮：模块的参数只显示选着的模块的（字段表的 when）
  countryPattern: [
    { id: 'basic', title: BASIC, keys: ['name', 'description', 'module', 'amount'] },
    { id: 'params', title: '参数', keys: PATTERN_PARAM_KEYS },
  ],
  terrainClass: [
    { id: 'basic', title: BASIC, keys: ['name', 'color', 'height', 'description'] },
    { id: 'rules', title: '自动规则', keys: ['priority', 'rules', 'fallback'] },
    { id: 'traits', title: '人文', keys: ['peaks', 'ore', 'movement', 'habitability'] },
    { id: 'export', title: '导出', keys: ['exportColor', 'terrain'] },
  ],
  resource: [
    { id: 'basic', title: BASIC, keys: ['name', 'color', 'icon', 'category', 'description'] },
    { id: 'rules', title: '长在哪里', keys: ['rules'] },
    { id: 'spread', title: '多少', keys: ['rarity', 'weight', 'cluster'] },
  ],
  // 第七十二轮：生态的页面是生态编辑器（ecology/BiomeEditor.tsx），不按这几段画；分段留着给收起时的一句、测试里字段都有归处
  biome: [
    { id: 'basic', title: BASIC, keys: ['name', 'color', 'terrain', 'natural', 'competition'] },
    { id: 'where', title: '长在哪里', keys: ['tolerances', 'height'] },
    { id: 'water', title: '水系', keys: ['plainRiver', 'plainLake', 'waterBlock'], custom: 'biomeWater' },
    { id: 'human', title: '人文', keys: ['habitability', 'movement'] },
    { id: 'look', title: '样子', keys: ['visual'] },
    { id: 'effects', title: '对周围的影响', keys: ['effects'] },
    { id: 'feature', title: '地名设定', keys: ['feature'] },
    { id: 'scripts', title: '规则', keys: ['scripts'] },
  ],
  riverType: riverSegs('河'),
  lakeType: riverSegs('湖'),
  islandType: [
    { id: 'basic', title: BASIC, keys: ['name', 'shape', 'height', 'color', 'rock', 'province'] },
    { id: 'names', title: '起名', keys: ['names'] },
  ],
  planetForm: [
    { id: 'basic', title: BASIC, keys: ['name', 'hint', 'base'] },
    { id: 'profile', title: '配方', keys: ['profile'] },
    { id: 'tuning', title: '微调', keys: ['tuning'] },
    { id: 'scripts', title: '规则', keys: ['scripts'] },
  ],
  nameStyle: [
    { id: 'basic', title: BASIC, keys: ['name', 'description', 'kind'] },
    { id: 'words', title: '写法', keys: ['lists', 'types', 'readings', 'syllables', 'length', 'forbid', 'translit', 'vowels', 'fallback'] },
    { id: 'samples', title: '示例', keys: [], custom: 'samples' },
  ],
  mapStyle: [
    { id: 'basic', title: BASIC, keys: ['name', 'description', 'typeColors'] },
    { id: 'land', title: '陆地', keys: ['landTint', 'landTintAmount', 'landShade', 'shadeDark', 'shadeLight', 'glow'] },
    { id: 'sea', title: '海', keys: ['sea', 'seaShade', 'tier1', 'depth2', 'tier2', 'depth3', 'tier3', 'depth4', 'tier4', 'isobath', 'isobathAmount', 'tierShade'] },
    { id: 'lines', title: '线', keys: ['coastLine', 'coastAmount', 'provinceLine', 'countryLine'] },
    { id: 'water', title: '河与路', keys: ['river', 'riverBank', 'road', 'roadMinor', 'quietRoad', 'quietRoadMinor'] },
    { id: 'text', title: '字', keys: ['countryLabel'] },
  ],
  cityRank: [
    { id: 'basic', title: BASIC, keys: ['name', 'icon', 'color', 'description'] },
    { id: 'rule', title: '多大算这一级', keys: ['minShare', 'minPop', 'major'] },
    { id: 'look', title: '样子', keys: ['label', 'alpha', 'iconScale', 'labelAlpha'] },
  ],
  landmarkType: [
    { id: 'basic', title: BASIC, keys: ['name', 'icon', 'color', 'description'] },
    { id: 'who', title: '谁有', keys: ['cultureGroups', 'governments'] },
    { id: 'where', title: '放在哪', keys: ['detector', 'place', 'category', 'per', 'count', 'chance', 'manual'] },
    { id: 'label', title: '名字的写法', keys: ['label'] },
  ],
  pointType: [
    { id: 'basic', title: BASIC, keys: ['name', 'icon', 'image', 'color', 'description'] },
    { id: 'city', title: '当作城市', keys: ['actsAsCity'] },
  ],
};

const memo = new Map<string, { fields: readonly FieldDesc[]; segs: Segment[] }>();

// 这种内容的几段：字段全部归到某一段（测试查着）；表里没写的种类、没写到的字段放进“基本”
export function segmentsOf(kind: ContentKind): Segment[] {
  const hit = memo.get(kind.id);
  if (hit?.fields === kind.fields) return hit.segs;
  const defs = TABLE[kind.id] ?? [{ id: 'basic', title: BASIC, keys: [] }];
  const listed = new Set(defs.flatMap((d) => d.keys));
  const rest = kind.fields.filter((f) => f.key !== 'id' && !listed.has(f.key));
  const segs = defs.map((d, k): Segment => {
    const fields = kind.fields.filter((f) => d.keys.includes(f.key));
    // 字段的先后按这一段写的
    const sorted = [...fields].sort((a, b) => d.keys.indexOf(a.key) - d.keys.indexOf(b.key));
    return { id: d.id, title: d.title, fields: k === 0 ? [...sorted, ...rest] : sorted, ...(d.custom ? { custom: d.custom } : {}), ...(d.hint ? { hint: d.hint } : {}) };
  });
  memo.set(kind.id, { fields: kind.fields, segs });
  return segs;
}

// 一开始展开哪几段：第一段。seg：从引用点过来时直接展开的
export const initialOpen = (segs: readonly Segment[], seg?: string): Set<string> => new Set(seg ? [seg] : segs.length ? [segs[0].id] : []);

// ---------- 收起时写的一句 ----------

const short = (s: string, n = 14) => (s.length > n ? `${s.slice(0, n)}…` : s);

export type LabelOf = (ref: string | readonly string[], id: string) => string;
const plainLabel: LabelOf = (_, id) => id;

// 一个字段现在的内容写成几个字（没写时空的）
export function fieldBrief(f: FieldDesc, v: unknown, labelOf: LabelOf = plainLabel): string {
  if (v === undefined || v === null || v === '') return '';
  switch (f.type) {
    case 'text':
      return typeof v === 'string' ? short(f.ref ? labelOf(f.ref, v) : v) : '';
    case 'longtext':
      return typeof v === 'string' ? short(v) : '';
    case 'number':
      return typeof v === 'number' ? `${f.label} ${v}${f.unit ?? ''}` : '';
    case 'bool':
      return v === true ? f.label : '';
    case 'color':
      return '';
    case 'enum':
      return f.options?.find((o) => o.value === v)?.label ?? String(v);
    case 'tags': {
      const list = Array.isArray(v) ? v.map(String) : [];
      if (!list.length) return '';
      const names = list.slice(0, 2).map((x) => (f.ref ? labelOf(f.ref, x) : x));
      return list.length > 2 ? `${names.join('、')} 等 ${list.length} 个` : names.join('、');
    }
    case 'weighted':
    case 'list':
    case 'tuples':
    case 'titleList':
      return Array.isArray(v) && v.length ? `${f.label} ${v.length}` : '';
    case 'map':
      return isObj(v) && Object.keys(v).length ? `${f.label} ${Object.keys(v).length}` : '';
    case 'range':
      return isObj(v) ? `${f.label} ${String(v.low)}–${String(v.high)}${f.unit ?? ''}` : '';
    case 'tuple':
      return Array.isArray(v) ? v.join('–') : '';
    case 'title': {
      if (typeof v === 'string') return short(v);
      if (!isObj(v)) return '';
      if (typeof v.zh === 'string') return short(v.zh);
      const first = v[DEFAULT_KEY] ?? Object.values(v)[0];
      return typeof first === 'string' ? short(first) : isObj(first) && typeof first.zh === 'string' ? short(first.zh) : '';
    }
    case 'tendencies':
      return isObj(v) && Object.keys(v).length ? `${f.label} ${Object.keys(v).length} 维` : '';
    case 'script':
      return isObj(v) && typeof v.src === 'string' && v.src.trim() ? '有规则' : '';
    case 'json': {
      if (!isObj(v)) return '';
      const parts = (f.of ?? []).map((x) => fieldBrief(x, v[x.key], labelOf)).filter(Boolean);
      return parts.slice(0, 2).join(' · ') || f.label;
    }
  }
}

// 一段的一句：名字不写（页面最上面有）；最多三项
export function segmentBrief(seg: Segment, item: Record<string, unknown>, labelOf: LabelOf = plainLabel): string {
  const parts = shownFields(seg.fields, item)
    .filter((f) => f.key !== 'name')
    .map((f) => fieldBrief(f, item[f.key], labelOf))
    .filter(Boolean);
  if (!parts.length) return '';
  const s = parts.slice(0, 3).join(' · ');
  return parts.length > 3 ? `${s} …` : s;
}
