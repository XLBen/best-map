# 界面的写法

工具怎样组织、界面的样子、文字的规则（从开发说明搬来，第四十一轮）。

## 工具怎样组织

- 接口在 `src/ui/tools/api.ts`：`Pointer`（地图坐标、格、屏幕坐标、画出来的是哪一格）、`Preview`（高亮的格、图形、一句话、省份预览、幽灵海岸、将来的世界）、`ToolHandler`（`down / move / up / click / cancel / leave / preview / backdrop`……）、`ToolEnv`（地图给工具的缩放与“这一点是哪个地名”），还有几个工具都用的小工具（地图上的距离、整个星球的经度绕回、世界的编号）与 `guard`。
- 正在计算时：每个工具在动手的地方用 `guard('queue')`（只是在算前面的编辑时照样能用，松手后排队）或 `guard('refuse')`（`isBusy`，河、剪刀、合并、重画这一片……要按最新的世界算，前面的算完以前不动手）。
- `tools/brush.ts` 是画笔（`Stroke` 一笔、`brushTool` 通用的画笔：圈、排队、拖滑块时在最后停的地方预览、停一下的确切预览）；`tools/gestures.ts` 是几个工具共用的手势：圈一片（`lassoAdd`、`lassoShapes`）、点一下或拖出大小（`startDrag`、`dragTo`、`sizeLine`、`movedAway`）、湖里的岛的确切预览（`lakeIsleExact`、`lakeIsleRelease`）、数连通块（`groupCount`）。
- 按类：`terrain.ts`（画陆地 / 海、放岛、岛链、堆山、打碎、重画、恢复原样的橡皮擦 `restoreTool`）、`nature.ts`（涂生态、拖动扩张、擦除生态的橡皮擦 `eraseTool`、选生态的范围）、`climate.ts`（冷暖、干湿、擦除冷暖干湿的橡皮擦 `climateEraseTool`、自定义场、吸取 `pickClimate` / `pickField`）、`erasers.ts`（第二十七轮：别的笔刷的橡皮擦）、`water.ts`（放湖）、`provinces.ts`、`names.ts`、`measure.ts`（量距离）、`human.ts`（第二十一轮：画地形类别、资源，Alt+点吸取）、`culture.ts`（第二十二轮：文化笔刷、人口笔刷、发源地）、`countries.ts`（第二十三轮：选国家、领土、新建国家、合并；第二十七轮去掉了首都）、`settlements.ts`（第二十四轮：城市、道路、地标、自定义点）、`pointer.ts`（第二十五轮：指针）；画河、删除河湖在 `river/tool.ts`。core 里的规则（画笔中心 `brushCore`、碎化恢复 `fragmentAfter`……）从 core 导出直接调用，不在界面里再写一份。
- 工具读选项（`options`）只读真正的设置；每放一个岛、一条岛链自动换的形状编号是 `tools/terrain.ts` 的 `islandVariant`、`chainVariant`，不在 `options` 里（换形状不让别的确切预览作废）。冷暖、干湿各有各的力度（`tempAmount`、`moistAmount`）。
- **吸管与橡皮擦**（第二十七轮）：工具表里写了 `pick(w, cell)` 的工具底部条第二行末尾有吸管，写了 `eraser: { auto?, clear? }`（两个工厂函数）的有橡皮擦，见“编辑：吸管、橡皮擦、自动的结果”。
- **加一个工具**：在 `tools/` 下（或 `river/`）写它的工厂函数，返回 `ToolHandler`；再在 `defs/tools.ts` 的工具表 `SPECS` 里加一条，键就是它的 id——`ToolId` 由这张表推出来，类别里的工具列表按表里的先后推出来（底部工具条、数字键的顺序就是它）。要手指光标写 `cursor: 'pointer'`；离开时要清掉的东西写 `onLeave`；它的选中状态变了地图要重画就写 `watch`（读一下那个信号）；要在地图上沿着选中的东西画光写 `focus`；Delete / Backspace 删除选中的东西写 `del`（用掉了返回 true，第二十四轮）。一类工具开着时地图上多画的（高亮、省名、地名、河道标记）写在类别表的 `map` 里，离开这一类要清掉的写在类别的 `onLeave`。
- 换工具都走 `setTool`（面板里、工具里经 `state.ts` 的 `switchTool`），不直接写 `tool.value`：离开的工具与类别的清理、底部条的预览、量距离、鼠标旁的话都在那里清掉。
- 底图只在“图层”里换（第二十五轮：人文的底图就是地图模式，换底图就是换模式，见“地图模式与指针”）；工具表里写了 `view` 的工具（第二十一轮：地形类别、资源；第二十二轮：文化、人口、发源地；第二十三轮：“国家”一类的工具都是 `country`）是例外——开着时 `setTool` 把底图换成它那一层，换到没写 `view` 的工具时换回原来的；这期间在图层里换过底图就不动（`defs/tools.ts` 的 `switchView`）。`view` 可以写成函数（人口笔刷按模式：改成分 `culture`、改人数 `popDensity`、改一个维度 `dim:维度 id`），选项变了时底图跟着换（底图还是工具换上的那一层时）；世界里没有那一层（`defs/layers.ts` 的 `viewAvailable`：没有人文时人口的几层都没有）时不换；底图那一层在世界里没了（删除人文、换了时代、打开别的世界）时回到工具换上之前的那一层，又有了时再换上。
- 测试：`src/ui/tool-replay.test.ts` 是一串脚本化的手势交给各个工具后发出的命令、提示与预览（`__snapshots__/tool-replay.json`，第十九轮拆分之前录下，之后不重录：变了就是行为变了；第十九轮 C 改字时重录过一次，核对过只有提示、正在计算的字和命令的 `label` 这些文字变了，结构与其余的值一个没变）；`tool-defs.test.ts` 查工具表与类别、换工具的清理、冷暖干湿的力度、`Settle`。

