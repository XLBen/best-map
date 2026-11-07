import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import { kindOf } from '../../../core/content/registry';
import { CONDITIONS, type ConditionId, HEIGHT_MARGIN, HEIGHT_MAX, M_RANGE, type Species, T_RANGE, elevationTolerances, speciesConditions, speciesRect } from '../../../core/species';
import { askUser, download, exec, options, tool, world } from '../../state';
import { packFileName } from '../../../core/packs';
import { Seg } from '../common';
import { RangeSliders } from '../components/RangeSliders';
import { Slider, linear } from '../components/Slider';
import { Toggle } from '../components/Toggle';
import { paintWith, setTool } from '../defs/tools';
import { FieldsBox } from '../packs/ContentEditor';
import type { Obj } from '../packs/fields';
import { BiomeWaterSegment } from '../packs/PageEcology';
import type { PageCtx, SourceRef } from '../packs/pages';
import { closeLibrary } from '../packs/panel-store';
import { rangePick } from '../tools/public';
import { BiomeAdvanced } from './BiomeAdvanced';
import { BiomeChart } from './BiomeChart';
import { EDITOR_VIEWS, editorOpened, shownEditorView, showEditorView } from './base-map';
import { alpinePatch, biomesPack, conditionPatch, copySpeciesCommand, elevationPatch, elevationText, heightOf, heightPatch, isAlpine, newSpeciesCommand, rangeText, rectPatch } from './biome-edit';
import { type BiomeTarget, biomeTarget } from './biome-target';
import { biomeShares, fmtM, fmtShare, fmtT } from './chart';

// 生态编辑器（第七十二轮）：生态抽屉（ClimateChart.tsx + SpeciesAdvanced.tsx）和资源库里生态的通用表单合成这一个，
// 就是资源库里一种生态的页面（本世界、我的库、内置的库都是它；内置的只读）。字段的叫法照生态抽屉的。
// 上面是气候图（这一份里的全部生态），下面是这一种：名字颜色、强势程度、长在哪里、水系、人文、高级。
// 改了就存：本世界是 update_species（和抽屉同一条命令、同一个撤销），我的库换掉这一项（这个库的撤销），见 biome-target.ts

const RAIN: [string, ConditionId | null][] = [
  ['不限', null],
  ['夏季多雨', 'summerRain'],
  ['冬季多雨', 'winterRain'],
];
// 海拔只在高度范围里设（“只长在高山上”是它旁边的按钮）
const PLACES: ConditionId[] = ['coast', 'river', 'flat', 'wetland'];

const COMPETITION = linear(0.5, 10, 0.1);

export interface BiomeEditorProps {
  sp: Species;
  src: SourceRef;
  ctx: PageCtx;
  // 气候图上点了别的生态
  onSelect: (id: string) => void;
}

export function BiomeEditor({ sp, src, ctx, onSelect }: BiomeEditorProps) {
  const t = biomeTarget(src, ctx);
  const w = world.value;
  const inWorld = !!w?.small.species.some((s) => s.id === sp.id);
  // 编辑器开着：“在地图上看”换上的底图留着；关上时换回去
  useLayoutEffect(() => editorOpened(inWorld ? sp.id : null), [sp.id]);
  const shares = t.inWorld && w ? biomeShares(w) : null;
  const share = shares?.get(w!.small.species.findIndex((s) => s.id === sp.id)) ?? 0;
  const rect = speciesRect(sp);
  return (
    <div class="biome-editor">
      <p class="hint">色块是最适合的冷暖干湿：拖动移动，拖边改大小，拖到图边为“不限”。灰点是陆地，黄圈是指针所在。</p>
      <BiomeChart w={w} all={t.all} selected={sp} onSelect={onSelect} live={t.inWorld} readonly={!!t.readonly} onCommit={(id, r) => void t.edit(id, rectPatch(t.all.find((x) => x.id === id) ?? sp, r), '正在计算…')} />
      <p class="hint">
        最适合：年均 {fmtT(rect.t0, T_RANGE[0])} ～ {fmtT(rect.t1, T_RANGE[1])}，湿润程度 {fmtM(rect.m0, M_RANGE[0])} ～ {fmtM(rect.m1, M_RANGE[1])}
        {shares ? `。现在占陆地 ${fmtShare(share)}。` : '。'}
      </p>
      {w && <OnMap sp={sp} inWorld={inWorld} />}
      <fieldset class="lp-fields" disabled={!!t.readonly}>
        <Basics sp={sp} t={t} />
        <Where sp={sp} t={t} />
        <h5>水系</h5>
        <BiomeWaterSegment src={src} ctx={ctx} sp={sp} />
        <h5>人文</h5>
        <FieldsBox fields={kindOf('biome')!.fields.filter((f) => f.key === 'habitability' || f.key === 'movement')} value={sp as unknown as Obj} onChange={(next) => void t.replace(sp.id, next)} issues={[]} />
        <BiomeAdvanced sp={sp} t={t} ctx={ctx} />
      </fieldset>
      <Buttons sp={sp} t={t} onSelect={onSelect} />
    </div>
  );
}

