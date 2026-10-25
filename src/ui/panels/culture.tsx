import { useState } from 'preact/hooks';
import type { Command } from '../../../core/commands';
import { defaultTotalPop, dimensionValues, groupInfo, humanLegend, populationSummary, typicalTuple, worldCultureGroups, worldCultures, worldDimensions } from '../../../core/human';
import type { World } from '../../../core/world';
import { askUser, exec, openPanel, options, setOptions, togglePanel, world } from '../../state';
import { Seg } from '../common';
import { OptionSlider, Slider } from '../components/Slider';
import { Toggle } from '../components/Toggle';
import { fragAt, fragPos, fragText, fragTitle } from '../countries';
import { LayoutPick } from './countries';
import { TypePicker, TypePickerButton } from '../components/TypePicker';
import type { SliderDef } from '../defs/types';
import {
  type HumanChoice,
  WEIGHT_RANGE,
  chooseEra,
  choiceProblem,
  culturesIn,
  defaultChoice,
  densityText,
  eraChoices,
  firstLine,
  generateCommand,
  groupChoices,
  groupShares,
  popAt,
  popPos,
  popText,
  regenerateWith,
  roundWeight,
  setGroupWeight,
  shareText,
  suggestedGroups,
  toggleGroup,
} from '../human';
import { openRepo } from '../packs/store';
import { restyleProvincesCommand } from '../packs/styles';
import { NO_HUMAN, chosenCulture, chosenTuple, chosenValue, hasHuman, hearthCommand, hearthMarks, percentText } from '../tools/culture';

// “文化”一类（第二十二轮）：底部条上的选择（文化、群体、维度的取值、倍数），“文化 ⋯”里的生成人文、时代、文化组、总人口，
// 与新建向导共用的“生成人文”的选择（HumanChoices）

const pick = (patch: Partial<typeof options.value>) => {
  openPanel.value = null;
  setOptions(patch);
};
const toRepo = (kind: string) => () => {
  openPanel.value = null;
  openRepo({ kind });
};

// ---------- 底部条 ----------

// 没有人文时底部条上只有这一个入口
export function NoHumanChip() {
  const w = world.value;
  if (!w || hasHuman(w)) return null;
  return (
    <button class="bar-btn warn" onClick={() => togglePanel('cat:culture')} title={NO_HUMAN}>
      生成人文…
    </button>
  );
}

export function CulturePick() {
  const w = world.value;
  if (!w || !hasHuman(w)) return null;
  const c = chosenCulture(w);
  return <TypePickerButton panel="culturepick" prefix="文化" swatch={c?.color} name={c ? c.name : '选文化'} title="画成哪一种文化" />;
}

// 文化按文化组列
export function CultureMenu() {
  const w = world.value;
  if (!w) return null;
  const cur = chosenCulture(w)?.id;
  const groups = new Map(worldCultureGroups(w.small).map((g) => [g.id, g.name]));
  const list = [...worldCultures(w.small)].sort((a, b) => [...groups.keys()].indexOf(a.group) - [...groups.keys()].indexOf(b.group));
  return (
    <TypePicker
      items={list.map((c) => ({ label: c.name, swatch: c.color, group: groups.get(c.group) ?? c.group, on: c.id === cur, hint: c.description, onPick: () => pick({ culture: c.id }) }))}
      onNew={toRepo('culture')}
      newLabel="仓库…"
      newTitle="新建、编辑文化"
    />
  );
}

export function PopTuplePick() {
  const w = world.value;
  if (!w || !hasHuman(w) || options.value.popMode !== 'share') return null;
  const t = chosenTuple(w);
  const c = t ? w.small.content?.culture?.[t.culture] : undefined;
  return <TypePickerButton panel="poppick" prefix="群体" swatch={(c as { color?: string } | undefined)?.color} name={t ? groupInfo(w, 0, t).label : '选群体'} title="这群人的占比升高" />;
}

