// 进度条默认的各步耗时（第九十七轮）：这一类请求还没有“上一次真实的耗时”时用（见 progress.ts）。
// 出处：node --import tsx tools/progress-weights.ts --runs 5（一块地区 4 万格）和 --globe --runs 5（整个星球，类地 6.26 万格）：
// 照新建向导的顺序新建一个带人文的世界，各开一个进程跑五次，取每一步的中位数。这台开发机（Apple M2）上 Node 里量的，毫秒，
// 量的时候机器不闲（同一步五次之间差到一倍）。只用它们之间的比例（各步占多少），不当成“要几秒”显示给用户；
// 别的格数按格数折算（progress.ts 的 defaultMs）。浏览器里、别的机器上绝对值不一样，比例差得不多；
// 做过一次以后就用那一次真实的了。改了流水线、生成人文的步骤以后重跑上面两条命令，把打出来的表贴到这里。
// 标着“没量”的四项那个工具量不到，是估的。
//
// [一块地区, 整个星球]
export const REF_CELLS = { region: 40000, globe: 62600 } as const;
export const DEFAULT_STEP_MS: Readonly<Record<string, readonly [number, number]>> = {
  // 建网格（计算程序里的；主线程另建一份，算在 show 里）
  mesh: [286, 325],
  // 造陆地和海（连同先加进世界的内容）
  terrain: [681, 1174],
  elevation: [279, 459],
  climate: [315, 611],
  // 水文、河的类型、植被（第一遍；连同修湖底、查冲突）
  water: [111, 173],
  habitat: [29, 48],
  features: [149, 266],
  'human.cultures': [141, 271],
  'human.population': [100, 151],
  'human.countries': [131, 202],
  'human.claims': [10, 19],
  'human.blocs': [3, 4],
  'human.capitals': [16, 21],
  'human.country-mix': [21, 35],
  // 城市、道路、地标（连同之后重算人文的几层、起名）
  settlements: [201, 359],
  provinces: [101, 148],
  // 没量：涂上去要“自然融入”的生态，每一轮是一遍水文与植被，最多两轮——按 water 的两倍
  solve: [222, 346],
  // 没量：从检查点恢复（不重算，主要是对齐命令）——按建网格的一半
  restore: [143, 163],
  // 没量：重放命令不靠这个数，按数出来的快慢算（这里只是还没数出第一条时的占位）
  replay: [500, 1000],
  // 没量：回复到了以后主线程换上快照、等自己的网格、画第一帧——按建网格那么久
  show: [286, 325],
};
