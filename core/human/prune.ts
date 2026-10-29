import { contentItems } from '../content/registry';
import { styleInUse } from '../name-styles';
import type { World } from '../world';
import { type Culture, type CultureGroup, type Era, type PopValue, worldEra } from './era';
import { eraFactions } from './government';

// 生成人文之后只留用到的内容（第二十八轮）：世界里只放用得上的时代、取值、文化组、文化，工具里就只列这些。
// 在生成的命令里做（generateHuman 的最后一步），重放时结果一样。
// 第三十轮起不论是不是内置原样，没用到的都去掉（计算 Worker 里没有内置数据）：移出的项照样列在命令结果里（RemovedItem），
// 界面把不是内置原样的存进资源库（“来自《世界名》”），所以不会丢。
// 留着的：
//   - 时代：人文用的那一个；
//   - 取值：有人的（现在的人口或自动的快照里）。第二十九轮起这个时代没人的取值也去掉（画人口要用时从资源库的时代包里加回来）；
//   - 文化：有人的、是国家的主流文化的、有发源地的、生成时点名要的；
//   - 文化组：生成时选的、留下的文化所在的、国家兼容的、有发源地的；
//   - 地名风格：去掉的文化用的、别处都没用到的风格（世界默认、地名、省份、留下的文化都没用到）才去掉；
//   - 政体、派系（第二十九轮）：有国家用的（国家的政体、国家写了影响力的派系）。换了时代后旧时代的那一套、
//     没有国家时的全部都去掉

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
    eras.filter((e) => e.id !== h.era).map((e) => e.id),
  );

  // 取值：没人的
  const values = Object.values(contentItems<PopValue>(small, 'popValue'));
  drop(
    'popValue',
    values.filter((v) => !popValues.has(v.id)).map((v) => v.id),
  );

  // 文化
  const keepCulture = new Set<string>(popCultures);
  for (const c of countries) keepCulture.add(c.primaryCulture);
  for (const x of h.hearths) if (x.culture) keepCulture.add(x.culture);
  for (const g of h.groups) for (const c of g.cultures ?? []) keepCulture.add(c);
  const cultures = Object.values(contentItems<Culture>(small, 'culture'));
  const goneCultures = cultures.filter((c) => !keepCulture.has(c.id));
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
    groups.filter((g) => !keepGroup.has(g.id)).map((g) => g.id),
  );

  // 去掉的文化用的地名风格
  dropStyles(small, content, goneCultures, left, drop);

  // 政体、派系：没有国家用的
  dropUnusedGov(small, content, drop);

  if (Object.keys(content).length) small.content = content;
  else delete small.content;
}

type Drop = (kind: string, ids: readonly string[]) => void;
type Content = NonNullable<World['small']['content']>;

// 去掉的文化用的、别处都没用到的地名风格
function dropStyles(small: World['small'], content: Content, gone: readonly Culture[], left: readonly Culture[], drop: Drop) {
  const styleIds = new Set(gone.map((c) => c.nameStyle));
  for (const c of left) styleIds.delete(c.nameStyle);
  const styles = (content.nameStyle ?? {}) as Record<string, { id: string }>;
  drop(
    'nameStyle',
    [...styleIds].filter((id) => styles[id] && !styleInUse({ ...small, content }, id)),
  );
}

// 没有国家用的政体、派系（第二十九轮）
function dropUnusedGov(small: World['small'], content: Content, drop: Drop) {
  const countries = Object.values(small.countries ?? {});
  const govUsed = new Set(countries.map((c) => c.government));
  // 没写影响力的国家按世界里的派系自动算：对它们都算在用
  const era = worldEra(small);
  const auto = era ? eraFactions(small, era).map((f) => f.id) : [];
  const facUsed = new Set(countries.flatMap((c) => (c.factions ? Object.keys(c.factions) : auto)));
  const govs = Object.values((content.government ?? {}) as Record<string, { id: string }>);
  drop(
    'government',
    govs.filter((g) => !govUsed.has(g.id)).map((g) => g.id),
  );
  const facs = Object.values((content.faction ?? {}) as Record<string, { id: string }>);
  drop(
    'faction',
    facs.filter((f) => !facUsed.has(f.id)).map((f) => f.id),
  );
}

// 去掉人文、国家之后（第二十九轮，remove_human、remove_countries）：它们用的、现在没用到的内容一起移出——
// 没有人文时是时代、取值、文化组、文化（和它们的地名风格）；政体、派系看还有没有国家。第三十轮起自己做的、改过的也移出
// （界面存进资源库）
export function dropBroughtContent(world: World): void {
  const small = world.small;
  if (!small.content) return;
  const content = { ...small.content };
  const drop: Drop = (kind, ids) => {
    if (!ids.length) return;
    const store = { ...((content[kind] ?? {}) as Record<string, unknown>) };
    for (const id of ids) delete store[id];
    if (Object.keys(store).length) content[kind] = store;
    else delete content[kind];
  };
  if (!small.human) {
    const ids = (kind: string) => Object.keys((content[kind] ?? {}) as Record<string, unknown>);
    drop('era', ids('era'));
    drop('popValue', ids('popValue'));
    const cultures = Object.values(contentItems<Culture>(small, 'culture'));
    drop(
      'culture',
      cultures.map((c) => c.id),
    );
    drop('cultureGroup', ids('cultureGroup'));
    dropStyles(small, content, cultures, [], drop);
  }
  dropUnusedGov(small, content, drop);
  if (Object.keys(content).length) small.content = content;
  else delete small.content;
}
