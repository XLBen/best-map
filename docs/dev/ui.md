# src/ui/：界面

Preact + signals。工具、参数、底图都是声明（`defs/`），顶栏、底部工具条、面板、光标、高亮由声明生成。写法的规矩见 [界面的写法](ui-design.md)（工具怎样组织、界面的样子、文字）。

## 分层（第六十九轮，`layering.test.ts` 查着）
- `components/` 只引用 `core/`、库和 `components/` 自己：不认识世界、状态、资源库（要的由用的地方经 props 给；认识的搬到 `shell/` 等处）
- `defs/` 不引用 `panels/`、`tools/`（含一起导出的 `tools.ts`）和任何 `.tsx`：工具表只声明；底部条上的部件、“⋯”的设置写名字（`panel-registry.ts`，面板模块自己 `registerPanels`），工具做什么由 `tools/bind.ts` 接上（`bindTools`）；`register-all.tsx`（App 引用）把它们都引用一次
- `.ts` 不引用 `.tsx`：逻辑不写在组件文件里（放进同名的 `.ts`）
- `src/state.ts` 与 `src/state/` 不引用 `src/ui/`（`import type` 不算）；换工具经 `registerToolSwitch` 登记进去
- `src/ui/`、`state.ts`、`state/` 之间没有绕成圈的引用（只算运行时的引用）
- 第七十轮：`panels/` 只经 `tools/api.ts`、`tools/public.ts` 用工具；`shell/` 不引用具体的档案（`defs/archive-registry.ts`）；界面只经 `state.ts` 引用状态，不直接引用 `state/` 下的文件（测试 `vi.mock('../state')` 换掉 `exec` 等）；`domain/` 不引用 `panels/`、`shell/`、`tools/`、`river/` 和 `.tsx`
- 模块里不写 `effect`（以前在工具表模块里的三个改成 `startToolEffects()`，`main.tsx` 在第一次画界面前调用）；只看引用、不在整个页面里 `querySelector` 别人的元素（用 ref）

## 注册表 `defs/`
- `tools/` 工具表（第七十轮按类分开）：`index.ts` 合起来（`TOOL_DEFS`、`ToolId`）与类别表（“⋯”、高亮）、`setTool`、`bindTools`、`startToolEffects`；`terrain.ts`、`climate.ts`、`nature.ts`、`water.ts`、`provinces.ts`、`names.ts`、`culture.ts`、`countries.ts`、`settlements.ts`、`inspect.ts` 每一类的工具是什么（图标、名字、底部条的滑块与选项、光标、离开时清掉什么、地图跟着重画的状态）；`tool-sliders.ts` 表里的滑块与底部条常用的几项；`tool-values.ts` 滑块的上限、取整、数值的写法（`tools/` 照旧导出）
- `panel-registry.ts` 工具表按名字引用的部件（`PANEL_KEYS`、`registerPanels`、`panelOf`）；`archive-registry.ts` 右边抽屉里的四种档案（第七十轮：`registerArchive`、`archiveOf`，标题和内容）；`adjustments.ts` “调整”里的滑块；`layers.ts` “图层”里的底图与开关；`types.ts`（`ToolSpec` 是什么，`ToolBehavior` 做什么）

## 外壳 `shell/`
- `TopBar.tsx` 顶栏；`MapKind.tsx` 顶栏下面一排地图模式；`Popover.tsx` 弹出面板；`ContextBar.tsx` 底部工具条（`sliders.ts` 横滑块的换算，`OptionSlider.tsx` 工具选项的滑块，`bottom-bar.ts` 它的元素给地图量高度）
- `TypePicker.tsx` 选“哪一种”的按钮和列表（`type-picker.ts` 按来源分段、“从资源库添加…”）；`SelectionActions.tsx` 选中了一样东西时的那几个按钮
- `Notice.tsx` 提示条（`src/notice-timer.ts` 多久消失）；`SkippedBanner.tsx` 缺了内容跳过的步骤；`ScriptBanner.tsx` 安全模式与脚本出错；`Ask.tsx` 信任脚本 / 安全模式的问话
- `HereCard.tsx` 右下角“这里”（`Inspector.tsx`、格的档案 `ArchiveBox.tsx`）；`Ruler.tsx` 尺子；`MapLegend.tsx` 图例（开着风向、洋流时另有一张，带风的季节，与底图的图例叠着放）；`Sheet.tsx` 右边的抽屉（按登记的档案画）；`keys.ts` 键盘；`escape.ts` Esc 的栈（`pushEscape`、`useEscape`、先后 `ESC_RANK`，捕获与冒泡两个阶段）

