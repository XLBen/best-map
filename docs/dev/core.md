# core/：纯计算

不依赖 DOM，Node 与浏览器（计算 Worker）共用。每个文件一两行；各轮加了什么、函数的细节见 [第四十轮时的文件结构原文](history/文件结构（第四十轮）.md) 与 history/ 下各轮的设计。人文在 [core-human.md](core-human.md)。

## 网格与几何
- `mesh.ts` 网格（平面、球面两种），图上的最短路（`graphDistanceSame` / `graphDistanceAvoid` / `graphDistanceOwner`）
- `sphere.ts` 球面网格：斐波那契撒点、球面 Delaunay、显示用的三角网、最近格
- `mesh-pack.ts` 网格的打包与拆包（网格 Worker 建好转交，与就地建的逐值相同）
- `geo.ts` 整个星球的几何：经度绕回、球面距离、大圆、球面上的圆

## 地形
- `generate.ts` 随机世界：地壳高度、板块、火山锥；裂开漂移的大陆块、三角形半岛、地峡（第三十五轮）。第八十三轮拆开（照旧全部导出）：`generate-model.ts` 设置、类型的参数与模型的类型，`generate-rifts.ts` 裂开的大陆块与地峡，`generate-sample.ts` 每格的取样（大陆场、板块边界）
- `outline.ts` 大陆轮廓的式子与常数（切口、大陆架、洋中脊、地峡、半岛；地区与星球共用）
- `relief.ts` 大格局（第三十二轮）：板块栅格与距离变换、基准面、高原、洼地；第八十六轮：大陆倾斜的衰减长度 0.35（`RELIEF_TUNING`）
- `planet-gen.ts` 整个星球的生成器（球面板块、大陆块、热点岛链）；`planet-form.ts` 星球形态的格式。第八十三轮拆开：`planet-gen-model.ts`（布局坐标 `LAYOUT_R`、类型、向量小工具）、`planet-gen-rifts.ts`、`planet-gen-sample.ts`（每格的取样）、`planet-gen-crust.ts`（形态的地形脚本）
- `terrain.ts` 组合地形（`resolveTerrain`；第八十六轮：造山带的抬升往中间集中 `beltCore` / `BELT`）、空闲预热的分段采样，照旧导出下面几个（第八十三轮拆出）：`terrain-coast.ts` 海岸噪声、潟湖、填海块（`fillSeaPockets`）、小洼地的湖；`terrain-brush.ts` 画陆地 / 画海、打碎、抬升的画笔；`islands.ts` 放岛、碎岛；`island-chains.ts` 湖里的岛、岛链、`placeIsland`、`combineStamps`
- `island-types.ts` 岛的种类与编号（`causes.islandType`、`LAGOON_BIT`）、省份按格分陆海（`provinceLand`、`landProvinceCells`、`landPixelCells`）
- `elevation.ts` 高程的入口与按陆块的记忆（`fromMemo`）；第八十三轮拆开（照旧全部导出）：`elevation-solve.ts` 抬升-侵蚀稳态的求解、迎风坡、洼地，`seafloor.ts` / `seafloor-coast.ts` 海底（`seafloor`）与它用的岸边属性，`elevation-lakes.ts` 湖底（`lakeBedShape`）、画的湖、只挖河床（`carveBeds`）
- `plains.ts` 冲积平原、冲积扇、三角洲平原（第三十三轮）
- `glacial.ts` 冰川刻蚀与冰川湖群（第三十四轮）；第八十六轮：冰盖按现在的纬度、冷暖笔刷、太阳（`iceStrength` → `derived.ice`，每格超过冰盖南界多少度），在流水线里按米挖（`scourTerrain`，求解之后、气候按没挖的地形）；第八十八轮：只涂了冷暖时冰盖只重算涂过的格（`iceStrengthAt`），南界与小洼的噪声分开、用到才算；`glacial-legacy.ts` 第八十五轮在求解里挖的写法（测试退回旧地形用）
- `elevation-precip.ts` 求解用的降水代理（第八十六轮）：纬度带 × 顺着盛行风走过的陆路 × 雨影（按东西坐标顺风扫），流量按它加权（`wetWeights`），干的内陆多出平底的洼地；`precipOn` 测试用的开关
- `sea-ice.ts` 海冰（第八十六轮）：按两个半年与全年的海面气温，冬天的范围与多年冰（`seaIceAt`，只是画法）
- `reefs.ts` 珊瑚礁（第八十六轮）：暖、浅、离大河口远的海格的强度（`reefStrength`，写进岩性层的白沙，只是画法）
- `routing.ts` 汇流路由（Priority-Flood + 最陡下降；第八十八轮：逐格的几段是模块里的小函数，每次只重置活动格）；`routing-parts.ts` 水文的路由按陆块记（`routeByParts`：没变的陆块照用，第八十八轮）；`heap.ts` 类型化数组的堆
- `stats.ts` 地形统计量与和地球比（`tools/terrain-stats.ts`、`tools/realism-report.ts` 用）

