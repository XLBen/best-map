// 缺了内容跳过的步骤（第三十轮界面）：生成、新建的结果里带的说明（core/content/missing.ts，“没有城市等级：没有放城市和道路”），
// 顶上说一次，带“从资源库添加…”：缺的只有一种时资源库筛成那一种，只列不在本世界的。不碰界面，测试直接调

// 说明里“没有 X”的 X → 内容的种类（登记表里的 id）
const KINDS: readonly [string, string][] = [
  ['生态', 'biome'],
  ['地形类别', 'terrainClass'],
  ['资源', 'resource'],
  ['岛的种类', 'islandType'],
  ['地名风格', 'nameStyle'],
  ['时代', 'era'],
  ['文化', 'culture'],
  ['政体', 'government'],
  ['派系', 'faction'],
  ['城市等级', 'cityRank'],
  ['地标类型', 'landmarkType'],
];

// 一条说明缺的是哪一种（认不出时 undefined）
export function skippedKind(note: string): string | undefined {
  const m = /^没有([^：:，,（(]+)/.exec(note);
  return m ? KINDS.find(([w]) => w === m[1].trim())?.[1] : undefined;
}

// 几条说明合起来：顶上的一句、资源库筛哪一种（几种时是全部）
export function skippedSummary(notes: readonly string[]): { head: string; kind: string } {
  const kinds = [...new Set(notes.map(skippedKind).filter((k): k is string => !!k))];
  const head = notes.length === 1 ? `跳过了一步：${notes[0]}` : `缺了内容，跳过了 ${notes.length} 步`;
  return { head, kind: kinds.length === 1 ? kinds[0] : 'all' };
}
