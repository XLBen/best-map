import { useState } from 'preact/hooks';
import { flagSvg } from '../../../core/human';
import type { CountryMeta, World } from '../../../core/world';
import { askUser, exec, openPanel, selectedCountry, setOptions, sheet, switchTool, togglePanel, world } from '../../state';
import { focusOn } from '../camera';
import { Slider } from '../components/Slider';
import { Toggle } from '../components/Toggle';
import { TypePicker, TypePickerButton } from '../components/TypePicker';
import {
  NO_COUNTRIES,
  cellsOf,
  countryRows,
  estimateCountries,
  fragAt,
  fragPos,
  fragText,
  generateCountriesCommand,
  hasCountries,
  regenerateCountriesCommand,
} from '../countries';
import { popText } from '../human';
import { hasHuman } from '../tools/culture';
import { chosenTerritory, selectCountry } from '../tools/countries';

// “国家”一类（第二十三轮）：底部条上的选择（领土涂给谁、选中的国家）、“国家 ⋯”（生成、重新生成、删除、按人口排的国家列表）

// 一面小旗（flagSvg 是内容生成的 SVG 字符串）
export function Flag({ m, w = 30, h = 20 }: { m: Pick<CountryMeta, 'flag'>; w?: number; h?: number }) {
  return <span class="flag" style={{ width: `${w}px`, height: `${h}px` }} dangerouslySetInnerHTML={{ __html: flagSvg(m.flag, w, h) }} />;
}

// 选中、定位一国
export function showCountry(w: World, id: number) {
  selectCountry(id);
  focusOn(cellsOf(w, id));
}

// ---------- 底部条 ----------

// 没有国家时底部条上只有这一个入口
export function NoCountryChip() {
  const w = world.value;
  if (!w || hasCountries(w)) return null;
  return (
    <button class="bar-btn warn" onClick={() => togglePanel('cat:countries')} title={NO_COUNTRIES}>
      生成国家…
    </button>
  );
}

// 领土涂给谁
export function TerritoryPick() {
  const w = world.value;
  if (!w || !hasCountries(w)) return null;
  const t = chosenTerritory(w);
  return <TypePickerButton panel="countrypick" prefix="涂给" swatch={t?.meta?.color ?? 'transparent'} name={t ? (t.meta?.name ?? '无主地') : '选国家'} title="涂成哪一国的领土" />;
}

export function TerritoryMenu() {
  const w = world.value;
  if (!w) return null;
  const t = chosenTerritory(w);
  const pick = (territory: number) => {
    openPanel.value = null;
    setOptions({ territory });
  };
  return (
    <TypePicker
      items={[
        { label: '无主地', swatch: 'transparent', on: t?.id === null, hint: '不归哪一国', onPick: () => pick(0) },
        ...countryRows(w).map((r) => ({ label: r.meta.name, swatch: r.meta.color, on: t?.id === r.meta.id, meta: r.government, onPick: () => pick(r.meta.id) })),
      ]}
      onNew={() => {
        openPanel.value = null;
        switchTool('newCountry');
      }}
      newLabel="新建国家"
      newTitle="点一个省份或圈一片"
      note="Alt+点击地图吸取"
    />
  );
}

// 合并、首都：选中的国家（没选时说一句）
export function SelectedCountryChip() {
  const w = world.value;
  if (!w || !hasCountries(w)) return null;
  const m = selectedCountry.value !== null ? w.small.countries?.[selectedCountry.value] : undefined;
  if (!m) return <span class="bar-note">先点一个国家</span>;
  return (
    <>
      <span class="bar-note">
        <span class="swatch" style={{ background: m.color }} /> {m.name}
      </span>
      <button class={`bar-btn ${sheet.value === 'country' ? 'open' : ''}`} onClick={() => (sheet.value = sheet.value === 'country' ? null : 'country')} title="名字、旗帜、政体、外交……">
        档案
      </button>
    </>
  );
}

// ---------- 列表 ----------