## 气候与水
- `climate.ts` 地区的气候：风带季风、水汽输运、洋流的增减（`planeSeaOf`、`currentTemps`），分层缓存（`planeLayers`）；下面四个是第四十六轮搬出去的，它照旧导出
- `climate-physics.ts` 共用的式子：扩散一轮 `smoothPass`、日照、辐射平衡温度（每格调的 `saturation`、`petHalf` 留在 `climate.ts`）
- `climate-flow.ts` 平面的输运图：网格的邻接反查与扫描顺序、入流表 `buildFlow`、拓扑序 `kahnOrder`
- `wind-deflect.ts` 山挡风（平面与球面共用）
- `content-memo.ts` 按内容做键的缓存 `ContentMemo`
- `planet-climate.ts` 整个星球的气候（`sphereStatic` / `sphereLand` 分层缓存）；第八十三轮拆出 `planet-land-fraction.ts`（陆地比例的模糊）、`planet-climate-steps.ts`（气温、水汽扫掠、海风、季风等小步）；`sphere-flow.ts` 球面上的输送
- `ocean.ts` 简化洋流与海面温度（整个星球）
- `ocean-plane.ts` 一块地区的洋流（第四十六轮）：粗栅格（像素约 3 格、长边 ≤ 128）上的风生环流、上涌、海温输送、带上陆地；按像素上取到的海陆、温度、风缓存；`ocean-raster.ts` 它用的只看像素的小算子（挡流陆地、海岸距离、平滑、倒角距离）
- `hydrology.ts` 填洼汇流、湖、径流（`cut`：断流的格）、湖底修深（`shapeLakeBeds`）、坡度缓存（`slopeMemo`；第八十八轮：只重算高度变了的格与邻格）
- `rivers.ts` 描河（`traceRivers`），照旧导出下面几个（第八十三轮拆出）：`rivers-line.ts` 折线的类型、平滑与曲流、编码、画的河的导线、几何小工具；`rivers-shore.ts` 对画面上岸线的查询；`rivers-mouth.ts` 河口（`normalMouth`、`tidyMouths`）；`rivers-branch.ts` 三角洲分汊（`withBranches`）；`rivers-ribbon.ts` 河画出来的带子（`riverRibbon`）
- `delta.ts` 三角洲的河口与亚格子海岸凸出（`deltaBulge`）
- `coast-memo.ts` 描河时按画面海岸场的查询跨几次描河记下来
- `coast-style.ts` 海岸类型（峡湾、沙坝、溺谷、小湖群的权重）与着色器海岸值纹理 b、a 的打包；`LOOK`、`SKERRY_REACH`；第八十八轮：冰盖变了时按强度比哪些格要重算
- `fjords.ts` 峡湾（第三十六轮）：谷网 `buildFjordNet`（按块）；第八十三轮拆出（照旧导出）：`fjord-base.ts` `FJ` 常数、谷网的类型、候选的谷段、画法的场，`fjord-layer.ts` `fjordLayer`（着色器的峡湾纹理）；第八十八轮：`fjord-cells.ts` 每格撒的点与两格的点连不连按网格记着（`cellPoints`、`linkBits`），一块的一带没变时照用几何、只重算预算（`reweighTile`）
- `river-pack.ts` 地图上的河在计算 Worker 里描好打包（`worldRivers`），主线程 `seedRivers` 拆开直接用；`riverDraw`；第八十轮：`riversId` 这一份的编号（没变时快照不带河，主线程 `reseedRivers` 用手上拆好的）；第八十八轮：记最近几份（撤销、重做回到前几步时照用，键里多了冰盖、汇水面积）
- `river-edit.ts` 改一条河（拖控制点、加删弯点、重画一笔）
- `water-types.ts` 河流类型、湖泊类型共用的部分：声明式条件（`when`）、一遍要做什么（`waterPlan`）、允许表编译成查表（`waterRules`）；`river-types.ts` 河流类型（每格哪种河、河网 `riverNet`、断流的格 `stopCells`、河岸场）；`river-segments.ts` 短段并进相邻的段；`lake-types.ts` 湖泊类型；`water-table.ts` 允许表的读写（生态页、河湖页共用）。第五十七轮：湖的条件多大小（`LAKE_WHEN_KEYS`）；`river-pack.ts` 的带子按线缓存（`memoDraws`）；`rivers.ts` 断流的尾巴（`RiverLine.tail`）；`vegetation.ts` 的 `baseBiomes` 只算河格和湖岸（`waterCells`）；`biome-scripts.ts` 的记录按遍分开（`SLOT_*`），同一遍里比较快照的结果复用（`newScriptPass`）；`waterPlan` 的 `reuseFirstBase`：奇幻库第二遍的类型读第一遍的生态
- `effects.ts` 生态、河湖对周围冷暖干湿的影响

