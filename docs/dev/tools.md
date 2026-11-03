# tools/ 与根目录

## 命令行
- `generate.ts` 批量生成并导出；`hash.ts` 各层的哈希（核对 Node 与浏览器逐值一致）
- `terrain-stats.ts` 地形统计；`preview-terrain.ts` 地形预览图；`realism.ts` + `realism-report.ts` 和地球比（`realism.test.ts` 是慢测试）

## 测速与对照（见 [性能](performance.md)）
- `bench.ts` 加工各步的耗时（`--globe`、`--long`、`--pack fantasy`、`--hash`、`--library`：带着一整个时代库的世界，另计不重算的几步，第四十七轮；`--water`：七种河、七种湖带声明式条件，荒漠不允许普通河，第五十六轮，和同一个提交不带它的对照；`--kept`：再生成人文，另计改人口、改国家、存文件，第五十轮）；`bench-median.mjs` 跑几次取中位数，`--against <提交>` 与旧提交对照（把现在的 `bench.ts` 复制过去，所以 `--library` 在旧提交上也能跑）；基准存在 `bench-baseline/`
- `bench-layers.ts` 各视图模式的着色计时（第三十九轮）
- `bench-pointer.vitest.ts` 鼠标移动的计时，在 vitest 里跑（`npx vitest run -c tools/bench.vitest.config.ts`）
- `compose-ab.mjs` + `compose-ab-page.ts` 无头 Chrome 里对照两个提交的合成着色器，逐字节比
- `overlay-ab.mjs` + `overlay-ab-page.ts` 无头 Chrome 里对照两个提交的叠加层（一串帧逐字节比）与选国家；`--against <提交>`
- `flow-layer.mjs` + `flow-layer-page.ts` 风向、洋流的帧时间（关着 / 只开风 / 只开洋流 / 都开）与线看不看得清（真的底图上量 ΔE，`--png` 存图），第四十八轮
- `r40-world.ts` 叠加层测试、测速用的世界（种子 3，人文、国家、城市）
- `rewrite-factions.mjs` 一次性（第五十三轮）：从 bcf2c05 的 JSON 推出政体的派系名单和基础分量，写进 `core/packs/`；`--check` 查可复现，`--table` 打印

## 开发服务器与一键开启
- `isolated-engine.ts` Vite 插件：开发服务器上现打包计算 Worker（`/__map2/engine.js`，开发时也隔离）；`isolated-engine.test.ts`
- `launch.mjs` 一键开启（查 Node 版本、装依赖、打包、开浏览器）；`launchers.test.ts` 查两个启动文件
- 根目录：`启动-Mac.command`、`启动-Windows.bat`（运行 `tools/launch.mjs`；bat 只能用 ASCII、CRLF）、`vite.config.ts`（测试的超时与排除也在这里）、`index.html`
