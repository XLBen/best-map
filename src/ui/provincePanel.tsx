import { Ban, Lock, LockOpen, Palette, ScanSearch, SplitSquareHorizontal, X } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Command } from '../../core/commands';
import { PROVINCE_KINDS, PROVINCE_KIND_INFO, type ProvinceKind, type ProvinceRules } from '../../core/provinces';
import { provinceCells } from '../../core/select';
import type { World } from '../../core/world';
import { provinceDisplayColor } from '../../core/world';
import { type ViewMode, exec, mapKm, mode, selectedProvince, world } from '../state';
import { focusOn } from './camera';
import { Seg } from './common';
import { clearBarPreview, holdBarPreview, showProvinceCommand, showSplit } from './provincePreview';

// 省份：底部条上的“选中省份”编辑、省份着色开关；“⋯”里的自动划分规则

// 省份着色：底图只在用户点了才换成省份；再点一下回到原来的底图
let viewBefore: ViewMode = 'terrain';
export function ProvinceColorToggle() {
  const on = mode.value === 'provinces';
  return (
    <button
      class={`bar-btn ${on ? 'on' : ''}`}
      onClick={() => {
        if (on) mode.value = viewBefore === 'provinces' ? 'terrain' : viewBefore;
        else {
          viewBefore = mode.value;
          mode.value = 'provinces';
        }
      }}
      title="底图按省份着色（“图层”里也能换）"
    >
      <Palette size={15} /> 省份着色
    </button>
  );
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
  const cells = provinceCells(w, id);
  const area = Math.round((cells.length * mapKm(w).cell ** 2) / 100) * 100;
  // 湖省：一半以上的格已经不是湖了（湖被删掉、干了），可以改回陆地
  const lakeGone = meta.kind === 'lake' && cells.filter((i) => w.derived.lake[i] === 1).length * 2 < cells.length;
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
  const [r, g, b] = provinceDisplayColor(w, id);
  const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  // 海省默认不着色（地图上看得到海本来的样子）；自己选了颜色才涂
  const auto = !meta.color;
  return (
    <>
      <span class="swatch" style={{ background: !meta.land && auto ? 'transparent' : hex }} title={!meta.land && auto ? '海上的省份默认不着色' : undefined} />
      <input class="bar-input" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} onKeyDown={onKey} onBlur={rename} />
      <span class="bar-label" title={`${cells.length} 格`}>
        约 {area.toLocaleString()} km²
      </span>
      {/* 类型：陆地省份只有“无人区”一个开关；湖省只由自动划分产生，这里只标出来 */}
      {meta.land && meta.kind !== 'lake' && (
        <button
          class={`bar-btn ${meta.kind === 'wasteland' ? 'on' : ''}`}
          onClick={() => void exec({ op: 'set_province', id, kind: meta.kind === 'wasteland' ? 'land' : 'wasteland' }, '正在修改…')}
          title="没人住的地方（冰原、深漠、高山）。导出到游戏时算作不可进入的荒地；地图上画灰色斜线。不改地形和生态"
        >
          <Ban size={15} /> 无人区
        </button>
      )}
      {meta.kind === 'lake' && (
        <span class="bar-chip" title="这个省是一片湖（省份规则里“湖：单独成省”），导出时算作湖">
          {lakeGone ? '湖省 · 这里已没有湖' : '湖省'}
        </span>
      )}
      {lakeGone && (
        <button class="bar-btn" onClick={() => void exec({ op: 'set_province', id, kind: 'land' }, '正在修改…')}>
          改回陆地
        </button>
      )}
      {/* 颜色：自动（陆地省按编号配色，海省不着色）/ 自己选（导出的 provinces.bmp 照旧按编号，一一对应） */}
      <span class="bar-label">颜色</span>
      <Seg
        value={auto ? 'auto' : 'own'}
        options={[
          ['auto', '自动'],
          ['own', '自己选'],
        ]}
        titles={{ auto: meta.land ? '按省份编号自动配色' : '海上的省份不着色', own: '给这个省份选一个颜色（只影响地图上的省份着色）' }}
        onChange={(v) => {
          if (v === 'auto' && !auto) void exec({ op: 'set_province', id, color: null }, '正在修改…');
          if (v === 'own' && auto) void exec({ op: 'set_province', id, color: meta.land ? hex : '#4a7fb5' }, '正在修改…');
        }}
      />
      {!auto && (
        <input
          type="color"
          class="bar-color"
          value={hex}
          title="选颜色"
          onChange={(e) => {
            const v = (e.target as HTMLInputElement).value.toLowerCase();
            if (v !== meta.color) void exec({ op: 'set_province', id, color: v }, '正在修改…');
          }}
        />
      )}
      <button
        class={`bar-btn ${meta.locked ? 'on' : ''}`}
        onClick={() => void exec({ op: 'set_province', id, locked: !meta.locked }, '正在修改…')}
        title="锁定后，重新划分时不动它，也不能从它这里拿格子"
      >
        {meta.locked ? <Lock size={15} /> : <LockOpen size={15} />} {meta.locked ? '已锁定' : '锁定'}
      </button>
      {/* 鼠标停在按钮上：地图上先画出新的省界，分出来的那一半淡淡地涂上它将来的颜色 */}
      <button
        class="bar-btn"
        disabled={meta.locked || cells.length < 2}
        onPointerEnter={() => showSplit(w, id)}
        onPointerLeave={clearBarPreview}
        onClick={() => holdBarPreview(exec({ op: 'split_province', id }, '正在划分…'))}
      >
        <SplitSquareHorizontal size={15} /> 对半分开
      </button>
      <button class="bar-btn icon" onClick={() => focusOn(cells)} title="在地图上看">
        <ScanSearch size={15} />
      </button>
      <button class="bar-btn icon" onClick={() => (selectedProvince.value = null)} title="取消选择">
        <X size={15} />
      </button>
    </>
  );
}