## 生态

同一个东西有几个名字（第七十一轮记下，存的字段、命令名不改）：**生态**（界面、文档）= `species`（世界里的 `small.species`、命令 `add_species` / `update_species`、检查器的页）= `biome`（内容种类的 id、资源包的段 `biomes`、涂生态的工具）= `vegetation`（算哪里长什么的那一步，`vegetation.ts`；结果是每格的主导生态 `derived.dominant`，底图“生态分区”的 id 是 `dominant`）。资源库面板里“生态与水系”这一层叫 `ecology`（路由 `{ p: 'ecology' }`、`PageEcology.tsx`）。一种生态算哪一大类（荒漠、森林、苔原、冰盖、沼泽湿地）只看 `species.ts` 的 `biomeGroupOf`：写了 `group` 用它，没写的按导出用的地形（`terrain`；奇幻的三种森林靠这一条）。

- `species.ts` 生态类型（色块 + 条件 + 耐受曲线）、`PATTERNS`、大类 `BIOME_GROUPS` 与 `biomeGroupOf`；高度范围（第五十五轮：`height`、`heightTolerance`、`speciesTolerances`，算适宜度时用后者；第七十二轮：读进来的海拔条件换成高度范围逐值相同时换 `elevationAsHeight`，资源包的 `biomes` 读的时候用它；高山的下限 `ALPINE_LOW`）
- `vegetation.ts` 适宜度 / 竞争 / 扩散 / 长在哪里 / 不计水体类型的一遍（baseBiomes）/ 没有生态的陆地格的兜底（`fillBare`，写了高度范围的世界才走）；第八十九轮：场 `shelter`（有遮蔽的海岸，`shelterGetter`：三圈以内陆地的比例按网格记着，陆海变了的格附近作废），红树林用
- `constraints.ts` 涂生态的反推与“没涂成”的原因
- `biome-look.ts` 生态在地图上的样子（颜色脚本、花纹与发光的算式，着色器里同一份）；`biome-scripts.ts` 生态的脚本在世界上运行
- `script.ts` 脚本的运行环境（编译、中英文变量表、辅助函数、安全模式、给看门狗报平安；冻结的 Math 副本）

