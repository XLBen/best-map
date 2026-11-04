# core/：纯计算

不依赖 DOM，Node 与浏览器（计算 Worker）共用。每个文件一两行；各轮加了什么、函数的细节见 [第四十轮时的文件结构原文](history/文件结构（第四十轮）.md) 与 history/ 下各轮的设计。人文在 [core-human.md](core-human.md)。

## 网格与几何
- `mesh.ts` 网格（平面、球面两种），图上的最短路（`graphDistanceSame` / `graphDistanceAvoid` / `graphDistanceOwner`）
- `sphere.ts` 球面网格：斐波那契撒点、球面 Delaunay、显示用的三角网、最近格
- `mesh-pack.ts` 网格的打包与拆包（网格 Worker 建好转交，与就地建的逐值相同）
- `geo.ts` 整个星球的几何：经度绕回、球面距离、大圆、球面上的圆

## 地形
- `generate.ts` 随机世界：地壳高度、板块、火山锥；裂开漂移的大陆块、三角形半岛、地峡（第三十五轮）
- `outline.ts` 大陆轮廓的式子与常数（切口、大陆架、洋中脊、地峡、半岛；地区与星球共用）
- `relief.ts` 大格局（第三十二轮）：板块栅格与距离变换、基准面、高原、洼地
- `planet-gen.ts` 整个星球的生成器（球面板块、大陆块、热点岛链）；`planet-form.ts` 星球形态的格式
- `terrain.ts` 组合地形（`resolveTerrain`）、画笔、放岛、岛链、湖里的岛（`placeIsland`、`lakeIslandStamp`）、填海块（`fillSeaPockets`）、空闲预热的分段采样
- `island-types.ts` 岛的种类与编号（`causes.islandType`、`LAGOON_BIT`）、省份按格分陆海（`provinceLand`、`landProvinceCells`、`landPixelCells`）
- `elevation.ts` 抬升-侵蚀稳态、海底（`seafloor`）、湖底（`lakeBedShape`）、湖里的岛的高度；按陆块的记忆（`fromMemo`）
- `plains.ts` 冲积平原、冲积扇、三角洲平原（第三十三轮）
- `glacial.ts` 冰川刻蚀与冰川湖群（第三十四轮）
- `routing.ts` 汇流路由（Priority-Flood + 最陡下降）；`heap.ts` 类型化数组的堆
- `stats.ts` 地形统计量与和地球比（`tools/terrain-stats.ts`、`tools/realism-report.ts` 用）

## 气候与水
- `climate.ts` 地区的气候：风带季风、水汽输运、洋流的增减（`planeSeaOf`、`currentTemps`），分层缓存（`planeLayers`）；下面四个是第四十六轮搬出去的，它照旧导出
- `climate-physics.ts` 共用的式子：扩散一轮 `smoothPass`、日照、辐射平衡温度（每格调的 `saturation`、`petHalf` 留在 `climate.ts`）
- `climate-flow.ts` 平面的输运图：网格的邻接反查与扫描顺序、入流表 `buildFlow`、拓扑序 `kahnOrder`
- `wind-deflect.ts` 山挡风（平面与球面共用）
- `content-memo.ts` 按内容做键的缓存 `ContentMemo`
- `planet-climate.ts` 整个星球的气候（`sphereStatic` / `sphereLand` 分层缓存）；`sphere-flow.ts` 球面上的输送
- `ocean.ts` 简化洋流与海面温度（整个星球）
- `ocean-plane.ts` 一块地区的洋流（第四十六轮）：粗栅格（像素约 3 格、长边 ≤ 128）上的风生环流、上涌、海温输送、带上陆地；按像素上取到的海陆、温度、风缓存；`ocean-raster.ts` 它用的只看像素的小算子（挡流陆地、海岸距离、平滑、倒角距离）
- `hydrology.ts` 填洼汇流、湖、径流（`cut`：断流的格）、湖底修深（`shapeLakeBeds`）、坡度缓存（`slopeMemo`）
- `rivers.ts` 河流折线与河画出来的带子（`riverRibbon`）、河口（`normalMouth`、`tidyMouths`）、三角洲分汊（`withBranches`）
- `delta.ts` 三角洲的河口与亚格子海岸凸出（`deltaBulge`）
- `coast-memo.ts` 描河时按画面海岸场的查询跨几次描河记下来
- `coast-style.ts` 海岸类型（峡湾、沙坝、溺谷、小湖群的权重）与着色器海岸值纹理 b、a 的打包；`LOOK`、`SKERRY_REACH`
- `fjords.ts` 峡湾（第三十六轮）：谷网 `buildFjordNet`（按块）、`fjordLayer`、着色器的峡湾纹理、`FJ` 常数
- `river-pack.ts` 地图上的河在计算 Worker 里描好打包（`worldRivers`），主线程 `seedRivers` 拆开直接用；`riverDraw`
- `river-edit.ts` 改一条河（拖控制点、加删弯点、重画一笔）
- `water-types.ts` 河流类型、湖泊类型共用的部分：声明式条件（`when`）、一遍要做什么（`waterPlan`）、允许表编译成查表（`waterRules`）；`river-types.ts` 河流类型（每格哪种河、河网 `riverNet`、断流的格 `stopCells`、河岸场）；`river-segments.ts` 短段并进相邻的段；`lake-types.ts` 湖泊类型；`water-table.ts` 允许表的读写（生态页、河湖页共用）。第五十七轮：湖的条件多大小（`LAKE_WHEN_KEYS`）；`river-pack.ts` 的带子按线缓存（`memoDraws`）；`rivers.ts` 断流的尾巴（`RiverLine.tail`）；`vegetation.ts` 的 `baseBiomes` 只算河格和湖岸（`waterCells`）；`biome-scripts.ts` 的记录按遍分开（`SLOT_*`），同一遍里比较快照的结果复用（`newScriptPass`）；`waterPlan` 的 `reuseFirstBase`：奇幻库第二遍的类型读第一遍的生态
- `effects.ts` 生态、河湖对周围冷暖干湿的影响

