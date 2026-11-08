# core/human/：人文

流水线里人文的几层（`Dirty.Human` 只重算这里与名字）。设计见 history/：[第21轮](history/第21轮.md)（地形类别、资源、格的档案）、[第22轮](history/第22轮.md)（时代、文化、人口）、[第23轮](history/第23轮.md)（国家与政体）、[第24轮](history/第24轮.md)（城市、道路、地标、点）、[第26轮](history/第26轮.md)（等级、领土补齐、集团）、[第27轮](history/第27轮.md)（自动的结果）、[第30轮](history/第30轮.md)（时代就是资源包）、[第42轮](history/第42轮.md)（国家等级是内容）、[第43轮](history/第43轮.md)（EU4 的文化组、宗教组与政体名）、[第44轮](history/第44轮.md)（政体限谁用；奇幻、科幻照 EU4 重做）、[第73轮](history/第73轮.md)（国家一步按步拆开、国家格局）、[第74轮](history/第74轮.md)（各时代的历史格局、民族主义、殖民地）、[第75轮](history/第75轮.md)（奇幻的种族王国、科幻的殖民据点、档案里格局的角色）、[第84轮](history/第84轮.md)（人口在国家之前、首都挪到人口重心、国界顺着山河、资源有用处、港口与海路、宗教的发源地、改气候后人口挪动）。

## 格的几层（第二十一轮）
- `index.ts` 流水线里的一步 `computeHuman` 与给界面的函数（`countryLabels`、`regionLabels`、`peakMarks`、`cellName`……）
- `rules.ts` 按格的条件（地形类别的自动规则、资源的分布规则共用）
- `terrain-class.ts` 地形类别（内置 5 种起伏、世界里的列表、自动分类、画过的；`cellMovement`、`paradoxTerrain`、`terrainLabel`）
- `class-ground.ts` 涂类别时地面跟着变（第五十八轮）：这一笔下面的平均高度、每格抬升的变化、写进 `upliftDelta`、擦掉时回去；命令在 `commands/human.ts` 的 `paintClassGround`
- `resources.ts` 资源（内置通用 18 种、奇幻 5 种，按噪声分布；第八十四轮的 `habitability`、`cityBonus` 两项，省略时按种类 `RESOURCE_EFFECT`；`resourceEffects`、分人口用的宜居度 `resourceHabitability`）
- `peaks.ts` 山峰；`cells.ts` 格的小地名与档案
- `cell-memo.ts` 自动的类别、资源、宜居度按格记下（只重算输入变了的格）
- `kinds.ts` 地形类别、资源登记进登记表

## 时代、文化、人口（第二十二轮）
- `era.ts` 时代（第七十三轮起写国家格局 `patterns` 与民族主义 `nationalism`，`relations` 只剩集团的称号；从属的种类第七十四轮多了殖民地 `colony`，第七十五轮多了公司领地 `company`）、取值、取值组（第四十三轮）、文化组、文化的格式与世界里的列表（`worldEra`、`worldCultures`、`worldDimensions`……）；文化的倾向 `cultureTendency`（文化按时代 → 文化 → 组按时代 → 组）、风格 `styleOfCulture`、异端 / 异教 `faithRelation`
- `pop-kinds.ts` 这五种登记进登记表
- `context.ts` 生成各步共用的 `GenContext`；`generate.ts` 生成人文（分步、复制内容、重新生成；`generateHuman`、`regenerateHuman`、`humanBlockers`；用的包记在 `small.genStamp`，第五十一轮以前是 `human.packs`；第七十七轮：命令只写文化组的 id，各组占多少是组的比重 `cultureGroup.weight`，`human.groups` 只记 id，`countryRules` 只有种子）
- `habitability.ts` 宜居度与偏好（第七十九轮 `preferenceProducts`、`preferenceFactorsAfter`：文化的偏好在组的双精度乘积上接着乘）；`cultures.ts` 文化圈；`culture-style.ts` 地名跟着文化
- `population.ts` 人口、修补、笔刷（`paintPop`、`setCellPop`、`applyPopFix`；第七十九轮 `composeCell` 按候选的下标拼数查群体，`valueDistAt`；第八十四轮：首都一带多出来的人 `scalePopulation`，`populationFix` 带上一步的宜居度时宜居度变了的一带的人在本国里重新分 `habitabilityMoves`）；`religion-spread.ts` 宗教的发源地与传播（第八十四轮，`SPREAD_DIMS`、`spreadValues`、`spreadFactor`）；`groups.ts` 人口群体的编号与每格成分（`codeFor`：键已拼好）
- `add-dimension.ts` 给已有的世界加一维（第五十四轮）：现有的人原地分开，文化比例逐值不变（`fillPopulation`）；生成时后加的维度最后分开（`fillAddedDims`）；群体的上限 `MAX_POP_GROUPS`。`era.ts` 的 `composedDims`、`filledDims` 分哪几维排列组合，`MAX_DIMENSIONS` 每个时代最多 8 维
- `layers.ts` 人口的几层、图例、档案的人口一栏、每省人口；`space.ts` 面积、距离、噪声、按份额长
- `packs/eras/` 内置 6 个时代（一个 JSON 一个）、`values/` 共用的取值与宗教组、`cultures/` EU4 的 71 个文化组 410 个文化（一个地区一个 JSON）与奇幻、科幻的组（`fantasy.json` 11 组、`scifi.json` 9 组，第四十四轮）；奇幻的宗教组在 `fantasy.json` 时代文件的 `valueGroups`

