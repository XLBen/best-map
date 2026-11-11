import { ChevronRight, Library, Plus } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { FALLBACK_MAP_STYLE, type MapStyle } from '../../../core/map-style';
import { type WaterType, perCellRule, waterTypeOwner } from '../../../core/water-types';
import type { World } from '../../../core/world';
import { type PanelId, openPanel, world } from '../../state';
import { Seg } from '../common';
import { TypePicker, TypePickerButton } from '../shell/TypePicker';
import { openLibraryFor } from '../shell/type-picker';
import { LIBRARY_ADD_LABEL } from '../copy';
import { openWorldItem } from '../packs/panel-store';
import { type WaterKind, KINDS, createAndUse } from './water-types';
import { lakeTypeColor } from '../../render/colors';
import { riverStroke, riverTypeColor } from '../../render/overlay';

// 水体类型（河流类型、湖泊类型）共用的界面：底部条上“新画的河：血河 ▾”“这个湖：晶湖 ▾”的按钮、弹出的列表（最后一项“新建类型…”），
// “水系 ⋯”里的“水体类型”（河 / 湖两栏，选择用的列表）。
// 第九十三轮：这里以前有另一个编辑器（颜色、画法、粗细、两岸、起名、自然生成、条件、规则）。并进了资源库里这一种的页面——
// 那里是唯一能改的地方（规则的脚本框也搬过去了，packs/WaterScript.tsx）；列表上点一种、“新建类型…”都直达那一页

// 一种画出来的颜色（列表里的色块照旧按默认的画法——写实——画；画风选了另一种颜色时用 atlasColor）
const typeColor = (kind: WaterKind, t: WaterType, style: MapStyle = FALLBACK_MAP_STYLE) =>
  kind === 'lake' ? lakeTypeColor(t, style) : riverTypeColor(t, style);

// 普通的河、湖的颜色（列表里的色块）
const PLAIN_COLOR: Record<WaterKind, string> = { river: riverStroke(FALLBACK_MAP_STYLE), lake: 'rgb(70, 125, 175)' };

export function TypeSwatch({ kind, t }: { kind: WaterKind; t: WaterType | null }) {
  return <span class="swatch" style={{ background: t ? typeColor(kind, t) : PLAIN_COLOR[kind] }} />;
}

// 底部条上的按钮：“新画的河：血河 ▾”“这个湖：普通 ▾”。总是显示（世界里还没有类型时是“普通”，列表里能新建）。
// auto：现在是按各类型的规则判断出来的
// plainText：没有类型时写什么（新画的河、新放的湖按规则时写“按规则”）
export function TypeButton({ kind, prefix, type, auto, panel, plainText = '普通' }: { kind: WaterKind; prefix: string; type: WaterType | null; auto?: boolean; panel: PanelId; plainText?: string }) {
  const noun = KINDS[kind].noun;
  return (
    <TypePickerButton
      panel={panel}
      prefix={prefix}
      swatch={type ? typeColor(kind, type) : PLAIN_COLOR[kind]}
      name={type ? type.name : plainText}
      auto={auto && !!type}
      title={auto ? `${noun}的类型 · 自动` : `${noun}的类型`}
    />
  );
}

export interface MenuItem {
  t: WaterType | null;
  label: string;
  on: boolean;
  hint?: string;
  onPick: () => void;
}

// 弹出的列表：几行选择，最后一项“新建类型…”（新建一种、用上它，并打开它的编辑）
export function TypeMenu({ kind, items, onNew, note }: { kind: WaterKind; items: MenuItem[]; onNew: () => void; note?: string }) {
  const def = KINDS[kind];
  return (
    <TypePicker
      items={items.map((it) => ({
        ...(it.t ? { id: it.t.id } : {}),
        label: it.label,
        on: it.on,
        hint: it.hint,
        onPick: it.onPick,
        swatch: it.t ? typeColor(kind, it.t) : PLAIN_COLOR[kind],
        meta: it.t?.style && it.t.style !== 'solid' ? def.styleLabel[it.t.style] : undefined,
      }))}
      onNew={onNew}
      newLabel="新建类型…"
      newTitle={`新建一种${def.noun}并用上，在资源库里改`}
      library={def.library}
      note={note}
    />
  );
}

// ---------- “水系 ⋯”里的“水体类型” ----------

// 这一种在资源库里的页面（“⋯”先收起）
function openType(kind: WaterKind, id: string) {
  openPanel.value = null;
  openWorldItem(KINDS[kind].library, id);
}

// 一栏：这一类的列表（点一种在资源库里改）、新建、从资源库添加（血河这些示例在资源库里）
function TypeList({ w, kind }: { w: World; kind: WaterKind }) {
  const def = KINDS[kind];
  const types = def.list(w);
  return (
    <>
      {types.length === 0 ? <p class="hint">{def.intro}</p> : <p class="hint">点一种在资源库里改</p>}
      {types.length > 0 && (
        <div class="list">
          {types.map((t) => (
            <div class="item" key={t.id} role="button" tabIndex={0} title="在资源库里打开" onClick={() => openType(kind, t.id)} onKeyDown={(e) => e.key === 'Enter' && openType(kind, t.id)}>
              <span class="grow ellipsis">
                <TypeSwatch kind={kind} t={t} /> {waterTypeOwner(t)}
              </span>
              <span class="hint">
                {def.styleLabel[t.style ?? 'solid']}
                {t.natural === false ? ' · 不自然生成' : t.scripts?.match || perCellRule(t) ? ' · 自然生成' : ''}
              </span>
              <ChevronRight />
            </div>
          ))}
        </div>
      )}
      <div class="row wrap">
        <button class="small" onClick={() => void createAndUse(kind, null)}>
          <Plus /> 新建
        </button>
        <button class="small" title={`资源库里的${def.title}（奇幻的示例都在那里）`} onClick={() => openLibraryFor(def.library)}>
          <Library /> {LIBRARY_ADD_LABEL}
        </button>
      </div>
    </>
  );
}

// “水体类型”：河 / 湖两栏。打开时在用着放湖工具就先看湖那一栏
// tab、onTab（可选）：哪一栏由外面管（“水系 ⋯”在“湖”那一栏下面列出全部的湖）
export function WaterTypesSection({ initial, tab: outer, onTab }: { initial?: WaterKind; tab?: WaterKind; onTab?: (k: WaterKind) => void }) {
  const w = world.value;
  const [own, setOwn] = useState<WaterKind>(initial ?? 'river');
  const tab = outer ?? own;
  const setTab = (k: WaterKind) => {
    setOwn(k);
    onTab?.(k);
  };
  if (!w) return null;
  const count = (k: WaterKind) => KINDS[k].list(w).length;
  return (
    <section>
      <div class="row">
        <h5 class="grow">水体类型</h5>
        <Seg<WaterKind>
          value={tab}
          options={[
            ['river', `河${count('river') ? ` ${count('river')}` : ''}`],
            ['lake', `湖${count('lake') ? ` ${count('lake')}` : ''}`],
          ]}
          onChange={(v) => setTab(v)}
        />
      </div>
      <TypeList w={w} kind={tab} />
    </section>
  );
}