## 生态
- `species.ts` 生态类型（色块 + 条件 + 耐受曲线）、`PATTERNS`；高度范围（第五十五轮：`height`、`heightTolerance`、`speciesTolerances`，算适宜度时用后者）
- `vegetation.ts` 适宜度 / 竞争 / 扩散 / 长在哪里 / 不计水体类型的一遍（baseBiomes）/ 没有生态的陆地格的兜底（`fillBare`，写了高度范围的世界才走）
- `constraints.ts` 涂生态的反推与“没涂成”的原因
- `biome-look.ts` 生态在地图上的样子（颜色脚本、花纹与发光的算式，着色器里同一份）；`biome-scripts.ts` 生态的脚本在世界上运行
- `script.ts` 脚本的运行环境（编译、中英文变量表、辅助函数、安全模式、给看门狗报平安；冻结的 Math 副本）

## 地名、画风、省份
- `features.ts` 地理要素识别（陆块、海、山脉、群岛……；用户圈的地名区块；前后地物配对留名字）
- `names.ts` 模板式起名；`name-styles.ts` 地名风格（模板式、音译式，`styleFor`）；`name-display.ts` 中文 / 原文 / 两者
- `map-style.ts` 画风的格式（`DEFAULT_LOOK` 就是写实）、`styleRgba`、`worldMapStyle`、签名 `mapStyleKey`
- `provinces.ts` 省份规则、划分、局部重划、修补（海、陆、湖三类）、湖与陆地的整理（`lakeProvinceFix`）
- `select.ts` 画笔、拖动扩张、画河的路线、圈一片、剪刀沿线切省；`seams.ts` 剪刀的切线

## 引擎与命令
- `world.ts` 世界的数据（原因、推导、小数据 `SmallState`、各种 schema）
- `commands.ts` 命令的入口：`applyCommand`（校验、撤销记录、内容的增减）、`revert`、`runOp`；照旧导出 `Command`、`Dirty`……
- `commands/` 第四十一轮从 commands.ts 拆出来：`schema.ts` 命令的格式（`baseCommands` 的先后不要调换）、`shared.ts` 共用的（`Dirty`、`UndoRecord`、`ApplyContext`、`RunResult`）、每类一个 `runXxxOp`：`terrain.ts`、`nature.ts`（生态、约束、画的河、河湖岛的种类、场）、`provinces.ts`、`features.ts`（地名、片区、内容、风格、画风）、`human.ts`、`settlements.ts`
- `engine.ts` 流水线、历史、撤销缓存、预览、检查点、空闲预热（`warmSteps`）、`fixLakeProvinces`
- `small-copy.ts` 小数据的副本（第四十七轮）：内容（`small.content`，不可变）按引用共用，别的是一段 JSON；撤销记录、比较、预览的克隆都用它第五十四轮：人口群体（`small.popGroups`）也按引用共用。
- `preview-world.ts` 预览世界（只带变了的数组；`postedPatch`：内容没换时不发）；`doc-version.ts` 世界文件的版本（`DOC_VERSION`）与打开前的检查
- `rng.ts` 随机数与噪声（按位置取，与格数无关）；`digest.ts` 64 位哈希；`errors.ts`、`type-id.ts`、`world-types.ts` 为避免循环引用拆出来的小文件