// 群体：文化 + 每一维的取值。先选文化（取值换成这个文化最典型的），再改每一维
export function PopTupleMenu() {
  const w = world.value;
  if (!w) return null;
  const t = chosenTuple(w);
  if (!t) return <p class="hint">没有文化</p>;
  const groups = new Map(worldCultureGroups(w.small).map((g) => [g.id, g.name]));
  return (
    <div class="menu">
      <h5>文化</h5>
      <select value={t.culture} onChange={(e) => setOptions({ popTuple: typicalTuple(w, (e.target as HTMLSelectElement).value) })}>
        {[...groups.entries()].map(([gid, gname]) => (
          <optgroup label={gname}>
            {worldCultures(w.small)
              .filter((c) => c.group === gid)
              .map((c) => (
                <option value={c.id}>{c.name}</option>
              ))}
          </optgroup>
        ))}
      </select>
      {worldDimensions(w.small).map((dim) => {
        const values = dimensionValues(w.small, dim.id);
        const none = dim.required ? [] : [{ id: '', name: '无', color: 'transparent' }];
        const all = [...none, ...values];
        return (
          <>
            <h5>{dim.label}</h5>
            {all.length <= 3 ? (
              <Seg<string>
                value={t.values[dim.id] ?? ''}
                options={all.map((v) => [v.id, v.name])}
                swatches={Object.fromEntries(values.map((v) => [v.id, v.color]))}
                onChange={(v) => {
                  const values2 = { ...t.values };
                  if (v) values2[dim.id] = v;
                  else delete values2[dim.id];
                  setOptions({ popTuple: { culture: t.culture, values: values2 } });
                }}
                wide
              />
            ) : (
              <select
                value={t.values[dim.id] ?? ''}
                onChange={(e) => {
                  const v = (e.target as HTMLSelectElement).value;
                  const values2 = { ...t.values };
                  if (v) values2[dim.id] = v;
                  else delete values2[dim.id];
                  setOptions({ popTuple: { culture: t.culture, values: values2 } });
                }}
              >
                {all.map((v) => (
                  <option value={v.id}>{v.name}</option>
                ))}
              </select>
            )}
          </>
        );
      })}
      <p class="hint">Alt+点击地图吸取</p>
    </div>
  );
}

export function ValuePick() {
  const w = world.value;
  if (!w || !hasHuman(w) || options.value.popMode !== 'value') return null;
  const v = chosenValue(w);
  return <TypePickerButton panel="valuepick" prefix={v ? v.dim.label : '维度'} swatch={v?.value.color} name={v ? v.value.name : '无'} title="换成哪一种" />;
}

// 一个维度的取值（维度不止一个时先选维度）
export function ValueMenu() {
  const w = world.value;
  if (!w) return null;
  const dims = worldDimensions(w.small);
  const cur = chosenValue(w);
  if (!dims.length || !cur) return <p class="hint">这个时代没有别的维度</p>;
  return (
    <>
      {dims.length > 1 && (
        <Seg<string> value={cur.dim.id} options={dims.map((d) => [d.id, d.label])} onChange={(id) => setOptions({ popDim: id, popValue: '' })} wide />
      )}
      <TypePicker
        items={dimensionValues(w.small, cur.dim.id).map((v) => ({ label: v.name, swatch: v.color, on: v.id === cur.value.id, hint: v.description, onPick: () => pick({ popDim: cur.dim.id, popValue: v.id }) }))}
        onNew={toRepo('popValue')}
        newLabel="仓库…"
        newTitle={`新建、编辑${cur.dim.label}`}
      />
    </>
  );
}

// 改人数：增减的比例（第二十七轮：−90% 到 +300%，Shift 反过来）
export const FACTOR: SliderDef = {
  key: 'popPercent',
  label: '增减',
  range: () => [-0.9, 3],
  scale: 'linear',
  snap: (v) => Math.round(v * 20) / 20,
  format: (v) => percentText(v),
};
export function FactorSlider() {
  const w = world.value;
  if (!w || !hasHuman(w) || options.value.popMode !== 'count') return null;
  return <OptionSlider def={FACTOR} w={w} />;
}

// 发源地：锁定了几个，全部恢复自动
export function HearthBar() {
  const w = world.value;
  if (!w || !hasHuman(w)) return null;
  const locked = hearthMarks(w).filter((m) => m.locked);
  if (!locked.length) return <span class="bar-note">拖动发源地，人文重新生成</span>;
  const cmd: Command = { op: 'batch', label: `发源地恢复自动 · ${locked.length} 个`, commands: locked.map((m) => hearthCommand(m, null)) };
  return (
    <>
      <span class="bar-note">锁定 {locked.length} 个</span>
      <button class="bar-btn" onClick={() => void exec(cmd, '正在生成…')} title="锁定的发源地都恢复自动">
        全部恢复自动
      </button>
    </>
  );
}

// ---------- 生成人文的选择（向导、“文化 ⋯”共用） ----------