## 界面的样子

一套 token、每种控件一个组件（第十九轮 B）。改界面时只从这里取，不在别处另写颜色、字号、圆角。

- **token**（`src/styles.css` 最上面的 `:root`）：字号 `--fs-xs/sm/md/lg` = 11 / 12 / 13 / 15；圆角 `--r-sm/md/lg` = 6 / 10 / 14，圆点 `50%`、胶囊 `--r-pill`；阴影 `--shadow-sm`（滑块、开关的圆点）、`--shadow-lg`（浮在地图上的）；间距 `--sp-1…4` = 4 / 8 / 12 / 16；控件高 `--h-sm` 28、`--h-md` 32；档案里左边名字一栏的宽 `--label-w` 44（第二十九轮）；灰阶 `--field --bg --surface --line --faint --muted --text`；叠在任何底上的白 `--fill`（按钮的底、毛玻璃的边）、`--hover`（悬停，只有这一个值）、`--press`（按下、开着、滑轨）；毛玻璃 `--glass --glass-strong`；强调 `--accent --accent-bg --accent-line`；警告 `--warn --warn-text --warn-bg`；危险 `--danger --danger-text --danger-bg`；另有 `--ok --mark --sea --scrim --mono --sheet-w`（抽屉的宽，底部条按它居中）。十六进制、rgba 只在 `:root` 里写。
- **按钮**没有边框：淡淡的底（`--fill`），悬停在任何底上叠同一层 `--hover`（`background-image`），选着的 `.on` / 主要的 `.primary` 是 `--accent-bg`，弹出面板开着的 `.open` 是 `--press`。图标由 `App.tsx` 的 `LucideProvider` 统一成 16 / 粗细 1.8，顶栏写 `size={18}`；各处不再写大小。
- **控件各一种**（`src/ui/components/`）：
  - `Slider.tsx`：全界面的滑块。`Slider` 给位置（0–1）和写出来的数，拖动时 `onDraft`、松手 `onCommit`、拖着时被取消 `onCancel`、方向键 `onStep`；`stacked` 是面板里的两行样子，`note` 写在下面；`linear(lo, hi, step)` 是等间距的换算；`OptionSlider` 是底部条上工具的滑块（值在 `options` 里，换算在 `shell/sliders.ts`）。不再用原生的 `<input type="range">`。
  - `RangeSliders.tsx`（第五十五轮）：一段范围，“最低”“最高”两个 `Slider`（`scale` 可换刻度，第五十六轮：流量按对数），到两头写“不限”，不交叉。字段表的类型是 `range`。
  - `Toggle.tsx`：开 / 关一项设置（无人区、锁定、省份着色、图层里显示什么、自然生成……）。从一组里挑几样（从本世界存进资源库带哪些、只长在哪些地方、地名的几组）照旧是勾选框 `label.check`；资源库里每一项是两个按钮“添加到本世界 / 移出本世界”（第二十八轮以前是 `Toggle`）。
  - `common.tsx` 的 `Seg`：几个里选一个（底部条上工具的模式也是它；`swatches` 色块、`off` 现在不起作用）。
  - `TypePicker.tsx`：选“哪一种”——底部条上的按钮 `TypePickerButton` 和弹出的列表 `TypePicker`。河、湖、岛（放岛、岛链）的六个列表都是它，`App.tsx` 的 `TYPE_PANELS` 写着每个列表的标题和种类表。一项写了 `group` 时按它分段（第二十二轮：文化按文化组列）；`icon`（lucide 图标）、`image`（上传的小图）画在名字前面（第二十四轮：地标、点的种类），按钮也可以带 `icon`。
  - `Legend.tsx`（第二十一轮）：图例，`{title, items: {color, label, count?}[], open, onToggle}`；都写了 `count` 时右边写百分比。按类着色的底图的图例由 `ui/legend.ts` 的 `legendFor(world, mode)` 给（地形类别、资源、生态分区：只列世界里有的，按格数从多到少，资源的“无”排最后；按着色用的数组缓存），`shell/MapLegend.tsx` 放在左下角量距离按钮上面（跟着 `cornerLift` 抬）。第二十二轮加了文化、文化组、时代的每一维（`humanLegend`，`count` 是人数）与宜居度、人口密度（色带上的五档，没有 `count`）；第二十三轮加了国家（`countryLegend`：按人口前 `LEGEND_TOP` = 12 国，颜色是 `countryMapColors` 的，其余合成“其他 N 国”；没有人时按格数）。
  - `SelectionActions.tsx`：选中一样东西时的换一个、恢复自动、锁定、在地图上看、删掉、取消选择，河、湖、地名、省份共用。河、省的底部条只放常用的几个，其余用 `menu` 布局放进它们的“⋯”（`PanelId` 的 `river`、`province`）；`MenuItem` 是“⋯”里的一行。
  - `LibraryPick.tsx`（第五十二轮）：选一个库。新建向导里是一排卡片，`compact`（弹出面板）是下拉；内置的在前，我的库另成一段。
