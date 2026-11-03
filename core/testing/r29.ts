import saved from '../human/r29-digests.json';

// r29-digests.json（核对“同一个库、同样的选择，生成的结果不变”）。第五十一轮没有重录这个文件，只有一处例外，单独记在这里：
// 奇幻库现在自带 5 种奇幻资源（秘银、魔晶……，以前要单独勾“奇幻 ▸ 资源”），生成时它们在世界里，资源层多了它们，
// 所以 fantasy、fantasy:again 的 resource 这一项不一样，这两个键别的 13 项逐值相同。
// 把这 5 种移出世界再生成时，14 项都和文件里的相同（era-packs.test 查着）。下次重录（R29_RECORD，第五十五轮有意改结果）时去掉这里
export const R51_FANTASY_RESOURCE = 'f5d1d381e5a325fd';

export function r29Digest(key: string): Record<string, string> {
  const d = (saved as Record<string, Record<string, string>>)[key];
  return key === 'fantasy' || key === 'fantasy:again' ? { ...d, resource: R51_FANTASY_RESOURCE } : d;
}
