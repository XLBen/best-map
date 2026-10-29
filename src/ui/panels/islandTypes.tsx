import { signal } from '@preact/signals';
import { Plus, Trash2 } from 'lucide-preact';
import { Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
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
import type { World } from '../../../core/world';
import { exec, openPanel, options, setOptions, whenEditsIdle, world, worldEpoch } from '../../state';
import { Seg } from '../common';
import { Toggle } from '../components/Toggle';
import { TypePicker, TypePickerButton } from '../components/TypePicker';
import { Slider } from '../components/Slider';

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
  return <TypePickerButton panel={PANEL[which]} prefix="岛" swatch={islandSwatch(t)} name={t?.name ?? '大陆岛'} title={t ? hintOf(t) : '岛的种类'} />;
}

// 放岛工具条上的“岛：X ▾”
export const IslandTypePick = () => <TypePick which="island" />;
// 画岛链工具条上的“岛：X ▾”（岛链有自己的选择，放岛时选了小礁不影响岛链）
export const ChainTypePick = () => <TypePick which="chain" />;

// 画岛链工具条上的“碎岛 0–100%”（第十八轮）：按链上的编号把这么多的岛换成碎岛（不随机），100% 全是碎岛。
// 拖的时候正在画的岛链跟着变；种类本身是碎岛时用不上（全是碎岛），不显示
export function ChainFragSlider() {
  const w = world.value;
  const start = useRef<number | null>(null);
  if (!w || islandTypeById(w.small, liveIslandKind(w, options.value.chainKind))?.shape === 'frag') return null;
  const v = options.value.chainFrag;
  const snap = (p: number) => Math.round(Math.max(0, Math.min(1, p)) * 20) / 20;
  return (
    <Slider
      label="碎岛"
      pos={v}
      text={`${Math.round(v * 100)}%`}
      title="岛链里碎岛的比例"
      onDraft={(p) => {
        start.current ??= v;
        setOptions({ chainFrag: snap(p) });
      }}
      onCommit={(p) => {
        start.current = null;
        setOptions({ chainFrag: snap(p) });
      }}
      onCancel={() => {
        if (start.current !== null) setOptions({ chainFrag: start.current });
        start.current = null;
      }}
    />
  );
}

// 弹出的列表：内置的五种、自己的几种，最后一项“新建…”（新建一种、用上它，并打开它的设置）
export function IslandTypeMenu({ which }: { which: Which }) {
  const w = world.value;
  if (!w) return null;
  const cur = liveIslandKind(w, options.value[KEY[which]]);
  const pick = (id: string) => {
    setOptions({ [KEY[which]]: id });
    openPanel.value = null;
  };
  return (
    <TypePicker
      items={allIslandTypes(w.small).map((t) => ({
        id: t.id,
        label: t.name,
        swatch: islandSwatch(t),
        on: cur === t.id,
        hint: hintOf(t),
        meta: ISLAND_SHAPE_INFO[t.shape].name,
        onPick: () => pick(t.id),
      }))}
      onNew={() => void createAndUse(which)}
      newLabel="新建…"
      newTitle="新建一种岛并打开设置"
      library="islandType"
    />
  );
}

// ---------- 新建、修改 ----------

// “地形 ⋯”里要展开哪一种（新建之后打开它的设置）
const editorRequest = signal<string | null>(null);
// 别处（资源库的“编辑”）要打开某一种的设置
export const requestIslandTypeEditor = (id: string) => void (editorRequest.value = id);

const NEW_COLORS = ['#3d3a38', '#b5523b', '#6b8f3a', '#c9a24a', '#4d7f9c', '#8a5aa8'];
export function newIslandType(w: World): IslandType {
  const ids = new Set(islandTypesOf(w.small).map((t) => t.id));
  let k = 1;
  while (ids.has(`island-type-${k}`)) k++;
  return { id: `island-type-${k}`, name: `新的岛 ${k}`, shape: 'rugged', height: 'hilly', color: NEW_COLORS[(k - 1) % NEW_COLORS.length], province: 'land' };
}

