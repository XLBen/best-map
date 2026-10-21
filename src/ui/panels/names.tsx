import { Dices, Lock, LockOpen, ScanSearch, Trash2, X } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { FEATURE_INFO, type GeoFeature, REGION_KIND_INFO, featureLabel } from '../../../core/features';
import { DEFAULT_PACK, type WordPack, wordPackSchema } from '../../../core/names';
import { REGION_KINDS, type RegionKind, type World } from '../../../core/world';
import { download, exec, focusName, labelGroups, selectedFeature, showToast, world } from '../../state';
import { focusOn } from '../camera';
import { Seg } from '../common';

// 地名：底部条上的“选中地名”编辑，工具列表下方的文字包与全部地名

// 名字框：回车或点别处提交，Esc 放弃这次输入（不在失去焦点时提交）。
// 刚圈好、刚放下的地名会让它获得焦点并选中文字，直接打字就是改名
function NameInput({ fkey, value, onCommit }: { fkey: string; value: string; onCommit: (v: string) => void }) {
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
  return <input ref={ref} class="bar-input" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} onKeyDown={onKey} onBlur={commit} />;
}

const AREA_KINDS = REGION_KINDS.filter((k) => k !== 'spot') as Exclude<RegionKind, 'spot'>[];

// 用户圈的区块、放的地名：类型、名字、换一个、恢复自动、删除
function RegionBar({ w, f, id }: { w: World; f: GeoFeature; id: string }) {
  const r = w.small.regions.find((x) => x.id === id);
  if (!r) return null;
  const update = (patch: { name?: string; kind?: RegionKind; reroll?: boolean }) => void exec({ op: 'update_region', id, ...patch }, '正在起名…');
  return (
    <>
      {r.kind === 'spot' ? (
        <span class="bar-label">地点</span>
      ) : (
        <Seg<Exclude<RegionKind, 'spot'>> value={r.kind} options={AREA_KINDS.map((k) => [k, REGION_KIND_INFO[k].label])} onChange={(k) => update({ kind: k })} />
      )}
      <NameInput fkey={f.key} value={f.name} onCommit={(v) => update({ name: v })} />
      <button class="bar-btn" onClick={() => update({ reroll: true })} title="按文字包换一个名字">
        <Dices size={15} /> 换一个
      </button>
      {f.custom && (
        <button class="bar-btn" onClick={() => update({ name: '' })} title="不用自己起的名字，按文字包自动起">
          <LockOpen size={15} /> 恢复自动
        </button>
      )}
      <button class="bar-btn icon" onClick={() => focusOn(f.cells)} title="在地图上看">
        <ScanSearch size={15} />
      </button>
      <button
        class="bar-btn icon"
        onClick={() => {
          selectedFeature.value = null;
          void exec({ op: 'remove_region', id }, '正在删除…');
        }}
        title="删掉这个地名"
      >
        <Trash2 size={15} />
      </button>
      <button class="bar-btn icon" onClick={() => (selectedFeature.value = null)} title="取消选择">
        <X size={15} />
      </button>
    </>
  );
}

export function NamesBar() {
  const w = world.value;
  const f = w?.derived.features.find((x) => x.key === selectedFeature.value);
  if (!w || !f) return null;
  if (f.region) return <RegionBar w={w} f={f} id={f.region} />;
  const rename = (v: string) => void exec({ op: 'rename_feature', key: f.key, name: v }, '正在改名…');
  return (
    <>
      <span class="bar-label">{FEATURE_INFO[f.type].label}</span>
      <NameInput fkey={f.key} value={f.name} onCommit={rename} />
      <button class="bar-btn" onClick={() => void exec({ op: 'reroll_feature', key: f.key }, '正在起名…')} title="自动换一个名字">
        <Dices size={15} /> 换一个
      </button>
      {f.custom ? (
        <button class="bar-btn" onClick={() => rename('')} title="不再固定，跟着文字包自动起名">
          <LockOpen size={15} /> 恢复自动
        </button>
      ) : (
        <button class="bar-btn" onClick={() => rename(f.name)} title="之后地形再变，这个名字也不会变">
          <Lock size={15} /> 锁定
        </button>
      )}
      <button class="bar-btn icon" onClick={() => focusOn(f.cells)} title="在地图上看">
        <ScanSearch size={15} />
      </button>
      <button class="bar-btn icon" onClick={() => (selectedFeature.value = null)} title="取消选择">
        <X size={15} />
      </button>
    </>
  );
}

function WordPackBox({ w }: { w: World }) {
  const pack = w.small.wordPack ?? DEFAULT_PACK;
  const importPack = (file: File) => {
    void file.text().then(async (text) => {
      try {
        const parsed = wordPackSchema.safeParse(JSON.parse(text));
        if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}：${i.message}`).slice(0, 3).join('；'));
        await exec({ op: 'set_word_pack', pack: parsed.data as WordPack }, '正在起名…');
      } catch (e) {
        showToast(`文字包读不了：${(e as Error).message}`, true);
      }
    });
  };
  return (
    <section>
      <h5>文字包：{pack.name}</h5>
      <p class="muted small">名字由文字包按地貌类型生成（岛、山脉、海湾……各有模板和词表）。可以导出来改，做成别的风格再导入。</p>
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
    .filter((f) => f.name && groups.has(FEATURE_INFO[f.type].group) && (!q || f.name.includes(q) || featureLabel(w, f).includes(q)))
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 150);
  return (
    <section>
      <h5>全部地名</h5>
      <input class="wide-input" placeholder="找地名…" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      <div class="feature-list">
        {list.map((f) => (
          <div
            class={`feature-row ${selectedFeature.value === f.key ? 'on' : ''}`}
            onClick={() => {
              selectedFeature.value = f.key;
              focusOn(f.cells);
            }}
          >
            <span class={f.custom ? 'custom' : ''}>{f.name}</span>
            <span class="muted small">{featureLabel(w, f)}</span>
          </div>
        ))}
      </div>
    </section>
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
