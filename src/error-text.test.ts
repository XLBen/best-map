import { describe, expect, it } from 'vitest';
import { commandSchema } from '../core/commands/schema';
import { formatIssues } from '../core/commands/shared';
import { INTERNAL_ERROR, humanError, looksEnglish, rawText } from './error-text';

// 第九十六轮：报错改成人话。原话留在 detail 里（界面放进“原因”的折叠，能复制）；本来就是人话的原样、不带 detail

describe('本来就是中文的原样', () => {
  it.each([
    '重放第 3 步出错：找不到生态',
    '存储已满，“My World”没能自动保存。请删除几张地图，或导出世界文件',
    '读不出“world final.json”',
    '浏览器不支持浮点渲染目标（EXT_color_buffer_float）',
    '计算程序没有响应，这一步没做',
    '“world v2.json”不是世界文件',
    '已停止，回到了这一步之前',
    '导出失败',
  ])('%s', (s) => {
    expect(humanError(s)).toEqual({ text: s, detail: null });
  });

  it('脚本出的错原样：写脚本的人要看解析器、运行时的原话', () => {
    const s = '“苔原”的长在哪里脚本第 3 行出错：ReferenceError: foo is not defined';
    expect(humanError(s)).toEqual({ text: s, detail: null });
    const t = '“苔原”的脚本有语法错误：语法不对（Unexpected token }）';
    expect(humanError(t).text).toBe(t);
  });

  it('引号里的英文名字、单个的英文词不算', () => {
    expect(looksEnglish('没能打开“My Old World”')).toBe(false);
    expect(looksEnglish('浏览器不支持 WebGL2')).toBe(false);
    expect(looksEnglish('Invalid input')).toBe(true);
    expect(looksEnglish('TypeError')).toBe(true);
  });
});

describe('引擎的原话', () => {
  it('命令的格式不对：真的 zod 给的那一句（“(根)：Invalid input”）不给用户看', () => {
    const r = commandSchema.safeParse({ op: '没有这种命令' });
    expect(r.success).toBe(false);
    if (r.success) return;
    const raw = `命令参数无效：${formatIssues(r.error)}`;
    // 确实是任务书里说的那一句
    expect(raw).toBe('命令参数无效：(根)：Invalid input');
    expect(humanError(raw)).toEqual({ text: '这一步的内容格式不对', detail: raw });
  });

  it('打开世界文件时重放到某一步出错：说是第几步', () => {
    const raw = '第 7 条命令失败：命令参数无效：(根)：Invalid input';
    expect(humanError(raw)).toEqual({ text: '第 7 步做不出来：这一步的内容格式不对', detail: raw });
    expect(humanError('第 12 条命令失败：找不到生态“苔原”').text).toBe('第 12 步做不出来：找不到生态“苔原”');
    expect(humanError("第 3 条命令失败：Cannot read properties of undefined (reading 'id')").text).toBe(`第 3 步做不出来：${INTERNAL_ERROR}`);
  });

  it('zod 别的几种说法', () => {
    const h = (issue: string) => humanError(`命令参数无效：${issue}`).text;
    expect(h('params.seed：Invalid input: expected number, received string')).toBe('这一步的内容不对：应该是数，给的是文字');
    expect(h('cells：Invalid input: expected array, received undefined')).toBe('这一步的内容不对：缺了一项');
    expect(h('amount：Too small: expected number to be >=0')).toBe('这一步的内容不对：太小，不能小于 0');
    expect(h('amount：Too big: expected number to be <=1')).toBe('这一步的内容不对：太大，不能大于 1');
    expect(h('kind：Invalid option: expected one of "a"|"b"')).toBe('这一步的内容不对：不在可以选的几种里');
    expect(h('(根)：Unrecognized key: "foo"')).toBe('这一步的内容不对：有不认识的项');
    expect(h('a：Too small: expected number to be >=0；b：Invalid input')).toBe('这一步的内容不对：太小，不能小于 0，另有 1 处');
    // 自己写的中文的校验原样
    expect(h('name：名字不能是空的')).toBe('这一步的内容不对：名字不能是空的');
  });

  it('前半句是中文、后半句是原话：前半句留着', () => {
    expect(humanError('世界没能恢复：TypeError: x is not a function')).toEqual({ text: `世界没能恢复：${INTERNAL_ERROR}`, detail: '世界没能恢复：TypeError: x is not a function' });
  });
});

describe('浏览器、运行时的原话', () => {
  it.each([
    ["Cannot read properties of undefined (reading 'small')", INTERNAL_ERROR],
    ['TypeError: e.foo is not a function', INTERNAL_ERROR],
    ['Maximum call stack size exceeded', INTERNAL_ERROR],
    ['RangeError: Array buffer allocation failed', '内存不够'],
    ['Invalid typed array length: 4294967296', '内存不够'],
    ['QuotaExceededError: The quota has been exceeded.', '浏览器存储满了'],
    ['Failed to fetch dynamically imported module: https://x/assets/a.js', '没能读到程序的文件，请重新载入'],
    ['TypeError: Failed to fetch', '没能读到要用的文件'],
    ['SecurityError: The operation is insecure.', '浏览器不让这样做'],
    ['NotAllowedError: The request is not allowed by the user agent', '浏览器没有允许'],
    ['ERROR: 0:12: \'foo\' : undeclared identifier', '显卡没能画出来'],
  ])('%s → %s', (raw, text) => {
    expect(humanError(raw)).toEqual({ text, detail: raw });
  });

  it('翻出来的话里没有英文句子', () => {
    for (const raw of ['Uncaught Error: boom happened here', 'x is not defined', 'DataCloneError: could not be cloned', 'NotFoundError: thing could not be found', 'AbortError: The user aborted a request.']) {
      expect(looksEnglish(humanError(raw).text), raw).toBe(false);
    }
  });
});

describe('抛出来的东西写成一段字', () => {
  it('Error 带名字；不是 Error 的原样；什么都没有时也有一句', () => {
    expect(rawText(new TypeError('x is not a function'))).toBe('TypeError: x is not a function');
    expect(rawText(new Error('找不到生态'))).toBe('找不到生态');
    expect(rawText('一句话')).toBe('一句话');
    expect(rawText({ name: 'QuotaExceededError', message: 'full' })).toBe('QuotaExceededError: full');
    expect(rawText(undefined)).toBe(INTERNAL_ERROR);
    expect(rawText(null)).toBe(INTERNAL_ERROR);
    expect(rawText(5)).toBe('5');
    expect(humanError(undefined)).toEqual({ text: INTERNAL_ERROR, detail: null });
  });
});
