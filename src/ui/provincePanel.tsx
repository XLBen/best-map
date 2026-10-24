import { effect } from '@preact/signals';
import { SplitSquareHorizontal, Waves } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Command } from '../../core/commands';
import { PROVINCE_KINDS, PROVINCE_KIND_INFO, type ProvinceKind, type ProvinceRules } from '../../core/provinces';
import { provinceCells } from '../../core/select';
import type { World } from '../../core/world';
import { provinceDisplayColor, seaProvinceDefaultColor } from '../../core/world';
import { type ViewMode, exec, mapKm, mode, openPanel, selectedProvince, world } from '../state';
import { focusOn } from './camera';
import { Seg } from './common';
import { MenuItem, SelectionActions } from './components/SelectionActions';
import { Toggle } from './components/Toggle';
import { TypePicker } from './components/TypePicker';
import { openRepo } from './packs/store';
import { defaultStyleName, restyleOffer, styleChoices } from './packs/styles';
import { clearBarPreview, holdBarPreview, showProvinceCommand, showSplit } from './provincePreview';

// 省份：底部条上的“选中省份”编辑（不常用的在它的“⋯”里）、省份着色开关；“省份 ⋯”里的自动划分规则

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

export function ProvinceBar() {
  const w = world.value;
  const id = selectedProvince.value;
  const meta = w && id !== null ? w.small.provinces[id] : null;
  const [name, setName] = useState(meta?.name ?? '');
  // Esc：放弃这次输入（不在失去焦点时提交）
  const cancelled = useRef(false);
  useEffect(() => setName(meta?.name ?? ''), [id, meta?.name]);
  // 按钮不见了（取消选择、换了工具）时鼠标移开的事件不会来：一并去掉按钮的预览
  useEffect(() => clearBarPreview, []);
  if (!w || id === null || !meta) return null;
  const { cells, lakeGone, hex, auto } = provinceOf(w, id);
  const area = Math.round((cells.length * mapKm(w).cell ** 2) / 100) * 100;
  const rename = () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    if (name.trim() && name.trim() !== meta.name) void exec({ op: 'set_province', id, name: name.trim() }, '正在改名…');
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
    if (e.key === 'Escape') {
      e.stopPropagation();
      cancelled.current = true;
      setName(meta.name);
      (e.target as HTMLInputElement).blur();
    }
  };
  // 海省默认不着色（地图上看得到海本来的样子）；自己选了颜色才涂
  return (
    <>
      <span class="swatch" style={{ background: !meta.land && auto ? 'transparent' : hex }} title={!meta.land && auto ? '海省默认不着色' : undefined} />
      <input class="bar-input" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} onKeyDown={onKey} onBlur={rename} />
      <span class="bar-label" title={`${cells.length} 格`}>
        约 {area.toLocaleString()} km²
      </span>
      {meta.kind === 'wasteland' && <span class="bar-chip">无人区</span>}
      {meta.kind === 'lake' && (
        <span class="bar-chip" title={PROVINCE_KIND_INFO.lake.hint}>
          {lakeGone ? '湖省 · 已没有湖' : '湖省'}
        </span>
      )}
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
      <SelectionActions more="province" moreTitle="无人区、颜色、风格、定位" deselect={() => (selectedProvince.value = null)} />
    </>
  );
}

// 选中的省底部条上的“⋯”：无人区、颜色、地名风格、改回陆地、在地图上看
export function ProvinceMore() {
  const w = world.value;
  const id = selectedProvince.value;
  if (!w || id === null || !w.small.provinces[id]) return null;
  const { meta, cells, lakeGone, hex, auto } = provinceOf(w, id);
  return (
    <>
      {/* 类型：陆地省份只有“无人区”一个开关；湖省只由自动划分产生，底部条上只标出来 */}
      {meta.land && meta.kind !== 'lake' && (
        <Toggle
          on={meta.kind === 'wasteland'}
          onChange={(on) => void exec({ op: 'set_province', id, kind: on ? 'wasteland' : 'land' }, '正在修改…')}
          title={PROVINCE_KIND_INFO.wasteland.hint}
        >
          无人区
        </Toggle>
      )}
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
          ...styleChoices(w.small).map((c) => ({ label: c.name, on: own === c.id, onPick: () => pick(c.id) })),
        ]}
        onNew={() => {
          openPanel.value = null;
          openRepo({ kind: 'nameStyle' });
        }}
        newLabel="仓库…"
        newTitle="启用更多地名风格"
      />
    </section>
  );
}