- **资源库面板**（第五十九轮，`packs/LibPanel.tsx`、`lib-panel.css`）：窄的（380 px），只有总表放宽。首页的卡片 `.lp-card`（图标、名字、数），列表行 `.lp-row`（色块、名字、灰字、`›`），一项的页面是几段 `.lp-seg`（标题、收起时灰色的一句）。首页有哪些卡片、一段有哪些字段都在 `pages.ts`、`page-layout.ts`、`page-segments.ts`，组件不写判断。融入（第六十轮）：卡片上的“含”是 `.lp-contains`，我的库里每种一个能拖的 `.lp-chip`，含两种以上的卡片占两列（`.wide`）；拖的时候跟手的是 `.lp-ghost`，指着的卡片 `.drop-ok` / `.drop-no`，拖的那张 `.lifted`；上级页面下面的一段是 `.lp-seg.lp-child`，一行 `.lp-child-row`，展开的 `.lp-child-edit`。第六十二轮：和来源的库不同的标记 `.lp-diff`（一项的页面上是 `.lp-diff-chip`），生成后没用到的行 `.lp-row.faint`，清理的按钮 `.lp-clean`，面板顶上的重新生成 `.lp-regen`，“谁用到它”是最后一段（一行 `.arch-line`，左边 `.lp-used-kind`，名字 `.lp-used-names`）。只读用 `<fieldset disabled>`，引用的链接用 `<a>`（只读时还能点）。字段表写了 `min`、`max`、`step` 且不超过 2000 格的数画成滑块（`fields.ts` 的 `sliderScale`），别的还是框。
- **导入窗口**（第六十一轮，`packs/ImportDialog.tsx`）：弹窗 `.modal.import`（640 px）。上面一段是能滚的 `.imp-list-box`，每种内容一组 `.imp-group`（勾选框勾整组，先后同首页），一行 `.imp-row`；下面一段 `.imp-summary`：还会带上（`.imp-dep`，按种类分，取消了的留在原位），可以带上，收着的“已经有了”“会改名”“去掉的引用”（`.imp-fold`），最后一句要不要重新生成。选库用 `LibraryPick` 的 `compact any`。
- **列表行一种** `.item`（菜单、地名、河、湖、涂过的地方、类型列表、国家、城市），高 `--h-sm`，`.list` 是可以滚的一列；资源库面板的一行是 `.lp-row`（色块、名字、灰字、`›`）。（`.row` 早就是“一行排开”的布局类，所以列表行叫 `.item`。）
- **排版**（第二十九轮，照 Claude Code 的密度，颜色不变）：
  - 一行一项：`.list` 里的 `.item-text` 名字和灰色的说明排在同一行，放不下时说明先省略；`.menu`（世界）里说明在名字下面、只占一行。
  - 弹窗里的一行 `.file-row`（我的地图、资源包）：缩略图或色块、`.file-info`（`.file-name` 一行名字，下面一行灰字）、右边 `.file-actions` 几个小按钮；不画线，鼠标停着淡淡亮一下。
  - 段与段之间靠小标题 `h5` 和留白分开，弹出面板、档案、“这里”卡片里都不画线；弹出面板、抽屉、“这里”卡片的标题栏一样薄（关上的按钮 24 px），内容左右留 `--sp-3`。
  - 档案的一行 `.arch-line`：左边灰色的名字一栏 `--label-w`，统计的 `.stat-grid` 用同一栏宽，几段上下对得齐。
  - 弹窗三段：`common.tsx` 的 `ModalHead`（名字、右边一个小的关上）、内容、`.modal-foot`（按钮靠右，主要的在最右边；问话框的 `.ask-actions` 同一种）。
