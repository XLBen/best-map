// 报错改成人话（第九十六轮）：引擎、浏览器给的原话里常带英文（“Invalid input”“Cannot read properties of undefined”），
// 新手看不懂。这里只在显示的那一层翻：core/ 里的原话不动（进了金标准、快照、测试的断言），原话留在 detail 里，
// 界面放进“原因”的折叠里、能复制（问别人时用）。
// 纯函数，不碰界面：顶上的提示（state/notes.ts 的 showToast）、“上次的世界没能打开”的问话、自救页都用它

export interface HumanError {
  // 给用户看的一句
  text: string;
  // 原话（和 text 不一样时才有）
  detail: string | null;
}

// 引号、书名号里的是名字（文件名、地图名可以是英文），不算报错里的英文
// 全角括号里的也不算：程序自己在中文的话后面附的原话（脚本的“语法不对（Unexpected token）”）
const QUOTED = /“[^”]*”|"[^"]*"|'[^']*'|‘[^’]*’|《[^》]*》|（[^）]*）/g;
// 连着两个以上的英文词，或者一个 XxxError
const ENGLISH = /[A-Za-z][A-Za-z']+(?:[ \t]+[A-Za-z][A-Za-z']+)+|\b[A-Za-z]*(?:Error|Exception)\b/;
const CJK = /[一-鿿]/;

// 这句话里有没有用户看不懂的英文（单个的词不算：WebGL2、JSON、km、Esc）
export function looksEnglish(s: string): boolean {
  return ENGLISH.test(s.replace(QUOTED, ''));
}

// zod 说的类型
const TYPE: Record<string, string> = {
  number: '数',
  int: '整数',
  string: '文字',
  boolean: '是或否',
  object: '一组设置',
  array: '列表',
  record: '一组设置',
  nan: '不是数的值',
  null: '空的',
};

// zod 的一条（默认的英文）；自己写的中文原样
function zodIssue(msg: string): string {
  if (!looksEnglish(msg) && CJK.test(msg)) return msg;
  let m: RegExpExecArray | null;
  if ((m = /^Invalid input: expected ([\w"|. -]+?), received (\w+)/.exec(msg))) {
    if (m[2] === 'undefined') return '缺了一项';
    const want = TYPE[m[1]];
    const got = TYPE[m[2]];
    return want && got ? `应该是${want}，给的是${got}` : want ? `应该是${want}` : '';
  }
  if ((m = /^Too small: .*?>=?\s*(-?\d+(?:\.\d+)?)/.exec(msg))) return `太小，不能小于 ${m[1]}`;
  if ((m = /^Too big: .*?<=?\s*(-?\d+(?:\.\d+)?)/.exec(msg))) return `太大，不能大于 ${m[1]}`;
  if (/^Invalid option/.test(msg)) return '不在可以选的几种里';
  if (/^Unrecognized keys?/.test(msg)) return '有不认识的项';
  if (/^Required/.test(msg)) return '缺了一项';
  if (/^Invalid number: must be a multiple/.test(msg)) return '应该是整数';
  // “Invalid input”：几种写法都对不上（命令的格式是“几种里的一种”，多半只有这一句），没有更细的可说
  return '';
}

// “命令参数无效：”后面那一串（core/commands/shared.ts 的 formatIssues：“路径：话；路径：话”）。路径是英文的字段名，不给用户看
function zodIssues(list: string): string {
  const issues = list.split('；').filter((s) => s.trim());
  const first = issues[0] ?? '';
  const at = first.indexOf('：');
  const said = zodIssue(at >= 0 ? first.slice(at + 1) : first);
  if (!said) return '这一步的内容格式不对';
  return `这一步的内容不对：${said}${issues.length > 1 ? `，另有 ${issues.length - 1} 处` : ''}`;
}

// 浏览器、JS 引擎的原话 → 一句人话。先后有意义（先认具体的）
const RULES: [RegExp, string][] = [
  [/out of memory|allocation failed|Invalid (?:typed )?array length|Array buffer allocation/i, '内存不够'],
  [/QuotaExceeded|exceeded the quota/i, '浏览器存储满了'],
  [/dynamically imported module|Importing a module script failed|Unable to preload CSS|Failed to load module script/i, '没能读到程序的文件，请重新载入'],
  [/Failed to fetch|NetworkError|Load failed|network error/i, '没能读到要用的文件'],
  [/SecurityError|operation is insecure/i, '浏览器不让这样做'],
  [/NotAllowedError|Permission denied|not allowed by the user agent/i, '浏览器没有允许'],
  [/NotFoundError|could not be found/i, '要用的东西找不到了'],
  [/AbortError|user aborted|operation was aborted/i, '已取消'],
  [/WebGL|shader|GLSL|ERROR: \d+:\d+|context lost/i, '显卡没能画出来'],
];

// 内部出错时说的那一句（界面在后面接“这一步没做”之类）
export const INTERNAL_ERROR = '程序内部出错';

function leaf(raw: string): string {
  if (!looksEnglish(raw)) return raw;
  for (const [re, text] of RULES) if (re.test(raw)) return text;
  return INTERNAL_ERROR;
}

function human(raw: string): string {
  let m: RegExpExecArray | null;
  // 脚本出的错（core/script.ts 已经写成中文，后面带着解析器、运行时的原话）：写脚本的人要看原话，原样
  if (raw.includes('脚本')) return raw;
  // 打开世界文件时重放到某一步出错（core/engine.ts）
  if ((m = /^第 (\d+) 条命令失败：([\s\S]*)$/.exec(raw))) return `第 ${m[1]} 步做不出来：${human(m[2])}`;
  // 命令的格式不对（core/commands.ts）
  if ((m = /^命令参数无效：([\s\S]*)$/.exec(raw))) return zodIssues(m[1]);
  // 前半句是中文、后半句带英文（“世界没能恢复：TypeError: …”）：前半句留着
  const at = raw.indexOf('：');
  if (at > 0) {
    const head = raw.slice(0, at);
    if (CJK.test(head) && !looksEnglish(head) && looksEnglish(raw.slice(at + 1))) return `${head}：${human(raw.slice(at + 1))}`;
  }
  return leaf(raw.trim());
}

export function humanError(raw: unknown): HumanError {
  const s = rawText(raw);
  const text = human(s) || INTERNAL_ERROR;
  return { text, detail: text === s ? null : s };
}

// 抛出来的东西写成一段字（Error 带名字；不是 Error 的原样）
export function rawText(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.name && e.name !== 'Error' && !e.message.startsWith(e.name) ? `${e.name}: ${e.message}` : e.message || e.name || INTERNAL_ERROR;
  if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') {
    const o = e as { name?: unknown; message: string };
    return typeof o.name === 'string' && o.name && o.name !== 'Error' ? `${o.name}: ${o.message}` : o.message;
  }
  if (e === undefined || e === null) return INTERNAL_ERROR;
  try {
    return String(e);
  } catch {
    return INTERNAL_ERROR;
  }
}
