import { useMemo, useState } from 'preact/hooks';
import type { Command } from '../../../core/commands';
import { defaultTotalPop, dimensionValues, groupInfo, humanLegend, populationSummary, typicalTuple, worldCultureGroups, worldCultures, worldDimensions, worldEra } from '../../../core/human';
import type { World } from '../../../core/world';
import { askUser, exec, openPanel, options, setOptions, togglePanel, world } from '../../state';
import { Seg } from '../common';
import { Slider } from '../components/Slider';
import { OptionSlider } from '../shell/OptionSlider';
import { Toggle } from '../components/Toggle';
import { EraRulesNote } from '../shell/EraRulesNote';
import { LibraryLink, TypePicker, TypePickerButton } from '../shell/TypePicker';
import { LibItemLines } from '../shell/LibItemLine';
import { libTarget } from '../packs/open-item';
import type { SliderDef } from '../defs/types';
import {
  type HumanChoice,
  chooseLibrary,
  choiceEra,
  choiceProblem,
  defaultChoice,
  densityText,
  generateCommand,
  popAt,
  popPos,
  popText,
  regenerateCommand,
  regenerateWith,
  shareText,
  switchNote,
  toggleGroup,
} from '../domain/human';
import { LibraryPick } from '../components/LibraryPick';
import { ADD_DIMENSION_NOTE, GEN_RULES_NOTE } from '../copy';
import { GEN_OPEN_TIP, GEN_TITLE, popDensityNote } from '../packs/copy';
import { openGenSettings } from '../packs/open-era';
import { addDimensionCommand, dimensionOptions } from '../../../core/packs/add-dimension';
import { type GroupOption, beyondGroups, libRoots, libraryOptions, packGroups, packLabel, worldLibrary } from '../domain/packChoice';
import { openLibrary } from '../packs/panel-store';
import { library } from '../../library';
import { restyleProvincesCommand } from '../packs/styles';
import { NO_HUMAN, chosenCulture, chosenTuple, chosenValue, hasHuman, hearthCommand, hearthMarks } from '../tools/public';
import { percentText } from '../defs/tool-values';
import { registerPanels } from '../defs/panel-registry';

// “文化”一类（第二十二轮）：底部条上的选择（文化、群体、维度的取值、倍数），“文化 ⋯”里的生成人文、时代、文化组、总人口，
// 与新建向导共用的“生成人文”的选择（HumanChoices）

const pick = (patch: Partial<typeof options.value>) => {
  openPanel.value = null;
  setOptions(patch);
};
const toLibrary = (kind: string) => () => {
  openPanel.value = null;
  openLibrary({ kind });
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
      library="culture"
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
      {/* 第九十二轮：正在涂的这种文化在资源库里的那一项 */}
      <LibItemLines list={libTarget(w, '文化', 'culture', t.culture)} />
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
      <LibraryLink kind="culture" />
    </div>
  );
}