## 国家与政体（第二十三轮、第二十六轮）
- `government.ts` 政体、派系的格式与世界里的列表，政体列的派系 `governmentFactions`（第五十三轮）；称号按国家等级与换说法（`govTitles`、`tierTitle`，第四十三轮），限谁用（`only`、`govAllowed`，第四十四轮），地标、集团的称号 `pickTitle`；`gov-kinds.ts` 登记进登记表
- `countries.ts` 只是照旧导出（第七十三轮拆进 `countries/`，一步一个文件，见 [第73轮](history/第73轮.md)）；`country-names.ts` 国名的地名部分、人名
- `countries/base.ts` 常数、`CountryPlan`、清掉国家、`countryList`、`pickWeighted`；`state.ts` 一次生成共用的 `CountryRun`（种子、按名字的随机流 `stream` / 共用的 `shared`、起点 `Seed`、预留的地方 `Region`、各步的结果、集团一步的 `bloc`）
- `countries/count.ts` 几个国家（`averageCountryKm2` 就是时代的 `countryKm2`，第七十七轮去掉了“分裂 ↔ 统一”；`plannedCountries`、`apportion`、`landComponents`、`countCountries`）；`seeds.ts` 挑政体（`govWeights`、`pickGov`，限谁用）、等级（`govFit`）、起点（`placeSeeds`）；`grow.ts` 两遍往外长（`growOwners`，预留的地方、格局加的代价 `stepCost`，第七十九轮长之前合成一个函数；第八十四轮过大河、翻分水岭的倍数 `crossingCosts` → `CountryRun.cross`，领土补齐的那一圈也用）；`capitals.ts` 首都（第八十四轮：集团之后挪到人口的重心一带最好的城址 `bestCapital`、`placeCapitals`，再按 `countryPopScale` 让首都一带的人多一些）；`cleanup.ts` 隔海的、住满、湖、飞地（`cleanupOwners`，`Seed.overseas` 的不放掉；飞地那一步 `mergeDetached` 格局改了领土后再调）
- `countries/records.ts` 颜色、名字（`titleContext`：等级 + `cultureContext`：主流文化、最典型的宗教……）、称号、建国年份、历史、写进原因建档案（`writeRecords`）；`diplomacy.ts` 邻国、附庸（格局的钩子）、同盟与敌对；`stage.ts` 国家一步按先后调各步与格局的钩子（`growCountries`；往外长之前放开 `Region.open`）、首都一带的人口、国家的移民（之前殖民地掺进新土认同）；`relate.ts` 集团一步（`blocsStage`，帝国、联邦、同盟是格局的 relate）
- `countries/patterns.ts` 国家格局（第七十三轮）：模块的接口（`reserve`、`grow`、`after`、`diplomacy`、`relate` 五个钩子）、登记（`registerPattern`，先后就是调的先后）、时代的格局 → 每个模块的用法（`patternUses`）、`runPatterns`；`patterns/` 内置的模块：第七十三轮的 `holy-empire.ts`（邦联并成帝国，诸侯的个数第七十四轮成了参数）、`federation.ts`、`alliance.ts`、`vassals.ts`；第七十四轮的 `city-league.ts` 城邦群、`river-empire.ts` 大河帝国、`central-empire.ts` 集权帝国、`khanate.ts` 游牧汗国、`colonies.ts` 殖民地（列强、名字、颜色、新土认同 `settleColonies`）、`multiethnic.ts` 多民族帝国、`nationalism.ts` 民族主义（时代没列也用）、`unification.ts` 民族统一、`nation-state.ts` 民族国家、`post-colonial.ts` 前殖民地国家；第七十五轮的 `race-realms.ts` 种族王国（种族那一维 `raceDimension`、地方的三类 `landKinds`：古林、山地、荒原；古林的种族守着森林，山地的分成几个要塞小国结成同盟，荒原的结成部落联盟；长完以后空着的、住得下人的地方归别的王国 `fillLeftover`）、`outposts.ts` 殖民据点（本族最大的几国当宗主，公司领地或殖民据点；只占自己那一片，`trimOutposts`）；模块的 `tip`（资源库里的一句）、`roles`（档案里的一句，`roleText`；Seed.role → CountryMeta.role）；`common.ts` 共用的圈地方、撒起点（`scatterSeeds`）、陆块与本土（`lands`、`homeLands`）、草原荒漠（`steppeSpecies`）、长完以后的并国与压紧（`mergeOwners`、`dropSeeds`、`addSeed`）；`index.ts` 按先后登记、格局项的格式 `countryPatternSchema`（各模块的参数平铺）；`pattern-kinds.ts` 国家格局（`countryPattern`）登记进登记表
- `country-edit.ts` 改国家的命令、整理、改地形后的修补
- `country-layers.ts` 国家的一层、国界的分组、颜色、统计、派系影响力 `countryFactions`（政体列的，基础分量加人口，用到时才算，第五十三轮；来源可以按与国教的关系）、国教 `countryFaith`、国名的位置
- `claims.ts` 领土补齐（国家一步之后、人口之前）；`blocs.ts` 帝国、联邦、同盟（`small.blocs`）的查、名字、整理、命令（生成在 `countries/relate.ts` 与格局里）、同盟模式的颜色（`memberBlocs`：殖民地跟着宗主）；`federate.ts` 把一国切成联邦的成员邦（第七十三轮从 `blocs.ts` 分出来）
- `tiers.ts` 国家等级的格式与世界里的列表（按 order 排）、生效的比例 `tierWeights`（只按时代的 tiers；第七十七轮去掉了每个世界选的格局 countryLayout）、邦联 / 联邦 / 附庸的规则、首都的样子 `capitalLook`（第四十二轮）；`tier-kinds.ts` 登记进登记表；`packs/countries/` 内置的五级、十八种国家格局（`patterns.json`，放在每个库的“时代”小包里）
- `flags.ts` 旗帜的规则与 SVG；`packs/governments/` 内置政体与派系
- `auto.ts` 自动的结果（`causes.countryAuto`、`popAuto*`），橡皮擦的“恢复自动”（第二十七轮）

## 城市、道路、地标、点（第二十四轮）
- `settle-types.ts` 城市等级（第四十二轮多了地图上的浓淡、大小）、地标类型、点的类型的格式与等级规则；`settle-content.ts` 世界里的列表；`settle-kinds.ts` 登记进登记表
- `settlements.ts` 城市的生成，照旧导出下面几个（第八十三轮拆出）：`city-table.ts` 现算的表（等级、人口、所属、名字），`city-edit.ts` 编辑与修补，`city-archive.ts` 档案
- `roads.ts` 道路（代价、A* 与最近的路网、生成、改走向、修补；第八十四轮最后连海路 `SEA_LANE`）；`ports.ts` 港口与海路（第八十四轮：`isPortCell`、`seaLanes`、`laneIntact`）
- `landmarks.ts` 地标（自然的检测器、人造的放法、名字、命令）；`points.ts` 自定义点
- `settle-gen.ts` 一起生成（生成人文的最后一步与命令共用）
- `archive.ts` 导出的表与档案全文；`packs/settlements/` 内置的城市等级、地标类型、点的类型
