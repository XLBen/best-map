import { effect } from '@preact/signals';
import { Dices, LockOpen, ScanSearch, Trash2, X } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { PLAIN_LAKE } from '../../../core/lake-types';
import { roundKm as km } from '../../../core/terrain';
import type { LakeSpec, World } from '../../../core/world';
import { type LakeRef, exec, lakeRange, openPanel, options, selectedLake, setOptions, world } from '../../state';
import { focusOn } from '../camera';
import { hasLakeRules, lakeInfo, lakeSizeDraft, lakeTypeChoiceCommand, lakeTypeOfLake } from '../lakeInfo';
import { NameInput } from './names';
import { DragSlider } from './rivers';
import { type MenuItem, TypeButton, TypeMenu, createAndUse } from './waterTypes';

// 湖（第九轮）：放湖时点一下湖就选中它，底部条换成这个湖的设置（名字、换一个、是哪一种、大小、删掉），
// 与画河时点一条河选中它一样。“新放的湖：X ▾”是新放的湖用哪一种

// ---------- 选类型的按钮与弹出的列表 ----------

// 放湖工具条上：“新放的湖：X ▾”
export function NewLakeTypePick() {
  const w = world.value;
  if (!w) return null;
  const cur = options.value.lakeType;
  const t = w.small.lakeTypes?.find((x) => x.id === cur) ?? null;
  const byRules = !t && cur !== PLAIN_LAKE && hasLakeRules(w);
  return <TypeButton kind="lake" prefix="新放的湖" type={t} panel="newlaketype" plainText={byRules ? '按规则' : '普通'} />;
}

// 新放的湖用哪一种
export function NewLakeTypeMenu() {
  const w = world.value;
  if (!w) return null;
  const types = w.small.lakeTypes ?? [];
  const rules = hasLakeRules(w);
  const cur = options.value.lakeType;
  const known = cur === PLAIN_LAKE || types.some((t) => t.id === cur);
  const pick = (id: string) => {
    setOptions({ lakeType: id });
    openPanel.value = null;
  };
  const items: MenuItem[] = [
    ...(rules ? [{ t: null, label: '按规则', on: !known, hint: '按各类型的“哪些自然的湖是这一种”判断', onPick: () => pick('') }] : []),
    {
      t: null,
      label: '普通的湖',
      on: rules ? cur === PLAIN_LAKE : !known || cur === PLAIN_LAKE,
      hint: rules ? '不按规则变成别的类型' : undefined,
      onPick: () => pick(rules ? PLAIN_LAKE : ''),
    },
    ...types.map((t) => ({ t, label: t.name, on: cur === t.id, onPick: () => pick(t.id) })),
  ];
  return <TypeMenu kind="lake" items={items} onNew={() => void createAndUse('lake', null, (id) => setOptions({ lakeType: id }))} />;
}

// 选中的这个湖是哪一种
export function LakeTypeMenu() {
  const w = world.value;
  const sel = selectedLake.value;
  if (!w || !sel) return null;
  const types = w.small.lakeTypes ?? [];
  const cur = lakeTypeOfLake(w, sel);
  const rules = hasLakeRules(w);
  const choose = (choice: string | null) => {
    openPanel.value = null;
    const cmd = lakeTypeChoiceCommand(w, sel, choice);
    if (cmd) void exec(cmd, '正在计算湖泊…');
  };
  const items: MenuItem[] = [
    ...(rules
      ? [
          {
            t: cur.chosen === null ? cur.type : null,
            label: `按规则${cur.chosen === null ? `（现在是${cur.type ? cur.type.name : '普通的湖'}）` : ''}`,
            on: cur.chosen === null,
            hint: '按各类型的“哪些自然的湖是这一种”判断',
            onPick: () => choose(null),
          },
        ]
      : []),
    { t: null, label: '普通的湖', on: rules ? cur.chosen === 'plain' : !cur.type, onPick: () => choose(PLAIN_LAKE) },
    ...types.map((t) => ({ t, label: t.name, on: cur.chosen === 'type' && cur.type?.id === t.id, onPick: () => choose(t.id) })),
  ];
  return (
    <TypeMenu
      kind="lake"
      items={items}
      onNew={() => void createAndUse('lake', (id) => lakeTypeChoiceCommand(w, sel, id))}
      note="换了类型，湖按那种湖的起名模板换个名字（自己起的名字不变）。"
    />
  );
}

