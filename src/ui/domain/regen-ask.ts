import type { Command } from '../../../core/commands';
import { type Loss, type LossKey, type Removed, isRegen, regenLoss, removalCounts } from '../../../core/regen-loss';
import type { World } from '../../../core/world';
import { askUser, commandsNow, exec, world } from '../../state';

// 重新生成之前（第九十八轮）：先数这一次会换掉多少手改的东西（core/regen-loss.ts），大于零才问，问的话里写清楚数；等于零直接做
// （之后有“撤销”）。各处的“重新生成”（人文、国家、城市与地标、省份、拖发源地、资源库面板底下的那一条、“添加并重新生成”）都走这里，
// 问法、按钮是同一个。删除人文、国家、城市之前的问话也在这里拼：一起没了的是什么，按实际删的数。
// 这里只有话和问的先后；数的规则在 core

// 一种手改怎么说（n 个）
const LOSS_TEXT: Record<LossKey, (n: number) => string> = {
  pop: (n) => `手改过的 ${n} 格人口`,
  hearths: (n) => `${n} 个拖过的发源地`,
  borders: (n) => `${n} 个国家手画的边界`,
  countries: (n) => `${n} 个改过的国家`,
  cities: (n) => `${n} 座改过的城市`,
  roads: (n) => `${n} 条自己画的道路`,
  landmarks: (n) => `${n} 个改过的地标`,
  provinces: (n) => `${n} 个手改过的省份`,
};

// “会换掉你手改过的 37 格人口、2 个国家手画的边界。可以撤销。”；没有时 null
export function lossText(loss: readonly Loss[]): string | null {
  if (!loss.length) return null;
  const parts = loss.map((l) => LOSS_TEXT[l.key](l.count));
  // 第一项已经写着“手改过的”时不重复
  const head = parts[0].startsWith('手改过的') ? `会换掉你${parts[0]}` : `会换掉你的 ${parts[0]}`;
  return `${[head, ...parts.slice(1)].join('、')}。可以撤销。`;
}

// 这条命令现在会换掉的手改（按页面里现在的世界和命令记录）
export function lossNow(cmd: Command, given?: World | null): Loss[] {
  // 不是重新生成的命令不去看世界、不去拿命令记录（资源库里每改一项都经过这里）
  if (!isRegen(cmd)) return [];
  const w = given === undefined ? world.value : given;
  return w ? regenLoss(w, cmd, commandsNow()) : [];
}

export interface RegenAsk {
  // 问话的标题、主要按钮上的字（默认都是“重新生成”）
  title?: string;
  action?: string;
}

// 要不要做：没有会被换掉的手改时不问（true）；有就问一次，点了“先不”是 false
export async function confirmRegen(cmd: Command, opts: RegenAsk = {}): Promise<boolean> {
  const text = lossText(lossNow(cmd));
  if (!text) return true;
  const v = await askUser({
    title: opts.title ?? '重新生成',
    text,
    // 主要的按钮写在前面：问话框里它在最右边（shell/Ask.tsx）
    choices: [
      { value: 'ok', label: opts.action ?? '重新生成', primary: true },
      { value: 'cancel', label: '先不' },
    ],
  });
  return v === 'ok';
}

// 重新生成的那一步：先数、要问就问，再做。没做（点了“先不”、没做成）是 false
export async function execRegen(cmd: Command, busy: string, opts: RegenAsk = {}): Promise<boolean> {
  if (!(await confirmRegen(cmd, opts))) return false;
  return exec(cmd, busy);
}

// ---------- 删除之前 ----------

const join = (parts: readonly string[]) => parts.filter(Boolean).join('、');
// 数字开头的前面空一格（“还有 17 个国家”），字开头的不空（“还有档案里的…”）
const also = (more: string) => (more ? `，一起删除的还有${/^\d/.test(more) ? ' ' : ''}${more}` : '');

// 删除人文、国家、城市之前问的那一句：一起没了的是什么（按 core 数出来的）
export function removalText(cmd: Command, n: Removed): string {
  const lore = n.archive ? `档案里的 ${n.archive} 条统治者、家族和大事` : '';
  if (cmd.op === 'remove_human') {
    const more = join([n.countries ? `${n.countries} 个国家` : '', n.blocs ? `${n.blocs} 个集团` : '', n.cities ? `${n.cities} 座城市` : '', n.roads ? `${n.roads} 条道路` : '', lore]);
    const hand = n.pop ? `手改过的 ${n.pop} 格人口也没了。` : '';
    return `人口和文化圈都删除${also(more)}。${hand}地标、资源库里的内容留着。可以撤销。`;
  }
  if (cmd.op === 'remove_countries') {
    const more = join([n.blocs ? `${n.blocs} 个集团` : '', lore]);
    return `${n.countries} 个国家都删除${also(more)}。人口、城市留着。可以撤销。`;
  }
  const parts = join([n.cities ? `${n.cities} 座城市` : '', n.roads ? `${n.roads} 条道路` : '', n.landmarks ? `${n.landmarks} 个地标` : '', n.points ? `${n.points} 个自定义点` : '']);
  return `${parts}都删除。可以撤销。`;
}

// 问一次再删。标题、按钮写动作
export async function execRemoval(cmd: Command, title: string, busy = '正在计算…'): Promise<boolean> {
  const w = world.value;
  if (!w) return false;
  const v = await askUser({
    title,
    text: removalText(cmd, removalCounts(w, cmd)),
    choices: [
      { value: 'ok', label: '删除', primary: true },
      { value: 'cancel', label: '先不' },
    ],
  });
  if (v !== 'ok') return false;
  return exec(cmd, busy);
}
