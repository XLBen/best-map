// 用户脚本的入口（第一百零一轮）：代码按职责分在 core/script/ 下，这里照旧导出全部，别处的引用不用改。
//   format.ts 容器与格式、变量 · shadow.ts 被遮住的名字 · issues.ts 出错的说明 · helpers.ts 辅助函数 · editor.ts 编辑器用 · compile.ts 编译与行号 ·
//   inputs.ts 输入 · run.ts 运行 · purity.ts 纯度检查
// 注意循环引用（原来写在这里的那一段）：ScriptError extends CommandError 在模块顶层就用到了 CommandError，所以它在不引用别的模块的
// errors.ts 里（commands.ts 照旧导出它）。species.ts 引用这里的 scriptsSchema，而 script/inputs.ts 经 world.ts 又引用 species.ts：
// species.ts 只能在 z.lazy(() => scriptsSchema) 里读它，不能在模块顶层直接读。commands.ts 也间接引用本文件
// （generate.ts → planet-form.ts、terrain.ts → planet-gen.ts）：core/script/ 下的文件不要值引用 commands.ts、generate.ts、terrain.ts、
// planet-gen.ts，否则循环又回来了


// 用户脚本（第三批）的运行环境：编译、绑定变量、整段循环地运行、检查返回值，出错时给出中文说明。
//
// 一段脚本是一个函数体，用户写 `return …`。五种脚本：
//   placement 长在哪里 —— 每个陆地格一次，返回 0–1 的数或 true/false，乘进生态的适宜度
//   color     颜色     —— 每格一次，返回 [r, g, b] 或 '#rrggbb'
//   match     哪些河（湖）是这一种 —— 每条河、每个湖一次，返回真或假
//   crust     地形     —— 整个星球每格一次，返回新的高度，或者 {height?, mountains?, hills?, rock?}
//   setup     布局     —— 每个星球模型一次（加大陆块、加岛）
//
// 确定性：脚本看不到时间、随机数、全局对象（这些名字被同名参数遮住，Math 换成没有 random 的冻结副本），
// 随机只能用 rand(k)：每格固定、与计算顺序无关。脚本能碰到的本模块的东西（辅助函数、它们的 prototype、
// Math 副本、Date 等替身）都是冻结的，生成代码自己的名字（运行状态、循环函数）在脚本里被遮成 undefined，
// 所以脚本没有地方“记住上一格”。剩下的路——在 JSON、Array.prototype、Math.sin 这些内置对象上挂东西，
// 或者 (()=>{}).constructor 拿到真正的 Function——遮名字挡不住，由 checkPurity 查出来（正反两遍、
// 隔一格一遍，再比较内置对象前后有没有被改）；提交脚本前必须通过它。
// 遮住名字只保证确定性，不是安全边界；安全靠把脚本放进隔离的 worker 里跑（见计划第三批“隔离”）。
//
// 出错分两种：
//   语法错误 —— 编译时抛 ScriptError（添加、修改脚本的命令当场被拒绝）；
//   运行时出错、算出 NaN、返回值类型不对 —— runScript 不抛错，返回 {ok: false, issue, output}，
//   output 是“当作没有这段脚本”的结果（系数 1、基础颜色、不匹配、地形不改），调用方照常用它。
//
// 编译好的函数只放在本模块的缓存里，绝不能放进会被克隆的数据（small、derived、命令、检查点）：
// structuredClone 和 postMessage 遇到函数会抛 DataCloneError。

export { type CellKind, codeOnly, findScripts, type FoundScript, type MatchScope, MAX_SCRIPT_CHARS, type Script, SCRIPT_API, SCRIPT_HELPERS, SCRIPT_KIND_LABEL, SCRIPT_KINDS, scriptHash, type ScriptKind, type Scripts, scriptsSchema, type ScriptVariable, scriptVariablesFor, VARIABLES } from './script/format';
export { ScriptError, type ScriptIssue } from './script/issues';
export { blockedNameText, SCRIPT_HELPER_NAMES, syntaxErrorText, unknownVariableText } from './script/editor';
export { type CompiledScript, compileScript, disallowScripts, type ParamMode, type ScriptParam, scriptsEnabled, scriptStats, setScriptsEnabled, setSyntaxLocator } from './script/compile';
export { arrayInputs, type BiomeInputs, incrementalDistance, type InputValue, type ScriptInputs, worldInputs } from './script/inputs';
export { type CellOutputs, type CellResult, type CrustOutput, type RunOptions, runScript, runSetup, type ScriptHost, setScriptHost, type SetupResult } from './script/run';
export { checkPurity, type PurityResult, usesBiomeHelpers } from './script/purity';