## 地名、画风、省份
- `features.ts` 地理要素识别的入口（`detectFeatures`、画的河、用户圈的地名区块）；第八十三轮拆开（照旧导出）：`features-base.ts` 种类与格图工具，`features-terrain.ts` 从地形认的（群岛、海、湖、河、山……，跨几次的记忆），`features-nature.ts` 生态区与物种的地名，`features-names.ts` 起名、前后地物配对留名字
- `names.ts` 模板式起名；`name-styles.ts` 地名风格（模板式、音译式，`styleFor`）；`name-display.ts` 中文 / 原文 / 两者
- `map-style.ts` 画风的格式（`DEFAULT_LOOK` 就是写实）、`styleRgba`、`worldMapStyle`、签名 `mapStyleKey`；第八十七轮：手绘的几项（纸、水彩、水纹、符号、墨色、字体、导出的装饰）可以不写、没有默认值，读时按 `HAND_OFF` 补（`handLook`、`hasSymbols`）
- `provinces.ts` 省份的划分、局部重划、修补（海、陆、湖三类）、湖与陆地的整理（`lakeProvinceFix`）；`province-kinds.ts` 种类、目标大小、起名、统计（第八十三轮拆出）；`province-rules.ts` 划分的规则（第七十八轮起是资源库里的内容“省份划分”：格式、默认的一份、世界的那一份 `worldProvinceRules`，种子在 `small.provinceSeed`）
- `select.ts` 画笔、拖动扩张、画河的路线、圈一片、剪刀沿线切省；画的河照着线走（第八十三轮拆出，照旧导出）：`course-base.ts` 计划的类型，`course-plan.ts` 描线与汇合，`course-overlap.ts` 重叠分析，`course-edit.ts` 并入、延长、改道、提醒；`seams.ts` 剪刀的切线

## 引擎与命令
- `world.ts` 世界的数据（原因、推导、小数据 `SmallState`、各种 schema）；`world-token.ts` 一个世界全部数组的“这一批”编号（`arraysToken`，第八十轮：主线程上数组没变时相同；城市表、城市地标的列表、国家的统计按它当键）
- `commands.ts` 命令的入口：`applyCommand`（校验、撤销记录、内容的增减）、`revert`、`runOp`；照旧导出 `Command`、`Dirty`……
- `commands/` 第四十一轮从 commands.ts 拆出来：`schema.ts` 命令的格式（`baseCommands` 的先后不要调换）、`shared.ts` 共用的（`Dirty`、`UndoRecord`、`ApplyContext`、`RunResult`）、每类一个 `runXxxOp`：`terrain.ts`、`nature.ts`（生态、约束、画的河、河湖岛的种类、场）、`provinces.ts`、`features.ts`（地名、片区、内容、风格、画风）、`human.ts`、`settlements.ts`、`archive.ts`（第八十五轮：国家的备注、统治者、家族、大事）
- `engine.ts` 历史、撤销缓存、预览、检查点、空闲预热（`warmSteps`）、`fixLakeProvinces`；第八十三轮拆出：`engine-recompute.ts` 按标记重算的流水线（`recomputeDerived`、`passStats`；第八十六轮：气候这一层更新冰盖 `derived.ice`，推导的高程 = 地形挖冰川（`elevation.ts` 的 `glacialTerrain`）再挖河床），`engine-types.ts` 世界文件、检查点、预览结果的类型，`engine-helpers.ts` 预览的差异、复制世界
- `small-copy.ts` 小数据的副本（第四十七轮）：内容（`small.content`，不可变）按引用共用，别的是一段 JSON；撤销记录、比较、预览的克隆都用它第五十四轮：人口群体（`small.popGroups`）也按引用共用。第八十五轮：国家的档案（`small.archive`）也是，`postedSmall` 占位内容和档案，`withoutContent` 只占位内容（预览、快照里内容没换时）。
- `preview-world.ts` 预览世界（只带变了的数组；`postedPatch`：内容没换时不发）；`doc-version.ts` 世界文件的版本（`DOC_VERSION`）与打开前的检查
- `rng.ts` 随机数与噪声（按位置取，与格数无关）；`digest.ts` 64 位哈希；`errors.ts`、`type-id.ts`、`world-types.ts` 为避免循环引用拆出来的小文件

