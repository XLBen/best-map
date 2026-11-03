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
- `human.tsx`（地形类别、资源）、`culture.tsx`（文化一类、`HumanChoices`、`CountryChoice`）、`countries.tsx`（国家一类、列表、`Flag`）、`settlements.tsx`（城市一类、列表、`CityGlyph`）

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
- `countries.ts` + `CountryArchive.tsx`（第四十二轮：`layoutChoices`、`tierLabel` 按世界里的格局、等级）；`blocs.ts` + `BlocArchive.tsx`；`settlements.ts`（`cityLook`：城市按等级、首都按国家的等级分轻重，第四十二轮） + `SettleArchive.tsx`；`archive.ts` 格的档案的命令
- `FormEditor.tsx` 星球形态编辑器（`forms.ts`、`form-store.ts`）；`ClimateChart.tsx` 生态类型编辑器；`Help.tsx` 上手说明
- `packs/` 资源库（第四十五轮：顶栏最左边打开，左栏列表、右栏详情与编辑器）：`RepoPanel.tsx` 外壳与展开的状态；`RepoList.tsx` 左栏（两段摊成一长列只画看得见的行，双击改名、拖动换先后）、`lines.ts`（`treeLines`、`visibleRange`）；`RepoDetail.tsx` 右栏（详情、按钮、编辑器）；`RepoPreview.ts` 停一下预览；`repo-actions.ts` 各个按钮做的事；`edit.ts` 编辑的规则（`startEdit`、`applyEdit` 改内置不另起 id、`restoreCommand` 恢复内置、改名、换先后）；`prefs.ts` 记着的种类与展开（存不了时照默认）；`repo.ts`（`packTree`、添加与移出、`builtinOriginal` 改过的内置项）；`tidy.ts`、`styles.ts`、`PackDialog.tsx`、`Scripts.tsx`、`store.ts`
- 通用编辑器：`ContentEditor.tsx`（按字段表画）+ `editors.tsx`（称号、几种称号、带权重的、`tuple` / `tuples`、按引用的比例表、引用的一组、键 → 值、拖动的把手）+ `TendencyEditor.tsx`（倾向的表，`tendency.ts` 是规则）+ `RefPicker.tsx`（带搜索的下拉，`refs.ts` 给选项）+ `fields.ts`
- `maps/` 我的地图的弹窗（`MapsDialog.tsx`、`store.ts`）
- `copy.ts` 几处共用的一句话；`common.tsx` 的 `Seg`；`components/` 全界面共用的控件（`Slider`、`Toggle`、`TypePicker`、`Legend`、`LibraryPick`（第五十二轮：选一个库，向导里是卡片，弹出面板里是下拉）、`SelectionActions`）
