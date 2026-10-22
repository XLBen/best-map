// 命令出错（参数不对、做不了）：界面把 message 原样告诉用户。
// 单独放一个不引用别的模块的小文件：script.ts 在模块顶层就要用它（class ScriptError extends CommandError），
// 而 species.ts 要引用 script.ts 的 scriptsSchema。放在 commands.ts 里会形成
// species → script → commands → species 的环，commands.ts 顶层读 speciesSchema 时还没初始化。
// commands.ts 照旧导出它，原来的 import 不用改
export class CommandError extends Error {}