// “国家”（第二十三轮）：生成国家、分裂 ↔ 统一、格局（第二十六轮）。estimate：大约几个国家（有世界时才知道）
// settlements（第二十四轮）：带上“生成城市与道路”“地标”（要有国家）
export function CountryChoice({
  choice,
  onChange,
  disabled,
  estimate,
  settlements = true,
}: {
  choice: HumanChoice;
  onChange: (c: HumanChoice) => void;
  disabled?: boolean;
  estimate?: (f: number) => number | null;
  settlements?: boolean;
}) {
  const c = choice.countries;
  const setS = (patch: Partial<HumanChoice['settlements']>) => onChange({ ...choice, settlements: { ...choice.settlements, ...patch } });
  const [draft, setDraft] = useState<number | null>(null);
  const f = draft ?? c.fragmentation;
  const n = estimate?.(f);
  const set = (patch: Partial<HumanChoice['countries']>) => onChange({ ...choice, countries: { ...c, ...patch } });
  return (
    <div class="human-countries">
      <h5>国家</h5>
      <Toggle on={c.on} disabled={disabled} onChange={(on) => set({ on })}>
        生成国家
      </Toggle>
      {c.on && (
        <Slider
          stacked
          label="分裂 ↔ 统一"
          pos={fragPos(f)}
          text={fragText(f)}
          changed={c.fragmentation !== 0.5}
          disabled={disabled}
          title={fragTitle(choice.era, world.value?.small)}
          note={
            <>
              {n ? `约 ${n} 个国家` : '正中按时代'}
              {c.fragmentation !== 0.5 && (
                <button class="link" onClick={() => set({ fragmentation: 0.5 })}>
                  恢复自动
                </button>
              )}
            </>
          }
          onDraft={(p) => setDraft(fragAt(p))}
          onCommit={(p) => {
            setDraft(null);
            set({ fragmentation: fragAt(p) });
          }}
          onCancel={() => setDraft(null)}
        />
      )}
      {c.on && <LayoutPick value={c.layout ?? 'era'} disabled={disabled} onChange={(layout) => set({ layout })} />}
      {settlements && (
        <>
          <h5>城市</h5>
          <Toggle on={c.on && choice.settlements.on} disabled={disabled || !c.on} title={c.on ? '按国家的人口放城市，按地形连道路' : '要先生成国家'} onChange={(on) => setS({ on })}>
            生成城市与道路
          </Toggle>
          <Toggle on={c.on && choice.settlements.on && choice.settlements.landmarks} disabled={disabled || !c.on || !choice.settlements.on} title="名山、瀑布、神庙、城堡……" onChange={(landmarks) => setS({ landmarks })}>
            地标
          </Toggle>
        </>
      )}
    </div>
  );
}

