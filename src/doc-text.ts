// 世界文件的字（第九十五轮）：和 JSON.stringify(doc) 一字不差，但每条命令只转一次。
// 留以前的版本、存到电脑上的文件都要整份世界文件的字；世界做得久了有几 MB，整份转一次要几十毫秒（量到的数见第 95 轮的设计），
// 在主线程上每隔一阵来一次会卡一下。主线程手上的命令记录（sandbox.ts 的 Mirror）里，没变的命令一直是同一个对象：
// 按对象记下它转成的字，下一次只转新加的几条，再接起来（接几 MB 的字是一两毫秒）。
// 命令对象当作不可变的（引擎改一步的命令时换一个新对象，主线程收到的是复制过来的）

const parts = new WeakMap<object, string>();

const one = (c: unknown): string => {
  if (c === null || typeof c !== 'object') return JSON.stringify(c) ?? 'null';
  let s = parts.get(c);
  if (s === undefined) {
    s = JSON.stringify(c);
    parts.set(c, s);
  }
  return s;
};

export function docText(doc: unknown): string {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return JSON.stringify(doc);
  const keys = Object.keys(doc);
  const commands = (doc as { commands?: unknown }).commands;
  // 只认“命令在最后一项”的样子（引擎、命令记录给的都是）；别的样子照普通的办法转
  if (keys.length < 2 || keys[keys.length - 1] !== 'commands' || !Array.isArray(commands) || typeof (doc as { toJSON?: unknown }).toJSON === 'function') return JSON.stringify(doc);
  const { commands: _, ...head } = doc as Record<string, unknown>;
  const h = JSON.stringify(head);
  // 头里一项都没写出来（值都是 undefined）：照普通的办法
  if (h === '{}') return JSON.stringify(doc);
  return `${h.slice(0, -1)},"commands":[${commands.map(one).join(',')}]}`;
}
