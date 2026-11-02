# map_2 给改代码的人（与 AI）的说明

奇幻地图生成与编辑器：TypeScript、Vite、WebGL2、Preact + signals，计算在 Worker 里。文档全是中文。
架构与文档索引见 `docs/开发说明.md`（约 130 行）；文件一两行一个的清单在 `docs/dev/*.md`；每一轮的设计在 `docs/dev/history/第N轮.md`。

## 命令

```bash
npx tsc --noEmit                 # 查类型
npx vitest run                   # 全部测试（约 1700 个，几分钟）
npm run test:fast                # 跳过最慢的几个文件
npx vitest run core/foo.test.ts  # 单个文件；机器忙时 core/sizing 的“滑块最小值命令都接受”会超时，单独重跑
npm run golden                   # 只跑金标准
npm run build                    # 查类型后打包
node tools/bench-median.mjs 5 --against <提交> --           # 一块地区的加工各步与旧提交对照，五次中位数（结尾的 -- 不能省：省了只测星球）
node tools/bench-median.mjs 5 --against <提交> -- --globe   # 整个星球
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
- `src/` 线程、Worker、存储 → `docs/dev/src.md`
- `src/render/` 渲染器、着色器（`shaders/`）、2D 叠加层（`overlay*.ts`）→ `docs/dev/render.md`
- `src/ui/` 界面：`defs/` 注册表、`shell/`、`panels/`、`map/`、`tools/`、`river/`、`packs/`、`components/` → `docs/dev/ui.md`
- `src/testing/frozen/` 冻结的旧代码参照（测试拿它与现在的比，不要改）
- `tools/` 命令行、测速、逐字节对照、一键开启 → `docs/dev/tools.md`
- `docs/` 使用说明、开发说明、更新记录；`docs/dev/` 分篇的开发文档

## 要改什么，看哪里

| 要改 | 看 |
| --- | --- |
| 新的内容种类 / 资源包的段 | `core/content/registry.ts`、`core/content/kinds.ts`（登记的先后有意义）、`core/packs.ts`；设计见 `docs/dev/history/第20轮.md` |
| 新命令、改命令 | 格式在 `core/commands/schema.ts` 的 `baseCommands`（先后不要调换），执行在对应类别的 `core/commands/<类>.ts` 的 `runXxxOp`；改人文数组的在 `core/commands.ts` 的 `touchedArrays` 登记 |
| 生成的各步 | 流水线 `core/engine.ts`；地形 `generate.ts` / `planet-gen.ts` / `relief.ts` / `outline.ts` / `terrain.ts`；高程 `elevation.ts`；气候 `climate.ts` / `planet-climate.ts`；水 `hydrology.ts`、`rivers.ts`；生态 `vegetation.ts`；人文 `core/human/generate.ts` |
| 着色器 | `src/render/shaders/*.ts`；CPU 的同一套式子在 `core/subcell.ts`、`core/display.ts`、`core/coast-style.ts`（测试把 GLSL 照字面换成 JS 对照）；有意改源码后 `RECORD_SHADERS=1 npx vitest run src/render/shader-sources.test.ts` |
| 地名、国名、片区名的排版 | `src/render/overlay-labels.ts`、`overlay-country-labels.ts`、`src/ui/map/political.ts`；叠加层新选项要进 `overlay-base.ts` 的 `OverlayState` 与 `overlay-static.ts` 的 `FIELD_KIND` |
| 工具 | 声明在 `src/ui/defs/tools.ts`，行为在 `src/ui/tools/<类>.ts`（约定见 `src/ui/tools/api.ts`），河在 `src/ui/river/` |
| 面板、底部条、顶栏 | `src/ui/panels/*.tsx`、`src/ui/shell/*.tsx`；控件只用 `src/ui/components/`；写法见 `docs/dev/ui-design.md` |
| 地图模式、底图 | `src/ui/map/modes.ts`、`src/ui/defs/layers.ts`、`src/render/colors.ts` |
| 画风 | `core/map-style.ts`、`core/packs/map-styles.ts`、`src/render/renderer.ts` 的 `styleUniforms` |
| 地名风格 | `core/name-styles.ts`、`core/packs/names/*.json` |
| 世界文件的格式 | `core/world.ts`；改了就把 `core/doc-version.ts` 的 `DOC_VERSION` 加一 |
| 主线程与 Worker 的消息 | `src/protocol.ts`、`src/worker.ts`、`src/state.ts` |
| 用户看得到的说明 | `docs/使用说明.md`、`src/ui/Help.tsx`、`src/ui/copy.ts` |

## 规矩

- **结果逐值不变**：提速、重构后金标准（`core/golden*.json`、`*digests*.json`、`shader-hashes.json`）一个都不重录；每项提速另加“新旧逐位相同”的测试。
- **不能变慢**：编辑不能变慢，`node tools/bench-median.mjs 5 --against <上一个提交> --`（区域）和 `-- --globe`（星球）任何一步超过 +5% 要压回去；噪音大时先拿同一提交对照自己看宽度；画法的改动跑 `compose-ab` / `overlay-ab`，0 字节不同。
- **旧存档不必兼容**：世界格式变了就把 `DOC_VERSION` 加一，代码里不留旧存档的写法。
- **计算 Worker 不打包内置数据**：内置的包只在主线程（`src/worker-imports.test.ts` 查着）。
- **文件不要太大**：往一个文件里加代码时控制在约 800 行以内，超过就按职责拆（原样搬、照旧导出）。
- **冻结的参照不要改**：`src/testing/frozen/`、测试里标着“不要改它”的原样拷贝。
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
