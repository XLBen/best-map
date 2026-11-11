import { effect } from '@preact/signals';
import { Merge, RefreshCw, SplitSquareHorizontal, Waves, X } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Command } from '../../core/commands';
import { PROVINCE_KINDS, PROVINCE_KIND_INFO, type ProvinceKind } from '../../core/provinces';
import { provinceCells } from '../../core/select';
import type { World } from '../../core/world';
import { provinceDisplayColor, seaProvinceDefaultColor } from '../../core/world';
import { type ViewMode, exec, mapKm, mode, openPanel, provinceSet, selectedProvince, world } from '../state';
import { countryAt, countryRows, hasCountries, territoryCommand } from './domain/countries';
import { execRegen } from './domain/regen-ask';
import { brushNew } from './tools/provinces';
import { focusOn } from './camera';
import { MenuItem } from './components/MenuItem';
import { SelectionActions } from './shell/SelectionActions';
import { Toggle } from './components/Toggle';
import { TypePicker } from './shell/TypePicker';
import { defaultStyleName, restyleOffer, styleChoices } from './packs/styles';
import { clearBarPreview, holdBarPreview, showProvinceCommand, showSplit } from './provincePreview';
import { provinceMultiCommands } from './province-panel';
import { PROVINCE_RULES_NOTE, PROVINCE_RULES_TIP } from './copy';
import { openProvinceRules } from './packs/open-province';
import { openGenSettings } from './packs/open-era';
import { GEN_OPEN_TIP, GEN_TITLE } from './packs/copy';
import { registerPanels } from './defs/panel-registry';

// 省份：底部条上的“选中省份”编辑（不常用的在它的“⋯”里）、省份着色开关；“省份 ⋯”里的划分省份、换一种划分（规则在资源库的“省份划分”里）

// 省份着色：底图只在用户点了才换成省份；再点一下回到原来的底图
let viewBefore: ViewMode = 'terrain';
export function ProvinceColorToggle() {
  const on = mode.value === 'provinces';
  return (
    <Toggle
      on={on}
      onChange={() => {
        if (on) mode.value = viewBefore === 'provinces' ? 'terrain' : viewBefore;
        else {
          viewBefore = mode.value;
          mode.value = 'provinces';
        }
      }}
      title="底图按省份着色"
    >
      省份着色
    </Toggle>
  );
}

// 选中的省：一些算好的数
function provinceOf(w: World, id: number) {
  const meta = w.small.provinces[id];
  const cells = provinceCells(w, id);
  const [r, g, b] = provinceDisplayColor(w, id);
  // 湖省：一半以上的格已经不是湖了（湖被删掉、干了），可以改回陆地
  const lakeGone = meta.kind === 'lake' && cells.filter((i) => w.derived.lake[i] === 1).length * 2 < cells.length;
  return { meta, cells, lakeGone, hex: `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`, auto: !meta.color };
}

// 名字和原文（第二十七轮）：两个框一组，焦点离开这一组、回车时一起提交；Esc 回到原来的
function ProvinceName({ id, name, orig }: { id: number; name: string; orig: string }) {
  const [n, setN] = useState(name);
  const [o, setO] = useState(orig);
  // Esc：放弃这次输入（不在失去焦点时提交）
  const cancelled = useRef(false);
  useEffect(() => setN(name), [id, name]);
  useEffect(() => setO(orig), [id, orig]);
  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const nn = n.trim();
    const oo = o.trim();
    if (!nn || (nn === name && oo === orig)) return;
    void exec({ op: 'set_province', id, name: nn, ...(oo ? { orig: oo } : {}) }, '正在改名…');
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
    if (e.key === 'Escape') {
      e.stopPropagation();
      cancelled.current = true;
      setN(name);
      setO(orig);
      (e.target as HTMLInputElement).blur();
    }
  };
  return (
    <span
      class="bar-pair"
      onFocusOut={(e) => {
        const to = e.relatedTarget as Node | null;
        if (!to || !(e.currentTarget as HTMLElement).contains(to)) commit();
      }}
    >
      <input class="bar-input" value={n} onInput={(e) => setN((e.target as HTMLInputElement).value)} onKeyDown={onKey} />
      <input class="bar-input label-input" value={o} placeholder="原文" maxLength={80} onInput={(e) => setO((e.target as HTMLInputElement).value)} onKeyDown={onKey} />
    </span>
  );
}

