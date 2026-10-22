import type { Command } from '../../../core/commands';
import { PLAIN_RIVER, type RiverType, majorityType } from '../../../core/river-types';
import type { World } from '../../../core/world';
import { type RiverRef, exec, openPanel, options, selectedRiver, setOptions, world } from '../../state';
import { execAndSelect, guideOf, pinCommand, riverInfo } from '../riverCourse';
import { type MenuItem, TypeButton, TypeMenu, createAndUse, newWaterType, typeScriptCommand } from './waterTypes';

// 河流类型（第三批）：画河工具条上“新画的河”、选中一条河时“这条河”是哪一种。列表、编辑在 waterTypes.tsx（“水系 ⋯”里的“水体类型”）

// ---------- 一条河是哪一种 ----------

export interface RiverTypeOfRiver {
  // 现在画出来是哪一种（普通的河为 null）
  type: RiverType | null;
  // 这条河自己选的：一种类型、“普通的河”；没选（按各类型的规则）为 null
  chosen: 'type' | 'plain' | null;
}

export function riverTypeOfRiver(w: World, ref: RiverRef): RiverTypeOfRiver {
  const types = w.small.riverTypes ?? [];
  if (ref.kind === 'guide') {
    const g = guideOf(w, ref.id);
    if (g?.type === PLAIN_RIVER) return { type: null, chosen: 'plain' };
    const own = g?.type !== undefined ? types.find((t) => t.id === g.type) : undefined;
    if (own) return { type: own, chosen: 'type' };
  }
  const cells = riverInfo(w, ref)?.cells ?? [];
  const k = majorityType(w.derived, cells);
  return { type: k >= 0 ? types[k] : null, chosen: null };
}

// 有没有哪一种带“哪些自然的河是这一种”的规则
export const hasRules = (w: World) => (w.small.riverTypes ?? []).some((t) => !!t.scripts?.match);

// 给一条河选类型（choice：类型 id、'plain' 普通的河、null 按规则）的命令；不用改时为 null。
// 画的河改它自己的 type；自然的河固定下来并带上类型（一步：固定、选类型、名字照旧）
export function riverTypeChoiceCommand(w: World, ref: RiverRef, choice: string | null): Command | null {
  const types = w.small.riverTypes ?? [];
  const cur = riverTypeOfRiver(w, ref);
  // 没有规则时“普通的河”就是不选
  const want = choice === PLAIN_RIVER && !hasRules(w) ? null : choice;
  const name = riverInfo(w, ref)?.name;
  const who = name ? `「${name}」` : '这条河';
  // 说明按点的是什么写（没有规则时点“普通的河”，命令是去掉类型，说明仍是“改成普通的河”）
  const what = choice === PLAIN_RIVER ? '普通的河' : (types.find((t) => t.id === choice)?.name ?? choice);
  const label = choice === null ? `${who}的类型改回按规则` : `${who}改成${what}`;
  // 名字照旧：固定下来、自己选了类型的自然河按那条河原来的样子起名（不用类型的模板），所以现在的名字
  // 是按规则成了某种河、用那种河的模板起的时，把它写下来（之后“恢复自动”就是那条自然河普通的名字）
  const f = riverInfo(w, ref)?.feature;
  const tag = f && !f.custom && f.name ? f.tags.find((t) => t.startsWith('rtype:')) : undefined;
  const keepName = want !== null && !!tag && !!types.find((t) => t.id === tag.slice(6))?.names ? { name: f!.name } : {};
  if (ref.kind === 'guide') {
    const g = guideOf(w, ref.id);
    if (!g || (g.type ?? null) === want) return null;
    // 画的河照选的类型的模板起名；固定下来的自然河（用着那条河的地名键、没自己起名）名字照旧
    const pinned = g.nameKey !== undefined && !g.name;
    return { op: 'update_guide', id: g.id, patch: { type: want, ...(pinned ? keepName : {}) }, label };
  }
  if (want === null) return null;
  if (want !== PLAIN_RIVER && cur.type?.id === want) return null;
  const pin = pinCommand(w, ref.cell);
  if (!pin || pin.cmd.op !== 'add_guide') return null;
  return { ...pin.cmd, guide: { ...pin.cmd.guide, ...keepName, type: want }, label };
}

// ---------- 选类型的按钮与弹出的列表 ----------

