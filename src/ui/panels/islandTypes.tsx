import { signal } from '@preact/signals';
import { ChevronDown, Plus, Trash2 } from 'lucide-preact';
import { Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import {
  BUILTIN_ISLAND_TYPES,
  ISLAND_HEIGHTS,
  ISLAND_HEIGHT_INFO,
  ISLAND_LOOK_INFO,
  ISLAND_ROCK_RANGE,
  ISLAND_SHAPES,
  ISLAND_SHAPE_INFO,
  type IslandType,
  allIslandTypes,
  islandTypeById,
  islandTypesOf,
  liveIslandKind,
} from '../../../core/island-types';
import type { Command } from '../../../core/commands';
import { SCRIPT_API } from '../../../core/script';
import type { World } from '../../../core/world';
import { exec, openPanel, options, replaceLast, setOptions, toast, togglePanel, trustHandledElsewhere, whenEditsIdle, world, worldEpoch } from '../../state';
import { Seg } from '../common';
import { noteScriptCommitted, showCell } from '../editor-hooks';
import { ScriptBox } from '../ScriptBox';
import { type ApplyMode, type ApplyResult, normScript } from '../script-commit';
import { DragSlider } from './rivers';

// 岛的种类（第十四轮）：放岛、画岛链底部条上“岛：珊瑚岛 ▾”的按钮、弹出的列表（最后一项“新建…”），
// “地形 ⋯”里的“岛的种类”（新建、修改、删掉自己的岛）

export { liveIslandKind };

// 列表里的色块：自己选的颜色；白沙、沙洲按样子；和周围一样的画成草地的绿
export function islandSwatch(t: IslandType | undefined): string {
  const c = t?.color;
  if (!c) return '#7f9a68';
  if (c === 'coral') return '#f2eedd';
  if (c === 'marsh') return '#a8b89a';
  return c;
}

const hintOf = (t: IslandType) => (t as { hint?: string }).hint ?? `${ISLAND_SHAPE_INFO[t.shape].name} · ${t.province === 'sea' ? '归海省' : '归陆地省'}`;

type Which = 'island' | 'chain';
const KEY: Record<Which, 'islandKind' | 'chainKind'> = { island: 'islandKind', chain: 'chainKind' };
const PANEL: Record<Which, 'islandtype' | 'chaintype'> = { island: 'islandtype', chain: 'chaintype' };

function TypePick({ which }: { which: Which }) {
  const w = world.value;
  if (!w) return null;
  const t = islandTypeById(w.small, liveIslandKind(w, options.value[KEY[which]]));
  const panel = PANEL[which];
  return (
    <button class={`bar-btn ${openPanel.value === panel ? 'on' : ''}`} data-panel={panel} onClick={() => togglePanel(panel)} title={t ? hintOf(t) : '放哪一种岛'}>
      <span class="muted">岛：</span>
      <span class="swatch" style={{ background: islandSwatch(t) }} /> {t?.name ?? '大陆岛'}
      <ChevronDown size={13} />
    </button>
  );
}

// 放岛工具条上的“岛：X ▾”
export const IslandTypePick = () => <TypePick which="island" />;
// 画岛链工具条上的“岛：X ▾”（岛链有自己的选择，放岛时选了小礁不影响岛链）
export const ChainTypePick = () => <TypePick which="chain" />;

// 弹出的列表：内置的四种、自己的几种，最后一项“新建…”（新建一种、用上它，并打开它的设置）
export function IslandTypeMenu({ which }: { which: Which }) {
  const w = world.value;
  if (!w) return null;
  const cur = liveIslandKind(w, options.value[KEY[which]]);
  const pick = (id: string) => {
    setOptions({ [KEY[which]]: id });
    openPanel.value = null;
  };
  return (
    <div class="menu">
      {allIslandTypes(w.small).map((t) => (
        <button key={t.id} class={`menu-row ${cur === t.id ? 'on' : ''}`} title={hintOf(t)} onClick={() => pick(t.id)}>
          <span class="swatch" style={{ background: islandSwatch(t) }} />
          <span>{t.name}</span>
          <span class="muted small">{ISLAND_SHAPE_INFO[t.shape].name}</span>
        </button>
      ))}
      <button class="menu-row" onClick={() => void createAndUse(which)} title="新建一种岛，用上它，并打开它的设置">
        <Plus size={14} />
        <span>新建…</span>
      </button>
    </div>
  );
}

// ---------- 新建、修改 ----------

// “地形 ⋯”里要展开哪一种（新建之后打开它的设置）
const editorRequest = signal<string | null>(null);

const NEW_COLORS = ['#3d3a38', '#b5523b', '#6b8f3a', '#c9a24a', '#4d7f9c', '#8a5aa8'];
export function newIslandType(w: World): IslandType {
  const ids = new Set(islandTypesOf(w.small).map((t) => t.id));
  let k = 1;
  while (ids.has(`island-type-${k}`)) k++;
  return { id: `island-type-${k}`, name: `新的岛 ${k}`, shape: 'rugged', height: 'hilly', color: NEW_COLORS[(k - 1) % NEW_COLORS.length], province: 'land' };
}

async function createAndUse(which: Which | null): Promise<void> {
  const w = world.value;
  if (!w) return;
  openPanel.value = null;
  const t = newIslandType(w);
  const ok = await exec({ op: 'set_island_type', type: t }, '正在新建…');
  if (!ok) return;
  if (which) setOptions({ [KEY[which]]: t.id });
  editorRequest.value = t.id;
  openPanel.value = 'cat:terrain';
}

// 连着改几项时排队：后一步按前一步改完之后世界上的这一种做出整份（set_island_type 是整份换掉）
let tail: Promise<unknown> = Promise.resolve();
let queued = 0;
function edit(id: string, make: (t: IslandType) => IslandType) {
  const epoch = worldEpoch.value;
  queued++;
  tail = tail.then(async () => {
    await whenEditsIdle();
    const w = world.value;
    if (worldEpoch.value !== epoch || !w) return;
    const t = islandTypesOf(w.small).find((x) => x.id === id);
    if (!t) return;
    const next = make(structuredClone(t));
    const out = { ...next } as Record<string, unknown>;
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    if (JSON.stringify(out) !== JSON.stringify(t)) await exec({ op: 'set_island_type', type: out as unknown as IslandType }, '正在修改…');
  });
  tail = tail.then(
    () => void queued--,
    () => void queued--,
  );
}

// ---------- 脚本（第十五轮） ----------

type IslandScriptKind = 'placement' | 'shape';

// 排着的修改都做完了没有、等它们做完（脚本框提交前先等，“换掉最后一步”才不会换掉别人的那一步）
const editsSettled = () => queued === 0;
async function settleEdits(): Promise<void> {
  while (!editsSettled()) {
    await tail;
    await whenEditsIdle();
  }
}

// 这一种的一段脚本换成 src（空的就去掉）
export function islandScriptCommand(t: IslandType, kind: IslandScriptKind, src: string): Command {
  const s = normScript(src);
  const scripts = { ...(t.scripts ?? {}) };
  if (s) scripts[kind] = { api: SCRIPT_API, src: s };
  else delete scripts[kind];
  const next = { ...t } as IslandType;
  if (Object.keys(scripts).length) next.scripts = scripts;
  else delete next.scripts;
  return { op: 'set_island_type', type: next };
}

// 提交脚本。信任与别的脚本框一样只记框里写的这一段；revert：出错后换回旧写法，不报给信任列表
async function applyIslandScript(id: string, kind: IslandScriptKind, src: string, mode: ApplyMode, revert = false): Promise<ApplyResult> {
  const w = world.value;
  const t = w ? islandTypesOf(w.small).find((x) => x.id === id) : undefined;
  if (!t) return { ok: false, error: '这种岛已经不在了' };
  const before = t.scripts?.[kind]?.src ?? '';
  const cmd = trustHandledElsewhere(islandScriptCommand(t, kind, src));
  const ok = mode === 'exec' ? await exec(cmd, '正在修改…') : await replaceLast(cmd, '正在修改…');
  if (ok) {
    if (!revert) noteScriptCommitted({ species: `island:${id}`, kind, src: normScript(src), before, mode });
    return { ok: true };
  }
  const x = toast.value;
  return { ok: false, error: x?.error ? x.text : '没有改成' };
}

function IslandScripts({ t }: { t: IslandType }) {
  const w = world.value;
  if (!w) return null;
  const box = (kind: IslandScriptKind, label: string, hint: string) => (
    <ScriptBox
      key={`${worldEpoch.value}:island:${t.id}:${kind}`}
      kind={kind}
      scope="island"
      label={label}
      hint={hint}
      value={t.scripts?.[kind]?.src ?? ''}
      issue={() => null}
      apply={(src, mode, revert) => applyIslandScript(t.id, kind, src, mode, revert)}
      idle={editsSettled}
      settle={settleEdits}
      fields={Object.keys(w.causes.fields)}
      onShowCell={showCell}
    />
  );
  return (
    <>
      <h5>脚本</h5>
      <p class="muted small">放岛的那一刻才运行，只影响以后放的岛。出错的那一段按没有脚本放，并在放岛的说明里写出来。</p>
      {box('placement', '放在哪里', '每格一次，真的格岛才能占；点的地方不行就不放')}
      {box('shape', '岛的样子', '每格一次，返回这格的高度（米），或 {height, rock, land}')}
    </>
  );
}

const ROCK_LO = ISLAND_ROCK_RANGE[0];
const ROCK_HI = ISLAND_ROCK_RANGE[1];
const rockPos = (v: number) => Math.log(v / ROCK_LO) / Math.log(ROCK_HI / ROCK_LO);
const rockAt = (p: number) => Math.round(ROCK_LO * Math.pow(ROCK_HI / ROCK_LO, Math.max(0, Math.min(1, p))) * 20) / 20;
const rockText = (v: number) => `${v < 0.7 ? '硬' : v < 2 ? '中' : v < 4 ? '软' : '很软'} ${v.toFixed(2)}`;

type ColorChoice = 'same' | 'coral' | 'marsh' | 'own';
const colorChoice = (t: IslandType): ColorChoice => (!t.color ? 'same' : t.color === 'coral' || t.color === 'marsh' ? t.color : 'own');

function IslandTypeEditor({ t }: { t: IslandType }) {
  const [rock, setRock] = useState<number | null>(null);
  useEffect(() => setRock(null), [t.rock]);
  const [name, setName] = useState(t.name);
  useEffect(() => setName(t.name), [t.name]);
  const [names, setNames] = useState((t.names ?? []).map((n) => n.p).join('\n'));
  useEffect(() => setNames((t.names ?? []).map((n) => n.p).join('\n')), [t.id, JSON.stringify(t.names ?? null)]);
  const saveName = () => {
    const v = name.trim().slice(0, 12);
    if (v && v !== t.name) edit(t.id, (x) => ({ ...x, name: v }));
    else setName(t.name);
  };
  const saveNames = () => {
    const list = names
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 20)
      .map((p) => p.slice(0, 40));
    edit(t.id, (x) => ({ ...x, names: list.length ? list.map((p) => ({ p })) : undefined }));
  };
  const flatOnly = t.shape === 'ring' || t.shape === 'cell';
  const cc = colorChoice(t);
  return (
    <div class="river-type-editor">
      <div class="row">
        <input class="grow" value={name} maxLength={12} onInput={(e) => setName((e.target as HTMLInputElement).value)} onBlur={saveName} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
      </div>
      <div class="row wrap">
        <span class="hs-label">颜色</span>
        <Seg<ColorChoice>
          value={cc}
          options={[
            ['same', '和周围一样'],
            ['coral', ISLAND_LOOK_INFO.coral.name],
            ['marsh', ISLAND_LOOK_INFO.marsh.name],
            ['own', '自己选'],
          ]}
          titles={{ coral: ISLAND_LOOK_INFO.coral.hint, marsh: ISLAND_LOOK_INFO.marsh.hint }}
          onChange={(v) => edit(t.id, (x) => ({ ...x, color: v === 'same' ? undefined : v === 'own' ? (cc === 'own' ? x.color : NEW_COLORS[0]) : v }))}
        />
        {cc === 'own' && <input type="color" value={t.color} title="岛上的地的颜色" onChange={(e) => edit(t.id, (x) => ({ ...x, color: (e.target as HTMLInputElement).value }))} />}
      </div>
      <div class="row wrap">
        <span class="hs-label">省份</span>
        <Seg<'land' | 'sea'>
          value={t.province}
          options={[
            ['land', '归陆地省'],
            ['sea', '归海省'],
          ]}
          titles={{ sea: '像小礁一样，算进旁边的海省' }}
          onChange={(v) => edit(t.id, (x) => ({ ...x, province: v }))}
        />
      </div>
      <h5>以后放的岛</h5>
      <p class="muted small">形状、高低、岩石、脚本只用在以后放的岛上；颜色、省份、起名马上用到已经放的岛上。</p>
      <div class="row wrap">
        <span class="hs-label">形状</span>
        <Seg<IslandType['shape']>
          value={t.shape}
          options={ISLAND_SHAPES.map((s) => [s, ISLAND_SHAPE_INFO[s].name])}
          titles={Object.fromEntries(ISLAND_SHAPES.map((s) => [s, ISLAND_SHAPE_INFO[s].hint]))}
          onChange={(v) => edit(t.id, (x) => ({ ...x, shape: v }))}
        />
      </div>
      {!flatOnly && (
        <div class="row wrap">
          <span class="hs-label">高低</span>
          <Seg<IslandType['height']>
            value={t.height}
            options={ISLAND_HEIGHTS.map((h) => [h, ISLAND_HEIGHT_INFO[h].name])}
            titles={Object.fromEntries(ISLAND_HEIGHTS.map((h) => [h, ISLAND_HEIGHT_INFO[h].hint]))}
            onChange={(v) => edit(t.id, (x) => ({ ...x, height: v }))}
          />
        </div>
      )}
      <div class="row wrap">
        <label class="check">
          <input type="checkbox" checked={t.rock === undefined} onChange={() => edit(t.id, (x) => ({ ...x, rock: x.rock === undefined ? 1 : undefined }))} />
          岩石和周围一样
        </label>
      </div>
      {t.rock !== undefined && (
        <div class="row">
          <DragSlider
            label="岩石"
            pos={rockPos(rock ?? t.rock)}
            text={rockText(rock ?? t.rock)}
            title="硬的蚀得慢、留得高；软的蚀得低平"
            onDraft={(p) => setRock(rockAt(p))}
            onCommit={(p) => {
              const v = rockAt(p);
              setRock(v);
              edit(t.id, (x) => ({ ...x, rock: v }));
            }}
            onCancel={() => setRock(null)}
          />
        </div>
      )}
      <h5>起名</h5>
      <p class="muted small">每行一个模板，比如 {'{color}'}沙岛、{'{animal}'}礁；不写时按普通的岛起名。岛的大半是这一种时用。</p>
      <textarea class="names-box" rows={3} value={names} onInput={(e) => setNames((e.target as HTMLTextAreaElement).value)} onBlur={saveNames} />
      <IslandScripts t={t} />
      <div class="row wrap">
        <button class="small danger" onClick={() => void exec({ op: 'remove_island_type', id: t.id }, '正在删掉…')} title="删掉这一种：已经放的这种岛变成大陆岛">
          <Trash2 size={14} /> 删掉这一种
        </button>
      </div>
    </div>
  );
}

