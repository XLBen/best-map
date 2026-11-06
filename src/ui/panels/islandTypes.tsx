
import { Plus, Trash2 } from 'lucide-preact';
import { Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
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
import { exec, openPanel, options, setOptions, world } from '../../state';
import { Seg } from '../common';
import { Toggle } from '../components/Toggle';
import { TypePicker, TypePickerButton } from '../shell/TypePicker';
import { Slider } from '../components/Slider';
import { KEY, NEW_COLORS, type Which, createAndUse, editIslandType as edit, editorRequest, islandSwatch } from './island-types';
import { registerPanels } from '../defs/panel-registry';

// 岛的种类（第十四轮）：放岛、画岛链底部条上“岛：珊瑚岛 ▾”的按钮、弹出的列表（最后一项“新建…”），
// “地形 ⋯”里的“岛的种类”（新建、修改、删掉自己的岛）

const hintOf = (t: IslandType) => (t as { hint?: string }).hint ?? `${ISLAND_SHAPE_INFO[t.shape].name} · ${t.province === 'sea' ? '归海省' : '归陆地省'}`;

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

// ---------- 新建、修改（新建、排队改在 island-types.ts） ----------

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
      <p class="hint">世界里的岛的种类（内置的几种在资源库里每个库的“基础”里）</p>
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

// 工具表里按名字引用的部件（defs/panel-registry.ts）
registerPanels({ IslandTypePick, ChainTypePick, ChainFragSlider, TerrainExtras });
