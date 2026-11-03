import { contentItems } from '../content/registry';
import { styleInUse } from '../name-styles';
import type { World } from '../world';
import { type Culture, type CultureGroup, styleOfCulture, worldEra } from './era';
import { eraFactions } from './government';

// 删掉人文、国家时带进来的内容一起移出（第二十九轮，remove_human、remove_countries）。
// 生成之后不再移出没用到的（第五十轮：世界保留全部内容，要清理时走整理 core/tidy.ts）。

type Drop = (kind: string, ids: readonly string[]) => void;
type Content = NonNullable<World['small']['content']>;

// 去掉的文化用的、别处都没用到的地名风格
// （第四十三轮：文化没写风格时用文化组的；去掉的文化组写的默认风格也算，按移出之前的世界查）
function dropStyles(small: World['small'], content: Content, gone: readonly Culture[], drop: Drop, goneGroups: readonly CultureGroup[]) {
  const styleIds = new Set<string>();
  for (const c of gone) {
    const id = styleOfCulture(small, c);
    if (id) styleIds.add(id);
  }
  for (const g of goneGroups) if (g.nameStyle) styleIds.add(g.nameStyle);
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

// 去掉人文、国家之后：它们用的、现在没用到的内容一起移出——没有人文时是时代、取值、文化组、文化（和它们的地名风格）；
// 政体、派系看还有没有国家。第三十轮起自己做的、改过的也移出（界面存进资源库）
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
    drop('valueGroup', ids('valueGroup'));
    const groups = Object.values(contentItems<CultureGroup>(small, 'cultureGroup'));
    drop('cultureGroup', ids('cultureGroup'));
    dropStyles(small, content, cultures, drop, groups);
  }
  dropUnusedGov(small, content, drop);
  if (Object.keys(content).length) small.content = content;
  else delete small.content;
}