## 内容与资源包
- `content/registry.ts` 内容种类的登记表（`ContentKind`、`allKinds`、`kindOf`）；编辑器的字段表 `FieldDesc`（第四十五轮：`ref` / `keyRef` 引用什么，`tuple`、`tuples`、`title`、`titleList`、`tendencies` 几种成块的字段）；`content/kinds.ts` 现有的种类在这里登记（登记的先后有意义）；`content/province-kind.ts` 省份划分（第七十八轮，一个世界一份，改了湖的归属马上整理）
- `content/links.ts` 内容之间的引用表（第四十九轮）：由字段表推出，一项引用了什么、谁引用它、依赖的闭包（`hard` / `auto` / `strip` / `gate`，`gate` 是“限谁用”，全部落空就不能导入）、改名时跟着改（`renameLinks`）、去掉引用（`stripLinks`）；第七十三轮字段表多了 `follow`（去得掉的引用导入时也跟着带：时代的国家格局）；`content/link-rules.ts` 每种内容一条补充；`content/pack-tree.ts` 走包的树（`packs.ts` 照旧导出）
- `content/arrange.ts` 融入（第六十轮）：库的 `arrange`（下级 → 上级，只改显示）、讲得通的组合 `RELATIONS`（怎么读出下面有哪些、加和移出改哪一项）、预设 `PRESET_ARRANGE`、`childrenOf`、`parentsOf`、`looseItems`
- `content/refs.ts` 引用的底层：脚本字面量的位置、两项是不是一模一样（`sameItem`、`sameContent`）；`content/usage.ts` 内容用在哪里；`content/unused.ts`（第五十轮起也看文化、文化组、地名风格、时代）哪里都没用到的；`content/cleanable.ts`（第六十二轮）生成后没用到的：面板上变淡的、“清理没用到的”清的都是它，生态、河、湖、画风不算；`content/origin.ts` 每项来自哪个包、改名前的 id；`content/missing.ts` 缺了什么
- `packs.ts` 资源包的格式、检查、用到世界、从世界导出（各段由登记表推出）；`readPack` 读文件（资源包、单独的文字包；第七十二轮起不认裸的生态数组）
- `packs/builtin-tree.ts` 六个内置的库（第五十一轮：每个时代一个完整的库，由同一份数据拼出来；四个历史库带全部 EU4 文化组，不默认带的比重 0；第七十七轮起默认带的组带着这个时代的比重（各组占多少，`groupPack`）；`LIBRARY_BASE_PACKS`、`worldPartsOf` 是世界的底子）；`packs/base.ts` 库里“基础”由代码写的几样（第七十八轮：基础里还有内置的省份划分，见 `province-rules.ts`）；`packs/nature.ts` 15 种生态（`builtinBiomesIn` 某一大类的 id）、`packs/biome-ids.ts` 它们的 id（别的内置数据点名生态时用）；`packs/planet-forms.ts` 星球形态；`packs/map-styles.ts` 写实、地图册，第八十七轮的手绘（`DRAWN_MAP_STYLES`，在每个库单独的小包“手绘画风”`drawn` 里，新世界不带）；`packs/countries/` 国家等级（第四十二轮；第七十七轮去掉了格局）
- `packs/import.ts` 生成要用的内容从资源包加进世界（时代包整个加时不带世界的底子，比重 0 的组点名才带），`importIntoPack` 把一个包的内容导入另一个包（撞名改名；第六十一轮：文化组放进“文化”下面自己的小包，取值放进同一维的小包，包不再整个拷贝）；`packs/names/` 内置地名风格（一个 JSON 一种，92 种；`eu4-a/b/c.ts` 是第四十三轮照 EU4 文化组补的 49 种，`fiction-a/b/c/d.ts` 是第四十四轮给奇幻、科幻的组补的 16 种）；`packs/eras/`、`packs/governments/`、`packs/settlements/` 见 [core-human.md](core-human.md)
- `packs/source-diff.ts` 世界里的一项和来源的库比（第六十二轮）：`sourceDiff`（一样、不同、只差导入时去掉的引用、来源不在了）、`usedSourceItem`（用库里的版本）、`savedBackItem`（存回我的库）
- `packs/import-gates.ts` 导入时一项能不能选（第六十四轮）：`importGates(来源, 目的地, 勾选, 去掉的)` 给 `free` / `have` / `fixable` / `gated`（写要什么；第六十六轮加 `resolvable`：要的在这个来源里勾得到，`choices` 是勾得到的那几个）/ `full`（写原因）；`walkClosure` 走勾的项、子项（库的 `arrange`）、去不掉的引用和写了 `follow` 的引用（第七十三轮），最小不动点，勾的文化带来的组记 `member`；派系主要靠的变量只看来源库提供的（第六十五轮）；来源的表按对象记着
- `packs/import-relation.ts` 来源的一项和目的地同 id 的一项（第六十六轮从 import-gates.ts 搬出）：比较用的字（`contentKey`）、目的地是不是来源去掉几条引用后的样子（`relationOf`）、补回（`restoredLinks`）、比重回来（`weightBack`）
- `packs/closure.ts` 导入（第六十一轮，第六十四轮重写）：`importPreview` 算清单（`list` 树形、`rows`）、`count`（等于 `rows.length`，就是真的写入的）、`stripCount`、`dropped`（灰的、放不下的，带原因）、补回；勾的文化带来的组比重和勾的组一样（第六十六轮）；`importCommand` 导入本世界（一个 batch，变量走 `add_dimension`，撤销条 `importLabel`“添加“X”等 N 项”）；`importToPack` 导入库（不动安排）
- `packs/add-dimension.ts` 从资源库给世界加一个变量（第五十四轮，“文化 ⋯”和时代规则的“加变量”用）：`dimensionOptions` 能加的；`addDimensionCommand` 批量：先加取值、取值组，再 `add_dimension`
- `packs/switch.ts` 已有的世界换一个库的计划（第五十二轮）：`worldLibrary` 世界现在用的库；`librarySwitchPlan` 给出加什么、移出什么（来自旧库、新世界用新库不带的）、来源改写到哪里、还在用留下的；两个库都有、世界里没改过的项逐字比，比重不同的组换成新库的（第七十七轮）。`commands/switch.ts` 的 `leaveLibrary` 在生成的命令里照着做（`switchLibrary`）世界自己加的变量（第五十四轮）：新库没有时带到新时代，取值不移出。
- `packs/fantasy-*.ts` 奇幻的内容（生态、河流类型、湖泊类型、星球形态；`fantasy-water.ts` 第五十七轮的六种河），奇幻库新建世界时默认带上生态、河、湖
- `packs/water.ts` 现实的水系（第五十七轮）：七种河、七种湖，只有声明式条件，六个库的“水系”小包
- `compact.ts` 压缩世界文件（第五十轮：只去掉“加了又删”）；`tidy.ts` 整理本世界的计划（在副本上试，地图不变才移出）

