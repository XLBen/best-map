# src/render/：画地图

WebGL2 底图 + 2D 画布的矢量叠加。屏幕与导出共用同一套画法；改了画法要跑 `node tools/compose-ab.mjs` / `node tools/overlay-ab.mjs` 逐字节对照（见 [性能](performance.md)）。设计见 history/ [第37轮](history/第37轮.md)（描格）、[第38轮](history/第38轮.md)（画风）、[第39轮](history/第39轮.md)（图层提速）、[第40轮](history/第40轮.md)（叠加层提速）。

## WebGL
- `renderer.ts` 渲染器 `Renderer`：编号层、地形层、切线层、合成四遍；镜头、场景（`planScene`）、移动中的半分辨率、停稳补全（`SETTLE_MS`）、描格（`setFocus`、`FOCUS_REACH`）、画风的 uniform（`styleUniforms`）、`packElevation` / `packCoast`
- `shaders/` 着色器源码（第四十一轮从 renderer.ts 原样搬出）：
  - `common.ts` 共用片段：噪声、破碎度 `FRAG_GLSL`、海岸类型 `STYLE_GLSL`、峡湾 `FJORD_GLSL`、花纹、岩性、`withoutFx`、`TEX_W`
  - `plane.ts` 平面的顶点 / 编号 / 地形 / 切线着色器、省份规则、描格 `FOCUS_GLSL`
  - `compose.ts` 合成着色器 `FS_COMPOSE`
  - `sphere.ts` 星球、极地、投影的着色器：由平面的按 `must` / `mustAll` 替换出来（替换次数不对就报错）
  - `index.ts` 测试用的 `COMPOSE_SOURCES`、`TERRAIN_SOURCES`、`PROJ_SOURCES`、`SHADER_PROGRAMS`；`shader-hashes.json` 每个程序源码的 sha256（`shader-sources.test.ts` 查；有意改着色器时 `RECORD_SHADERS=1` 重记）
- `colors.ts` 每格的颜色与几层数据（`cellLayers`：底子与每种模式的一层、省份 / 国界的分组、岩性、花纹、幽灵）
- `near.ts` 离边界远的格（合成里跳过环上的点，第三十九轮）
- `projection.ts` 整个星球的等面积、球形投影：正反算式与同一套 GLSL `PROJ_GLSL`、镜头换算、`sceneNeed`
- `perf.ts` 测速开关（`?perf`、`window.__perf`）；`bench.ts` 开发用的帧测速（`__map2Bench`）

## 2D 叠加层
`overlay.ts` 第四十一轮拆成几个文件、代码原样；外面照旧只从 `overlay.ts` 引。
- `overlay.ts` 底下那一层的缓存（离屏画布、移动中挪用）、`drawOverlay` / `overlayParts`（底下、图形、上面三段）、屏幕上什么都没变时不画（`drawScreen`）
- `overlay-base.ts` 共用的类型（`OverlayState`、`OverlayPaths`、`Shape`、`Frame`、`LabelBox`、`PlacedLabel`）、`refZoom`、`copiesFor`、字宽缓存、测速 `perf`
- `overlay-static.ts` 静态的键（`FIELD_KIND` 表：新加一项叠加层选项要在这里写它算不算静态）、`staticKey`、`sameShapes`
- `overlay-rivers.ts` 河线（`riverLines`、`seedRivers`）、路径（`buildPaths`）、河的画法（宽度、颜色、样式）
- `overlay-river-layer.ts` 河画进叠加层或离屏的河的图层（`riverLayer`、`riverLayerTile`、`riverLayerScene`，极地）
- `overlay-labels.ts` 地名、山峰、城市与地标的排版（`placeLabels`：按格子避让 `BoxIndex`，移动中沿用版面）与画法（`drawLabels`；第四十二轮淡一些的点按 `alpha` 画，`settleStrong` 里的照 1 画）、`peakLabels`
- `overlay-country-labels.ts` 国名、片区名沿中线弯着写（`smoothPath`、`layoutAlong`、`COUNTRY_KEY`、`REGION_KEY`）
- `overlay-grid.ts` 经纬网、纬度刻度、比例尺
- `overlay-shapes.ts` 工具的预览图形（圈、线、箭头、格、河）
- `overlay-proj.ts` 投影时的叠加层（`projectedParts`）
- `settle-draw.ts` 城市、道路、地标、点的图标与道路的画法，避让用的格子 `BoxIndex`
- `wind.ts` 风与洋流的流线：按场（风按季节、洋流碰到陆地就停）分块算、块的缓存有上限、新的块空闲时算；`windLines` / `currentLines` 取看得见的线，`strokeFlows` 画（可逐线投影）
- `wind-layer.ts` 第四十六轮：“风与洋流”模式里把流线画进叠加层：停稳贴位图、移动中挪位图，转球时直接画（逐点投影的系数按线记下）；不在这种模式时一笔不画
- `export-plan.ts` 导出整张地图的算式（虚拟镜头、分块、`autoSeam`；不碰 WebGL）