export async function createAndUse(which: Which | null): Promise<void> {
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
function edit(id: string, make: (t: IslandType) => IslandType) {
  const epoch = worldEpoch.value;
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
  const flatOnly = t.shape === 'ring' || t.shape === 'cell' || t.shape === 'frag';
  // 碎岛（第十八轮）：格还是海，只是画出来（颜色按附近的地），总是归海省；岩石、高低用不上
  const shards = t.shape === 'frag';
  const cc = colorChoice(t);
  return (
    <div class="river-type-editor">
      <div class="row">
        <input class="grow" value={name} maxLength={12} onInput={(e) => setName((e.target as HTMLInputElement).value)} onBlur={saveName} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
      </div>
      {shards && <p class="hint">碎岛的格还是海，归海省</p>}
      {!shards && (
      <div class="row wrap">
        <span class="bar-label">颜色</span>
        <Seg<ColorChoice>
          value={cc}
          options={[
            ['same', '和周围一样'],
            ['coral', ISLAND_LOOK_INFO.coral.name],
            ['marsh', ISLAND_LOOK_INFO.marsh.name],
            ['own', '自选'],
          ]}
          titles={{ coral: ISLAND_LOOK_INFO.coral.hint, marsh: ISLAND_LOOK_INFO.marsh.hint }}
          onChange={(v) => edit(t.id, (x) => ({ ...x, color: v === 'same' ? undefined : v === 'own' ? (cc === 'own' ? x.color : NEW_COLORS[0]) : v }))}
        />
        {cc === 'own' && <input type="color" value={t.color} title="岛的颜色" onChange={(e) => edit(t.id, (x) => ({ ...x, color: (e.target as HTMLInputElement).value }))} />}
      </div>
      )}
      {!shards && (
      <div class="row wrap">
        <span class="bar-label">省份</span>
        <Seg<'land' | 'sea'>
          value={t.province}
          options={[
            ['land', '归陆地省'],
            ['sea', '归海省'],
          ]}
          titles={{ sea: '算进旁边的海省' }}
          onChange={(v) => edit(t.id, (x) => ({ ...x, province: v }))}
        />
      </div>
      )}
      <h5>以后放的岛</h5>
      <div class="row wrap">
        <span class="bar-label">形状</span>
        <Seg<IslandType['shape']>
          value={t.shape}
          options={ISLAND_SHAPES.map((s) => [s, ISLAND_SHAPE_INFO[s].name])}
          titles={Object.fromEntries(ISLAND_SHAPES.map((s) => [s, ISLAND_SHAPE_INFO[s].hint]))}
          onChange={(v) => edit(t.id, (x) => ({ ...x, shape: v }))}
        />
      </div>
      {!flatOnly && (
        <div class="row wrap">
          <span class="bar-label">高低</span>
          <Seg<IslandType['height']>
            value={t.height}
            options={ISLAND_HEIGHTS.map((h) => [h, ISLAND_HEIGHT_INFO[h].name])}
            titles={Object.fromEntries(ISLAND_HEIGHTS.map((h) => [h, ISLAND_HEIGHT_INFO[h].hint]))}
            onChange={(v) => edit(t.id, (x) => ({ ...x, height: v }))}
          />
        </div>
      )}
      {!shards && (
        <Toggle on={t.rock === undefined} onChange={() => edit(t.id, (x) => ({ ...x, rock: x.rock === undefined ? 1 : undefined }))}>
          岩石和周围一样
        </Toggle>
      )}
      {!shards && t.rock !== undefined && (
        <Slider
          stacked
          label="岩石"
          pos={rockPos(rock ?? t.rock)}
          text={rockText(rock ?? t.rock)}
          title="硬的留得高，软的蚀得低"
          onDraft={(p) => setRock(rockAt(p))}
          onCommit={(p) => {
            const v = rockAt(p);
            setRock(v);
            edit(t.id, (x) => ({ ...x, rock: v }));
          }}
          onCancel={() => setRock(null)}
        />
      )}
      <h5>起名</h5>
      <p class="hint">每行一个模板，如 {'{color}'}沙岛、{'{animal}'}礁</p>
      <textarea rows={3} value={names} onInput={(e) => setNames((e.target as HTMLTextAreaElement).value)} onBlur={saveNames} />
      <div class="row wrap">
        <button class="small danger" onClick={() => void exec({ op: 'remove_island_type', id: t.id }, '正在删除…')} title="已放的这种岛变成大陆岛">
          <Trash2 /> 删除
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
      <p class="hint">
        内置：{BUILTIN_ISLAND_TYPES.map((t) => t.name).join('、')}
      </p>
      {own.length > 0 && (
        <div class="list">
          {own.map((t) => (
            <Fragment key={t.id}>
              <div class={`item ${open === t.id ? 'on' : ''}`} onClick={() => setOpen(open === t.id ? null : t.id)}>
                <span class="grow ellipsis">
                  <span class="swatch" style={{ background: islandSwatch(t) }} /> {t.name}
                </span>
                <span class="hint">
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
          <Plus /> 新建
        </button>
      </div>
    </section>
  );
}

// 地形这一类的“⋯”
export function TerrainExtras() {
  return <IslandTypesSection />;
}
