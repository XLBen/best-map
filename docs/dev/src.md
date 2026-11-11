# src/：线程与存储

界面的入口、Worker 与存储。画地图在 [render.md](render.md)，界面在 [ui.md](ui.md)。线程怎样分工见 [开发说明 · 线程与隔离](../开发说明.md#线程与隔离)。

## 线程
- `main.tsx` 入口（第一次画界面前 `startToolEffects`）；`state.ts` 只给界面用的信号（地图模式、季节、开着的面板、悬停……）、脚本出错的“编辑”，并把 `state/` 下给界面用的照旧导出（界面只从它引用；不引用 `ui/`）
- `state/`（第七十轮从 `state.ts` 分出来，原样搬，彼此不绕成圈）：`world.ts` 世界与选中的东西（快照换上时一起改的信号）；`notes.ts` 提示、跳过的步骤、“改了什么”与高亮（`describeChange`）；`options.ts` 工具的选项；`prefs.ts` 偏好（localStorage）与参考图（IndexedDB）
- `state/worker-host.ts` 开计算 Worker、请求排队（`call`、`editsIdle`）、换上快照（`applySnapshot`）、缩略图、页面隐藏时写检查点；上层的预览作废、自动保存经 `hostHooks` 接回来；`snapshot-merge.ts` 把只带变了的快照拼到手上的世界上（`mergeSnapshot`、轻快照 `lightWorld`，第八十轮搬出来）；`mesh.ts` 网格的缓存与建网格的 Worker；`cost-gate.ts` 成本闸门
- `state/edits.ts` 执行、换掉最后一步、撤销、重做；`exact-preview.ts` 地形预览、命令预览、省份的轻预览、确切预览与调整面板的预览；`open.ts` 新建、打开、继续上次的世界（第九十四轮：没能打开时停在问话上 `RESUME_FAILED`，`openDoc` 另说是取消了还是没能打开）、“再试一次”；`script-trust.ts` 问要不要信任脚本；`ask.ts` 问一句的对话框
- `state/autosave.ts` 自动保存（IndexedDB，退回 localStorage）与连着的“我的地图”（第九十一轮：读、写之前先等 `keepStaleOnce`；后备的位置上压着没能挪走的旧世界时不盖它；第九十四轮：只剩定时、信号、接到 Worker 和页面事件上——写什么、谁写在 `autosave-io.ts`、`autosave-lock.ts`；`takeOverSaving`“在这里接着做”、`flushNow` 关页面的那一下同步写、`noteResumed` / `noteNotResumed`、页面隐藏和 `pagehide` 时马上写、有没存的改动才挂 `beforeunload`、测试换存取的 `useAutosaveIo`）；`state/save-status.ts`（第九十四轮）保存状态的信号 `saveFail`、`saveRole`、`savedState`、`storageTight`、`saveProblem`、`unsaved` 与纯函数 `failWhy`、`saveProblemOf`、`hasUnsaved`；`state/backups.ts`（第九十一轮）留着的旧世界的信号 `backups`、这一次打开页面只挪一次的 `keepStaleOnce`、`deleteBackup`、`dismissBackups`、测试换存取的 `useBackupIo`；`export-host.ts` 导出 Worker、下载；`tidy.ts` 移出的存进资源库、整理的计划、压缩世界文件
- `notice-timer.ts` 提示条多久消失；`biome-range.ts` 生态范围外怎么说（第六十九轮从 `ui/` 搬来）
- `protocol.ts` 主线程与计算 Worker 之间的消息（第九十轮：新建、打开、撤销、重做的回复带 `regen`——上一次生成时的内容里和现在不一样的项；执行的回复不带）；`transfer.ts` 搬数据不复制
- `worker.ts` 计算 Worker（持有引擎；快照、描好的河、空闲预热）；`worker-snapshot.ts` 快照（`SnapshotSender`，第八十轮搬出来）：推导数组、原因数组（第八十轮）、地物、河都只发与上一次发的不同的，主线程沿用手上的同一个对象
- `regen-track.ts` 上一次生成时世界里的内容，跟着撤销的先后记（第六十二轮，资源库面板的“重新生成”；第八十一轮加省份 `provinces`，`hand` 记上次生成之后手改过的国家、省份；第九十轮：新建、打开时用引擎从命令记录里算的那一份起头（`reset` 的第三个参数，`Response.regen`，`worker-host.ts` 的 `applySnapshot` 拼回来），撤销到这次打开页面之前的位置时也用引擎给的；规则 `scopesOf`、`handOf` 搬到 `core/regen-base.ts`）
- `content-post.ts` 快照里的 `small.content` 没换时不发，主线程补上手上那一份（第四十七轮）；人口群体 `small.popGroups` 同样（第五十四轮）；第八十轮：小数据的其余各段按 JSON 比、国家一国一国比，没变的不发（`sameSmall`、`sameCountries`，要主线程用上了上一份才拼得起来）；第八十五轮：国家的档案 `small.archive` 按对象比（不可变，不序列化）
- `engine-spawn.ts`、`engine-source.ts`、`isolation-probe.ts` 开计算 Worker 与隔离（data: 地址，Worker 里不打包内置数据）
- `sandbox.ts` Worker 的看护（看门狗、恢复、安全模式）
- `storage-worker.ts` + `checkpoint-store.ts` 存储 Worker 与检查点（经 MessageChannel，不过主线程）
- `mesh-worker.ts` 建网格；`export-worker.ts` 导出（游戏文件包、整张地图的栅格化）；`compact-job.ts` 压缩世界文件（在导出 Worker 里）

## 存储
- `backups.ts`（第九十一轮，见 [第91轮](history/第91轮.md)）留着的旧世界：这一版打不开的自动保存（旧版本的、更新的版本做的；第九十四轮加这一版的但没存完整的 `damaged` / `staleWhy`，和写自动保存那一边盖掉之前挪进来的几种 `BackupWhy`；自动保存的头怎么拆 `splitHead`）启动时原样挪进 `backups` 表（`keepStaleAutosaves`：IndexedDB 的一个事务里挪，localStorage 后备的放进表或换一个键），`listBackups`、`removeBackup`、`markSeen`、导出的字 `backupFileText`、文件名 `backupFileName`；存取经 `BackupIo`（浏览器的 `browserBackupIo`、测试的 `memoryBackupIo`）
- `autosave-io.ts`（第九十四轮，见 [第94轮](history/第94轮.md)）自动保存写什么：头里记谁写的（`writer`）、第几代（`gen`），每次写在同一个事务里先读头——是自己上一次写的那一代才按下标只写变了的，不是就整份重写（有写的权利时）或不写；整份重写盖掉别人写的那一份之前，不是自己打开的那一份、也不是自己世界的开头（`continues`）就先原样挪进留着的旧世界；`AutosaveWriter`（`write`、关页面时不读头的 `blind`、`claim`、`canPromote`）；存取经 `AutosaveIo`（浏览器的 `browserAutosaveIo`：留着一个开着的连接给关页面那一下用；测试的 `memoryAutosaveIo` + `MemoryDisk`）
- `autosave-lock.ts`（第九十四轮）哪个页面写自动保存：`SaveRole`（`navigator.locks` 的 `map2-autosave`，拿到的写；`take` 抢过来并在 `BroadcastChannel` 上说一声；写的那一页关了、能接才接）；锁和频道经 `LockIo`（`browserLockIo`、测试的 `memoryLocks`）；没有锁的环境 `lock` 为 null，靠头里的核对
- `storage-health.ts`（第九十四轮）申请“持久”的存储只申请一次（结果记在 localStorage 的 `map2.persist`）、用掉九成以上算快满了
- `idb.ts` IndexedDB（第九十一轮是第 7 版，多一张 `backups` 表；自动保存、检查点、网格、参考图、资源库、我的地图；`kvRequest` kv 表上的一个请求）
- `maps.ts` 我的地图（存、盖掉、改名、删掉，连着哪一张）；`library-edit.ts` 第九十一轮加 `setItems`（一次改几项，一步撤销：把各政体里的一个称号都换掉）
- `library.ts` 资源库（内置的树、我的库、“来自《世界名》”、加进来的；`saveItem`、`keepInLibrary`；第五十九轮：包带版本 `rev`，同一版不再 `parsePack`；第九十二轮：以前叫“我的资源”的那个包键没变 `MY_PACK_KEY`，新建时叫“我的星球形态”，还叫旧名字的读出来显示成“以前存的内容” `shownPack`；世界里的内容不再存进它——存到我的库在 `ui/packs/save-mine.ts`，`saveItem` 只剩星球形态编辑器在用）
- `library-edit.ts` 改我的库（第九十四轮：整个库没写进存储时留着“没写”的记号和日志、说一次 `libStoreFail`、过 `FLUSH_RETRY_MS` 再试；第五十九轮；第六十轮加 `setArrange` 换融入的安排、`applyItems` 几项一步；第六十一轮加 `setPack` 导入时整个换掉，一步撤销，先 `parsePack`）：`setItem` 只查这一项、只换到树根的路、写日志（localStorage），整个库晚一点才写（`FLUSH_MS`、关面板、切换库）；自己的撤销（第八十一轮 `undoLabel`、`redoLabel`：顶栏悬停写哪一步）；`adopt` 读存储时补上日志；`copyLibrary`、`createLibrary`、`deleteLibrary`
- `trust.ts` 信任过的脚本（按源码的 SHA-256；问话的一句 `scriptTrustText`）
- `testing/imports.ts` 测试用：读运行时的引用（`worker-imports.test.ts`、`ui/layering.test.ts`）；`testing/fake-idb.ts` 假的 IndexedDB（第九十四轮从 `autosave-backups.test.ts` 搬出来，加了按范围删、存储满了）；`testing/fake-engine-worker.ts` 带命令记录的假计算 Worker（第九十四轮：自动保存、继续上次的世界的测试）
- `styles.css` 全部样式