// 选中的省没了（撤销、换了类别）：它的“⋯”也关上
effect(() => {
  if (selectedProvince.value === null && openPanel.value === 'province') openPanel.value = null;
});

function RulesBox({ w }: { w: World }) {
  const rules = w.small.provinceRules;
  const [draft, setDraft] = useState<ProvinceRules>(rules);
  useEffect(() => setDraft(rules), [JSON.stringify(rules)]);
  useEffect(() => clearBarPreview, []);
  const changed = JSON.stringify(draft) !== JSON.stringify(rules);
  const counts = new Map<ProvinceKind, number>();
  for (const m of Object.values(w.small.provinces)) counts.set(m.kind, (counts.get(m.kind) ?? 0) + 1);
  const check = (key: 'varied' | 'wasteland' | 'seaByDistance', label: string) => (
    <Toggle on={draft[key]} onChange={(on) => setDraft({ ...draft, [key]: on })}>
      {label}
    </Toggle>
  );
  return (
    <section>
      <h5>自动划分</h5>
      <p class="hint">
        现在：
        {PROVINCE_KINDS.filter((k) => counts.get(k))
          .map((k) => `${PROVINCE_KIND_INFO[k].name} ${counts.get(k)} 个`)
          .join('，') || '没有省份'}
      </p>
      <div class="row">
        <span>省份大小</span>
        <Seg value={draft.size} options={[['small', '小'], ['medium', '中'], ['large', '大']]} onChange={(v) => setDraft({ ...draft, size: v })} />
      </div>
      {check('varied', '按地形调整大小')}
      {check('wasteland', '冰原、深漠、高山划成无人区')}
      <div class="row">
        <span>湖</span>
        <Seg
          value={draft.lakeMode}
          options={[
            ['separate', '单独成省'],
            ['merge', '并进旁边的陆地省'],
          ]}
          titles={{ separate: PROVINCE_KIND_INFO.lake.hint, merge: '湖面和旁边的陆地同省' }}
          onChange={(v) => setDraft({ ...draft, lakeMode: v })}
        />
      </div>
      {check('seaByDistance', '近海的海省小，远洋的大')}
      <p class="hint">海省不和陆地、湖同省；湖变了，省份跟着整理</p>
      {/* 鼠标停在按钮上：地图上先画出新的省界和省名（与点下去的结果相同）；点下去照样一下就做，可以撤销 */}
      <div class="row wrap">
        {/* 只改了湖的归属：可以只整理湖，不动别的省份 */}
        {draft.lakeMode !== rules.lakeMode && (
          <RegenButton cmd={{ op: 'set_lake_mode', mode: draft.lakeMode }}>只整理湖</RegenButton>
        )}
        <RegenButton cmd={{ op: 'generate_provinces', rules: draft }} primary>
          {changed ? '按新规则重新划分' : '重新划分'}
        </RegenButton>
        <RegenButton cmd={{ op: 'generate_provinces', rules: { ...draft, seed: rules.seed + 1 } }}>换一种划分</RegenButton>
      </div>
      <p class="hint">规则相同，划分相同；锁定的省份不变</p>
      <p class="hint">灰色斜线：无人区；蓝色字：湖省</p>
    </section>
  );
}

function RegenButton({ cmd, primary, children }: { cmd: Command; primary?: boolean; children: ComponentChildren }) {
  return (
    <button
      class={primary ? 'primary' : undefined}
      onPointerEnter={() => showProvinceCommand(cmd)}
      onPointerLeave={clearBarPreview}
      onClick={() => holdBarPreview(exec(cmd, '正在划分省份…'))}
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
      <RulesBox w={w} />
      <NamesBox w={w} />
    </>
  ) : null;
}
