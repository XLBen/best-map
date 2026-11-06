# src/ui/：界面

Preact + signals。工具、参数、底图都是声明（`defs/`），顶栏、底部工具条、面板、光标、高亮由声明生成。写法的规矩见 [界面的写法](ui-design.md)（工具怎样组织、界面的样子、文字）。

## 注册表 `defs/`
- `tools.ts` 工具表（类别、图标、名字、底部条的滑块与选项、吸取、光标、离开时清掉什么、地图跟着重画的状态）与类别表（“⋯”、高亮）；`setTool`
- `adjustments.ts` “调整”里的滑块；`layers.ts` “图层”里的底图与开关；`extras.tsx` 注册表里引用的小部件；`types.ts`

## 外壳 `shell/`
- `TopBar.tsx` 顶栏；`MapKind.tsx` 顶栏下面一排地图模式；`Popover.tsx` 弹出面板；`ContextBar.tsx` 底部工具条（`sliders.ts` 横滑块的换算）
- `Notice.tsx` 提示条（`noticeTimer.ts` 多久消失）；`SkippedBanner.tsx` 缺了内容跳过的步骤；`ScriptBanner.tsx` 安全模式与脚本出错；`Ask.tsx` 信任脚本 / 安全模式的问话
- `HereCard.tsx` 右下角“这里”（`Inspector.tsx`、格的档案 `ArchiveBox.tsx`）；`Ruler.tsx` 尺子；`MapLegend.tsx` 图例（开着风向、洋流时另有一张，带风的季节，与底图的图例叠着放）；`Sheet.tsx` 右边的抽屉；`keys.ts` 键盘

## 面板 `panels/`
- `ActionsPanel.tsx`（世界：新建、保存、打开、资源包、导出；更多：历史、偏好、上手说明）、`AdjustPanel.tsx`、`LayersPanel.tsx`、`BiomePanel.tsx`（生态色板）、`ToolLibrary.tsx`（“⋯”）
- `rivers.tsx`、`riverTypes.tsx`、`lakes.tsx`、`waterTypes.tsx`（河湖共用的类型编辑器）、`islandTypes.tsx`、`names.tsx`
- `human.tsx`（地形类别、资源）、`culture.tsx`（文化一类、`HumanChoices`、`CountryChoice`、第五十四轮的“加一个变量” `DimensionAdd`）、`countries.tsx`（国家一类、列表、`Flag`）、`settlements.tsx`（城市一类、列表、`CityGlyph`）

## 地图
- `App.tsx` 整体布局；`MapView.tsx` 地图视图（只做连接）；`camera.ts` 镜头
- `map/input.ts` 指针、拖动、滚轮、捏合、空格键（预览键 `moveKey` 没变的移动不重画）；`map/highlights.ts` 按声明多画的高亮与叠放顺序
- `map/modes.ts` 地图模式的表；`map/political.ts` 片区名（屏幕与导出共用，几何与字分开缓存）；`map/settle.ts` 城市等给叠加层的几项
- `map/export.ts` 导出当前画面、整张地图；`map/debug.ts` window 上的钩子、开发测速

## 工具
- `tools/` 按类分文件，`tools.ts` 一起导出：`api.ts` 工具的约定（`ToolHandler`、确切预览）、`brush.ts`、`gestures.ts`（圈一片、拖出大小、湖里的岛）、`terrain.ts`、`climate.ts`、`nature.ts`、`water.ts`、`names.ts`、`provinces.ts`、`human.ts`、`culture.ts`、`countries.ts`、`settlements.ts`、`pointer.ts`（指针）、`erasers.ts`（橡皮擦）、`measure.ts`（量距离）
- `river/` 画河、选河、改河、删河：`model.ts` 走向与命令、`query.ts` 认河、`shapes.ts` 画法、`bar.ts` 底部条的预览、`tool.ts` 两个工具；`riverCourse.ts` 一起导出
- `exact.ts` 停一下的确切预览（`Exact`、`Settle`、`slowTail`）；`pending.ts` 排队中的编辑；`edits.ts` 我改过的地方；`skipped.ts` 跳过的步骤
- `barPreview.ts` 底部条按钮悬停的预览；`provincePreview.ts`；`provincePanel.tsx` 省份的底部条与划分规则；`panels.tsx` 没涂成的地方、历史；`unmetLocate.ts`
- `lakeInfo.ts` 点中的湖；`features-at.ts` 每格属于哪些地物；`legend.ts` 按格着色的图例（`flowLegend`：开着的那一层，风的三档、暖流寒流）；`biomeRange.ts` 生态范围外怎么说

