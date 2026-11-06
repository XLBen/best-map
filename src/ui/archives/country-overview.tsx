import { Paintbrush, ScanSearch, SplitSquareHorizontal, Trash2 } from 'lucide-preact';
import { FLAG_EMBLEMS, FLAG_LAYOUTS, type FlagSpec, blocsOf, cellName } from '../../../core/human';
import type { CountryMeta, World } from '../../../core/world';
import { setOptions, switchTool } from '../../state';
import { focusOn } from '../camera';
import { cellsOf, countriesByName, flagColorPatch, mergeCommand, namePatch, rerollFlag, statsOf } from '../domain/countries';
import { popText } from '../domain/human';
import { Flag } from '../panels/countries';
import { confirmMerge, selectCountry } from '../tools/countries';
import { EMBLEM_NAMES, LAYOUT_NAMES, flagPartName, withEmblem, withLayout, patch, run } from '../country-archive';
import { Line, NamePair } from './fields';

// 国家档案的“概览”一页（第七十轮从 CountryArchive.tsx 按页分出来）

export function NameSection({ m }: { m: CountryMeta }) {
  return (
    <section>
      <h5>名字</h5>
      <NamePair name={m.name} orig={m.orig ?? ''} onCommit={(n, o) => void patch(m.id, namePatch(m, n, o))} />
      <div class="row between">
        <span class="hint">{m.nameLocked ? '改过名字：换政体、文化时不变' : '按政体、主流文化自动起'}</span>
        {m.nameLocked && (
          <button class="small" onClick={() => void patch(m.id, { name: '' })}>
            恢复自动
          </button>
        )}
      </div>
    </section>
  );
}

export function FlagSection({ w, m }: { w: World; m: CountryMeta }) {
  const f = m.flag;
  const setFlag = (flag: FlagSpec | null) => void patch(m.id, { flag });
  return (
    <section>
      <h5>旗帜</h5>
      <div class="flag-edit">
        <Flag m={m} w={90} h={60} />
        {/* 每种颜色下面写是哪一块（第二十七轮） */}
        <div class="flag-colors">
          {f.colors.map((c, k) => (
            <label class="flag-color">
              <input type="color" value={c} onChange={(e) => setFlag(flagColorPatch(f, k, (e.target as HTMLInputElement).value))} />
              <span class="hint">{flagPartName(f.layout, k)}</span>
            </label>
          ))}
          {f.emblem && (
            <label class="flag-color">
              <input type="color" value={f.emblemColor ?? '#f4f1e8'} onChange={(e) => setFlag(flagColorPatch(f, -1, (e.target as HTMLInputElement).value))} />
              <span class="hint">纹章</span>
            </label>
          )}
        </div>
      </div>
      <Line label="样式">
        <select class="grow" value={f.layout} onChange={(e) => setFlag(withLayout(f, (e.target as HTMLSelectElement).value))}>
          {FLAG_LAYOUTS.map((l) => (
            <option value={l}>{LAYOUT_NAMES[l] ?? l}</option>
          ))}
        </select>
      </Line>
      <Line label="纹章">
        <select class="grow" value={f.emblem ?? ''} onChange={(e) => setFlag(withEmblem(f, (e.target as HTMLSelectElement).value))}>
          <option value="">无</option>
          {FLAG_EMBLEMS.map((x) => (
            <option value={x}>{EMBLEM_NAMES[x] ?? x}</option>
          ))}
        </select>
      </Line>
      <div class="row wrap">
        <button class="small" onClick={() => setFlag(rerollFlag(w, m, (Math.random() * 0xffffffff) >>> 0))} title="按政体换一面">
          换一个
        </button>
        <button class="small" onClick={() => setFlag(null)} title="回到生成时的旗帜">
          恢复自动
        </button>
      </div>
    </section>
  );
}

export function ColorCapital({ w, m }: { w: World; m: CountryMeta }) {
  const overlord = m.overlord !== undefined ? w.small.countries?.[m.overlord] : undefined;
  const fed = blocsOf(w, m.id).find((b) => b.kind === 'federation');
  const cap = m.capitalCell;
  return (
    <section>
      <Line label="颜色">
        <input type="color" value={m.color} onChange={(e) => void patch(m.id, { color: (e.target as HTMLInputElement).value })} />
        <span class="hint grow">{fed ? `地图上用“${fed.name}”的颜色` : overlord ? `地图上用“${overlord.name}”的浅色` : ''}</span>
      </Line>
      {/* 第二十七轮：换首都在城市、格的档案里（没有单独的首都工具了） */}
      <Line label="首都">
        <span class="grow" title="换首都：用指针点一座城市或一格，在它的档案里设为首都">
          {cap !== undefined ? cellName(w, cap).zh : '没有领土'}
          {cap !== undefined && !m.capitalLocked && <span class="hint">（自动）</span>}
        </span>
        {cap !== undefined && (
          <button class="icon-btn" onClick={() => focusOn([cap])} title="定位">
            <ScanSearch />
          </button>
        )}
        {m.capitalLocked && (
          <button class="small" onClick={() => void run({ op: 'move_capital', id: m.id, cell: null })}>
            恢复自动
          </button>
        )}
      </Line>
    </section>
  );
}

// 领土（第二十七轮）：涂领土（换到领土笔刷、涂给这一国）、分成两半、并入别国、删除
export function TerritorySection({ w, m, remove }: { w: World; m: CountryMeta; remove: () => void }) {
  const others = countriesByName(w).filter((x) => x.id !== m.id);
  const cells = cellsOf(w, m.id);
  const into = async (target: number) => {
    if (!(await confirmMerge(w, target, m.id))) return;
    if (await run(mergeCommand(target, m.id), '正在计算…')) selectCountry(target);
  };
  return (
    <section>
      <h5>领土</h5>
      <div class="row wrap">
        <button
          class="small"
          onClick={() => {
            setOptions({ territory: m.id });
            switchTool('territory');
          }}
          title="换到领土笔刷，涂给这一国"
        >
          <Paintbrush /> 涂领土
        </button>
        <button class="small" disabled={cells.length < 2} onClick={() => void run({ op: 'split_country', id: m.id }, '正在计算…')} title="领土对半分开，分出的一半成为新国家">
          <SplitSquareHorizontal /> 分成两半
        </button>
        {others.length > 0 && (
          <select
            class="small"
            value=""
            title="这一国并进所选的国家"
            onChange={(e) => {
              const v = Number((e.target as HTMLSelectElement).value);
              (e.target as HTMLSelectElement).value = '';
              if (v) void into(v);
            }}
          >
            <option value="">并入…</option>
            {others.map((x) => (
              <option value={x.id}>{x.name}</option>
            ))}
          </select>
        )}
        <button class="small danger" onClick={remove}>
          <Trash2 /> 删除
        </button>
      </div>
    </section>
  );
}

// 概览里的几个数（详细的在“人口与城市”）
export function Glance({ w, m }: { w: World; m: CountryMeta }) {
  const st = statsOf(w).get(m.id);
  if (!st) return null;
  return (
    <div class="stat-grid">
      <span class="hint">人口</span>
      <b>{popText(st.population)}</b>
      <span class="hint">面积</span>
      <b>{Math.round(st.areaKm2).toLocaleString()} km²</b>
    </div>
  );
}
