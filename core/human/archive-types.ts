// 国家的档案（第八十五轮）的类型：统治者、家族、备注、大事。从 world.ts 分出来（world.ts 照旧导出）

// 国家的档案里自己写的与生成的统治者、家族、大事（第八十五轮，见 human/rulers.ts、human/events.ts）。
// 都放在 small.archive：不可变的，改了就整个换成新对象（small-copy.ts 按引用共用，别的命令不用每步序列化它）
export interface RulerMeta {
  // 这一国里的编号
  id: number;
  name: string;
  orig?: string;
  // 称号（国王、可汗……）。生成的、没手改过的跟着资源库里政体的统治者称号变（第九十一轮，见 human/retitle.ts）
  title?: string;
  // 自己改过称号（set_ruler 写了称号、add_ruler 写的称号和政体给的不一样）：资源库、政体变了也不动；把称号改成空的就恢复自动
  titleLocked?: true;
  // 在位的年份；to 省略是还在位
  from: number;
  to?: number;
  // 家族（这一国的 dynasties 里的编号）、父母（这一国的另一位统治者）
  dynasty?: number;
  parent?: number;
  note?: string;
}
export interface DynastyMeta {
  id: number;
  name: string;
  orig?: string;
  // 开创者（这一国的一位统治者）
  founder?: number;
}
export interface CountryLore {
  // 自己写的备注
  note?: string;
  // 先后（最早的在前；最后一位是现在的统治者）
  rulers: RulerMeta[];
  dynasties: DynastyMeta[];
  // 统治者、家族自己改过：重新生成时留着这份名单（见 human/archive-keep.ts）
  edited?: true;
}
// 一件大事：属于 countries 里的每一国（存一份，几国的年表里都有）
export interface HistoryEvent {
  id: number;
  year: number;
  title: string;
  note?: string;
  countries: number[];
  // 生成的（结盟、开战、成为附庸）；自己加的、改过的没有这一项
  auto?: true;
}
export interface ArchiveState {
  // 国家的编号 → 备注、统治者、家族
  countries: Record<string, CountryLore>;
  // 编号 → 大事；下一个编号
  events: Record<string, HistoryEvent>;
  nextEvent: number;
}

