# src/：线程与存储

界面的入口、Worker 与存储。画地图在 [render.md](render.md)，界面在 [ui.md](ui.md)。线程怎样分工见 [开发说明 · 线程与隔离](../开发说明.md#线程与隔离)。

## 线程
- `main.tsx` 入口（第一次画界面前 `startToolEffects`）；`state.ts` 主线程状态（世界的只读视图、界面状态、排队的请求、快照合并；不引用 `ui/`）；`notice-timer.ts` 提示条多久消失；`biome-range.ts` 生态范围外怎么说（第六十九轮从 `ui/` 搬来）
- `protocol.ts` 主线程与计算 Worker 之间的消息；`transfer.ts` 搬数据不复制
- `worker.ts` 计算 Worker（持有引擎；快照、描好的河、空闲预热）
- `regen-track.ts` 上一次生成时世界里的内容，跟着撤销的先后记（第六十二轮，面板顶上的“重新生成”）
- `content-post.ts` 快照里的 `small.content` 没换时不发，主线程补上手上那一份（第四十七轮）；人口群体 `small.popGroups` 同样（第五十四轮）
- `engine-spawn.ts`、`engine-source.ts`、`isolation-probe.ts` 开计算 Worker 与隔离（data: 地址，Worker 里不打包内置数据）
- `sandbox.ts` Worker 的看护（看门狗、恢复、安全模式）
- `storage-worker.ts` + `checkpoint-store.ts` 存储 Worker 与检查点（经 MessageChannel，不过主线程）
- `mesh-worker.ts` 建网格；`export-worker.ts` 导出（游戏文件包、整张地图的栅格化）；`compact-job.ts` 压缩世界文件（在导出 Worker 里）

## 存储
- `idb.ts` IndexedDB（自动保存、检查点、网格、参考图、资源库、我的地图）
- `maps.ts` 我的地图（存、盖掉、改名、删掉，连着哪一张）
- `library.ts` 资源库（内置的树、我的资源、“来自《世界名》”、导入的；`saveItem`、`keepInLibrary`；第五十九轮：包带版本 `rev`，同一版不再 `parsePack`）
- `library-edit.ts` 改我的库（第五十九轮；第六十轮加 `setArrange` 换融入的安排、`applyItems` 几项一步；第六十一轮加 `setPack` 导入时整个换掉，一步撤销，先 `parsePack`）：`setItem` 只查这一项、只换到树根的路、写日志（localStorage），整个库晚一点才写（`FLUSH_MS`、关面板、切换库）；自己的撤销；`adopt` 读存储时补上日志；`copyLibrary`、`createLibrary`、`deleteLibrary`
- `trust.ts` 信任过的脚本（按源码的 SHA-256；问话的一句 `scriptTrustText`）
- `testing/imports.ts` 测试用：读运行时的引用（`worker-imports.test.ts`、`ui/layering.test.ts`）
- `styles.css` 全部样式