- **小标题**一种 `h5`；**说明文字**一种 `.hint`；**弹窗、问话的标题** `h2` / `h3`（同一个字号）。
- 要用户确认、起名字用 `state.ts` 的 `askUser` / `askText`（`shell/Ask.tsx` 的问话框），不用浏览器的 `confirm` / `prompt`。

## 文字

界面上的字要克制：短、不加修饰、不解释怎么实现的（第十九轮 C）。新加的字照这里写。

- **标签**：名词或两个字的动词（“删除”“定位”“擦除”“锁定”），不带“这条 / 这个 / 一下 / 一个”。**空状态**写名词短语（“没有河”）。**弹窗、弹出面板的标题**用名词（“河的种类”），不用问句。
- **说明**（悬停、`.hint`、提示条）：一句话，尽量不超过 20 个字；不用比喻；不写“真的 / 直接 / 其实 / 就 / 系统 / 一下 / 真正”；不写开发细节（轮次、像素数、文件名、函数名）；括号里的旁注移进悬停或删掉。
- **只讲一次的**：“停一下先看结果”和“Esc 取消”只写在帮助里，各个工具的说明不再写。
- **工具的说明**（`defs/tools.ts` 的 `how`）：一句话，只在工具按钮的悬停里显示，如“按住涂，抬高陆地”。
- **历史摘要**（`core/commands.ts` 的 `summary`、界面给命令写的 `label`）：“动作 对象 · 数值”，如“画河 · 约 120 km”“删除湖”“堆山 · 36 格”“改名为“X””。对象的名字用中文引号“”，不用「」。
- **省略号**“…”只用在会打开弹窗的按钮上，和“正在计算…”这类进行中的提示。
- **同一件事只写一处**：讲同一件事的说明收成常量（`src/ui/copy.ts`：信任脚本、自动起名、按类型的规则判断、锁定河、气候带；无人区用 `core/provinces.ts` 的说明），不在各处各写一句。
- **统一的叫法**：

| 用 | 不用 | 意思 |
|---|---|---|
| 恢复 | 恢复原样、退回 | 回到生成时的样子（工具“恢复”） |
| 擦除 | 擦掉、去掉 | 去掉涂上去的（擦除冷暖干湿、擦除生态） |
| 删除 | 删掉、移除、去掉 | 删除东西；地名不是删除而是“隐藏 / 显示” |
| 关闭 | 关上、收起、知道了 | 关掉面板、提示；结束一种模式用“完成” |
| 直径 | 大小、起点 | 画笔、岛、湖的大小（河的“大小”是水量，照旧） |
| 力度 | 强度 | |
| 省份 | 省 | 海上的省份叫“海省” |
| 自然生成 | 自己出现 | |
| 自动、恢复自动 | 换回内置、恢复默认、按规则 | |
| 锁定 | 固定 | 锁定河（走向不再随地形挪）、锁定名字、锁定省份 |
| 新建 | 新增 | |
| 没涂成 | 没长出来、未涂成 | 涂了但没长成的生态 |
| 正在计算… | 还在算、计算中 | 正在算的提示 |
| 定位 | 在地图上看 | 把镜头移到选中的东西 |