## 输出
- `subcell.ts` 格以下的细节、栅格化（`rasterizeWorld`），屏幕与导出共用，着色器里同一套式子；第八十三轮拆开（照旧导出）：`subcell-noise.ts` 与 GLSL 逐位一致的哈希与噪声，`subcell-coast.ts` 海岸值（`coastValues` / `shownCoastValues`）、破碎度、海岸类型，`subcell-locate.ts` 点在哪个三角形
- `display.ts` 画面上的一点画的是哪一格、画面上的海岸场（`displayCoast`、`displayCellAt`、`shoreCrossing`）
- `export.ts` 导出（第八十五轮：单独导出多了“导出维基” `wikiZip`）；`export-terrain.ts` 导出用的地形（id、中文名、地形图的颜色；生态的 `terrain` 选它）；`thumbnail.ts` 向导缩略图；`presets.ts` 世界大小、纬度带、星球格数（`planetCells`）

## 测试用
- `testing/fixtures.ts` 共用的世界模板与 `snapshot(key, build)`（建一次，每个测试拿副本）；`withoutHeights`、`plainEngine`（第五十五轮之前的生态，比算法和旧代码相同的测试用）；第七十七轮去掉的参数换成库里的规则：`humanExec` / `generateHuman` 收带比重的组（`TestGroup`，比重写进世界里的组）和改时代的 `era`，`fragKm2`（以前的“分裂 ↔ 统一”换成时代的国家大小）、`OLD_LAYOUTS`（以前的四种格局）、`eraCommand` / `setEra`；第七十八轮：以前 generate_provinces 的规则换成改世界里的省份划分（`provinceRulesCommand` / `setProvinceRules`、先改再划分的 `divideProvinces`，以前的小 · 中 · 大是 `OLD_SIZES`）；`testing/eras.ts` 按时代查内置内容
- `testing/round85.ts` 把生成的地形退回第八十五轮（`useRound85Terrain`：降水代理、山带集中、倾斜的长度、冰川的挖法几个开关，测试的新世界不加红树林；`withoutIce`），查工具、画河、求解这些逻辑、在旧地形上找好了地方的测试用（第八十六轮）
- `testing/class-only.ts` 只改类别的一串命令的摘要（第五十八轮，和 f01e102 记下的 `human/class-only-digests.json` 对照；不要改它）
- `golden-full.json`、`golden-hashes.json`、`r31-digests.json`、`human/r29-digests.json` 金标准与摘要：不要重录（见 [测试](tests.md)）
