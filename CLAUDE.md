# map_2 给改代码的人（与 AI）的说明

奇幻地图生成与编辑器：TypeScript、Vite、WebGL2、Preact + signals，计算在 Worker 里。文档全是中文。
架构与文档索引见 `docs/开发说明.md`（约 130 行）；文件一两行一个的清单在 `docs/dev/*.md`；每一轮的设计在 `docs/dev/history/第N轮.md`。

## 命令

```bash
npx tsc --noEmit                 # 查类型
npx vitest run                   # 全部测试（约 1700 个，几分钟）
npm run test:fast                # 跳过最慢的几个文件
npx vitest run core/foo.test.ts  # 单个文件；机器忙时 core/sizing 的“滑块最小值命令都接受”会超时，单独重跑；整套里 `tools/realism.test.ts` 的“类地星球”、`src/ui/speed-r80.test.ts` 的“一串编辑”也常超时，这两个文件单独重跑
npm run golden                   # 只跑金标准
npm run build                    # 查类型后打包
npm run smoke                    # 打包后在无头 Chrome 里走一遍：新建、画一笔、刷新后还在、两个页面、打不开先问、计算卡住能取消、画面丢了能恢复、页面出错有自救页、进度与取消、第一次打开一键开始、重新生成前的确认、简单界面与帮助的搜索（约 10 分钟；--shots <目录> 截图；只跑一段 node tools/smoke.mjs --only 12、13 或 14；第十二段“平常画一笔不闪进度条”在机器忙时偶尔不过，重跑）
node tools/bench-median.mjs 5 --against <提交> --           # 一块地区的加工各步与旧提交对照，五次中位数（结尾的 -- 不能省：省了只测星球）
node tools/bench-median.mjs 5 --against <提交> -- --globe   # 整个星球
node tools/bench-median.mjs 5 --against <提交> -- --library # 带着一整个时代库的世界（small.content 约 300 KB）：同样的加工，另计不重算的几步（libEdit、libUndo……）
node tools/compose-ab.mjs --against <提交>   # 合成着色器在无头 Chrome 里逐字节对照（file://，不起服务器）
node tools/overlay-ab.mjs --against <提交>   # 叠加层逐字节对照
```

开发服务器由应用管着：**不要自己在 5191 / 5196 上起服务器，也不要碰 localhost:5191 / 5196**。

## 目录

- `core/` 纯计算（Node 与浏览器共用）：网格、地形、气候、水、生态、地名、省份、命令、引擎 → `docs/dev/core.md`
- `core/commands/` 各类命令（`commands.ts` 是入口并照旧导出全部）
- `core/human/` 人文：地形类别、时代文化人口、国家、城市道路地标 → `docs/dev/core-human.md`
- `core/content/` 内容种类的登记表；`core/packs/` 内置资源包（JSON 与代码）
- `core/testing/` 测试共用的世界模板（`snapshot`）
- `src/` 线程、Worker、存储；`src/state/` 主线程状态（`src/state.ts` 照旧导出）→ `docs/dev/src.md`
- `src/render/` 渲染器、着色器（`shaders/`）、2D 叠加层（`overlay*.ts`）→ `docs/dev/render.md`
- `src/ui/` 界面：`defs/` 注册表、`shell/`、`panels/`、`map/`、`tools/`、`river/`、`packs/`、`domain/` 领域逻辑、`archives/` 档案的几页、`components/` → `docs/dev/ui.md`
- `src/testing/frozen/` 冻结的旧代码参照（测试拿它与现在的比，不要改）
- `tools/` 命令行、测速、逐字节对照、一键开启 → `docs/dev/tools.md`
- `docs/` 使用说明、开发说明、更新记录；`docs/dev/` 分篇的开发文档

## 要改什么，看哪里