## 面板 `panels/`
- `ActionsPanel.tsx`（世界：新建、保存、打开、资源包、导出；更多：历史、偏好、上手说明）、`AdjustPanel.tsx`、`LayersPanel.tsx`、`BiomePanel.tsx`（生态色板）、`ToolLibrary.tsx`（“⋯”）
- `rivers.tsx`、`riverTypes.tsx`、`lakes.tsx`、`waterTypes.tsx`（河湖共用的类型编辑器；逻辑在 `water-types.ts`）、`islandTypes.tsx`（逻辑在 `island-types.ts`）、`names.tsx`、`nature-bar.tsx`（自然一类底部条的部件、“自然 ⋯”）
- `human.tsx`（地形类别、资源）、`culture.tsx`（文化一类、`HumanChoices`、`CountryChoice`、第五十四轮的“加一个变量” `DimensionAdd`）、`countries.tsx`（国家一类、列表、`Flag`）、`settlements.tsx`（城市一类、列表、`CityGlyph`）

## 地图
- `App.tsx` 整体布局；`MapView.tsx` 地图视图（只做连接）；`camera.ts` 镜头
- `map/input.ts` 指针、拖动、滚轮、捏合、空格键（预览键 `moveKey` 没变的移动不重画）；`map/highlights.ts` 按声明多画的高亮与叠放顺序
- `map/modes.ts` 地图模式的表；`map/political.ts` 片区名（屏幕与导出共用，几何与字分开缓存）；`map/settle.ts` 城市等给叠加层的几项
- `map/export.ts` 导出当前画面、整张地图；`map/debug.ts` window 上的钩子、开发测速
- 第七十轮从 `MapView.tsx` 分出来：`map/color-cache.ts` 着色的缓存（底子、模式的那一层，`lruGet`）；`map/labels.ts` 省名标签放在哪、选中的东西自己的地名先不标；`map/preview-merge.ts` 几份预览叠在一起（`mergeProvinces`、`mergeGhosts`、`withQueued`）；`map/reference.ts` 参考图的样式；`map/corner-lift.ts` 比例尺要抬多高；`map/settle.ts` 加上最醒目的点（`settleStrongMarks`）

## 工具
- `tools/` 按类分文件，`tools.ts` 一起导出（`bind.ts` 把每个工具做什么登记进工具表）：`api.ts` 工具的约定（`ToolHandler`、确切预览）、`public.ts` 面板能用的几样（第七十轮：涂的是哪一种、选中、删掉选中的）、`brush.ts`、`gestures.ts`（圈一片、拖出大小、湖里的岛）、`terrain.ts`、`climate.ts`、`nature.ts`、`water.ts`、`names.ts`、`provinces.ts`、`human.ts`、`culture.ts`、`countries.ts`、`settlements.ts`、`pointer.ts`（指针）、`erasers.ts`（橡皮擦）、`measure.ts`（量距离）
- `river/` 画河、选河、改河、删河：`model.ts` 走向与命令、`query.ts` 认河、`shapes.ts` 画法、`bar.ts` 底部条的预览、`tool.ts` 画河工具、`course-view.ts` 画河时的说明与图形、`actions.ts` 选河加河（`selectRiver`、`execAndSelect`）、`unwater.ts` 删除河湖；`index.ts` 一起导出（第七十轮以前是 `ui/riverCourse.ts`）
- `domain/` 领域逻辑（第七十轮从 `ui/` 根下搬来，不碰界面的部件和工具）：`exact.ts` 停一下的确切预览（`Exact`、`Settle`、`slowTail`）；`edits.ts` 我改过的地方；`skipped.ts` 跳过的步骤；`lakeInfo.ts` 点中的湖；`features-at.ts` 每格属于哪些地物；`legend.ts` 按格着色的图例（`flowLegend`：开着的那一层，风的三档、暖流寒流）；`countries.ts`、`blocs.ts`、`settlements.ts`（`cityLook`）、`human.ts`、`archive.ts`（格的档案的命令）、`forms.ts`、`packChoice.ts`、`wizardTerrain.ts`
- `pending.ts` 排队中的编辑
- `barPreview.ts` 底部条按钮悬停的预览；`provincePreview.ts`；`provincePanel.tsx` 省份的底部条与划分规则（`province-panel.ts` 多选能做什么、省份大小）；`panels.tsx` 没涂成的地方、历史；`unmetLocate.ts`（`showIgnored`）
- 生态范围外怎么说在 `src/biome-range.ts`