// “地形 ⋯”里的“岛的种类”
export function IslandTypesSection() {
  const w = world.value;
  const [open, setOpen] = useState<string | null>(null);
  const req = editorRequest.value;
  useEffect(() => {
    if (!req) return;
    setOpen(req);
    editorRequest.value = null;
  }, [req]);
  if (!w) return null;
  const own = islandTypesOf(w.small);
  return (
    <section>
      <h5>岛的种类</h5>
      <p class="muted small">
        内置的有{BUILTIN_ISLAND_TYPES.map((t) => t.name).join('、')}。自己的岛可以选形状、颜色、岩石、高低、归哪种省和起名的样子，还能写脚本定放在哪里、长成什么样（示例包里的湖心岛就是这样做的），放岛、画岛链时都能选。
      </p>
      {own.length > 0 && (
        <div class="feature-list">
          {own.map((t) => (
            <Fragment key={t.id}>
              <div class={`feature-row river-row ${open === t.id ? 'on' : ''}`} onClick={() => setOpen(open === t.id ? null : t.id)}>
                <span>
                  <span class="swatch" style={{ background: islandSwatch(t) }} /> {t.name}
                </span>
                <span class="muted small">
                  {ISLAND_SHAPE_INFO[t.shape].name}
                  {t.province === 'sea' ? ' · 归海省' : ''}
                </span>
              </div>
              {open === t.id && <IslandTypeEditor t={t} />}
            </Fragment>
          ))}
        </div>
      )}
      <div class="row wrap">
        <button class="small" onClick={() => void createAndUse(null)}>
          <Plus size={14} /> 新建
        </button>
      </div>
    </section>
  );
}

// 地形这一类的“⋯”
export function TerrainExtras() {
  return <IslandTypesSection />;
}
