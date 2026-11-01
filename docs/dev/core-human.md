# core/human/：人文

流水线里人文的几层（`Dirty.Human` 只重算这里与名字）。设计见 history/：[第21轮](history/第21轮.md)（地形类别、资源、格的档案）、[第22轮](history/第22轮.md)（时代、文化、人口）、[第23轮](history/第23轮.md)（国家与政体）、[第24轮](history/第24轮.md)（城市、道路、地标、点）、[第26轮](history/第26轮.md)（等级、领土补齐、集团）、[第27轮](history/第27轮.md)（自动的结果）、[第30轮](history/第30轮.md)（时代就是资源包）。

## 格的几层（第二十一轮）
- `index.ts` 流水线里的一步 `computeHuman` 与给界面的函数（`countryLabels`、`regionLabels`、`peakMarks`、`cellName`……）
- `rules.ts` 按格的条件（地形类别的自动规则、资源的分布规则共用）
- `terrain-class.ts` 地形类别（内置 5 种起伏、世界里的列表、自动分类、画过的；`cellMovement`、`paradoxTerrain`、`terrainLabel`）
- `resources.ts` 资源（内置通用 18 种、奇幻 5 种，按噪声分布）
- `peaks.ts` 山峰；`cells.ts` 格的小地名与档案
- `cell-memo.ts` 自动的类别、资源、宜居度按格记下（只重算输入变了的格）
- `kinds.ts` 地形类别、资源登记进登记表

## 时代、文化、人口（第二十二轮）
- `era.ts` 时代、取值、文化组、文化的格式与世界里的列表（`worldEra`、`worldCultures`、`worldDimensions`……）
- `pop-kinds.ts` 这四种登记进登记表
- `context.ts` 生成各步共用的 `GenContext`；`generate.ts` 生成人文（分步、复制内容、重新生成；`generateHuman`、`regenerateHuman`、`humanBlockers`）
- `habitability.ts` 宜居度与偏好；`cultures.ts` 文化圈；`culture-style.ts` 地名跟着文化
- `population.ts` 人口、修补、笔刷（`paintPop`、`setCellPop`、`applyPopFix`）；`groups.ts` 人口群体的编号与每格成分
- `layers.ts` 人口的几层、图例、档案的人口一栏、每省人口；`space.ts` 面积、距离、噪声、按份额长
- `prune.ts` 生成之后只留用到的内容（第二十八轮）
- `packs/eras/` 内置 6 个时代（一个 JSON 一个）、`values/` 共用的取值、`cultures/` 23 个文化组

## 国家与政体（第二十三轮、第二十六轮）
- `government.ts` 政体、派系的格式与世界里的列表、称号；`gov-kinds.ts` 登记进登记表
- `countries.ts` 生成国家（两步）、颜色、名字、历史、等级；`country-names.ts` 国名的地名部分、人名
- `country-edit.ts` 改国家的命令、整理、改地形后的修补
- `country-layers.ts` 国家的一层、国界的分组、颜色、统计、派系影响力、国名的位置
- `claims.ts` 领土补齐（国家一步之后、人口之前）；`blocs.ts` 帝国、联邦、同盟（`small.blocs`）
- `flags.ts` 旗帜的规则与 SVG；`packs/governments/` 内置政体与派系
- `auto.ts` 自动的结果（`causes.countryAuto`、`popAuto*`），橡皮擦的“恢复自动”（第二十七轮）

## 城市、道路、地标、点（第二十四轮）
- `settle-types.ts` 城市等级、地标类型、点的类型的格式与等级规则；`settle-content.ts` 世界里的列表；`settle-kinds.ts` 登记进登记表
- `settlements.ts` 城市（生成、表与档案、命令、整理、修补）
- `roads.ts` 道路（代价、A* 与最近的路网、生成、改走向、修补）
- `landmarks.ts` 地标（自然的检测器、人造的放法、名字、命令）；`points.ts` 自定义点
- `settle-gen.ts` 一起生成（生成人文的最后一步与命令共用）
- `archive.ts` 导出的表与档案全文；`packs/settlements/` 内置的城市等级、地标类型、点的类型
