import { contentItems } from '../content/registry';
import { sameItem } from '../content/refs';
import { styleInUse } from '../name-styles';
import { BUILTIN_STYLES } from '../packs/names';
import { BUILTIN_CULTURE_GROUPS, BUILTIN_CULTURES, BUILTIN_ERAS, BUILTIN_POP_VALUES } from '../packs/eras';
import type { World } from '../world';
import type { Culture, CultureGroup, Era, PopValue } from './era';

// 生成人文之后只留用到的内容（第二十八轮）：世界里只放用得上的时代、取值、文化组、文化，工具里就只列这些。
// 在生成的命令里做（generateHuman 的最后一步），重放时结果一样。
// 只去掉与内置的一模一样的（随时能从资源库加回来）；自己做的、改过的总留着。
// 留着的：
//   - 时代：人文用的那一个；
//   - 取值：有人的（现在的人口或自动的快照里），和这个时代每一维能用的（画人口时要选）；
//   - 文化：有人的、是国家的主流文化的、有发源地的、生成时点名要的；
//   - 文化组：生成时选的、留下的文化所在的、国家兼容的、有发源地的；
//   - 地名风格：去掉的文化用的、别处都没用到的内置风格（世界默认、地名、省份、留下的文化都没用到）才去掉

// 人口群体里用到的文化、取值（现在的人口与自动的快照：恢复自动时要找得到）
function popUses(world: World): { cultures: Set<string>; values: Set<string> } {
  const cultures = new Set<string>();
  const values = new Set<string>();
  const groups = world.small.popGroups ?? {};
  const seen = new Set<number>();
  const scan = (g: Uint16Array | undefined, s: Uint8Array | undefined) => {
    if (!g || !s) return;
    for (let k = 0; k < g.length; k++) if (g[k] && s[k]) seen.add(g[k]);
  };
  scan(world.causes.popGroup, world.causes.popShare);
  scan(world.causes.popAutoGroup, world.causes.popAutoShare);
  for (const id of seen) {
    const t = groups[id];
    if (!t) continue;
    cultures.add(t.culture);
    for (const v of Object.values(t.values)) values.add(v);
  }
  return { cultures, values };
}

const builtinSame = <T extends { id: string }>(x: T, builtin: readonly T[]): boolean => {
  const b = builtin.find((y) => y.id === x.id);
  return !!b && sameItem(b, x);
};

export function pruneHumanContent(world: World): void {
  const small = world.small;
  const h = small.human;
  if (!h || !small.content) return;
  const content = { ...small.content };
  const drop = (kind: string, ids: readonly string[]) => {
    if (!ids.length) return;
    const store = { ...((content[kind] ?? {}) as Record<string, unknown>) };
    for (const id of ids) delete store[id];
    if (Object.keys(store).length) content[kind] = store;
    else delete content[kind];
  };
  const { cultures: popCultures, values: popValues } = popUses(world);
  const countries = Object.values(small.countries ?? {});

  // 时代
  const eras = Object.values(contentItems<Era>(small, 'era'));
  drop(
    'era',
    eras.filter((e) => e.id !== h.era && builtinSame(e, BUILTIN_ERAS)).map((e) => e.id),
  );
  const era = contentItems<Era>(small, 'era')[h.era];
  const dims = new Set(era?.dimensions.map((d) => d.id) ?? []);

  // 取值
  const values = Object.values(contentItems<PopValue>(small, 'popValue'));
  const eraValue = (v: PopValue) => dims.has(v.dimension) && (!v.eras || v.eras.includes(h.era));
  drop(
    'popValue',
    values.filter((v) => !popValues.has(v.id) && !eraValue(v) && builtinSame(v, BUILTIN_POP_VALUES)).map((v) => v.id),
  );

  // 文化
  const keepCulture = new Set<string>(popCultures);
  for (const c of countries) keepCulture.add(c.primaryCulture);
  for (const x of h.hearths) if (x.culture) keepCulture.add(x.culture);
  for (const g of h.groups) for (const c of g.cultures ?? []) keepCulture.add(c);
  const cultures = Object.values(contentItems<Culture>(small, 'culture'));
  const goneCultures = cultures.filter((c) => !keepCulture.has(c.id) && builtinSame(c, BUILTIN_CULTURES));
  drop(
    'culture',
    goneCultures.map((c) => c.id),
  );
  const left = cultures.filter((c) => !goneCultures.includes(c));

  // 文化组
  const keepGroup = new Set<string>(h.groups.map((g) => g.id));
  for (const c of left) keepGroup.add(c.group);
  for (const c of countries) for (const g of c.acceptedGroups) keepGroup.add(g);
  for (const x of h.hearths) keepGroup.add(x.group);
  const groups = Object.values(contentItems<CultureGroup>(small, 'cultureGroup'));
  drop(
    'cultureGroup',
    groups.filter((g) => !keepGroup.has(g.id) && builtinSame(g, BUILTIN_CULTURE_GROUPS)).map((g) => g.id),
  );

  // 去掉的文化用的地名风格
  const styleIds = new Set(goneCultures.map((c) => c.nameStyle));
  for (const c of left) styleIds.delete(c.nameStyle);
  const styles = contentItems<{ id: string }>(small, 'nameStyle');
  drop(
    'nameStyle',
    [...styleIds].filter((id) => styles[id] && !styleInUse(small, id) && builtinSame(styles[id], BUILTIN_STYLES as readonly { id: string }[])),
  );

  if (Object.keys(content).length) small.content = content;
  else delete small.content;
}
