import { CommandError } from './errors';

// 世界文件的版本。第九轮起是 5，不再兼容以前的存档（命令的含义、默认值都改过：山挡风默认打开、
// 画的河都只挖河床、湖和岛链的最小值……）。第三十轮是 6：新世界不再自带生态、基础内容（命令里从资源包加进来），
// 生成人文的命令带资源包（packs）而不是时代 id，旧文件重放出来不一样，打不开。第三十二轮是 7：地形有了大格局
// （大陆倾斜、高原、洼地、长河，重画一片不挪海平面），同样的命令重放出来的地形不一样。第三十三轮是 8：有了冲积平原、
// 冲积扇、三角洲平原，高程不一样。第三十四轮是 9：冰川刮出的湖群改了高程、海岸有了峡湾、沙坝等类型。第三十五轮是 10：大陆块会裂开漂移、
// 有三角形的半岛与地峡，海陆就不一样了。第四十三轮是 11：内置的文化、宗教、政体换成 EU4 的（id 都换了，政体的称号按国家等级），
// 旧文件里加内容、生成人文的命令重放出来不一样。第五十轮是 12：生成后不再移出没用到的内容，重放出来世界里的内容不一样
// （第四十九轮的 originId、fromId 也从这一版算起）。第五十三轮是 13：政体列派系（factions），派系的 base 换成 amount，旧文件里加内容的命令过不了格式。
// 第七十三轮是 14：时代的国家关系换成国家格局（patterns），旧文件里加时代的命令过不了格式。
// 第七十四轮是 15：长国家时用时代的民族主义、从属多了殖民地，旧文件里生成国家的命令重放出来国家不一样。
// 第七十五轮是 16：奇幻、科幻的国家有了种族王国、殖民据点，从属多了公司领地（set_country 的格式），档案多了格局里的角色（role）。
// 第七十七轮是 17：生成人文、国家的命令不再写权重、“分裂 ↔ 统一”、格局、总人口（格式变了），去掉了格局这种内容。
// 第七十八轮是 18：省份划分的规则成了资源库里的内容（provinceRules），划分省份的命令只写种子、去掉了“只整理湖”（set_lake_mode）（格式变了）。
// 单独放一个小文件：主线程打开文件、读自动保存时也要查，不必引进整个引擎
export const DOC_VERSION = 18;
export const OLD_DOC_ERROR = '旧版本的世界文件打不开';

// 打开前先查：不是世界文件、是旧版本的世界时报错（不去重放）
export function checkDoc(doc: unknown) {
  const d = doc !== null && typeof doc === 'object' ? (doc as { format?: unknown; version?: unknown }) : {};
  if (d.format !== 'map2-world') throw new CommandError('不是 map2 世界文件');
  if (d.version !== DOC_VERSION) throw new CommandError(OLD_DOC_ERROR);
}

// 同上，不抛错：是当前版本的世界文件时为 true
export function isCurrentDoc(doc: unknown): boolean {
  try {
    checkDoc(doc);
    return true;
  } catch {
    return false;
  }
}