// 省份归哪一国（第二十七轮）：整省的陆地一起划过去（paint_country）。陆地省、有国家时才有
function ProvinceOwner({ w, cells }: { w: World; cells: number[] }) {
  if (!hasCountries(w)) return null;
  const land = cells.filter((i) => w.causes.land[i] === 1);
  if (!land.length) return null;
  const now = countryAt(w, land[0]);
  const rows = countryRows(w);
  return (
    <span class="bar-choice">
      <span class="bar-label">归属</span>
      <select
        class="bar-select"
        value={String(now ?? 0)}
        title="整省划给这一国"
        onChange={(e) => {
          const v = Number((e.target as HTMLSelectElement).value);
          if (v !== (now ?? 0)) void exec(territoryCommand(land, v || null), '正在计算…');
        }}
      >
        <option value="0">无主地</option>
        {rows.map((r) => (
          <option value={r.meta.id}>{r.meta.name}</option>
        ))}
      </select>
    </span>
  );
}

export function ProvinceBar() {
  const w = world.value;
  const id = selectedProvince.value;
  const meta = w && id !== null ? w.small.provinces[id] : null;
  // 按钮不见了（取消选择、换了工具）时鼠标移开的事件不会来：一并去掉按钮的预览
  useEffect(() => clearBarPreview, []);
  if (w && provinceSet.value.length > 1) return <ProvinceMulti w={w} ids={provinceSet.value} />;
  if (!w || id === null || !meta) return null;
  const { cells, lakeGone, hex, auto } = provinceOf(w, id);
  const area = Math.round((cells.length * mapKm(w).cell ** 2) / 100) * 100;
  // 第二十七轮：名字连同原文、颜色、类型、归属国都在条上（不常用的地名风格、定位还在“⋯”里）。
  // 海省默认不着色（地图上看得到海本来的样子）；点色块自选颜色
  return (
    <>
      <label class="swatch-pick" title={auto ? (meta.land ? '自动配色，点了自选' : '海省默认不着色，点了自选') : '自选的颜色'}>
        <span class="swatch" style={{ background: !meta.land && auto ? 'transparent' : hex }} />
        <input
          type="color"
          value={hex}
          onChange={(e) => {
            const v = (e.target as HTMLInputElement).value.toLowerCase();
            if (v !== meta.color) void exec({ op: 'set_province', id, color: v }, '正在修改…');
          }}
        />
      </label>
      <ProvinceName id={id} name={meta.name} orig={meta.orig ?? ''} />
      <span class="bar-label" title={`${cells.length} 格`}>
        约 {area.toLocaleString()} km²
      </span>
      {/* 类型：陆地省份只有“无人区”一个开关；湖省只由自动划分产生，底部条上只标出来 */}
      {meta.land && meta.kind !== 'lake' && (
        <Toggle on={meta.kind === 'wasteland'} onChange={(on) => void exec({ op: 'set_province', id, kind: on ? 'wasteland' : 'land' }, '正在修改…')} title={PROVINCE_KIND_INFO.wasteland.hint}>
          无人区
        </Toggle>
      )}
      {meta.kind === 'lake' && (
        <span class="bar-chip" title={PROVINCE_KIND_INFO.lake.hint}>
          {lakeGone ? '湖省 · 已没有湖' : '湖省'}
        </span>
      )}
      {meta.land && <ProvinceOwner w={w} cells={cells} />}
      <Toggle on={!!meta.locked} onChange={(on) => void exec({ op: 'set_province', id, locked: on }, '正在修改…')} title="重新划分时不动它">
        锁定
      </Toggle>
      {/* 鼠标停在按钮上：地图上先画出新的省界，分出来的那一半淡淡地涂上它将来的颜色 */}
      <button
        class="bar-btn"
        disabled={meta.locked || cells.length < 2}
        onPointerEnter={() => showSplit(w, id)}
        onPointerLeave={clearBarPreview}
        onClick={() => holdBarPreview(exec({ op: 'split_province', id }, '正在划分…'))}
      >
        <SplitSquareHorizontal /> 对半分开
      </button>
      <SelectionActions more="province" moreTitle="颜色恢复自动、地名风格、定位" deselect={() => (selectedProvince.value = null)} />
    </>
  );
}

// ---------- 多选（第二十七轮：⇧+点；做出命令在 province-panel.ts） ----------

