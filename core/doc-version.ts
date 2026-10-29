import { CommandError } from './errors';

// 世界文件的版本。第九轮起是 5，不再兼容以前的存档（命令的含义、默认值都改过：山挡风默认打开、
// 画的河都只挖河床、湖和岛链的最小值……）。第三十轮是 6：新世界不再自带生态、基础内容（命令里从资源包加进来），
// 生成人文的命令带资源包（packs）而不是时代 id，旧文件重放出来不一样，打不开。
// 单独放一个小文件：主线程打开文件、读自动保存时也要查，不必引进整个引擎
export const DOC_VERSION = 6;
export const OLD_DOC_ERROR = '旧版本的世界文件打不开';

// 打开前先查：不是世界文件、是旧版本的世界时报错（不去重放）
export function checkDoc(doc: unknown) {
  const d = doc !== null && typeof doc === 'object' ? (doc as { format?: unknown; version?: unknown }) : {};
  if (d.format !== 'map2-world') throw new CommandError('不是 map2 世界文件');
  if (d.version !== DOC_VERSION) throw new CommandError(OLD_DOC_ERROR);
}

// 同上，不抛错：是当前版本的世界文件时为 true
export function isCurrentDoc(doc: unknown): boolean {
  try {
    checkDoc(doc);
    return true;
  } catch {
    return false;
  }
}
