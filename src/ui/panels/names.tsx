import { Spline } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { GuidePatch } from '../../../core/commands';
import { FEATURE_INFO, type GeoFeature, REGION_KIND_INFO, defaultFeatureLabel, featureLabel, overrideKeyOf } from '../../../core/features';
import { DEFAULT_PACK } from '../../../core/names';
import { readPack } from '../../../core/packs';
import { fileLabel, openPackImport } from '../packs/store';
import { REGION_KINDS, type RegionKind, type World } from '../../../core/world';
import { download, exec, focusName, labelGroups, selectedFeature, showToast, world } from '../../state';
import { focusOn } from '../camera';
import { selectRiver } from '../riverCourse';
import { Seg } from '../common';
import { SelectionActions } from '../components/SelectionActions';

// 地名：底部条上的“选中地名”编辑，工具列表下方的文字包与全部地名

// 名字框：回车或点别处提交，Esc 放弃这次输入（不在失去焦点时提交）。
// 刚圈好、刚放下的地名会让它获得焦点并选中文字，直接打字就是改名
// placeholder：还没有名字时框里淡淡的提示
export function NameInput({ fkey, value, onCommit, placeholder }: { fkey: string; value: string; onCommit: (v: string) => void; placeholder?: string }) {
  const [name, setName] = useState(value);
  const cancelled = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => setName(value), [fkey, value]);
  const want = focusName.value;
  useEffect(() => {
    if (want !== fkey || !ref.current) return;
    focusName.value = null;
    ref.current.focus();
    ref.current.select();
  }, [want, fkey]);
  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const v = name.trim();
    if (v && v !== value) onCommit(v);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
    if (e.key === 'Escape') {
      e.stopPropagation();
      cancelled.current = true;
      setName(value);
      (e.target as HTMLInputElement).blur();
    }
  };
  return (
    <input
      ref={ref}
      class="bar-input"
      value={name}
      placeholder={placeholder}
      onInput={(e) => setName((e.target as HTMLInputElement).value)}
      onKeyDown={onKey}
      onBlur={commit}
    />
  );
}

// 名字前面灰色的类型字（第十四轮）：点一下改成自己的叫法（比如“圣山”），清空或写回默认的叫法就换回默认的。
// 回车或点别处提交，Esc 放弃。label：现在的叫法；auto：不改时的叫法；onCommit('')：换回默认的
export function labelCommit(text: string, label: string, auto: string): string | null {
  const v = text.trim();
  const custom = label !== auto;
  if (!v || v === auto) return custom ? '' : null;
  return v === label ? null : v;
}

export function LabelEdit({ label, auto, onCommit }: { label: string; auto: string; onCommit: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(label);
  const cancelled = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editing || !ref.current) return;
    ref.current.focus();
    ref.current.select();
  }, [editing]);
  if (!editing) {
    return (
      <button
        class="bar-label label-edit"
        title={label !== auto ? `自己写的叫法（默认是“${auto}”）：点一下改，清空就换回默认的` : '点一下改成自己的叫法，比如“圣山”'}
        onClick={() => {
          setText(label);
          setEditing(true);
        }}
      >
        {label}
      </button>
    );
  }
  const done = () => {
    setEditing(false);
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const v = labelCommit(text, label, auto);
    if (v !== null) onCommit(v);
  };
  return (
    <input
      ref={ref}
      class="bar-input label-input"
      value={text}
      maxLength={20}
      placeholder={auto}
      title={`名字前面的叫法；清空就换回“${auto}”`}
      onInput={(e) => setText((e.target as HTMLInputElement).value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          e.stopPropagation();
          cancelled.current = true;
          (e.target as HTMLInputElement).blur();
        }
      }}
      onBlur={done}
    />
  );
}

// 改自然形成的地物（山脉、湖、自然的河……）的类型字：写进落到它上面的那条改动（见 overrideKeyOf）
export function labelCommand(w: World, f: GeoFeature, v: string) {
  return { op: 'rename_feature' as const, key: overrideKeyOf(w, f), label: v };
}

const AREA_KINDS = REGION_KINDS.filter((k) => k !== 'spot') as Exclude<RegionKind, 'spot'>[];
type AreaChoice = Exclude<RegionKind, 'spot'> | 'auto';
const KIND_CHOICES = AREA_KINDS.map((k): [AreaChoice, string] => [k, REGION_KIND_INFO[k].label]);

