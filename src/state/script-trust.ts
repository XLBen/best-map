import type { Command } from '../../core/commands';
import { type FoundScript, findScripts } from '../../core/script';
import { scriptTrustText, trustScripts, uniqueScripts, untrustedScripts } from '../trust';
import { askUser } from './ask';
import { knowIsolation, safeMode } from './worker-host';
import { world } from './world';

// 第七十轮从 state.ts 分出来（信任列表本身的读写在 src/trust.ts；打开世界时的问话、安全模式在 open.ts）

// ---------- 脚本的信任、安全模式 ----------

// 新建、打开带脚本的世界之前：有没信任过的脚本就问。信任并打开（记为信任）/ 不运行脚本打开（安全模式）/ 取消
export async function askTrust(scripts: FoundScript[], verb: '打开' | '新建'): Promise<'run' | 'safe' | 'cancel'> {
  const list = await untrustedScripts(null, scripts);
  if (!list.length) return 'run';
  await knowIsolation();
  const v = await askUser({
    title: '世界里的脚本',
    text: scriptTrustText(list.length),
    scripts: list,
    choices: [
      { value: 'run', label: `信任并${verb}`, primary: true },
      { value: 'safe', label: `不运行脚本${verb}` },
      { value: 'cancel', label: '取消' },
    ],
  });
  if (v === 'run') await trustScripts(list);
  return v === 'run' || v === 'safe' ? v : 'cancel';
}

// 往当前世界里导入的东西（生态 JSON……）带着没见过的脚本：先问，信任了才导入。
// 安全模式下不问（脚本不运行），也不记为信任：之后“再试一次”时照样会问
export async function confirmImport(json: unknown): Promise<boolean> {
  if (safeMode.value) return true;
  const list = await untrustedScripts(json);
  if (!list.length) return true;
  await knowIsolation();
  const v = await askUser({
    title: '要导入的脚本',
    text: scriptTrustText(list.length),
    scripts: list,
    choices: [
      { value: 'run', label: '信任并导入', primary: true },
      { value: 'cancel', label: '取消' },
    ],
  });
  if (v !== 'run') return false;
  await trustScripts(list);
  return true;
}

// 星球形态里没见过的脚本（向导里点了形态的卡片、打开形态编辑器，调整里选了一个形态）：先问，信任了才用
// （缩略图、预览都会运行它）。inWorld：用到现在的世界上；安全模式下脚本不运行，不问（也不记为信任，“再试一次”时照样会问）
export async function trustFormScripts(json: unknown, inWorld = false): Promise<boolean> {
  if (inWorld && safeMode.value) return true;
  const list = await untrustedScripts(json);
  if (!list.length) return true;
  const v = await askUser({
    title: '星球形态里的脚本',
    text: scriptTrustText(list.length),
    scripts: list,
    choices: [
      { value: 'run', label: '信任', primary: true },
      { value: 'cancel', label: '取消' },
    ],
  });
  if (v !== 'run') return false;
  await trustScripts(list);
  return true;
}

// 自己提交的脚本（加、改生态……）记为信任。安全模式下不记：那里的脚本可能是从没信任的世界里复制来的。
// 每一笔都要过一遍（涂一笔的命令里有上万个格号）：findScripts 不把数放进栈，比先转成 JSON 再找快
export function trustOwn(cmd: Command) {
  if (safeMode.value || trustedElsewhere.has(cmd)) return;
  const found = findScripts(cmd);
  if (found.length) void trustScripts(found);
}

// 脚本框的提交不在这里记：编辑器只报框里写的那一段（补丁里整份带着的另一段不算），
// 同一步里被换掉的中间版本还要从信任列表里去掉（见 ui/connect.ts）。这样的命令先在这里登记
const trustedElsewhere = new WeakSet<Command>();
export function trustHandledElsewhere<C extends Command>(cmd: C): C {
  trustedElsewhere.add(cmd);
  return cmd;
}

// “查看脚本”：现在这个世界里的脚本（生态的……）
export async function showScripts(): Promise<void> {
  const w = world.value;
  const list = w ? uniqueScripts(findScripts(w.small)) : [];
  await askUser({ title: '世界里的脚本', text: list.length ? undefined : '没有脚本', scripts: list, choices: [{ value: 'close', label: '关闭', primary: true }] });
}