| 要改 | 看 |
| --- | --- |
| 新的内容种类 / 资源包的段 | `core/content/registry.ts`、`core/content/kinds.ts`（登记的先后有意义）、`core/packs.ts`；设计见 `docs/dev/history/第20轮.md`；面板上放在哪张卡片是 `src/ui/packs/page-layout.ts`，分几段是 `page-segments.ts` |
| 资源库面板 | 逻辑 `src/ui/packs/pages.ts`、`page-source.ts`、`rows.ts`（一行的状态和命令）、`page-actions.ts`（改一项就存）；组件 `LibPanel.tsx`、`PageHome.tsx`、`PageList.tsx`、`PageItem.tsx`；我的库的写入 `src/library-edit.ts`；清单见 `docs/dev/ui.md` |
| 改了什么时候用上、“改了 N 项”、“在地图上”一行 | 唯一的一张表 `src/ui/packs/timing.ts`（页面上的“即时 / 要重新生成”和 `regen.ts` 比“改过没有”共用）；上一次生成时的内容 `core/regen-base.ts`（从历史里读）、`src/regen-track.ts`、`src/ui/packs/regen-now.ts`；一项顶上的“在地图上” `on-map.ts`、`OnMapLine.tsx`；新建时先选组 `new-in.ts`；预览 `previews.ts`；设计见 `docs/dev/history/第90轮.md` |
| 添加（看库就是添加）、依赖、融入、和库的差异 | 闭包 `core/packs/closure.ts`、能不能选 `core/packs/import-gates.ts`；勾选 `src/ui/packs/pick-store.ts`（按库记、连带）、`pick-view.ts`（怎么画、点了做什么）、`pick-look.ts`（每行的状态、清单分组）、写入 `pick-add.ts`、别的库的 `pick-other.ts`；组件 `LibPanel.tsx`、`LibSide.tsx`（右栏）、`LibBasket.tsx`（清单）、`PickBox.tsx`（一行的勾）；读文件 `lib-file.ts`；引用表 `core/content/links.ts`；融入 `core/content/arrange.ts`、`src/ui/packs/page-arrange.ts`；差异 `core/packs/source-diff.ts`；清理 `core/content/cleanable.ts`、`src/ui/packs/tidy.ts` |
| 新命令、改命令 | 格式在 `core/commands/schema.ts` 的 `baseCommands`（先后不要调换），执行在对应类别的 `core/commands/<类>.ts` 的 `runXxxOp`；改人文数组的在 `core/commands.ts` 的 `touchedArrays` 登记 |
| 生成的各步 | 流水线 `core/engine-recompute.ts`（历史、预览在 `core/engine.ts`）；地形 `generate.ts` / `planet-gen.ts` / `relief.ts` / `outline.ts` / `terrain.ts`；高程 `elevation.ts`；气候 `climate.ts` / `planet-climate.ts`；水 `hydrology.ts`、`rivers.ts`；生态 `vegetation.ts`；人文 `core/human/generate.ts` |
| 着色器 | `src/render/shaders/*.ts`；CPU 的同一套式子在 `core/subcell.ts`、`core/display.ts`、`core/coast-style.ts`（测试把 GLSL 照字面换成 JS 对照）；有意改源码后 `RECORD_SHADERS=1 npx vitest run src/render/shader-sources.test.ts` |
| 地名、国名、片区名的排版 | `src/render/overlay-labels.ts`（候选位置、字号分档在 `label-place.ts`，沿水的线在 `label-lines.ts`，摘要 `RECORD_LABELS=1` 重录）、`overlay-country-labels.ts`、`src/ui/map/political.ts`；叠加层新选项要进 `overlay-base.ts` 的 `OverlayState` 与 `overlay-static.ts` 的 `FIELD_KIND` |
| 工具 | 声明在 `src/ui/defs/tools/<类>.ts`（`index.ts` 合起来），行为在 `src/ui/tools/<类>.ts`（约定见 `src/ui/tools/api.ts`），河在 `src/ui/river/` |
| 面板、底部条、顶栏 | `src/ui/panels/*.tsx`、`src/ui/shell/*.tsx`；控件只用 `src/ui/components/`；写法见 `docs/dev/ui-design.md` |
| 地图模式、底图 | `src/ui/map/modes.ts`、`src/ui/defs/layers.ts`、`src/render/colors.ts` |
| 画风 | `core/map-style.ts`、`core/packs/map-styles.ts`、`src/render/style-uniforms.ts` 的 `styleUniforms` |
| 地名风格 | `core/name-styles.ts`、`core/packs/names/*.json` |
| 资源库里找东西：首页搜索、文化的卡片、地图上点到的东西直达库里那一项、档案里直接改名字颜色 | `src/ui/packs/page-search.ts`、`page-layout.ts` 的 `WORLD_OWN_CARDS`、`open-item.ts`、`src/ui/shell/LibItemLine.tsx`、`panel-store.ts` 的 `openWorldItem`；设计见 `docs/dev/history/第92轮.md` |
| 一项的页面平时露哪些字段（常用 / 更多设置） | 字段表的 `more`（`core/content/kinds.ts`、`core/human/*-kinds.ts`）、分段 `src/ui/packs/page-segments.ts`、规则 `more-settings.ts`、要不要都摊开 `lib-prefs.ts` 的 `showAllSettings`；整张表钉在 `lib-form.test.ts` 的 `COMMON`；设计见 `docs/dev/history/第93轮.md` |
| 滑块的范围、单位（同一个数只写一处）、点数值打字 | `core/effect-ranges.ts`（字段表、生态编辑器、向导都引用）；`src/ui/components/Slider.tsx`、`slider-entry.ts`（新滑块要给 `textAt`） |
| 表单里“从现成的里面选”（不让手打英文） | 内容之间的引用写 `ref` / `keyRef`；现成的表写 `pick` / `keyPick`（引用表不看），选项在 `src/ui/packs/refs.ts`；带图的选择、新加键 `field-controls.tsx` |
| 一项页面底下的一排按钮、删除的规矩；河、湖、岛的编辑 | `src/ui/packs/pages.ts` 的 `itemActions`、`item-delete.ts`、`PageItem.tsx` 的 `Actions`；河湖岛只在资源库那一项的页面改，“⋯”里是列表（`panels/waterTypes.tsx`、`islandTypes.tsx`），规则脚本框 `packs/WaterScript.tsx` |
| 改的是哪一份、来源下拉、存到我的库 | `src/ui/packs/source-view.ts`、`lib-prefs.ts`（`showAllSources`：“完整界面”开关接这里）、`save-mine.ts`（去向、怎么存，纯函数）、`save-mine-run.ts`（写入、提示、撤销）；旧的“我的资源”在 `src/library.ts` 的 `MY_PACK_KEY` / `shownPack`；挑选时的人话 `pick-help.ts`；样式 `lib-find.css` |
| 国名、称号跟着资源库变 | 每条命令之后的重算 `core/human/retitle.ts`（`core/commands.ts` 的 `applyCommand` 调）；称号怎么挑 `core/human/government.ts` 的 `govTitles`；称号编辑器旁的示例、“换说法盖过”、“都换掉” `src/ui/packs/title-help.ts`；设计见 `docs/dev/history/第91轮.md` |
| 世界文件的格式 | `core/world.ts`；改了就把 `core/doc-version.ts` 的 `DOC_VERSION` 加一，同时改 `src/checkpoint-store.ts` 的 `CURRENT_VERSION`、测试夹具里的 `version:`、`core/raster-identity.test.ts` 的四个 `world.json`（先把版本写回旧的，核对别的一项没变） |
| 自动保存：写什么、谁写、关页面时、没存成怎么说 | 写什么 `src/autosave-io.ts`（`AutosaveWriter`：事务里先读头，`writer` / `gen`，盖掉别人的之前先留着）；谁写 `src/autosave-lock.ts`（`SaveRole`：锁 `map2-autosave`、“在这里接着做”；`stale` 是“这个页面里的是旧的”，按钮“重新载入”在 `save-note.ts` 的 `reloadSaved`）；定时、页面事件 `src/state/autosave.ts`（`flushNow`、`takeOverSaving`）；状态 `src/state/save-status.ts`；界面 `src/ui/shell/save-note.ts`、`SaveBanner.tsx`、`TopBar.tsx` 的 `SaveBadge`，文字 `src/ui/copy.ts` 的 `SAVE_TEXT`；存储够不够 `src/storage-health.ts`；测试的替身 `src/testing/fake-idb.ts`、`fake-engine-worker.ts`；改完跑 `npm run smoke`；设计见 `docs/dev/history/第94轮.md` |
| 留着的旧世界；上次的世界没能打开时的问话 | 这一版打不开的、没存完整的、被换掉之前的自动保存原样挪进 `backups` 表：规则 `src/backups.ts`（`BackupWhy`、`staleWhy`）、信号 `src/state/backups.ts`、界面 `src/ui/maps/backups.ts`、`BackupsDialog.tsx`、`src/ui/shell/BackupBanner.tsx`，文字 `BACKUP_TEXT.why`；问话 `src/state/open.ts` 的 `resumeLast`、`RESUME_FAILED`；库的表在 `src/idb.ts` |
| 出了问题时：没接住的错、自救页、“停止”、计算卡着时导出、画面丢了、报错的人话 | 怎么分 `src/mishap.ts`（`classify`、`MishapLog`、`DrawHealth`），接线 `src/crash-host.ts`（`report`、`crashHooks`），最先载入的 `src/boot.ts`；自救页 `src/rescue.ts`（只用 DOM，不要引用界面、状态）、导出从哪拿世界 `src/rescue-doc.ts`（认存储里的形状，自动保存的格式变了要跟着改）；错误边界 `src/ui/shell/Guard.tsx`，顶上的一条 `src/state/mishap.ts`、`shell/MishapBanner.tsx`；卡住时的“取消”（第 97 轮前叫“停止”） `src/stall.ts`（`STOP_AFTER_MS`）、`src/sandbox.ts` 的 `stopAny`、`src/state/worker-host.ts` 的 `stalled` / `stopBusy`；不死等计算程序 `docNow` / `docTailNow` / `idleWithin`；连着两次没打开成 `src/open-guard.ts`、`src/state/open.ts` 的 `resumeLast`；WebGL `src/render/gl-recover.ts`、`Renderer.revive`、`shell/GlNote.tsx`；报错的人话 `src/error-text.ts`（`showToast(…, true)` 里已经用了）；文字 `src/crash-text.ts`（`copy.ts` 照旧导出）；冒烟 `tools/smoke-safety.mjs`、钩子 `src/smoke-hooks.ts`；改完跑 `npm run smoke`；设计见 `docs/dev/history/第96轮.md` |
| 久的一步的进度、“取消” | 回报 `core/progress.ts` 的 `reportStage`（新加久的步骤：那一步开头说一声，`src/ui/copy.ts` 的 `PROGRESS_TEXT.steps` 写人话，`src/progress-defaults.ts` 给默认耗时——`src/progress.test.ts` 查着两张表对得上）；画多长 `src/progress.ts`，接线 `src/state/progress.ts`（`progressView`、`cancelling`）；界面 `src/ui/shell/BusyLine.tsx`、`busy-line.ts`、`components/ProgressBar.tsx`；取消 `src/state/worker-host.ts` 的 `stopBusy`（轻的 `sandbox.ts` 的 `cancelEdits`：计算程序在两步之间自己停；重的 `stopAny`：新建、打开、卡住时结束它）、`src/worker-steps.ts`、`Engine.execSteps`、`core/commands.ts` 的 `applyCommandSteps`；默认耗时重量 `node --import tsx tools/progress-weights.ts [--globe] --runs 5`；冒烟 `tools/smoke-progress.mjs`；设计见 `docs/dev/history/第97轮.md` |
| 新建向导：第一屏、“自定义…”、默认的选择 | `src/ui/Wizard.tsx`（第一屏只有缩略图）；默认值、点一张发出去的设置和命令、收着时的一行小字 `src/ui/domain/wizardChoice.ts`（`wizard-choice.test.ts` 钉着默认选择和第九十七轮逐字相同）；展开过没有 `src/ui/wizard-prefs.ts`；向导里只写和新建有关的话：`showToast(…, …, 'open')`；冒烟 `tools/smoke-start.mjs`；设计见 `docs/dev/history/第98轮.md` |
| 重新生成之前问不问、删除之前写什么 | 数 `core/regen-loss.ts`（`regenLoss`、`isRegen`、`removalCounts`；每种手改怎么认、留不留的表在第98轮）；问 `src/ui/domain/regen-ask.ts`（`execRegen`、`execRemoval`，各处的重新生成都走它，资源库里经 `packs/row-actions.ts` 的 `runTrusted`）；按钮下面“留着什么” `copy.ts` 的 `REGEN_KEEPS`；命令记录 `state.ts` 的 `commandsNow`；问话框 `choices` 里主要的按钮写第一个（`shell/Ask.tsx` 倒着画，它在最右）；改完跑 `npm run smoke` |
| 简单界面 / 完整界面：哪些算常用、藏了东西的地方怎么露、数字键 | 偏好 `src/ui/ui-prefs.ts`（`fullUi`、`restOpen`；键 `map2.lib.allSources`，`packs/lib-prefs.ts` 的两问就是它）；规则 `src/ui/defs/simple-ui.ts`（`WORLD_SIGNS`、`splitSimple`、`shownTools`）；声明里的 `more` / `when`（`defs/tools/<类>.ts`、`defs/layers.ts`、`defs/adjustments.ts`、`packs/page-layout.ts` 的 `HOME_MORE_CARDS`）；`defs/tools/index.ts` 的 `barTools` / `keyTools`（`toolsOf` 还是全部）；部件 `shell/RestLine.tsx`、`ContextBar.tsx` 的 `.bb-rest`，字 `copy.ts` 的 `SIMPLE_TEXT`；整张表钉在 `src/ui/simple-ui.test.ts`；冒烟 `tools/smoke-simple.mjs`；设计见 `docs/dev/history/第99轮.md` |
| 帮助、`?` 键 | 字 `src/ui/help-data.ts`（新加工具要给它一条 `on('…', '工具 id')`，`help.test.ts` 查着）；搜索、“现在这个工具” `help-search.ts`；组件 `Help.tsx`（搜索框不抢焦点：一打开按 `?` 要能关上）；`src/ui/shell/keys.ts` 的 `isHelpKey`；向导上的入口是 `common.tsx` 的 `ModalHead` 的 `extra` |
| 以前的版本（留哪些、记在哪一串上、回到这一份、盖掉地图之前留一份） | 规则 `src/versions.ts`（`thin`、`planDrop`、`addVersion`、`overwriteKeeping`；表 `versions` / `versionDocs`）；接线 `src/state/versions.ts`（`worldId`、`keepVersion`、`versionAfterSave`、`overwriteLinked`）；界面 `src/ui/maps/versions.ts`、`VersionsDialog.tsx`，文字 `VERSION_TEXT`；世界文件的字 `src/doc-text.ts`；设计见 `docs/dev/history/第95轮.md` |
| 存到电脑上的文件 | 规则 `src/file-save.ts`（`FileSaver`、`FileIo`、`FILE_SAVE_MS`）；接线 `src/state/file-save.ts`；界面 `src/ui/shell/save-note.ts`（`fileLine`、`pickFile`）、`SaveBanner.tsx` 的 `FileBanner`、`ActionsPanel.tsx` 的 `FileStatusLine`，文字 `FILE_TEXT`；真的选择框没法自动点，冒烟里换成浏览器自己管的文件 |
| 撤销的内存上限 | `core/undo-budget.ts`、`core/engine.ts` 的 `settleUndo` / `trimUndo`（`core/engine.ts` 约 760 行，再加要拆；一步之后的整理已在 `core/engine-fixes.ts`）；界面 `UNDO_LIMIT_TEXT`；量：`node --expose-gc --import tsx tools/undo-bytes.ts [--globe] [--human]` |
| 浏览器里的库加一张表 | `src/idb.ts` 的 `DB_VERSION` / `DB_STORES`，同时改写着版本号的三个测试（`src/backups.test.ts`、`src/library.test.ts`、`src/state/autosave-backups.test.ts`） |
| 主线程与 Worker 的消息 | `src/protocol.ts`、`src/worker.ts`、`src/state/worker-host.ts`（`src/state.ts` 照旧导出，界面从它引用） |
| 用户看得到的说明 | `docs/使用说明.md`、`src/ui/Help.tsx`、`src/ui/copy.ts` |