export function CountryList({ w, onPick }: { w: World; onPick?: () => void }) {
  const rows = countryRows(w);
  const sel = selectedCountry.value;
  if (!rows.length) return <p class="hint">没有国家</p>;
  return (
    <div class="list country-list">
      {rows.map((r) => (
        <button
          class={`item country-row ${r.meta.id === sel ? 'on' : ''}`}
          title={r.overlord ? `“${r.overlord.name}”的附庸` : r.government}
          onClick={() => {
            showCountry(w, r.meta.id);
            onPick?.();
          }}
        >
          <span class="swatch" style={{ background: r.meta.color }} />
          <Flag m={r.meta} w={21} h={14} />
          <span class="grow item-text">
            <span class="ellipsis">{r.meta.name}</span>
            <span class="hint ellipsis">{r.overlord ? `附庸 · ${r.government}` : r.government}</span>
          </span>
          <span class="hint">{popText(r.stats?.population ?? 0)}</span>
        </button>
      ))}
    </div>
  );
}

// ---------- “国家 ⋯” ----------

function FragSlider({ w, value, onChange, keepLocked }: { w: World; value: number; onChange: (f: number) => void; keepLocked?: boolean }) {
  const [draft, setDraft] = useState<number | null>(null);
  const f = draft ?? value;
  const n = estimateCountries(w, f, keepLocked);
  return (
    <Slider
      stacked
      label="分裂 ↔ 统一"
      pos={fragPos(f)}
      text={fragText(f)}
      title="往左小国多，往右大国少"
      note={n ? `约 ${n} 个国家` : undefined}
      onDraft={(p) => setDraft(fragAt(p))}
      onCommit={(p) => {
        setDraft(null);
        onChange(fragAt(p));
      }}
      onCancel={() => setDraft(null)}
    />
  );
}

function GenerateCountries({ w }: { w: World }) {
  const [f, setF] = useState(0.5);
  return (
    <section>
      <h5>生成国家</h5>
      <FragSlider w={w} value={f} onChange={setF} />
      <button class="primary" onClick={() => void exec(generateCountriesCommand(f), '正在生成…')}>
        生成
      </button>
    </section>
  );
}

function CountryTools({ w }: { w: World }) {
  const [f, setF] = useState(w.small.human?.countryRules?.fragmentation ?? 0.5);
  const [keep, setKeep] = useState(true);
  const locked = Object.values(w.small.countries ?? {}).filter((m) => m.locked).length;
  return (
    <>
      <section>
        <h5>国家 · {Object.keys(w.small.countries ?? {}).length} 个</h5>
        <CountryList w={w} onPick={() => (openPanel.value = null)} />
      </section>
      <section>
        <h5>重新生成</h5>
        <FragSlider w={w} value={f} onChange={setF} keepLocked={keep} />
        {locked > 0 && (
          <Toggle on={keep} onChange={setKeep}>
            锁定的不动 · {locked} 个
          </Toggle>
        )}
        <div class="row wrap">
          <button onClick={() => void exec(regenerateCountriesCommand(w, f, keep), '正在生成…')} title="人口按新的国家重新分，手改过的格不动">
            重新生成
          </button>
          <button
            onClick={async () => {
              const v = await askUser({
                title: '删除国家',
                text: '全部国家都删除，人口不变。可以撤销。',
                choices: [
                  { value: 'cancel', label: '取消' },
                  { value: 'ok', label: '删除', primary: true },
                ],
              });
              if (v === 'ok') await exec({ op: 'remove_countries' }, '正在计算…');
            }}
          >
            删除国家
          </button>
        </div>
      </section>
    </>
  );
}

export function CountryExtras() {
  const w = world.value;
  if (!w) return null;
  if (!hasHuman(w)) {
    return (
      <section>
        <p class="hint">国家从文化圈里长出来，先生成人文</p>
        <button onClick={() => togglePanel('cat:culture')}>生成人文…</button>
      </section>
    );
  }
  return hasCountries(w) ? <CountryTools w={w} /> : <GenerateCountries w={w} />;
}

// 底部条上新建国家的方式（工具表里的选择）
export const NEW_COUNTRY_SHAPES = {
  kind: 'choice' as const,
  key: 'newCountryShape' as const,
  options: [
    { value: 'province', label: '点省份', hint: '这个省份成为新国家' },
    { value: 'lasso', label: '圈一片', hint: '圈住的陆地成为新国家' },
  ],
};