function ProvinceMulti({ w, ids }: { w: World; ids: number[] }) {
  const { cells, merge, why, land } = provinceMultiCommands(w, ids);
  const rows = hasCountries(w) ? countryRows(w) : [];
  const done = () => {
    provinceSet.value = [];
  };
  return (
    <>
      <span class="bar-note">已选 {ids.length} 个省份</span>
      <button
        class="bar-btn"
        disabled={!merge}
        title={why ?? `并进“${w.small.provinces[ids[0]]?.name ?? ''}”`}
        onClick={() => {
          if (!merge) return;
          void exec(merge, '正在计算…').then((ok) => {
            if (!ok) return;
            done();
            selectedProvince.value = ids[0];
          });
        }}
      >
        <Merge /> 合并
      </button>
      {rows.length > 0 && land.length > 0 && (
        <select
          class="bar-select"
          value=""
          title="这几个省的陆地都划给这一国"
          onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            (e.target as HTMLSelectElement).value = '';
            if (v !== '') void exec(territoryCommand(land, Number(v) || null), '正在计算…');
          }}
        >
          <option value="">划给…</option>
          <option value="0">无主地</option>
          {rows.map((r) => (
            <option value={r.meta.id}>{r.meta.name}</option>
          ))}
        </select>
      )}
      <button
        class="bar-btn"
        onPointerEnter={() => showProvinceCommand({ op: 'regenerate_provinces', cells })}
        onPointerLeave={clearBarPreview}
        onClick={() =>
          holdBarPreview(
            execRegen({ op: 'regenerate_provinces', cells }, '正在划分…', REPARTITION_ASK).then((ok) => {
              if (ok) done();
              return ok;
            }),
          )
        }
        title="这几个省重新划分"
      >
        <RefreshCw /> 重新划分
      </button>
      <button class="bar-btn icon" onClick={done} title="取消多选（Esc）">
        <X />
      </button>
    </>
  );
}