## 编辑器与档案
- `ScriptBox.tsx` 脚本框（`script-syntax.ts` 只解析不运行、`script-commit.ts` 停一下就提交、`script-examples.ts`）；`SpeciesAdvanced.tsx`（`species-scripts.ts`）；`connect.ts`、`editor-hooks.ts`
- `Wizard.tsx` 新建向导（`domain/wizardTerrain.ts`、`domain/human.ts`、`domain/packChoice.ts` 选一个库，文化组从它列，世界的底子从它来）
- `domain/countries.ts` + `CountryArchive.tsx`（抽屉的头、页签，`country-archive.ts` 旗的样式与图案、页签、`run`、`patch`；第七十轮：每一页在 `archives/country-overview.tsx`、`country-politics.tsx`、`country-people.tsx`、`country-relations.tsx`、`country-history.tsx`，小部件 `archives/fields.tsx`）；`CountryFactions.tsx` 档案里的派系与比例条（第五十三轮）；`domain/blocs.ts` + `BlocArchive.tsx`；`domain/settlements.ts`（城市按等级、首都按国家的等级分轻重，第四十二轮） + `SettleArchive.tsx`；四种档案在自己的模块末尾 `registerArchive`
- `FormEditor.tsx` 星球形态编辑器（`domain/forms.ts`、`form-store.ts`）；`ClimateChart.tsx` 生态类型编辑器（水系那一段在 `panels/speciesWater.tsx`）；`Help.tsx` 上手说明
- `packs/` 资源库面板（第五十九轮）。逻辑（不碰界面，测试直接调）：`pages.ts` 来源、首页、列表、一项的页面、面包屑、只读、总表、`refRoute`、`undoTarget`；`page-source.ts` 看的是哪一份、这一份里有什么（`rowsOf`）；`rows.ts` 列表里的一行（第六十三轮：`libraryRows`、`worldRows`、状态、`removeCommand`、`rowUsage`、`defaultStyleCommand`、`saveableItem`、`itemPack`、`DEDICATED`）；`page-arrange.ts` 融入：这一份用哪张安排（`arrangeFor`）、卡片拖到卡片上行不行（`dropVerdict`）、卡片的“⋯”（`cardActions`）；`page-children.ts` 上级页面下面的几段（`childSections`）、在哪几个上级下面（`partOf`）、上级列表最上面的“全部 X”（`insideRows`）；`page-marks.ts` 本世界的一行带的标记（和库不同、变淡）；`page-used-by.ts` “谁用到它”（`usedByOf`）；`regen.ts`、`RegenBar.tsx` 面板顶上的“重新生成”（`regenNeed`；第六十六轮 `addedNeed`、`addRegenLabel` 给“添加并重新生成…”）；`tidy.ts` 清理没用到的；`pick-store.ts` 按来源库记的勾选（第六十六轮）：连带的纯函数（`pickOn`、`pickOff`、`pickRows`、`pickRemove`、点灰的行 `pickWithNeeds`、“为了 X 加的” `withForNotes`），按库的状态（`picksOf`、`pickCount`、`togglePickIn`、`setPicksIn`、`removePickIn`、`pickNeedsIn`、`clearPicks`、换世界清掉），目的地（`pickDest`；第六十七轮 `destFor`：不加到自己、`canPick`），用户点的那一项 `pickLead`（撤销条写它），读进来的文件（`setFileSource`，在 `src/library.ts` 的 `fileLibrary`）；`pick-add.ts` 添加：`worldAddCommand`（`regen` 时接上重新生成，一个 batch；`lead` 写进撤销条）、按钮的字 `addRegenButton`、写入 `runAdd`（顶上“已添加…”，带“去看看”、撤销）、按库添加 `addPicked`、添加并闪一下 `addNow`；`pick-view.ts` 看库就是添加（第六十七轮）：一个库的勾选怎么画（`pickView`，按勾选、世界、库记着）、点一行做什么（`pressOf`、`pressRow`、`boxOf`）、哪种能勾（`kindPickable`）、卡片的“已勾 N”（`cardPicks`）；`pick-look.ts` 一行的状态（`rowLook`，灰的行写 `resolvable`、几选一的 `choices`）、列表头的全选（`allLook`）、清单分组（`basketGroups`）；`pick-other.ts` “从库里添加…”切到哪个库（`defaultFrom`、`rememberFrom`）、清单底下要重新生成的一句（`regenLine`）；`other-view.ts` “从别的库加”的右栏（第六十八轮）：别的库和数（`otherLibs`、`pickFrom`）、分段的行（`otherSections`，灰的列出写原因，上级放不下的 `otherLook`）、展开的一段（`otherDetail`）、放到上级下面的 `ontoOf`、按钮出不出 `hasOther`；`page-search.ts` 首页搜整个库；`lib-file.ts` 读文件成临时的库（`openFile`、`installFile`、`closeFile`）；`lib-keys.ts` 面板里的键盘（Esc 先清搜索、收起右栏，其余在 `shell/escape.ts`）；`page-drag.ts` 鼠标拖卡片（`startDrag`、`dragOutOf`、跟手的 `dragView`）；`page-layout.ts` 首页的排法（`Inside`：卡片 → 上级）；`page-segments.ts` 每种内容分几段、收起时写的一句；`panel-store.ts` 面板的状态（`openLibrary`；第六十七轮：右栏 `side`、`openRoute`、`closeSide`、窄窗口的 `basket`、两栏 `libWide`、刚加的行 `rowFlash`、“去看看” `lookAt`；第六十九轮：高亮的行自己报上来，滚到页面上第一行 `useFlashScroll`；第六十八轮：“从别的库加”的 `other`、`toggleOther`、`closeOther`，换页面、换来源收起）；`panel-open.ts` 别处打开并新建；`page-actions.ts` 改一项就存（世界是命令，我的库走 `src/library-edit.ts`）、水系的一格；`row-actions.ts` 一行的色块和示例（`swatchOf`、`sampleLine`），问脚本（`runTrusted`，`script-trust.ts` 的 `isolationNote`）、存进资源库、导出、打开详细编辑。组件：`LibPanel.tsx` 外壳（标题下拉、撤销、“从库里添加…”、“⋯”、返回、两栏）、`LibSide.tsx` 右栏（点开的一项和清单）、`LibOther.tsx` 右栏里的“从别的库加”（来自、搜索、分段的勾、展开、清单；第六十八轮）、`LibBasket.tsx` 清单（加到、添加、添加并重新生成）、`PickBox.tsx` 一行的勾（几选一的小菜单）、`PageHome.tsx`、`PageList.tsx`、`PageItem.tsx`、`PageWater.tsx`（总表和两段水系）、`PageChildren.tsx`（下面的几段、列表最上面含的几行、世界里的变量）、`lib-panel.css`、`lib-pick.css`（两栏、勾、清单）
- `packs/` 面板“⋯”打开的弹窗：`PackDialog.tsx`（资源包的列表、读好的文件、从本世界存进资源库）、`store.ts`（弹窗的状态，`fileLabel`、导入生态文件 `importBiomeFile`）、`Scripts.tsx`；`styles.ts` 地名风格的选项和“重起省名”（面板之外也用）
- 通用编辑器：`ContentEditor.tsx`（按字段表画，键 → 值）+ `editors.tsx`（称号、几种称号、带权重的、`tuple` / `tuples`、按引用的比例表、引用的一组、拖动的把手）+ `editor-parts.tsx`（两边共用的 `Draft`、`Errors`）+ `TendencyEditor.tsx`（倾向的表，`tendency.ts` 是规则）+ `RefPicker.tsx`（带搜索的下拉，`refs.ts` 给选项）+ `fields.ts`
- `maps/` 我的地图的弹窗（`MapsDialog.tsx`、`store.ts`）
- `copy.ts` 几处共用的一句话；`common.tsx` 的 `Seg`；`components/` 全界面共用的控件，不认识世界（`Slider`、`RangeSliders`（第五十五轮：一段范围的两个滑块）、`Toggle`、`Legend`、`LibraryPick`（第五十二轮：选一个库，向导里是卡片，弹出面板里是下拉；能选的库由用的地方给）、`MenuItem`）
- `App.tsx` 引用 `register-all.tsx`（工具表按名字引用的部件、`tools/bind.ts`、抽屉里的档案）
