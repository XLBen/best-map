import { PACK_MAX_CHARS, type PackRead, readPack } from '../../../core/packs';
import { setSource } from './panel-store';
import { dropFileSource, setFileSource } from './pick-store';
import { fileLabel, openPackImport } from './store';

// 读文件（第六十七轮）：“导入”只留给这件事。读进来的资源包是一个临时的库（library.ts 的 fileLibrary），
// 标题下拉里写“文件：xxx（没装进资源库）”，和别的库一样看、一样勾；“装进资源库”走原来的弹窗（PackDialog.tsx，查脚本、信任）。
// 读不了的文件也走那个弹窗，写为什么

const reads = new Map<string, { read: PackRead; file: string }>();

// 太大的文件不读进内存（readPack 按字数再查一遍；一个字可能占三个字节）
export async function readFileAsPack(file: Pick<File, 'name' | 'size' | 'text'>): Promise<PackRead> {
  if (file.size > 3 * PACK_MAX_CHARS) return { ok: false, errors: [`文件太大（${Math.round(file.size / 1e6)} MB），不是资源包`] };
  return readPack(await file.text(), fileLabel(file.name));
}

// 读一个文件：读得了的成为临时的库，面板换到它；读不了的弹窗写原因。返回临时库的键
export async function openFile(file: Pick<File, 'name' | 'size' | 'text'>): Promise<string | null> {
  const read = await readFileAsPack(file);
  if (!read.ok) {
    openPackImport(read, file.name);
    return null;
  }
  const key = setFileSource(file.name, read.pack);
  reads.set(key, { read, file: file.name });
  setSource({ t: 'lib', key });
  return key;
}

// “装进资源库…”：原来的导入弹窗（列出内容、问题和脚本，等用户确认）
export function installFile(key: string): void {
  const r = reads.get(key);
  if (r) openPackImport(r.read, r.file);
}

// 不要了：从标题下拉里去掉，勾选一起没了
export function closeFile(key: string): void {
  reads.delete(key);
  dropFileSource(key);
}