// 用户圈的区块、放的地名：类型（自动或固定）、名字、换一个、恢复自动、删除
function RegionBar({ w, f, id }: { w: World; f: GeoFeature; id: string }) {
  const r = w.small.regions.find((x) => x.id === id);
  if (!r) return null;
  const update = (patch: { name?: string; kind?: RegionKind; auto?: boolean; reroll?: boolean; label?: string }) => void exec({ op: 'update_region', id, ...patch }, '正在起名…');
  return (
    <>
      {r.kind === 'spot' ? (
        <LabelEdit label={featureLabel(w, f)} auto={defaultFeatureLabel(w, f)} onCommit={(v) => update({ label: v })} />
      ) : (
        // “自动”时写出现在判断成了什么；点已经选着的那一项不算一步
        <Seg<AreaChoice>
          value={r.auto ? 'auto' : r.kind}
          options={[['auto', r.auto ? `自动（${featureLabel(w, f)}）` : '自动'], ...KIND_CHOICES]}
          titles={{ auto: '按圈里的地形自动判断（涂了沙漠就变成沙漠）' }}
          onChange={(k) => {
            if (k !== (r.auto ? 'auto' : r.kind)) update(k === 'auto' ? { auto: true } : { kind: k });
          }}
        />
      )}
      <NameInput fkey={f.key} value={f.name} onCommit={(v) => update({ name: v })} />
      <SelectionActions
        reroll={() => update({ reroll: true })}
        rerollTitle="按文字包换一个名字"
        unlock={f.custom ? () => update({ name: '' }) : undefined}
        locate={() => focusOn(f.cells)}
        remove={() => {
          selectedFeature.value = null;
          void exec({ op: 'remove_region', id }, '正在删除…');
        }}
        removeTitle="删掉这个地名"
        deselect={() => (selectedFeature.value = null)}
      />
    </>
  );
}

// 画的河（有名字的河道）：名字、换一个、恢复自动 / 锁定。改的是河道本身（update_guide），撤销照常
function GuideNameBar({ w, f, id }: { w: World; f: GeoFeature; id: string }) {
  const g = w.small.guides.find((x) => x.id === id);
  if (!g) return null;
  // 固定下来的自然河没自己换过名字时，用那条河原来的盐
  const salt = g.salt ?? (g.nameKey ? w.small.featureNames[g.nameKey]?.salt : undefined) ?? 0;
  const update = (patch: GuidePatch, label: string, busy = '正在起名…') => void exec({ op: 'update_guide', id, patch, label }, busy);
  return (
    <>
      <LabelEdit label={featureLabel(w, f)} auto={defaultFeatureLabel(w, f)} onCommit={(v) => update({ label: v || null }, v ? `类型改叫“${v}”` : '类型换回自动的叫法', '正在改名…')} />
      <NameInput fkey={f.key} value={f.name} onCommit={(v) => update({ name: v }, `改名为“${v}”`, '正在改名…')} />
      <SelectionActions
        reroll={() => update({ name: '', salt: salt + 1 }, '换了个名字')}
        unlock={f.custom ? () => update({ name: '', salt }, '恢复自动命名') : undefined}
        unlockTitle="不再固定，跟着文字包自动起名"
        lock={f.custom ? undefined : () => update({ name: f.name }, `改名为“${f.name}”`, '正在改名…')}
        lockTitle="之后河再变，这个名字也不会变"
        locate={() => focusOn(f.cells)}
        remove={hideAndDeselect(() => update({ hidden: true }, `删掉了地名「${f.name}」`))}
        removeTitle={HIDE_TITLE}
        deselect={() => (selectedFeature.value = null)}
      >
        <button
          class="bar-btn"
          onClick={() => {
            selectedFeature.value = null;
            selectRiver({ kind: 'guide', id });
          }}
          title="换到“画河”：改大小、粗细、终点，重画一段"
        >
          <Spline /> 管理这条河
        </button>
      </SelectionActions>
    </>
  );
}

export function NamesBar() {
  const w = world.value;
  const f = w?.derived.features.find((x) => x.key === selectedFeature.value);
  if (!w || !f) return null;
  if (f.region) return <RegionBar w={w} f={f} id={f.region} />;
  if (f.guide) return <GuideNameBar w={w} f={f} id={f.guide} />;
  const rename = (v: string) => void exec({ op: 'rename_feature', key: f.key, name: v }, '正在改名…');
  return (
    <>
      <LabelEdit label={featureLabel(w, f)} auto={defaultFeatureLabel(w, f)} onCommit={(v) => void exec(labelCommand(w, f, v), '正在改名…')} />
      <NameInput fkey={f.key} value={f.name} onCommit={rename} />
      <SelectionActions
        reroll={() => void exec({ op: 'reroll_feature', key: f.key }, '正在起名…')}
        unlock={f.custom ? () => rename('') : undefined}
        unlockTitle="不再固定，跟着文字包自动起名"
        lock={f.custom ? undefined : () => rename(f.name)}
        locate={() => focusOn(f.cells)}
        remove={hideAndDeselect(() => void exec(hideCommand(w, f, true), '正在删除…'))}
        removeTitle={HIDE_TITLE}
        deselect={() => (selectedFeature.value = null)}
      />
    </>
  );
}