## 规矩

- **结果逐值不变**：提速、重构后金标准（`core/golden*.json`、`*digests*.json`、`shader-hashes.json`）一个都不重录；每项提速另加“新旧逐位相同”的测试。
- **不能变慢**：编辑不能变慢，`node tools/bench-median.mjs 5 --against <上一个提交> --`（区域）和 `-- --globe`（星球）任何一步超过 +5% 要压回去；噪音大时先拿同一提交对照自己看宽度；画法的改动跑 `compose-ab` / `overlay-ab`，0 字节不同。
- **旧存档不必兼容**：世界格式变了就把 `DOC_VERSION` 加一，代码里不留旧存档的写法。
- **计算 Worker 不打包内置数据**：内置的包只在主线程（`src/worker-imports.test.ts` 查着）。
- **文件不要太大**：往一个文件里加代码时控制在约 800 行以内，超过就按职责拆（原样搬、照旧导出）。
- **冻结的参照不要改**：`src/testing/frozen/`、测试里标着“不要改它”的原样拷贝。
- **计算程序主动发的消息不带 `id`**：带 `id` 的只有回复（`src/sandbox.ts` 的 `readWorkerMessage` 按它认）；进度的那一条用 `req`。
- **界面只经 `src/state.ts` 引用状态**：`src/ui/` 里不直接引用 `src/state/*.ts`（`src/ui/layering.test.ts` 查着）。
- **新加的东西先想算不算常用**：新加工具、底图、“调整”的项、资源库的卡片时在声明里写不写 `more`（每一类常用的工具不超过三个）；藏了东西的地方只用“还有 N 个”在原地展开这一种做法。
- 用户是新手：结果要可以预料，界面像 Procreate，控件是连续的（滑块），文字的规矩见 `docs/dev/ui-design.md`。

## 文档

每一轮：
- 新写 `docs/dev/history/第N轮.md`（这一轮的设计、取舍、量到的数）；
- 只改动到的那几篇 `docs/dev/*.md`（每个文件一两行）；架构变了才改 `docs/开发说明.md`；
- `docs/更新记录.md` 加一条短的（15 行以内，新的在前）；`README.md` 里的测试个数跟着改；用法变了改 `docs/使用说明.md`。

## 提交

- 标题不超过 80 个字符，以“第N轮：”开头（例：`第四十一轮：命令按类别拆到 core/commands/`）；细节写在正文里，一行一条的短条目；
- 最后空一行，写 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`；
- 可以分几个提交；不要推送，除非用户要。
- **不要用不带参数的 `git stash` / `git stash pop`**（几个工作树共用一个 stash 栈）：要暂存就做一个临时的提交。

## 搜索

根目录的 `.ignore` 让 ripgrep 跳过 `dist/`、`src/ui/__snapshots__/`、`tools/bench-baseline/`、`src/testing/frozen/`；`docs/dev/history/` 很大，按需打开。