// defaultPop：按时代的默认密度算的总人口（向导里是估的）
// compact：弹出面板里（窄）：时代两列，组旁不写有几个文化
// countries：带上“国家”（生成人文时；重新生成时不带）
export function HumanChoices({
  choice,
  onChange,
  small,
  defaultPop,
  disabled,
  compact,
  countries,
  estimate,
}: {
  choice: HumanChoice;
  onChange: (c: HumanChoice) => void;
  small: World['small'] | null;
  defaultPop: number;
  disabled?: boolean;
  compact?: boolean;
  countries?: boolean;
  estimate?: (f: number) => number | null;
}) {
  const eras = eraChoices(small);
  const era = eras.find((e) => e.id === choice.era);
  const suggested = suggestedGroups(era);
  const all = groupChoices(small);
  const shown = suggested ? all.filter((g) => suggested.has(g.id)) : all;
  const rest = suggested ? all.filter((g) => !suggested.has(g.id)) : [];
  const [more, setMore] = useState(rest.some((g) => choice.groups.some((x) => x.id === g.id)));
  const shares = groupShares(choice);
  const pop = choice.pop ?? defaultPop;
  const [draft, setDraft] = useState<number | null>(null);
  const v = draft ?? pop;
  const landKm2 = defaultPop / Math.max(1e-9, era?.popDensity ?? 1);
  const groupRow = (g: (typeof all)[number]) => {
    const sel = choice.groups.find((x) => x.id === g.id);
    const n = culturesIn(small, g.id).length;
    return (
      <div class="human-group">
        <label class="check" title={compact ? `${g.description ? `${g.description}\n` : ''}${n} 个文化` : g.description}>
          <input type="checkbox" checked={!!sel} disabled={disabled} onChange={() => onChange(toggleGroup(choice, g.id, !sel))} />
          <span class="swatch" style={{ background: g.color }} />
          {g.name}
          {!compact && <span class="hint">{n} 个文化</span>}
        </label>
        {sel && (
          <Slider
            label="占"
            pos={Math.log(sel.weight / WEIGHT_RANGE[0]) / Math.log(WEIGHT_RANGE[1] / WEIGHT_RANGE[0])}
            text={shareText(shares.get(g.id) ?? 0)}
            disabled={disabled}
            onDraft={(p) => onChange(setGroupWeight(choice, g.id, roundWeight(WEIGHT_RANGE[0] * (WEIGHT_RANGE[1] / WEIGHT_RANGE[0]) ** p)))}
            onCommit={(p) => onChange(setGroupWeight(choice, g.id, roundWeight(WEIGHT_RANGE[0] * (WEIGHT_RANGE[1] / WEIGHT_RANGE[0]) ** p)))}
          />
        )}
      </div>
    );
  };
  const problem = choiceProblem(choice, small);
  return (
    <div class="human-choices">
      <h5>时代</h5>
      <div class={`cards ${compact ? '' : 'three'}`}>
        {eras.map((e) => (
          <button class={`card ${choice.era === e.id ? 'on' : ''}`} disabled={disabled} onClick={() => onChange(chooseEra(choice, e.id, small))}>
            <b>
              {e.color && <span class="swatch" style={{ background: e.color }} />}
              {e.name}
            </b>
            <span class="hint">{firstLine(e.description) || `文化${e.dimensions.map((d) => ` · ${d.label}`).join('')}`}</span>
          </button>
        ))}
      </div>
      {era && <p class="hint">人口分{['文化', ...era.dimensions.map((d) => d.label)].join('、')}</p>}
      <h5>文化组</h5>
      <div class="human-groups">{shown.map(groupRow)}</div>
      {rest.length > 0 && (
        <>
          <button class="link-btn" onClick={() => setMore(!more)}>
            {more ? '收起' : `更多文化组（${rest.length}）`}
          </button>
          {more && (
            <>
              <p class="hint">这个时代少见</p>
              <div class="human-groups">{rest.map(groupRow)}</div>
            </>
          )}
        </>
      )}
      <Slider
        stacked
        label="总人口"
        pos={popPos(v, defaultPop)}
        text={`${choice.pop === null && draft === null ? '约 ' : ''}${popText(v)}`}
        changed={choice.pop !== null}
        disabled={disabled}
        note={
          <>
            {landKm2 > 0 ? `约 ${densityText(v / landKm2)}` : ''}
            {choice.pop !== null && (
              <button class="link" onClick={() => onChange({ ...choice, pop: null })}>
                恢复自动
              </button>
            )}
          </>
        }
        onDraft={(p) => setDraft(popAt(p, defaultPop))}
        onCommit={(p) => {
          setDraft(null);
          onChange({ ...choice, pop: popAt(p, defaultPop) });
        }}
        onCancel={() => setDraft(null)}
      />
      {countries && <CountryChoice choice={choice} onChange={onChange} disabled={disabled} estimate={estimate} />}
      {problem && <p class="hint warn">{problem}</p>}
    </div>
  );
}

// ---------- “文化 ⋯” ----------

// 省名按生成前的起：生成以后可以按当地的文化重起
function restyleCommand(w: World): Command | null {
  const cmd = restyleProvincesCommand(w);
  if (!cmd || cmd.op !== 'batch') return cmd;
  return { ...cmd, label: `按当地文化重起省名 · ${cmd.commands.length} 个` };
}

function RestyleOffer({ w }: { w: World }) {
  const cmd = restyleCommand(w);
  if (!cmd) return null;
  return (
    <div class="row between">
      <span class="hint">已有的省名不变</span>
      <button class="small" title="锁定的、自己选了风格的不动" onClick={() => void exec(cmd, '正在起名…')}>
        重起省名
      </button>
    </div>
  );
}

function GenerateBox({ w, onDone }: { w: World; onDone: () => void }) {
  const [choice, setChoice] = useState<HumanChoice>(() => defaultChoice(w.small));
  const era = eraChoices(w.small).find((e) => e.id === choice.era);
  const def = era ? defaultTotalPop(w, w.derived, era) : 0;
  const cmd = generateCommand(choice, w.small);
  return (
    <>
      <HumanChoices choice={choice} onChange={setChoice} small={w.small} defaultPop={def} compact countries />
      <button
        class="primary"
        disabled={!cmd}
        onClick={async () => {
          if (cmd && (await exec(cmd, '正在生成…'))) onDone();
        }}
      >
        生成
      </button>
    </>
  );
}