// 删掉地名（第十六轮）：地物还在（山还是山、河还是河），只是不再标名字；“地名 ⋯ → 删掉的地名”里恢复
const HIDE_TITLE = '删掉这个地名（地物还在，只是不标名字；在“⋯ → 删掉的地名”里能恢复）';
const hideAndDeselect = (onHide: () => void) => () => {
  selectedFeature.value = null;
  onHide();
};

// 自然的地物写在落到它上面的那条改动上（同 labelCommand），画的河写在河道上
export function hideCommand(w: World, f: GeoFeature, hidden: boolean) {
  if (f.guide) return { op: 'update_guide' as const, id: f.guide, patch: { hidden: hidden ? (true as const) : null }, label: hidden ? `删掉了地名「${f.name}」` : `恢复了地名「${f.name}」` };
  return { op: 'rename_feature' as const, key: overrideKeyOf(w, f), hidden };
}

function WordPackBox({ w }: { w: World }) {
  const pack = w.small.wordPack ?? DEFAULT_PACK;
  // 导入：和资源包走同一条路（只解析、检查）。文字包文件照旧直接换用；选的是资源包时打开资源包的导入
  const importPack = (file: File) => {
    void file.text().then(async (text) => {
      const read = readPack(text, fileLabel(file.name));
      if (!read.ok) {
        showToast(`文字包读不了：${read.errors.slice(0, 3).join('；')}`, true);
        return;
      }
      const wp = read.legacy === 'wordPack' ? read.pack.textPacks?.[0] : undefined;
      if (wp) await exec({ op: 'set_word_pack', pack: wp }, '正在起名…');
      else openPackImport(read, file.name);
    });
  };
  return (
    <section>
      <h5>文字包：{pack.name}</h5>
      <p class="hint">名字由文字包按地貌类型生成（岛、山脉、海湾……各有模板和词表）。可以导出来改，做成别的风格再导入。</p>
      <div class="row wrap">
        <button onClick={() => download(`${pack.id}.json`, JSON.stringify(pack, null, 2), 'application/json')}>导出文字包</button>
        <label class="file-button">
          导入文字包…
          <input
            type="file"
            accept="application/json"
            onChange={(e) => {
              const f = (e.target as HTMLInputElement).files?.[0];
              if (f) importPack(f);
              (e.target as HTMLInputElement).value = '';
            }}
          />
        </label>
        {w.small.wordPack && <button onClick={() => void exec({ op: 'set_word_pack', pack: null }, '正在起名…')}>换回内置</button>}
      </div>
    </section>
  );
}

function FeatureList({ w }: { w: World }) {
  const [q, setQ] = useState('');
  const groups = labelGroups.value;
  const list = w.derived.features
    .filter((f) => f.name && !f.hidden && groups.has(FEATURE_INFO[f.type].group) && (!q || f.name.includes(q) || featureLabel(w, f).includes(q)))
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 150);
  return (
    <section>
      <h5>全部地名</h5>
      <input class="wide-input" placeholder="找地名…" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      <div class="list">
        {list.map((f) => (
          <div
            class={`item ${selectedFeature.value === f.key ? 'on' : ''}`}
            onClick={() => {
              selectedFeature.value = f.key;
              focusOn(f.cells);
            }}
          >
            <span class={`grow ellipsis ${f.custom ? 'custom' : ''}`}>{f.name}</span>
            <span class="hint">{featureLabel(w, f)}</span>
          </div>
        ))}
      </div>
      <HiddenList w={w} />
    </section>
  );
}

// 删掉的地名：一个个恢复，点名字在地图上看
function HiddenList({ w }: { w: World }) {
  const hidden = w.derived.features.filter((f) => f.name && f.hidden).sort((a, b) => b.importance - a.importance);
  if (!hidden.length) return null;
  return (
    <details>
      <summary>删掉的地名（{hidden.length}）</summary>
      <div class="list">
        {hidden.map((f) => (
          <div class="item" key={f.key}>
            <span class="grow ellipsis muted" onClick={() => focusOn(f.cells)} title="在地图上看">
              {f.name}
            </span>
            <span class="hint">{featureLabel(w, f)}</span>
            <button class="small" onClick={() => void exec(hideCommand(w, f, false), '正在恢复…')} title="地图上重新标出这个名字">
              恢复
            </button>
          </div>
        ))}
      </div>
    </details>
  );
}

export function NamesExtras() {
  const w = world.value;
  if (!w) return null;
  return (
    <>
      <FeatureList w={w} />
      <WordPackBox w={w} />
    </>
  );
}