// ---------- 底部条 ----------

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function LakeSizeSlider({ w, l }: { w: World; l: LakeSpec }) {
  const [lo, hi] = lakeRange(w);
  const [draft, setDraft] = useState<number | null>(null);
  useEffect(() => setDraft(null), [l]);
  const cur = draft ?? l.radius;
  const at = (p: number) => {
    const v = lo * Math.pow(hi / lo, clamp01(p));
    const step = v < 20 ? 1 : v < 200 ? 5 : 10;
    return Math.min(hi, Math.max(lo, Math.round(v / step) * step));
  };
  const done = () => {
    lakeSizeDraft.value = null;
    setDraft(null);
  };
  return (
    <DragSlider
      label="大小"
      pos={clamp01(Math.log(cur / lo) / Math.log(hi / lo))}
      text={`直径 ${km(cur * 2)} km`}
      title="湖有多大；松手后重挖湖盆"
      onDraft={(p) => {
        const v = at(p);
        setDraft(v);
        lakeSizeDraft.value = { id: l.id, radius: v };
      }}
      onCommit={(p) => {
        const v = at(p);
        if (v === l.radius) return done();
        setDraft(v);
        void exec({ op: 'update_lake', id: l.id, patch: { radius: v }, label: `湖的直径改成约 ${km(v * 2)} km` }, '正在计算湖泊…').finally(done);
      }}
      onCancel={done}
    />
  );
}

function LakeTypeButton({ w, sel }: { w: World; sel: LakeRef }) {
  const cur = lakeTypeOfLake(w, sel);
  return <TypeButton kind="lake" prefix="这个湖" type={cur.type} auto={cur.chosen === null} panel="laketype" />;
}

export function LakeBar() {
  const w = world.value;
  const sel = selectedLake.value;
  if (!w || !sel) return null;
  const info = lakeInfo(w, sel);
  if (!info) return null;
  const f = info.feature;
  const l = info.placed;
  const size = info.dry ? `干湖 · 约 ${Math.round(info.areaKm2).toLocaleString()} km²` : `约 ${Math.round(info.areaKm2).toLocaleString()} km²`;
  const update = (patch: Record<string, unknown>, label: string, busy = '正在起名…') => l && void exec({ op: 'update_lake', id: l.id, patch, label }, busy);
  return (
    <>
      {f ? (
        l ? (
          <NameInput fkey={`lake:${l.id}`} value={f.name} onCommit={(v) => update({ name: v }, `改名为“${v}”`, '正在改名…')} />
        ) : (
          <NameInput fkey={f.key} value={f.name} onCommit={(v) => void exec({ op: 'rename_feature', key: f.key, name: v }, '正在改名…')} />
        )
      ) : (
        <span class="bar-label" title="只剩干涸的湖底，没有地名">
          {info.dry ? '干湖' : '无名的湖'}
        </span>
      )}
      {f && (
        <button
          class="bar-btn"
          onClick={() => (l ? update({ name: null, salt: (l.salt ?? 0) + 1 }, '换了个名字') : void exec({ op: 'reroll_feature', key: f.key }, '正在起名…'))}
          title="自动换一个名字"
        >
          <Dices size={15} /> 换一个
        </button>
      )}
      {f?.custom && l?.name && (
        <button class="bar-btn" onClick={() => update({ name: null }, '恢复自动命名')} title="不用自己起的名字，按文字包自动起">
          <LockOpen size={15} /> 恢复自动
        </button>
      )}
      <LakeTypeButton w={w} sel={sel} />
      {l ? <LakeSizeSlider w={w} l={l} /> : <span class="bar-label">自然的湖 · {size}</span>}
      {l && <span class="bar-label muted">{size}</span>}
      <button class="bar-btn icon" onClick={() => focusOn(info.cells)} title="在地图上看">
        <ScanSearch size={15} />
      </button>
      {l && (
        <button
          class="bar-btn"
          onClick={() => {
            selectedLake.value = null;
            void exec({ op: 'remove_lake', id: l.id }, '正在计算湖泊…');
          }}
          title="删掉这个放的湖"
        >
          <Trash2 size={15} /> 删掉
        </button>
      )}
      <button class="bar-btn icon" onClick={() => (selectedLake.value = null)} title="取消选择（Esc）">
        <X size={15} />
      </button>
    </>
  );
}

// 选中的湖没了（撤销、删掉、换了工具）：它的“是哪一种”也关上
effect(() => {
  if (!selectedLake.value && openPanel.value === 'laketype') openPanel.value = null;
});