export function ValuePick() {
  const w = world.value;
  if (!w || !hasHuman(w) || options.value.popMode !== 'value') return null;
  const v = chosenValue(w);
  return <TypePickerButton panel="valuepick" prefix={v ? v.dim.label : '变量'} swatch={v?.value.color} name={v ? v.value.name : '无'} title="换成哪一种" />;
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
      {dims.length > 1 && dims.length <= 3 && (
        <Seg<string> value={cur.dim.id} options={dims.map((d) => [d.id, d.label])} onChange={(id) => setOptions({ popDim: id, popValue: '' })} wide />
      )}
      {dims.length > 3 && (
        <select value={cur.dim.id} onChange={(e) => setOptions({ popDim: (e.target as HTMLSelectElement).value, popValue: '' })}>
          {dims.map((d) => (
            <option value={d.id}>{d.label}</option>
          ))}
        </select>
      )}
      <TypePicker
        items={dimensionValues(w.small, cur.dim.id).map((v) => ({ id: v.id, label: v.name, swatch: v.color, on: v.id === cur.value.id, hint: v.description, onPick: () => pick({ popDim: cur.dim.id, popValue: v.id }) }))}
        library="popValue"
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

// “国家”（第二十三轮）：生成国家。第七十七轮去掉了“分裂 ↔ 统一”、格局：国家多大、各等级占多少按资源库里的时代
// settlements（第二十四轮）：带上“生成城市与道路”“地标”（要有国家）
export function CountryChoice({ choice, onChange, disabled, settlements = true }: { choice: HumanChoice; onChange: (c: HumanChoice) => void; disabled?: boolean; settlements?: boolean }) {
  const c = choice.countries;
  const setS = (patch: Partial<HumanChoice['settlements']>) => onChange({ ...choice, settlements: { ...choice.settlements, ...patch } });
  return (
    <div class="human-countries">
      <h5>国家</h5>
      <Toggle on={c.on} disabled={disabled} onChange={(on) => onChange({ ...choice, countries: { on } })}>
        生成国家
      </Toggle>
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

// compact：弹出面板里（窄）：组旁不写有几个文化
// countries：带上“国家”（生成人文时；重新生成时不带）
// picker（第五十二轮）：带上选库（“文化 ⋯”里；新建向导的选库是单独的一步，这里不带）
// 第七十七轮：只选库、文化组，生成的参数（国家大小、人口密度、各组占多少）在资源库里改（EraRulesNote；向导里不带打开的按钮）
export function HumanChoices({
  choice,
  onChange,
  small,
  disabled,
  compact,
  countries,
  picker = true,
}: {
  choice: HumanChoice;
  onChange: (c: HumanChoice) => void;
  small: World['small'] | null;
  disabled?: boolean;
  compact?: boolean;
  countries?: boolean;
  picker?: boolean;
}) {
  const lib = library.value;
  // 文化组：库里的；世界里自己的、从别的库加来的列在最后
  const offered = packGroups(choice.library, lib);
  const groupRow = (o: Pick<GroupOption, 'group' | 'weight' | 'cultures'>) => {
    const g = o.group;
    const sel = choice.groups.includes(g.id);
    const n = o.cultures;
    return (
      <div class="human-group">
        <label class="check" title={compact ? `${g.description ? `${g.description}\n` : ''}${n} 个文化` : g.description}>
          <input type="checkbox" checked={sel} disabled={disabled} onChange={() => onChange(toggleGroup(choice, g.id, !sel))} />
          <span class="swatch" style={{ background: g.color }} />
          {g.name}
          {!compact && n > 0 && <span class="hint">{n} 个文化</span>}
        </label>
      </div>
    );
  };
  const problem = choiceProblem(choice, small, lib);
  // 第五十一轮：库里比重是 0 的组（这个库默认不带的）收着，勾上了才列在上面
  const isSpare = (o: GroupOption) => o.weight === 0 && !choice.groups.includes(o.group.id);
  const spare = offered.filter(isSpare);
  const rows = offered.filter((o) => !isSpare(o));
  const own = beyondGroups(small, choice.library, lib).map((group) => ({ group, cultures: small ? worldCultures(small).filter((c) => c.group === group.id).length : 0 }));
  const note = switchNote(choice, small, lib);
  return (
    <div class="human-choices">
      {picker && (
        <>
          <h5>库</h5>
          <LibraryPick value={choice.library} onChange={(key) => onChange(chooseLibrary(choice, key, lib, small))} options={libraryOptions(lib)} labelOf={(key) => packLabel(lib, [key])} compact={compact} disabled={disabled} />
          {note && <p class="hint">{note}</p>}
        </>
      )}
      <h5>文化组</h5>
      <div class="human-groups">{rows.map(groupRow)}</div>
      {own.length > 0 && (
        <>
          <h6 class="choice-group">这张地图加的</h6>
          <div class="human-groups">{own.map(groupRow)}</div>
        </>
      )}
      {!rows.length && !own.length && !spare.length && <p class="hint">这个库里没有文化组</p>}
      {spare.length > 0 && (
        <details>
          <summary>还有 {spare.length} 个文化组（这个库默认不带）</summary>
          <div class="human-groups">{spare.map(groupRow)}</div>
        </details>
      )}
      {countries && <CountryChoice choice={choice} onChange={onChange} disabled={disabled} />}
      <EraRulesNote libraryKey={choice.library} small={small} seg={countries ? 'state' : 'people'} button={!!small} />
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
  const lib = library.value;
  const [choice, setChoice] = useState<HumanChoice>(() => defaultChoice(w.small, true, lib));
  const cmd = generateCommand(choice, w.small, lib);
  return (
    <>
      <HumanChoices choice={choice} onChange={setChoice} small={w.small} compact countries />
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

// 加一个变量：资源库里有、这个时代还没有的（意识形态、种族……）。只把现有的人分开，点一下就加，可以撤销
function DimensionAdd({ w }: { w: World }) {
  const lib = library.value;
  const options = useMemo(() => dimensionOptions(libRoots(lib), w.small), [lib, w.small.content?.era, w.small.human?.era]);
  if (!options.length) return null;
  return (
    <section>
      <h5>加一个变量</h5>
      <TypePicker
        items={options.map((o) => ({
          label: o.label,
          meta: `${o.values.length} 种`,
          hint: o.values.slice(0, 6).map((v) => v.name).join('、'),
          on: false,
          onPick: () => {
            const cmd = addDimensionCommand(libRoots(lib), w, o.id, o.library);
            if (cmd) void exec(cmd, '正在计算…');
          },
        }))}
        note={ADD_DIMENSION_NOTE}
      />
    </section>
  );
}

// 已有人文：时代、各文化组占多少、总人口、重新生成、换库或文化组、删除
function HumanInfo({ w, onDone }: { w: World; onDone: () => void }) {
  const [edit, setEdit] = useState<HumanChoice | null>(null);
  const [draft, setDraft] = useState<number | null>(null);
  const sum = populationSummary(w);
  const era = worldEra(w.small);
  const groups = humanLegend(w, 'cultureGroup');
  const total = sum?.total ?? 0;
  const def = era ? defaultTotalPop(w, w.derived, era) : total;
  const manual = w.causes.popManual?.some((x) => x === 1) ?? false;
  const run = async (cmd: Command | null, busy = '正在生成…') => {
    if (cmd && (await exec(cmd, busy))) onDone();
  };
  if (edit) {
    const cmd = regenerateWith(edit, w.small, library.value);
    const editEra = choiceEra(edit, library.value, w.small);
    return (
      <>
        <HumanChoices choice={edit} onChange={setEdit} small={w.small} compact />
        {editEra && editEra.id !== w.small.human!.era && manual && <p class="hint">换了库，手改过的格也重新生成</p>}
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
        {worldLibrary(w.small) && <p class="hint">库：{packLabel(library.value, [worldLibrary(w.small)!])}</p>}
        <div class="row between">
          <span class="hint">{GEN_RULES_NOTE}</span>
          <button
            class="link-btn small"
            title={GEN_OPEN_TIP}
            onClick={() => {
              openPanel.value = null;
              openGenSettings();
            }}
          >
            {GEN_TITLE}
          </button>
        </div>
      </section>
      <DimensionAdd w={w} />
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
        {era && <p class="hint">{popDensityNote(era.popDensity)}</p>}
      </section>
      <section class="row wrap">
        <button onClick={() => void run(regenerateCommand(w.small, library.value))} title="拖过的发源地、手改过的格不动">
          重新生成
        </button>
        <button onClick={() => setEdit(defaultChoice(w.small, true, library.value))} title="换一个库，或改文化组、总人口">
          换库、文化组…
        </button>
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
        <button class="small" onClick={toLibrary('culture')}>
          资源库…
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

// 工具表里按名字引用的部件（defs/panel-registry.ts）
registerPanels({ NoHumanChip, CulturePick, PopTuplePick, ValuePick, FactorSlider, HearthBar, CultureExtras });