// 在地图上看：临时换底图（第七十二轮从“图层”挪来的几张）
function OnMap({ sp, inWorld }: { sp: Species; inWorld: boolean }) {
  const cur = shownEditorView();
  const list = EDITOR_VIEWS.filter((v) => !v.worldOnly || inWorld);
  const hint = list.find((v) => v.id === cur)?.hint;
  return (
    <>
      <label class="row">
        <span class="grow">在地图上看</span>
        <select value={cur ?? ''} onChange={(e) => showEditorView(((e.target as HTMLSelectElement).value || null) as never, inWorld ? sp.id : null)}>
          <option value="">不换底图</option>
          {list.map((v) => (
            <option value={v.id}>{v.label}</option>
          ))}
        </select>
      </label>
      {hint && <p class="hint">{hint}，关上编辑器换回原来的底图</p>}
    </>
  );
}

function Basics({ sp, t }: { sp: Species; t: BiomeTarget }) {
  const [name, setName] = useState(sp.name);
  // 拖着“强势程度”时先显示拖到的数，松手才提交
  const [competition, setCompetition] = useState<number | null>(null);
  useEffect(() => setCompetition(null), [sp.id, sp.competition]);
  useEffect(() => setName(sp.name), [sp.id, sp.name]);
  const rename = () => name.trim() && name.trim() !== sp.name && void t.edit(sp.id, { name: name.trim() });
  return (
    <>
      <div class="row">
        <input type="color" value={sp.color} onChange={(e) => void t.edit(sp.id, { color: (e.target as HTMLInputElement).value })} />
        <input class="grow" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} onBlur={rename} onKeyDown={(e) => e.key === 'Enter' && rename()} />
      </div>
      <Slider
        stacked
        label="强势程度"
        pos={COMPETITION.pos(competition ?? sp.competition)}
        text={(competition ?? sp.competition).toFixed(1)}
        changed={competition !== null && competition !== sp.competition}
        note="都能长时，强势的占上风"
        onDraft={(p) => setCompetition(COMPETITION.at(p))}
        onCommit={(p) => {
          const v = COMPETITION.at(p);
          if (v === sp.competition) return setCompetition(null);
          setCompetition(v);
          void t.edit(sp.id, { competition: v }, '正在计算…');
        }}
        onCancel={() => setCompetition(null)}
      />
    </>
  );
}

function Where({ sp, t }: { sp: Species; t: BiomeTarget }) {
  const conds = speciesConditions(sp);
  const setCond = (id: ConditionId, on: boolean) => void t.edit(sp.id, conditionPatch(sp, id, on), '正在计算…');
  const rain = conds.has('summerRain') ? 'summerRain' : conds.has('winterRain') ? 'winterRain' : null;
  const elevation = elevationTolerances(sp);
  const fix = elevationPatch(sp);
  return (
    <>
      <div class="row between">
        <h5 title={`超出后 ${HEIGHT_MARGIN} m 内慢慢长不了`}>高度范围（海拔）</h5>
        <button class={`small ${isAlpine(sp) ? 'on' : ''}`} title="下限设到高山" onClick={() => void t.edit(sp.id, alpinePatch(sp), '正在计算…')}>
          只长在高山上
        </button>
      </div>
      <RangeSliders lo={0} hi={HEIGHT_MAX} step={100} unit="m" value={heightOf(sp)} onCommit={(h) => void t.edit(sp.id, heightPatch(h), '正在计算…')} />
      {elevation.map((x) => (
        <p class="hint warn">
          另有海拔条件 {elevationText(x)}
          {fix && (
            <button class="small" title="过渡的宽窄会变，地图可能跟着变" onClick={() => void t.edit(sp.id, fix, '正在计算…')}>
              换成高度范围
            </button>
          )}
        </p>
      ))}
      <h5>只长在……</h5>
      {PLACES.map((id) => (
        <label class="check">
          <input type="checkbox" checked={conds.has(id)} onChange={() => setCond(id, !conds.has(id))} />
          {CONDITIONS[id].label}
        </label>
      ))}
      <h5>雨季</h5>
      <Seg<string>
        value={rain ?? ''}
        options={RAIN.map(([label, id]) => [id ?? '', label])}
        onChange={(id) => {
          if (id) setCond(id as ConditionId, true);
          else if (rain) setCond(rain, false);
        }}
        wide
      />
      <Range sp={sp} t={t} />
    </>
  );
}