## 编辑器与档案
- `ScriptBox.tsx` 脚本框（`script-syntax.ts` 只解析不运行、`script-commit.ts` 停一下就提交、`script-examples.ts`）；`SpeciesAdvanced.tsx`（`species-scripts.ts`）；`connect.ts`、`editor-hooks.ts`
- `Wizard.tsx` 新建向导（`wizardTerrain.ts`、`human.ts`、`packChoice.ts` 选一个库，文化组从它列，世界的底子从它来）
- `countries.ts` + `CountryArchive.tsx`（第四十二轮：`layoutChoices`、`tierLabel` 按世界里的格局、等级）；`CountryFactions.tsx` 档案里的派系与比例条（第五十三轮）；`blocs.ts` + `BlocArchive.tsx`；`settlements.ts`（`cityLook`：城市按等级、首都按国家的等级分轻重，第四十二轮） + `SettleArchive.tsx`；`archive.ts` 格的档案的命令
- `FormEditor.tsx` 星球形态编辑器（`forms.ts`、`form-store.ts`）；`ClimateChart.tsx` 生态类型编辑器（水系那一段在 `panels/speciesWater.tsx`）；`Help.tsx` 上手说明
- `packs/` 资源库面板（第五十九轮）。逻辑（不碰界面，测试直接调）：`pages.ts` 来源、首页、列表、一项的页面、面包屑、只读、总表、`refRoute`、`undoTarget`；`page-source.ts` 看的是哪一份、这一份里有什么（`rowsOf`）；`rows.ts` 列表里的一行（第六十三轮：`libraryRows`、`worldRows`、状态、`removeCommand`、`rowUsage`、`defaultStyleCommand`、`saveableItem`、`itemPack`、`DEDICATED`）；`page-arrange.ts` 融入：这一份用哪张安排（`arrangeFor`）、卡片拖到卡片上行不行（`dropVerdict`）、卡片的“⋯”（`cardActions`）；`page-children.ts` 上级页面下面的几段（`childSections`）、在哪几个上级下面（`partOf`）、上级列表最上面的“全部 X”（`insideRows`）；`page-marks.ts` 本世界的一行带的标记（和库不同、变淡）；`page-used-by.ts` “谁用到它”（`usedByOf`）；`regen.ts`、`RegenBar.tsx` 面板顶上的“重新生成”（`regenNeed`；第六十六轮 `addedNeed`、`addRegenLabel` 给“添加并重新生成…”）；`tidy.ts` 清理没用到的；`pick-store.ts` 按来源库记的勾选（第六十六轮）：连带的纯函数（`pickOn`、`pickOff`、`pickRows`、`pickRemove`、点灰的行 `pickWithNeeds`、“为了 X 加的” `withForNotes`），按库的状态（`picksOf`、`pickCount`、`togglePickIn`、`setPicksIn`、`removePickIn`、`pickNeedsIn`、`clearPicks`、换世界清掉），目的地（`pickDest`；第六十七轮 `destFor`：不加到自己、`canPick`），用户点的那一项 `pickLead`（撤销条写它），读进来的文件（`setFileSource`，在 `src/library.ts` 的 `fileLibrary`）；`pick-add.ts` 添加：`worldAddCommand`（`regen` 时接上重新生成，一个 batch；`lead` 写进撤销条）、按钮的字 `addRegenButton`、写入 `runAdd`（顶上“已添加…”，带“去看看”、撤销）、按库添加 `addPicked`；`pick-view.ts` 看库就是添加（第六十七轮）：一个库的勾选怎么画（`pickView`，按勾选、世界、库记着）、点一行做什么（`pressOf`、`pressRow`、`boxOf`）、哪种能勾（`kindPickable`）、卡片的“已勾 N”（`cardPicks`）；`pick-look.ts` 一行的状态（`rowLook`，灰的行写 `resolvable`、几选一的 `choices`）、列表头的全选（`allLook`）、清单分组（`basketGroups`）；`pick-other.ts` “从库里添加…”切到哪个库（`defaultFrom`、`rememberFrom`）、下拉里别的库的（`otherLibOptions`，灰的不列；`addOther` 直接加）、清单底下要重新生成的一句（`regenLine`）；`page-search.ts` 首页搜整个库；`lib-file.ts` 读文件成临时的库（`openFile`、`installFile`、`closeFile`）；`lib-keys.ts` 面板里的键盘；`page-drag.ts` 鼠标拖卡片（`startDrag`、`dragOutOf`、跟手的 `dragView`）；`page-layout.ts` 首页的排法（`Inside`：卡片 → 上级）；`page-segments.ts` 每种内容分几段、收起时写的一句；`panel-store.ts` 面板的状态（`openLibrary`；第六十七轮：右栏 `side`、`openRoute`、`closeSide`、窄窗口的 `basket`、两栏 `libWide`、刚加的行 `rowFlash`、“去看看” `lookAt`）；`panel-open.ts` 别处打开并新建；`page-actions.ts` 改一项就存（世界是命令，我的库走 `src/library-edit.ts`）、水系的一格；`row-actions.ts` 一行的色块和示例（`swatchOf`、`sampleLine`），问脚本（`runTrusted`）、存进资源库、导出、打开详细编辑。组件：`LibPanel.tsx` 外壳（标题下拉、撤销、“从库里添加…”、“⋯”、返回、两栏）、`LibSide.tsx` 右栏（点开的一项和清单）、`LibBasket.tsx` 清单（加到、添加、添加并重新生成）、`PickBox.tsx` 一行的勾（几选一的小菜单）、`PageHome.tsx`、`PageList.tsx`、`PageItem.tsx`、`PageWater.tsx`（总表和两段水系）、`PageChildren.tsx`（下面的几段、列表最上面含的几行、世界里的变量）、`lib-panel.css`、`lib-pick.css`（两栏、勾、清单）
- `packs/` 面板“⋯”打开的弹窗：`PackDialog.tsx`（资源包的列表、读好的文件、从本世界存进资源库）、`store.ts`（弹窗的状态，`fileLabel`）、`Scripts.tsx`；`styles.ts` 地名风格的选项和“重起省名”（面板之外也用）
- 通用编辑器：`ContentEditor.tsx`（按字段表画）+ `editors.tsx`（称号、几种称号、带权重的、`tuple` / `tuples`、按引用的比例表、引用的一组、键 → 值、拖动的把手）+ `TendencyEditor.tsx`（倾向的表，`tendency.ts` 是规则）+ `RefPicker.tsx`（带搜索的下拉，`refs.ts` 给选项）+ `fields.ts`
- `maps/` 我的地图的弹窗（`MapsDialog.tsx`、`store.ts`）
- `copy.ts` 几处共用的一句话；`common.tsx` 的 `Seg`；`components/` 全界面共用的控件（`Slider`、`RangeSliders`（第五十五轮：一段范围的两个滑块）、`Toggle`、`TypePicker`、`Legend`、`LibraryPick`（第五十二轮：选一个库，向导里是卡片，弹出面板里是下拉）、`SelectionActions`）
