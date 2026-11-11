import type { Command } from '../../../core/commands';
import type { UsageWorld } from '../../../core/content/registry';
import type { UsedBy } from './page-used-by';
import { type ItemRow, removeBatch, rowUsage } from './rows';

// 删除一项怎么办（第九十三轮）：每一种内容、这张地图和我的库都按同一套规矩（以前通用页“在用的不能删”只写在悬停里，
// 生态页不管用没用都问一句，“详细编辑”里河湖岛直接删，我的库每次都问）。规矩照 docs/dev/ui-design.md：能撤销的不问第二遍；
// 被用到时说清楚谁用到它、删了会怎样。
//
//   没人用到                         直接删（一步，能撤销）
//   别的内容写到了它                 问一次：谁写到了它；删了以后那几处不会跟着改
//   地图上用着、删了地图会变的       问一次：用在哪里；删了会怎样（生态、河、湖、岛：引擎让删，用到它的地方换成别的。
//                                    自己长出来的也算——“谁用到它”里地图的那一行，page-used-by.ts 的 mapPlaces）
//   地图上用着、引擎不让删的         不能删：写清楚用在哪里、先做什么（放在 small.content 里的种类，引擎的 set_content 查同一个钩子）
//
// 不碰界面，测试直接调

export type DeleteVerdict =
  | { t: 'go'; cmd: Command | null }
  | { t: 'ask'; cmd: Command | null; title: string; text: string }
  | { t: 'blocked'; why: string };

// 地图上用着时也删得掉的几种：删了以后用到它的地方怎么样
const AFTER: Readonly<Record<string, string>> = {
  biome: '长它的地方会换成别的生态',
  riverType: '这种河会变回普通的河',
  lakeType: '这种湖会变回普通的湖',
  islandType: '已放的这种岛会变成大陆岛',
};

const UNDO = '可以撤销。';

// 谁写到了它：“政体 封建君主制、部落 等 3 项”
export function referrersText(u: Pick<UsedBy, 'groups'>): string {
  const rows = u.groups.flatMap((g) => g.rows.map((r) => `${g.title}“${r.name}”`));
  if (!rows.length) return '';
  const head = rows.slice(0, 3).join('、');
  return rows.length > 3 ? `${head} 等 ${rows.length} 项` : head;
}

const refsLine = (u: Pick<UsedBy, 'groups'>): string => {
  const who = referrersText(u);
  return who ? `${who}写到了它，删了以后那几处不会跟着改。` : '';
};

type Used = Pick<UsedBy, 'groups'> & Partial<Pick<UsedBy, 'places'>>;

// 这张地图里的一项。cmd 是删它的那一步（世界默认的地名风格、在用的画风一起换掉，见 rows.ts 的 removeBatch）；动不了的 null
export function worldDelete(row: ItemRow, world: UsageWorld, usedBy: Used): DeleteVerdict | null {
  if (!row.status.on || row.status.locked) return null;
  const cmd = removeBatch(row, world);
  const usage = rowUsage(row, world);
  const title = `删除“${row.name}”`;
  const after = AFTER[row.kind.id];
  if (after) {
    // 删得掉的几种：地图上有它（涂的、选了它的、自己长出来的）就问一次
    const where = usedBy.places ?? (usage ? usage.label : null);
    if (where) return { t: 'ask', cmd, title, text: `地图上${where}。删了以后${after}。${refsLine(usedBy)}${UNDO}` };
  } else if (usage) {
    return { t: 'blocked', why: `地图上有 ${usage.count.toLocaleString('en-US')} 处用到它（${usage.label}），先把用到它的地方改掉` };
  }
  const refs = refsLine(usedBy);
  return refs ? { t: 'ask', cmd, title, text: `${refs}${UNDO}` } : { t: 'go', cmd };
}

// 我的库里的一项（删它走这个库自己的撤销，没有命令）
export function libraryDelete(name: string, usedBy: Used): DeleteVerdict {
  const refs = refsLine(usedBy);
  return refs ? { t: 'ask', cmd: null, title: `删除“${name}”`, text: `${refs}${UNDO}` } : { t: 'go', cmd: null };
}