function RulesBox({ w }: { w: World }) {
  const rules = w.small.provinceRules;
  const [draft, setDraft] = useState<ProvinceRules>(rules);
  useEffect(() => setDraft(rules), [JSON.stringify(rules)]);
  useEffect(() => clearBarPreview, []);
  const changed = JSON.stringify(draft) !== JSON.stringify(rules);
  const counts = new Map<ProvinceKind, number>();
  for (const m of Object.values(w.small.provinces)) counts.set(m.kind, (counts.get(m.kind) ?? 0) + 1);
  const check = (key: 'varied' | 'wasteland' | 'seaByDistance', label: string) => (
    <label class="check">
      <input type="checkbox" checked={draft[key]} onChange={() => setDraft({ ...draft, [key]: !draft[key] })} />
      {label}
    </label>
  );
  return (
    <section>
      <h5>自动划分</h5>
      <p class="muted small">
        现在：
        {PROVINCE_KINDS.filter((k) => counts.get(k))
          .map((k) => `${PROVINCE_KIND_INFO[k].name} ${counts.get(k)} 个`)
          .join('，') || '还没有省份'}
      </p>
      <div class="row">
        <span>省份大小</span>
        <Seg value={draft.size} options={[['small', '小'], ['medium', '中'], ['large', '大']]} onChange={(v) => setDraft({ ...draft, size: v })} />
      </div>
      {check('varied', '按地形调整大小（平原、河谷、海岸小，山地、荒漠大）')}
      {check('wasteland', '冰原、深漠、高山划成无人区')}
      <div class="row">
        <span>湖</span>
        <Seg
          value={draft.lakeMode}
          options={[
            ['separate', '单独成省'],
            ['merge', '并进旁边的陆地省'],
          ]}
          titles={{ separate: '湖面单独划成湖省（导出时算作湖）', merge: '湖面算陆地，和旁边的陆地同省' }}
          onChange={(v) => setDraft({ ...draft, lakeMode: v })}
        />
      </div>
      {check('seaByDistance', '近海的海域小，远洋的大')}
      <p class="muted small">海上的省份永远单独，不和陆地、湖同省。放湖、删湖、湖干了以后，湖和陆地的省份会自己跟着整理。</p>
      {/* 鼠标停在按钮上：地图上先画出新的省界和省名（与点下去的结果相同）；点下去照样一下就做，可以撤销 */}
      <div class="row wrap">
        {/* 只改了湖的归属：可以只整理湖，不动别的省份 */}
        {draft.lakeMode !== rules.lakeMode && (
          <RegenButton cmd={{ op: 'set_lake_mode', mode: draft.lakeMode }}>只整理湖，别的省份不动</RegenButton>
        )}
        <RegenButton cmd={{ op: 'generate_provinces', rules: draft }} primary>
          {changed ? '按新规则重新划分' : '重新划分'}
        </RegenButton>
        <RegenButton cmd={{ op: 'generate_provinces', rules: { ...draft, seed: rules.seed + 1 } }}>换一种划分</RegenButton>
      </div>
      <p class="muted small">同样的规则划出来的结果是固定的；想要别的分法点“换一种划分”。锁定的省份不会变，撤销可以回到原来的划分。</p>
      <p class="muted small">图例：灰色斜线 = 无人区；蓝色字 = 湖省；海上的省份默认不着色（选中一个海省可以给它选颜色）</p>
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

export function ProvinceExtras() {
  const w = world.value;
  return w ? <RulesBox w={w} /> : null;
}