// 选中的河：“这条河：血河 ▾”（点开是 RiverTypeMenu）
export function RiverTypeButton({ type, auto }: { type: RiverType | null; auto?: boolean }) {
  return <TypeButton kind="river" prefix="这条河" type={type} auto={auto} panel="rivertype" />;
}

// 画河工具条上：“新画的河：血河 ▾”（点开是 NewRiverTypeMenu）
export function NewRiverTypePick() {
  const w = world.value;
  if (!w) return null;
  const cur = options.value.riverType;
  const t = w.small.riverTypes?.find((x) => x.id === cur) ?? null;
  return <TypeButton kind="river" prefix="新画的河" type={t} panel="newrivertype" />;
}

// 新画的河用哪一种：有规则时“按规则”“普通的河”分开（普通的河不按规则变），没有规则时只有“普通的河”
export function NewRiverTypeMenu() {
  const w = world.value;
  if (!w) return null;
  const types = w.small.riverTypes ?? [];
  const rules = hasRules(w);
  const cur = options.value.riverType;
  const known = cur === PLAIN_RIVER || types.some((t) => t.id === cur);
  const pick = (id: string) => {
    setOptions({ riverType: id });
    openPanel.value = null;
  };
  const items: MenuItem[] = [
    ...(rules ? [{ t: null, label: '按规则', on: !known, hint: '按各类型的“哪些自然的河是这一种”判断', onPick: () => pick('') }] : []),
    {
      t: null,
      label: '普通的河',
      on: rules ? cur === PLAIN_RIVER : !known || cur === PLAIN_RIVER,
      hint: rules ? '不按规则变成别的类型' : undefined,
      onPick: () => pick(rules ? PLAIN_RIVER : ''),
    },
    ...types.map((t) => ({ t, label: t.name, on: cur === t.id, onPick: () => pick(t.id) })),
  ];
  return <TypeMenu kind="river" items={items} onNew={() => void createAndUse('river', null, (id) => setOptions({ riverType: id }))} />;
}

// 选中的这条河是哪一种
export function RiverTypeMenu() {
  const w = world.value;
  const sel = selectedRiver.value;
  if (!w || !sel) return null;
  const types = w.small.riverTypes ?? [];
  const cur = riverTypeOfRiver(w, sel);
  const rules = hasRules(w);
  const run = (cmd: Command) => (sel.kind === 'natural' ? void execAndSelect(cmd, '正在计算河流…') : void exec(cmd, '正在计算河流…'));
  const choose = (choice: string | null) => {
    openPanel.value = null;
    const cmd = riverTypeChoiceCommand(w, sel, choice);
    if (cmd) run(cmd);
  };
  const items: MenuItem[] = [
    ...(rules
      ? [
          {
            t: cur.chosen === null ? cur.type : null,
            label: `按规则${cur.chosen === null ? `（现在是${cur.type ? cur.type.name : '普通的河'}）` : ''}`,
            on: cur.chosen === null,
            hint: '按各类型的“哪些自然的河是这一种”判断',
            onPick: () => choose(null),
          },
        ]
      : []),
    { t: null, label: '普通的河', on: rules ? cur.chosen === 'plain' : !cur.type, onPick: () => choose(PLAIN_RIVER) },
    ...types.map((t) => ({ t, label: t.name, on: cur.chosen === 'type' && cur.type?.id === t.id, onPick: () => choose(t.id) })),
  ];
  // 新建一种并给这条河选上（一整步）。自然的河固定下来之后选中新的那条
  const onNew = async () => {
    const before = new Set(w.small.guides.map((g) => g.id));
    await createAndUse('river', (id) => riverTypeChoiceCommand(w, sel, id));
    const g = sel.kind === 'natural' ? world.value?.small.guides.find((x) => !before.has(x.id)) : undefined;
    if (g) selectedRiver.value = { kind: 'guide', id: g.id };
  };
  return (
    <TypeMenu
      kind="river"
      items={items}
      onNew={() => void onNew()}
      note={sel.kind === 'natural' ? '给自然的河选类型会把它固定下来（走向不再随地形挪），名字照旧。' : undefined}
    />
  );
}

// 以前的名字（测试、别处用）：河的编辑在 waterTypes.tsx
export const newRiverType = (w: World) => newWaterType(w, 'river') as RiverType;
export const riverTypeScriptCommand = (t: RiverType, src: string) => typeScriptCommand('river', t, src);