// 已有人文：时代、各文化组占多少、总人口、重新生成、换时代或文化组、删除
function HumanInfo({ w, onDone }: { w: World; onDone: () => void }) {
  const [edit, setEdit] = useState<HumanChoice | null>(null);
  const [draft, setDraft] = useState<number | null>(null);
  const sum = populationSummary(w);
  const era = eraChoices(w.small).find((e) => e.id === w.small.human!.era);
  const groups = humanLegend(w, 'cultureGroup');
  const total = sum?.total ?? 0;
  const def = era ? defaultTotalPop(w, w.derived, era) : total;
  const manual = w.causes.popManual?.some((x) => x === 1) ?? false;
  const run = async (cmd: Command | null, busy = '正在生成…') => {
    if (cmd && (await exec(cmd, busy))) onDone();
  };
  if (edit) {
    const cmd = regenerateWith(edit, w.small);
    return (
      <>
        <HumanChoices choice={edit} onChange={setEdit} small={w.small} defaultPop={def} compact />
        {edit.era !== w.small.human!.era && manual && <p class="hint">换了时代，手改过的格也重新生成</p>}
        <div class="row">
          <button
            class="primary"
            disabled={!cmd}
            onClick={async () => {
              await run(cmd);
              setEdit(null);
            }}
          >
            重新生成
          </button>
          <button onClick={() => setEdit(null)}>取消</button>
        </div>
      </>
    );
  }
  return (
    <>
      <section>
        <h5>时代</h5>
        <p>
          {era?.color && <span class="swatch" style={{ background: era.color }} />} <b>{era?.name ?? w.small.human!.era}</b>
          <span class="hint"> · 人口分{['文化', ...worldDimensions(w.small).map((d) => d.label)].join('、')}</span>
        </p>
        {era?.description && <p class="hint">{era.description}</p>}
      </section>
      <section>
        <h5>文化组</h5>
        {groups.map((g) => (
          <div class="share-row" title={`${popText(g.pop)} 人 · ${g.cells} 格`}>
            <span class="swatch" style={{ background: g.color }} />
            <span class="share-name">{g.name}</span>
            <span class="share-bar">
              <span style={{ width: `${total > 0 ? (g.pop / total) * 100 : 0}%`, background: g.color }} />
            </span>
            <span class="hint">{shareText(total > 0 ? g.pop / total : 0)}</span>
          </div>
        ))}
        {!groups.length && <p class="hint">没有人</p>}
      </section>
      <section>
        <Slider
          stacked
          label="总人口"
          pos={popPos(draft ?? total, def)}
          text={popText(draft ?? total)}
          changed={draft !== null}
          note={`约 ${densityText((draft ?? total) / Math.max(1e-9, def / Math.max(1e-9, era?.popDensity ?? 1)))}`}
          onDraft={(p) => setDraft(popAt(p, def))}
          onCommit={(p) => {
            setDraft(null);
            const v = popAt(p, def);
            if (Math.abs(v - total) > total * 1e-3) void exec({ op: 'set_pop_total', total: v }, '正在计算…');
          }}
          onCancel={() => setDraft(null)}
        />
      </section>
      <section class="row wrap">
        <button onClick={() => void run({ op: 'regenerate_human' })} title="拖过的发源地、手改过的格不动">
          重新生成
        </button>
        <button onClick={() => setEdit(defaultChoice(w.small))}>换时代、文化组…</button>
        <button
          onClick={async () => {
            const v = await askUser({
              title: '删除人文',
              text: '人口与文化圈都删除，可以撤销。',
              choices: [
                { value: 'cancel', label: '取消' },
                { value: 'ok', label: '删除', primary: true },
              ],
            });
            if (v === 'ok') await exec({ op: 'remove_human' }, '正在计算…');
          }}
        >
          删除人文
        </button>
      </section>
      <section class="row wrap">
        <button class="small" onClick={toRepo('culture')}>
          仓库…
        </button>
      </section>
    </>
  );
}

export function CultureExtras() {
  const w = world.value;
  // 生成过以后提一次“重起省名”（省名是生成之前起的）
  const [offer, setOffer] = useState(false);
  if (!w) return null;
  const done = () => setOffer(Object.keys(w.small.provinces).length > 0);
  return (
    <>
      {offer && w.small.human && Object.keys(w.small.provinces).length > 0 && (
        <section>
          <RestyleOffer w={world.value ?? w} />
        </section>
      )}
      {hasHuman(w) ? <HumanInfo w={w} onDone={done} /> : <GenerateBox w={w} onDone={done} />}
    </>
  );
}