// 长在哪里：自然生成；本世界里还有只在一个岛上、只在圈的范围里（格的编号只对这个世界有效）
function Range({ sp, t }: { sp: Species; t: BiomeTarget }) {
  const w = world.value;
  const natural = sp.natural !== false;
  const kind = sp.range?.kind ?? 'everywhere';
  const pick = (k: 'island' | 'cells') => {
    rangePick.value = { species: sp.id, kind: k, back: tool.value === 'range' ? 'biome' : tool.value };
    setTool('range');
    closeLibrary();
  };
  return (
    <>
      <h5>长在哪里</h5>
      <Toggle on={natural} onChange={(on) => void t.edit(sp.id, { natural: on }, '正在计算…')}>
        自然生成
      </Toggle>
      <p class="hint">{natural ? '合适且竞争得过的地方都会长' : '只长在涂了它的地方'}</p>
      {t.inWorld && w && (
        <>
          {/* 已经选着的“只在一个岛上”再点一下是重新选 */}
          <Seg<'everywhere' | 'island' | 'cells'>
            value={kind}
            options={[
              ['everywhere', '到处'],
              ['island', '只在一个岛上'],
              ['cells', '只在圈的范围里'],
            ]}
            titles={{ island: '点一个岛或一块大陆', cells: '按住圈一片' }}
            onChange={(k) => {
              if (k !== 'everywhere') pick(k);
              else if (sp.range) void t.edit(sp.id, { range: null }, '正在计算…');
            }}
            wide
          />
          {sp.range && (
            <p class="hint">
              只长在{rangeText(w, sp)}。
              <button class="small" onClick={() => pick(sp.range!.kind)}>
                {sp.range.kind === 'island' ? '换岛' : '重新圈'}
              </button>
            </p>
          )}
          {sp.dispersal && (
            <p class="hint">
              只长在起源地能扩散到的地方 · {sp.dispersal.seaCost >= 1e5 ? '不能跨海' : '可以跨海'}
              <button class="small" onClick={() => void t.edit(sp.id, { dispersal: null }, '正在计算…')}>
                取消限制
              </button>
            </p>
          )}
        </>
      )}
    </>
  );
}

// 本世界：用它涂、复制、删除、新建（和以前的生态抽屉一样）；都有：导出这一份的全部生态（资源包）
function Buttons({ sp, t, onSelect }: { sp: Species; t: BiomeTarget; onSelect: (id: string) => void }) {
  const w = world.value;
  const painting = options.value.biome === sp.id && tool.value === 'biome';
  const exportAll = () => {
    const pack = biomesPack(t.inWorld ? '本世界的生态' : '生态', t.all, t.inWorld);
    download(packFileName(pack), JSON.stringify(pack, null, 2), 'application/json');
  };
  return (
    <div class="row wrap lp-item-actions">
      {t.inWorld && w && (
        <>
          <button class="small" onClick={() => paintWith(sp.id)} disabled={painting}>
            {painting ? '正在涂' : '用它涂'}
          </button>
          <button
            class="small"
            onClick={async () => {
              const { id, cmd } = copySpeciesCommand(w, sp);
              if (await exec(cmd)) onSelect(id);
            }}
          >
            复制
          </button>
          <button
            class="small"
            onClick={async () => {
              const { id, cmd } = newSpeciesCommand(w);
              if (await exec(cmd)) onSelect(id);
            }}
          >
            新建生态
          </button>
        </>
      )}
      <button class="small" title="这一份的全部生态，存成资源包" onClick={exportAll}>
        导出
      </button>
      {t.inWorld && (
        <button
          class="small danger"
          onClick={async () => {
            const v = await askUser({
              title: `删除生态“${sp.name}”？`,
              text: '长它的地方会换成别的生态',
              choices: [
                { value: 'delete', label: '删除', primary: true },
                { value: 'cancel', label: '取消' },
              ],
            });
            if (v === 'delete') void exec({ op: 'remove_species', id: sp.id }, '正在计算…');
          }}
        >
          删除
        </button>
      )}
    </div>
  );
}
