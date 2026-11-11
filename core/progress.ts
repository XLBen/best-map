// 久的步骤回报到哪一步了（第九十七轮）：流水线（engine-recompute.ts）、生成人文（human/generate.ts）、造陆地、划省份、
// 建城市在每一步开头说一声“现在是第 k 步，共 n 步，叫什么”。和脚本的看门狗（script.ts 的 setScriptHost）一样是进程里的一个钩子：
// 计算 Worker 里接到主线程（src/worker.ts），别处（测试、命令行、预览用的副本）不接，那时这里只是一次判空。
//
// 只在步的边界上说（一次重算六七条、一次生成人文八九条），不在循环里说；只说，不改任何计算——接不接、说不说，
// 结果逐位相同（core/progress.test.ts 查着）。
//
// 步的名字（界面上翻成人话，src/ui/copy.ts 的 PROGRESS_TEXT）：
//   terrain（造陆地和海）、elevation、climate、water（水文、河的类型、植被的第一遍）、solve（涂上去的生态）、
//   habitat（人文的几层）、features（认地物、起名）；
//   human.<生成人文的一步>（cultures、population、countries、claims、blocs、capitals、country-mix）、settlements、provinces
export type StageSink = (step: string, k: number, n: number) => void;

let sink: StageSink | null = null;

export function setStageSink(s: StageSink | null): void {
  sink = s;
}

// 现在是第 k 步（从 1 起），这一串共 n 步
export function reportStage(step: string, k: number, n: number): void {
  if (sink) sink(step, k, n);
}

// 一口气走完分阶段的计算（第八十三轮起在 engine-helpers.ts，第九十七轮挪到这里：生成人文、命令也分阶段了，它们不该引用引擎的小工具）
export function drain<R>(it: Generator<void, R>): R {
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}
