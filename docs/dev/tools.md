# tools/ 与根目录

## 命令行
- `generate.ts` 批量生成并导出；`hash.ts` 各层的哈希（核对 Node 与浏览器逐值一致）
- `terrain-stats.ts` 地形统计；`preview-terrain.ts` 地形预览图；`realism.ts` + `realism-report.ts` 和地球比（`realism.test.ts` 是慢测试）

## 测速与对照（见 [性能](performance.md)）
- `bench.ts` 加工各步的耗时（`--globe`、`--long`、`--pack fantasy`、`--hash`、`--library`：带着一整个时代库的世界，另计不重算的几步，第四十七轮；`--no-water`：新世界不带现实的水系，第五十七轮，和同一个提交带着的对照；`overlay-ab`、`compose-ab` 加 `--plain` 画没有河湖类型的世界；`--kept`：再生成人文，另计改人口、改国家、存文件，第五十轮），每种都在最后另计 `classRelief`、`classHeight`、`classOnly`（第五十八轮：抬山同样的笔画涂类别，21 次的中位数）；`bench-median.mjs` 跑几次取中位数，`--against <提交>` 与旧提交对照（把现在的 `bench.ts` 复制过去，所以 `--library` 在旧提交上也能跑）；基准存在 `bench-baseline/`。第七十九轮：`--era <id>` 让 `--library`、`--kept` 用这个时代的库（六个时代），`--kept` 另计重新生成国家 `regenCountries`；`bench-median.mjs` 的 `--head <提交>` 新的一边也检出（量的时候可以接着改代码），`--script <文件>` 跑别的测速脚本（如 `bench-layers.ts`）
- `bench-layers.ts` 各视图模式的着色计时（第三十九轮；第七十九轮跟上第七十七、七十八轮的命令）
- `bench-lib-edit.ts` 带六个库的存储里改我的库一项：旧的整库校验对新的单项校验（第五十九轮）
- `bench-pointer.vitest.ts` 鼠标移动的计时，在 vitest 里跑（`npx vitest run -c tools/bench.vitest.config.ts`）
- `bench-legend.vitest.ts` 画了一笔以后取地图图例的耗时，对照第七十八轮的写法（第七十九轮；`--silent=false` 看输出，`BENCH_GLOBE=1` 用类地星球）
- `bench-steady.ts` 同一个世界上抬山、岩性、冷暖笔各做 21 次的中位数（第七十九轮：编译好以后的，分辨一步一次的数是不是真的变慢；`--script tools/bench-steady.ts` 和旧提交对照）
- `compose-ab.mjs` + `compose-ab-page.ts` 无头 Chrome 里对照两个提交的合成着色器，逐字节比
- `overlay-ab.mjs` + `overlay-ab-page.ts` 无头 Chrome 里对照两个提交的叠加层（一串帧逐字节比；第八十轮加了带首都的星的几帧）与选国家；`--against <提交>`
- `bench-country-ui.mjs` + `bench-country-ui-page.ts` 国家界面的测速（第八十轮）：无头 Chrome（默认用这台机器的显卡，`--soft` 按软件画）里两边各挂地图、底部条、图例、“这里”、国家的档案，量改名到画完下一帧、领土笔刷移动、换档案的页、选国家的主线程时间；`--against <提交>`（默认 1cd3bea）、`--head <提交>`、`--quick`（只量地区）、`--globe`（只量星球）、`--keep`；网址带 `#rename` 等时新的一边包在 `console.profile` 里（开发时用 CDP 收）
- `flow-layer.mjs` + `flow-layer-page.ts` 风向、洋流的帧时间（关着 / 只开风 / 只开洋流 / 都开）与线看不看得清（真的底图上量 ΔE，`--png` 存图），第四十八轮
- `r40-world.ts` 叠加层测试、测速用的世界（种子 3，人文、国家、城市）
- `rewrite-factions.mjs` 一次性（第五十三轮）：从 bcf2c05 的 JSON 推出政体的派系名单和基础分量，写进 `core/packs/`；`--check` 查可复现，`--table` 打印

## 开发服务器与一键开启
- `isolated-engine.ts` Vite 插件：开发服务器上现打包计算 Worker（`/__map2/engine.js`，开发时也隔离）；`isolated-engine.test.ts`
- `launch.mjs` 一键开启（查 Node 版本、装依赖、打包、开浏览器）；`launchers.test.ts` 查两个启动文件
- 根目录：`启动-Mac.command`、`启动-Windows.bat`（运行 `tools/launch.mjs`；bat 只能用 ASCII、CRLF）、`vite.config.ts`（测试的超时与排除也在这里）、`index.html`