## 内容与资源包
- `content/registry.ts` 内容种类的登记表（`ContentKind`、`allKinds`、`kindOf`）；编辑器的字段表 `FieldDesc`（第四十五轮：`ref` / `keyRef` 引用什么，`tuple`、`tuples`、`title`、`titleList`、`tendencies` 几种成块的字段）；`content/kinds.ts` 现有的种类在这里登记（登记的先后有意义）
- `content/links.ts` 内容之间的引用表（第四十九轮）：由字段表推出，一项引用了什么、谁引用它、依赖的闭包（`hard` / `auto` / `strip`）、改名时跟着改（`renameLinks`）、去掉引用（`stripLinks`）；`content/link-rules.ts` 每种内容一条补充；`content/pack-tree.ts` 走包的树（`packs.ts` 照旧导出）
- `content/refs.ts` 引用的底层：脚本字面量的位置、两项是不是一模一样（`sameItem`、`sameContent`）；`content/usage.ts` 内容用在哪里；`content/unused.ts`（第五十轮起也看文化、文化组、地名风格、时代）哪里都没用到的；`content/origin.ts` 每项来自哪个包、改名前的 id；`content/missing.ts` 缺了什么
- `packs.ts` 资源包的格式、检查、用到世界、从世界导出（各段由登记表推出）
- `packs/builtin-tree.ts` 六个内置的库（第五十一轮：每个时代一个完整的库，由同一份数据拼出来；四个历史库带全部 EU4 文化组，不默认带的比重 0；`LIBRARY_BASE_PACKS`、`worldPartsOf` 是世界的底子）；`packs/base.ts` 库里“基础”由代码写的几样；`packs/nature.ts` 13 种生态；`packs/planet-forms.ts` 星球形态；`packs/map-styles.ts` 写实、地图册；`packs/countries/` 国家等级与格局（第四十二轮）
- `packs/import.ts` 生成要用的内容从资源包加进世界（时代包整个加时不带世界的底子，比重 0 的组点名才带），`importIntoPack` 把一个包的内容导入另一个包（撞名改名）；`packs/names/` 内置地名风格（一个 JSON 一种，92 种；`eu4-a/b/c.ts` 是第四十三轮照 EU4 文化组补的 49 种，`fiction-a/b/c/d.ts` 是第四十四轮给奇幻、科幻的组补的 16 种）；`packs/eras/`、`packs/governments/`、`packs/settlements/` 见 [core-human.md](core-human.md)
- `packs/add-dimension.ts` 从资源库给世界加一个变量（第五十四轮，界面和第六十一轮的导入窗口用）：`dimensionOptions` 能加的；`addDimensionCommand` 批量：先加取值、取值组，再 `add_dimension`
- `packs/switch.ts` 已有的世界换一个库的计划（第五十二轮）：`worldLibrary` 世界现在用的库；`librarySwitchPlan` 给出加什么、移出什么（来自旧库、新世界用新库不带的）、来源改写到哪里、还在用留下的。`commands/switch.ts` 的 `leaveLibrary` 在生成的命令里照着做（`switchLibrary`）世界自己加的变量（第五十四轮）：新库没有时带到新时代，取值不移出。
- `packs/fantasy-*.ts` 奇幻的内容（生态、河流类型、湖泊类型、星球形态；`fantasy-water.ts` 第五十七轮的六种河），奇幻库新建世界时默认带上生态、河、湖
- `packs/water.ts` 现实的水系（第五十七轮）：七种河、七种湖，只有声明式条件，六个库的“水系”小包
- `compact.ts` 压缩世界文件（第五十轮：只去掉“加了又删”）；`tidy.ts` 整理本世界的计划（在副本上试，地图不变才移出）

## 输出
- `subcell.ts` 格以下的细节（破碎度、海岸值 `coastValues` / `shownCoastValues`、栅格化），屏幕与导出共用，着色器里同一套式子
- `display.ts` 画面上的一点画的是哪一格、画面上的海岸场（`displayCoast`、`displayCellAt`、`shoreCrossing`）
- `export.ts` 导出；`thumbnail.ts` 向导缩略图；`presets.ts` 世界大小、纬度带、星球格数（`planetCells`）

## 测试用
- `testing/fixtures.ts` 共用的世界模板与 `snapshot(key, build)`（建一次，每个测试拿副本）；`withoutHeights`、`plainEngine`（第五十五轮之前的生态，比算法和旧代码相同的测试用）；`testing/eras.ts` 按时代查内置内容
- `testing/class-only.ts` 只改类别的一串命令的摘要（第五十八轮，和 f01e102 记下的 `human/class-only-digests.json` 对照；不要改它）
- `golden-full.json`、`golden-hashes.json`、`r31-digests.json`、`human/r29-digests.json` 金标准与摘要：不要重录（见 [测试](tests.md)）
