# src/render/：画地图

WebGL2 底图 + 2D 画布的矢量叠加。屏幕与导出共用同一套画法；改了画法要跑 `node tools/compose-ab.mjs` / `node tools/overlay-ab.mjs` 逐字节对照（见 [性能](performance.md)）。设计见 history/ [第37轮](history/第37轮.md)（描格）、[第38轮](history/第38轮.md)（画风）、[第39轮](history/第39轮.md)（图层提速）、[第40轮](history/第40轮.md)（叠加层提速）、[第87轮](history/第87轮.md)（手绘画风）。

## WebGL
- `renderer.ts` 渲染器 `Renderer`：编号层、地形层、切线层、合成四遍；每一帧（停稳、移动中的半分辨率、投影）、停稳补全（`SETTLE_MS`）、屏幕与地图的换算。第八十三轮按职责拆成一串基类（方法原样搬，照旧从 renderer.ts 导出）：`renderer-base.ts` 状态与上传、`renderer-layers.ts` 网格与逐格的图层、描格（`setFocus`）、`renderer-draw.ts` 各层与合成、极地与投影、`renderer-export.ts` 导出的分块；`renderer-parts.ts` 类型与小工具（镜头、场景 `planScene`、`FOCUS_REACH`、`packElevation` / `packCoast`）；`style-uniforms.ts` 画风的 uniform（`styleUniforms`）
- `shaders/` 着色器源码（第四十一轮从 renderer.ts 原样搬出）：
  - `common.ts` 共用片段：噪声、破碎度 `FRAG_GLSL`、海岸类型 `STYLE_GLSL`、峡湾 `FJORD_GLSL`、花纹、岩性、`withoutFx`、`TEX_W`
  - `plane.ts` 平面的顶点 / 编号 / 地形 / 切线着色器、省份规则、描格 `FOCUS_GLSL`；第八十六轮：海的浅水不盖过格颜色里的海冰（`iceK`）
  - `compose.ts` 合成着色器 `FS_COMPOSE`
  - `hand.ts` 手绘画风的一段（第八十七轮：纸、水彩、岸外的水纹、粗一点的墨线；`uHand` 为 0 时不走，写实、地图册逐像素不变；离岸多远按场景颜色里海岸线的 mipmap 量，渲染器手绘时给场景颜色生成 mipmap）
  - `sphere.ts` 星球、极地、投影的着色器：由平面的按 `must` / `mustAll` 替换出来（替换次数不对就报错）
  - `index.ts` 测试用的 `COMPOSE_SOURCES`、`TERRAIN_SOURCES`、`PROJ_SOURCES`、`SHADER_PROGRAMS`；`shader-hashes.json` 每个程序源码的 sha256（`shader-sources.test.ts` 查；有意改着色器时 `RECORD_SHADERS=1` 重记）
- `colors.ts` 每格的颜色与几层数据（`cellLayers`：底子与每种模式的一层、花纹、湖色；第八十六轮：地貌一类的底图上按季节盖海冰）；第八十三轮拆出（照旧导出）：`color-ramps.ts` 色带与共用的小工具、碎岛的颜色，`colors-human.ts` 人文、省份 / 国界的分组、岩性（第八十六轮：自动的珊瑚礁写进白沙）、高亮，`ghost-buffer.ts` 幽灵海岸（`GhostBuffer`）
- `near.ts` 离边界远的格（合成里跳过环上的点，第三十九轮）
- `projection.ts` 整个星球的等面积、球形投影：正反算式与同一套 GLSL `PROJ_GLSL`、镜头换算、`sceneNeed`
- `perf.ts` 测速开关（`?perf`、`window.__perf`）；`bench.ts` 开发用的帧测速（`__map2Bench`）

