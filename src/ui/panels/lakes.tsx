import { effect } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { PLAIN_LAKE } from '../../../core/lake-types';
import { roundKm as km } from '../../../core/terrain';
import type { LakeSpec, World } from '../../../core/world';
import { type LakeRef, exec, lakeRange, openPanel, options, selectedLake, setOptions, switchTool, tool, world } from '../../state';
import { focusOn } from '../camera';
import { SelectionActions } from '../components/SelectionActions';
import { hasLakeRules, lakeInfo, lakeList, lakeSizeDraft, lakeTypeChoiceCommand, lakeTypeOfLake } from '../lakeInfo';
import { byRulesTip } from '../copy';
import { NameInput } from './names';
import { type MenuItem, TypeButton, TypeMenu, createAndUse } from './waterTypes';
import { Slider } from '../components/Slider';

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
  return <TypeButton kind="lake" prefix="新湖" type={t} panel="newlaketype" plainText={byRules ? '自动' : '普通'} />;
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
    ...(rules ? [{ t: null, label: '自动', on: !known, hint: byRulesTip('湖'), onPick: () => pick('') }] : []),
    {
      t: null,
      label: '普通的湖',
      on: rules ? cur === PLAIN_LAKE : !known || cur === PLAIN_LAKE,
      hint: rules ? '不自动变成别的类型' : undefined,
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
    if (cmd) void exec(cmd, '正在计算…');
  };
  const items: MenuItem[] = [
    ...(rules
      ? [
          {
            t: cur.chosen === null ? cur.type : null,
            label: `自动${cur.chosen === null ? ` · ${cur.type ? cur.type.name : '普通的湖'}` : ''}`,
            on: cur.chosen === null,
            hint: byRulesTip('湖'),
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
      note="按新类型的模板改名，自己起的名字不变"
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
    <Slider
      label="直径"
      pos={clamp01(Math.log(cur / lo) / Math.log(hi / lo))}
      text={`${km(cur * 2)} km`}
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
        void exec({ op: 'update_lake', id: l.id, patch: { radius: v }, label: `修改湖的直径 · 约 ${km(v * 2)} km` }, '正在计算…').finally(done);
      }}
      onCancel={done}
    />
  );
}

function LakeTypeButton({ w, sel }: { w: World; sel: LakeRef }) {
  const cur = lakeTypeOfLake(w, sel);
  return <TypeButton kind="lake" prefix="类型" type={cur.type} auto={cur.chosen === null} panel="laketype" />;
}

export function LakeBar() {
  const w = world.value;
  const sel = selectedLake.value;
  if (!w || !sel) return null;
  const info = lakeInfo(w, sel);
  if (!info) {
    // 放的湖的中心不再是湖（比如那里被画成了海）：取消选择，不留一个空的底部条
    queueMicrotask(() => {
      if (selectedLake.value === sel) selectedLake.value = null;
    });
    return null;
  }
  const f = info.feature;
  const l = info.placed;
  const size = info.dry ? `干湖 · 约 ${Math.round(info.areaKm2).toLocaleString()} km²` : `约 ${Math.round(info.areaKm2).toLocaleString()} km²`;
  // 名字放的湖、自然的湖都一样：是这个湖的地名（与“地名”工具改的是同一个）
  return (
    <>
      {f ? (
        <NameInput fkey={f.key} value={f.name} onCommit={(v) => void exec({ op: 'rename_feature', key: f.key, name: v }, '正在改名…')} />
      ) : (
        <span class="bar-label" title="只剩干涸的湖底">
          {info.dry ? '干湖' : '未命名'}
        </span>
      )}
      <LakeTypeButton w={w} sel={sel} />
      {l ? <LakeSizeSlider w={w} l={l} /> : <span class="bar-label">自然的湖 · {size}</span>}
      {l && <span class="bar-label">{size}</span>}
      <SelectionActions
        reroll={f ? () => void exec({ op: 'reroll_feature', key: f.key }, '正在起名…') : undefined}
        unlock={f?.custom ? () => void exec({ op: 'rename_feature', key: f.key, name: '' }, '正在起名…') : undefined}
        locate={() => focusOn(info.cells)}
        remove={
          l
            ? () => {
                selectedLake.value = null;
                void exec({ op: 'remove_lake', id: l.id }, '正在计算…');
              }
            : undefined
        }
        removeTitle="删除湖"
        deselect={() => (selectedLake.value = null)}
      />
    </>
  );
}

// ---------- 湖的列表（“水系 ⋯”里“湖”那一栏） ----------

// 选中一个湖：换到放湖工具（底部条换成这个湖的设置），与从河流列表里选中一条河一样
export function selectLake(ref: LakeRef) {
  if (tool.value !== 'lake') switchTool('lake');
  selectedLake.value = ref;
}

const LIST_NATURAL = 60;

const sameLake = (a: LakeRef | null, b: LakeRef) => !!a && (a.kind === 'placed' ? b.kind === 'placed' && a.id === b.id : b.kind === 'natural' && a.cell === b.cell);

// 世界里的湖：名字、面积、是哪一种；点一下选中它、镜头移过去
export function LakeList() {
  const w = world.value;
  if (!w) return null;
  const all = lakeList(w);
  // 放的湖都列；自然的湖从大到小最多 60 个（整个星球上小湖、干湖底很多）
  let natural = 0;
  const list = all.filter((x) => x.ref.kind === 'placed' || natural++ < LIST_NATURAL);
  const sel = selectedLake.value;
  return (
    <section>
      <h5>湖（{all.length}）</h5>
      {list.length === 0 ? (
        <p class="hint">没有湖</p>
      ) : (
        <div class="list">
          {list.map(({ ref, info, type }) => (
            <div
              key={ref.kind === 'placed' ? `p:${ref.id}` : `n:${ref.cell}`}
              class={`item ${sameLake(sel, ref) ? 'on' : ''}`}
              onClick={() => {
                selectLake(ref);
                focusOn(info.cells);
                openPanel.value = null;
              }}
            >
              <span class={`grow ellipsis ${info.feature?.custom ? 'custom' : ''}`}>
                {type && <span class="swatch" style={{ background: type.color }} title={type.name} />}
                {info.feature?.name || (info.dry ? '干湖' : '未命名')}
              </span>
              <span class="hint">
                约 {Math.round(info.areaKm2).toLocaleString()} km² · {type ? type.name : '普通的湖'} · {info.placed ? '放的' : '自然的'}
                {info.dry ? ' · 干涸' : ''}
              </span>
            </div>
          ))}
          {list.length < all.length && <p class="hint">另有 {all.length - list.length} 个小湖未列出</p>}
        </div>
      )}
    </section>
  );
}

// 选中的湖没了（撤销、删掉、换了工具）：它的“是哪一种”也关上
effect(() => {
  if (!selectedLake.value && openPanel.value === 'laketype') openPanel.value = null;
});