// 省份笔刷涂给谁（第二十七轮）：条上直接选一个省份，或“新省份”（涂出一个新的）；Alt+点击吸取
export function ProvincePick() {
  const w = world.value;
  if (!w) return null;
  const id = selectedProvince.value;
  const list = Object.entries(w.small.provinces)
    .filter(([, m]) => m.kind !== 'sea')
    .map(([k, m]) => ({ id: Number(k), name: m.name || `省份 ${k}` }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  const meta = id !== null && !brushNew.value ? w.small.provinces[id] : undefined;
  const value = brushNew.value ? 'new' : meta ? String(id) : '';
  return (
    <span class="bar-choice">
      <span class="bar-label">涂给</span>
      {meta && <span class="swatch" style={{ background: `rgb(${provinceDisplayColor(w, id!).join(',')})` }} />}
      <select
        class="bar-select"
        value={value}
        title="Alt+点击地图吸取"
        onChange={(e) => {
          const v = (e.target as HTMLSelectElement).value;
          if (v === 'new') brushNew.value = true;
          else if (v) {
            brushNew.value = false;
            selectedProvince.value = Number(v);
          }
        }}
      >
        {!value && <option value="">选省份</option>}
        <option value="new">新省份</option>
        {meta?.kind === 'sea' && <option value={String(id)}>{meta.name || `省份 ${id}`}</option>}
        {list.map((p) => (
          <option value={String(p.id)}>{p.name}</option>
        ))}
      </select>
    </span>
  );
}

// 选中的省底部条上的“⋯”：颜色恢复自动、地名风格、改回陆地、在地图上看（第二十七轮：无人区、选颜色在条上）
export function ProvinceMore() {
  const w = world.value;
  const id = selectedProvince.value;
  if (!w || id === null || !w.small.provinces[id]) return null;
  const { meta, cells, lakeGone, hex, auto } = provinceOf(w, id);
  return (
    <>
      {/* 颜色：自动（陆地省按编号配色，海省不着色）/ 自己选（导出的 provinces.bmp 照旧按编号，一一对应） */}
      <div class="row">
        <Toggle
          on={!auto}
          onChange={(on) => {
            if (!on) void exec({ op: 'set_province', id, color: null }, '正在修改…');
            else void exec({ op: 'set_province', id, color: meta.land ? hex : seaProvinceDefaultColor(id) }, '正在修改…');
          }}
          title={auto ? (meta.land ? '自动配色，打开可自选' : '海省默认不着色，打开可自选') : '关闭后恢复自动'}
        >
          自选颜色
        </Toggle>
        {!auto && (
          <input
            type="color"
            value={hex}
            title="选颜色"
            onChange={(e) => {
              const v = (e.target as HTMLInputElement).value.toLowerCase();
              if (v !== meta.color) void exec({ op: 'set_province', id, color: v }, '正在修改…');
            }}
          />
        )}
      </div>
      <ProvinceStyle w={w} id={id} />
      <SelectionActions menu locate={() => focusOn(cells)}>
        {lakeGone && <MenuItem icon={<Waves />} label="改回陆地" run={() => void exec({ op: 'set_province', id, kind: 'land' }, '正在修改…')} />}
      </SelectionActions>
    </>
  );
}

// 这个省用哪种地名风格（第二十轮）：换了就按新风格重新起名；“自动”是世界默认
function ProvinceStyle({ w, id }: { w: World; id: number }) {
  const own = w.small.provinces[id]?.style;
  const pick = (style: string | null) => {
    if (style !== (own ?? null)) void exec({ op: 'set_province', id, style }, '正在起名…');
  };
  return (
    <section>
      <h5>地名风格</h5>
      <TypePicker
        items={[
          { label: `自动（${defaultStyleName(w.small)}）`, on: !own, hint: '按世界默认', onPick: () => pick(null) },
          ...styleChoices(w.small).map((c) => ({ id: c.id, label: c.name, on: own === c.id, onPick: () => pick(c.id) })),
        ]}
        library="nameStyle"
      />
    </section>
  );
}

// 选中的省没了（撤销、换了类别）：它的“⋯”也关上
effect(() => {
  if (selectedProvince.value === null && openPanel.value === 'province') openPanel.value = null;
});

// 自动划分（第七十八轮起只有“划分省份 / 换一种划分”）：规则是世界里的“省份划分”，在资源库里改，旁边的按钮打开它的页面
function DivideBox({ w }: { w: World }) {
  useEffect(() => clearBarPreview, []);
  const counts = new Map<ProvinceKind, number>();
  for (const m of Object.values(w.small.provinces)) counts.set(m.kind, (counts.get(m.kind) ?? 0) + 1);
  const seed = w.small.provinceSeed;
  return (
    <section>
      <h5>自动划分</h5>
      <p class="hint">
        现在：
        {PROVINCE_KINDS.filter((k) => counts.get(k))
          .map((k) => `${PROVINCE_KIND_INFO[k].name} ${counts.get(k)} 个`)
          .join('，') || '没有省份'}
      </p>
      <div class="row between">
        <span class="hint">{PROVINCE_RULES_NOTE}</span>
        <span class="row">
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
          <button
            class="link-btn small"
            title={PROVINCE_RULES_TIP}
            onClick={() => {
              openPanel.value = null;
              openProvinceRules(w.small);
            }}
          >
            省份划分
          </button>
        </span>
      </div>
      {/* 鼠标停在按钮上：地图上先画出新的省界和省名（与点下去的结果相同）；点下去照样一下就做，可以撤销 */}
      <div class="row wrap">
        <RegenButton cmd={{ op: 'generate_provinces', seed }} primary>
          划分省份
        </RegenButton>
        <RegenButton cmd={{ op: 'generate_provinces', seed: seed + 1 }}>换一种划分</RegenButton>
      </div>
      <p class="hint">规则相同，划分相同；锁定的省份不变</p>
      <p class="hint">灰色斜线：无人区；蓝色字：湖省</p>
    </section>
  );
}

// 第九十八轮：会换掉手改过的省份时先问（domain/regen-ask.ts）
const REPARTITION_ASK = { title: '重新划分省份', action: '重新划分' };

function RegenButton({ cmd, primary, children }: { cmd: Command; primary?: boolean; children: ComponentChildren }) {
  return (
    <button
      class={primary ? 'primary' : undefined}
      onPointerEnter={() => showProvinceCommand(cmd)}
      onPointerLeave={clearBarPreview}
      onClick={() => holdBarPreview(execRegen(cmd, '正在划分省份…', REPARTITION_ASK))}
    >
      {children}
    </button>
  );
}

// 省名：世界默认的地名风格换了以后，已有的省名不变，在这里按新的默认重起
function NamesBox({ w }: { w: World }) {
  const cmd = restyleOffer(w);
  if (!cmd) return null;
  return (
    <section>
      <h5>省名</h5>
      <div class="row between">
        <span class="hint">按“{defaultStyleName(w.small)}”，锁定的不动</span>
        <button class="small" onClick={() => void exec(cmd, '正在起名…')}>
          重起省名
        </button>
      </div>
    </section>
  );
}

export function ProvinceExtras() {
  const w = world.value;
  return w ? (
    <>
      <DivideBox w={w} />
      <NamesBox w={w} />
    </>
  ) : null;
}

// 工具表里按名字引用的部件（defs/panel-registry.ts）
registerPanels({ ProvinceColorToggle, ProvinceBar, ProvincePick, ProvinceExtras });