## 2D 叠加层
`overlay.ts` 第四十一轮拆成几个文件、代码原样；外面照旧只从 `overlay.ts` 引。
- `overlay.ts` 底下那一层的缓存（离屏画布、移动中挪用）、`drawOverlay` / `overlayParts`（底下、图形、上面三段）、屏幕上什么都没变时不画（`drawScreen`）
- `overlay-base.ts` 共用的类型（`OverlayState`、`OverlayPaths`、`Shape`、`Frame`、`LabelBox`、`PlacedLabel`）、`refZoom`、`copiesFor`、字宽缓存、测速 `perf`
- `overlay-static.ts` 静态的键（`FIELD_KIND` 表：新加一项叠加层选项要在这里写它算不算静态）、`staticKey`、`sameShapes`（第八十轮：不再每次建 Set）
- `overlay-rivers.ts` 河线（`riverLines`、`seedRivers`）、路径（`buildPaths`）、河的画法（宽度、颜色、样式）
- `overlay-river-layer.ts` 河画进叠加层或离屏的河的图层（`riverLayer`、`riverLayerTile`、`riverLayerScene`，极地）
- `overlay-labels.ts`（第八十七轮：字体按画风 `labelFamily`，没写时照旧；`labelTexts` 要写的字）地名、山峰、城市与地标的排版（`placeLabels`：按格子避让 `BoxIndex`，移动中沿用版面）与画法（`drawLabels`；第四十二轮淡一些的点按 `alpha` 画，`settleStrong` 里的照 1 画）、`peakLabels`；第八十九轮：先放国名、所有的图标（`placeSettlements` 只放图标），名字（`placeSettleName`）与地名（`placeFeature`）按先后排成一串再放
- 第八十九轮（地名的新排版）：`label-place.ts` 字号分档 `FEATURE_TIER`、先后 `RANK`（`settleRank`）、候选位置（`AREA_CANDS`、`nameSpots8`）、横写 `placeStraight`、沿水写 `placeWaterCurve`、沿河写 `placeRiverCurve`；`label-lines.ts` 海、湖的中线 `waterLine`（按世界的地物缓存 `featureLinesOf`，`OverlayState.featureLines`）、平滑的河 `smoothRiver`
- `overlay-country-labels.ts` 国名、片区名沿中线弯着写（`smoothPath`、`layoutAlong`、`COUNTRY_KEY`、`REGION_KEY`）；第八十二轮：多大是 `CountryFit`（`COUNTRY_FIT`：不超过 40 px、画面短边的 5%、领土粗细的 0.28，铺满中线的七成；`OverlayState.countryFit` 省略时按它），以前的 `COUNTRY_FIT_R81` 只给对照冻结参照的测试用；第八十九轮：`CountryLabelDraw.scale`（国家等级的字号倍数）乘最大字号
- `overlay-grid.ts` 经纬网、纬度刻度、比例尺
- `overlay-shapes.ts` 工具的预览图形（圈、线、箭头、格、河）；第八十轮：一遍图形里颜色、线宽和上一个相同时不再设（`resetPen`，画出来逐像素相同）
- `overlay-proj.ts` 投影时的叠加层（`projectedParts`）
- `settle-draw.ts` 城市、道路、地标、点的图标与道路的画法，避让用的格子 `BoxIndex`；第八十四轮的海路 `RoadDraw.sea`（细的长虚线，`seaLaneStyle`；`overlay-proj.ts` 投影里同样画）
- `wind.ts` 风与洋流的流线：按场（风按 `flowSeason`、洋流碰到陆地就停）分块算、块的缓存有上限、新的块空闲时算（`dropWindQueue` 丢掉排着的）；`windLines` / `currentLines` 取看得见的线，`strokeFlows` 画（可逐线投影）
- `wind-layer.ts` 把开着的风向、洋流画进叠加层（第四十八轮起是两个开关）：停稳贴位图、移动中挪位图，转球时直接画（逐点投影的系数按线记下）；都关着时一笔不画，`releaseFlows` 放掉位图、丢掉排着的块
- `export-plan.ts` 导出整张地图的算式（虚拟镜头、分块、`autoSeam`；不碰 WebGL）
- 第八十七轮（手绘画风）：`symbol-place.ts` 山、丘陵、森林的符号放在哪里（每格的编码 `cellCodes`、按块 `symbolTile` / `tilesIn`、两轮“比周围都大就留下”不重叠、确定，块的键是四周一圈格的编码的哈希，改了高程只重算那一片；不碰画布）；`overlay-symbols.ts` 画符号（每个符号贴一张按种类、大小、屏幕半径记住的小图，画进叠加层最底下那一层）、纸的暗角 `drawVignette`、图例用的 `drawSymbolIcon`；`export-decor.ts` 导出的罗盘、标题、边框、图例（`DecorOptions`、`defaultDecor`：手绘全开、别的全关）；`label-font.ts` 画风的网页字体按字请浏览器载入（`askGlyphs`，导出前 `loadGlyphs` 等着）
