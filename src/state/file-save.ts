import { effect, signal } from '@preact/signals';
import { docText } from '../doc-text';
import { FILE_OFF, type FileIo, FileSaver, type FileStatus, browserFileIo } from '../file-save';
import { activeLink, fileNameOf, mapLink } from '../maps';
import { currentSeries } from './versions';
import { currentHost, getDoc } from './worker-host';
import { world, worldEpoch, worldState } from './world';

// 存到电脑上的文件（第九十五轮，规则在 ../file-save.ts）：接到现在的世界、自动保存、⌘S 上；界面读这里的信号。
// 不引用界面，也不引用自动保存（autosave.ts 引用这里）

// 现在怎么样：有没有文件、在不在写、上一次写成的时间、没写成的原因
export const fileStatus = signal<FileStatus>(FILE_OFF);

// 现在的世界文件的字（主线程手上的命令记录，没变的命令不重转）；mark 认“世界变了没有”
async function textNow(): Promise<{ text: string; mark: string } | null> {
  if (!world.peek()) return null;
  const mark = `${worldEpoch.peek()}:${worldState.peek()}`;
  const doc = currentHost()?.mirror.doc() ?? (await getDoc());
  return doc ? { text: docText(doc), mark } : null;
}

let io: FileIo = browserFileIo;
let saver = new FileSaver(io, { text: textNow, changed: (s) => (fileStatus.value = s) });
// 测试换成内存里的；不给就回到浏览器的
export function useFileIo(next?: FileIo) {
  io = next ?? browserFileIo;
  saver = new FileSaver(io, { text: textNow, changed: (s) => (fileStatus.value = s) });
  fileStatus.value = FILE_OFF;
  void saver.load(currentSeries.peek());
}

// 换了世界：看这个世界有没有记着的文件
effect(() => {
  void saver.load(currentSeries.value);
});

// 这个浏览器能不能存到电脑上的文件（Chrome、Edge 能；Firefox、Safari 不能）
export const fileSupported = (): boolean => io.supported();

// “存到电脑上的文件…”：选一个文件，马上写一次。取消了 false；选择框开不了时抛错
export function saveToFile(): Promise<boolean> {
  const link = activeLink(mapLink.peek(), worldEpoch.peek());
  return saver.attach(fileNameOf(link?.name ?? '世界'));
}
// “接着存到 xxx.json”（要在用户点了以后调：浏览器这时才肯问权限）
export const resumeFile = (): Promise<boolean> => saver.resume();
// “不再存到这个文件”
export const stopFile = (): Promise<void> => saver.detach();
// 自动保存写成之后（节流在 FileSaver 里）
export const fileAfterSave = (): void => saver.noteSaved();
// ⌘S：马上写一次
export const fileFlush = (): Promise<void> => saver.flush();
// 一个世界的键换了（第一次存进“我的地图”）：文件跟着走。要在换之前调
export const fileMoved = (from: string, to: string): Promise<void> => saver.rekey(from, to);
