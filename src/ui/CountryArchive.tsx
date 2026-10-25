import { Lock, LockOpen, ScanSearch, Trash2, X } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Command } from '../../core/commands';
import {
  BLOC_NAMES,
  type CountryPatch,
  FLAG_EMBLEMS,
  FLAG_LAYOUTS,
  type FlagSpec,
  LAYOUT_COLORS,
  TIER_NAMES,
  blocsOf,
  categoryName,
  cellName,
  countryFactions,
  worldCultureGroups,
  worldCultures,
} from '../../core/human';
import type { CountryMeta, World } from '../../core/world';
import { askUser, exec, nameMode, selectedCountry, sheet, switchTool, world } from '../state';
import { focusOn } from './camera';
import { Slider } from './components/Slider';
import { Toggle } from './components/Toggle';
import {
  cellsOf,
  factionPatch,
  flagColorPatch,
  foundedPatch,
  governmentChoices,
  historyPatch,
  namePatch,
  patchCommand,
  rerollFlag,
  rulerPatch,
  statsOf,
  titlePreview,
  vassalsOf,
  withId,
  withoutId,
  yearText,
} from './countries';
import { densityText, firstLine, popText, shareText } from './human';
import { BLOC_KIND_OPTIONS, SUBJECT_OPTIONS, joinBlocCommand, joinNote, joinableBlocs, leaveBlocCommand, newBlocCommand, selectBloc, subjectCommand } from './blocs';
import { Flag, showCountry } from './panels/countries';
import { CityList } from './panels/settlements';
import { countryCityRows, hasAnySettle } from './settlements';
import { selectSettle } from './tools/settlements';

// 国家的档案（第二十三轮）：右边的抽屉，选中的国家。名字、旗帜、颜色、首都、政体、主流文化与兼容的文化组、统计、派系、外交、统治者、
// 建国年份、历史。改的都是 set_country 的 patch；字在离开框（或回车）时提交，历史停下一会儿也提交。
// 第二十六轮：头上写等级；外交里有从属的种类、所在的帝国、联邦、同盟（加入、退出、新建，见 blocs.ts）

const run = (cmd: Command | null, busy = '正在保存…') => (cmd ? exec(cmd, busy) : Promise.resolve(false));
const patch = (id: number, p: CountryPatch | null) => run(p ? patchCommand(id, p) : null);

export const LAYOUT_NAMES: Record<string, string> = {
  plain: '纯色',
  'bicolor-h': '横二色',
  'bicolor-v': '竖二色',
  'tricolor-h': '横三色',
  'tricolor-v': '竖三色',
  cross: '十字',
  nordic: '北欧十字',
  saltire: '斜十字',
  canton: '角旗',
  chevron: '三角',
  quartered: '四分',
  border: '镶边',
  diagonal: '斜分',
  stripes: '条纹',
};
export const EMBLEM_NAMES: Record<string, string> = {
  star: '星',
  sun: '太阳',
  moon: '月',
  crown: '王冠',
  cross: '十字',
  circle: '圆',
  tower: '塔',
  tree: '树',
  sword: '剑',
  eagle: '鹰',
  lion: '狮',
  wheel: '轮',
  mountain: '山',
  wave: '波浪',
};

// 换旗的样式：颜色的种数跟着样式（少了补上现有的或深浅两色）
export function withLayout(flag: FlagSpec, layout: string): FlagSpec {
  const k = LAYOUT_COLORS[layout as keyof typeof LAYOUT_COLORS] ?? 1;
  const colors = flag.colors.slice(0, k);
  const pad = ['#f4f1e8', '#1d1d1f', '#c8102e', '#e8b923'];
  for (let q = 0; colors.length < k; q++) if (!colors.includes(pad[q % pad.length]) || q > 8) colors.push(pad[q % pad.length]);
  return { ...flag, layout: layout as FlagSpec['layout'], colors };
}
export function withEmblem(flag: FlagSpec, emblem: string): FlagSpec {
  if (!emblem) {
    const { emblem: _e, emblemColor: _c, ...rest } = flag;
    return rest;
  }
  return { ...flag, emblem: emblem as FlagSpec['emblem'], emblemColor: flag.emblemColor ?? '#f4f1e8' };
}

export function Line({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="arch-line">
      <span class="arch-label">{label}</span>
      {children}
    </div>
  );
}

// 一个字的框：离开框、回车时提交；Esc 回到原来的
export function TextField({ value, onCommit, placeholder, maxLength = 40, class: cls = 'grow', title }: { value: string; onCommit: (v: string) => void; placeholder?: string; maxLength?: number; class?: string; title?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      class={cls}
      value={v}
      maxLength={maxLength}
      placeholder={placeholder}
      title={title}
      onInput={(e) => setV((e.target as HTMLInputElement).value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          e.stopPropagation();
          setV(value);
        }
      }}
      onBlur={() => {
        if (v !== value) onCommit(v);
      }}
    />
  );
}

// 占比的一行（同格的档案里人口的样子）
export function ShareRow({ color, label, share, title, children }: { color: string; label: string; share: number; title?: string; children?: ComponentChildren }) {
  return (
    <div class="share-row" title={title}>
      <span class="swatch" style={{ background: color }} />
      <span class="share-name">{label}</span>
      <span class="share-bar">
        <span style={{ width: `${Math.round(share * 100)}%`, background: color }} />
      </span>
      {children ?? <span class="hint">{shareText(share)}</span>}
    </div>
  );
}

// 一整条的构成（文化、宗教……），鼠标停着写名字与占比
export function StackBar({ items }: { items: { name: string; color: string; share: number }[] }) {
  const rest = Math.max(0, 1 - items.reduce((a, x) => a + x.share, 0));
  return (
    <div class="stack-bar">
      {items.map((x) => (
        <span style={{ width: `${x.share * 100}%`, background: x.color }} title={`${x.name} ${shareText(x.share)}`} />
      ))}
      {rest > 0.005 && <span class="stack-rest" style={{ width: `${rest * 100}%` }} title={`其他 ${shareText(rest)}`} />}
    </div>
  );
}

// ---------- 几段 ----------

function NameSection({ m }: { m: CountryMeta }) {
  const [orig, setOrig] = useState(m.orig ?? '');
  useEffect(() => setOrig(m.orig ?? ''), [m.id, m.orig]);
  return (
    <section>
      <h5>名字</h5>
      <Line label="中文">
        <TextField value={m.name} onCommit={(v) => void patch(m.id, namePatch(m, v, orig))} placeholder="空着恢复自动" />
      </Line>
      <Line label="原文">
        <TextField value={m.orig ?? ''} maxLength={80} onCommit={(v) => (setOrig(v), void patch(m.id, namePatch(m, m.name, v)))} placeholder="原文" />
      </Line>
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

function FlagSection({ w, m }: { w: World; m: CountryMeta }) {
  const f = m.flag;
  const setFlag = (flag: FlagSpec | null) => void patch(m.id, { flag });
  return (
    <section>
      <h5>旗帜</h5>
      <div class="flag-edit">
        <Flag m={m} w={90} h={60} />
        <div class="flag-colors">
          {f.colors.map((c, k) => (
            <input type="color" value={c} title={k === 0 ? '底色' : `第 ${k + 1} 种颜色`} onChange={(e) => setFlag(flagColorPatch(f, k, (e.target as HTMLInputElement).value))} />
          ))}
          {f.emblem && <input type="color" value={f.emblemColor ?? '#f4f1e8'} title="纹章的颜色" onChange={(e) => setFlag(flagColorPatch(f, -1, (e.target as HTMLInputElement).value))} />}
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

function ColorCapital({ w, m }: { w: World; m: CountryMeta }) {
  const overlord = m.overlord !== undefined ? w.small.countries?.[m.overlord] : undefined;
  const fed = blocsOf(w, m.id).find((b) => b.kind === 'federation');
  const cap = m.capitalCell;
  return (
    <section>
      <Line label="颜色">
        <input type="color" value={m.color} onChange={(e) => void patch(m.id, { color: (e.target as HTMLInputElement).value })} />
        <span class="hint grow">{fed ? `地图上用“${fed.name}”的颜色` : overlord ? `地图上用“${overlord.name}”的浅色` : ''}</span>
      </Line>
      <Line label="首都">
        <span class="grow">
          {cap !== undefined ? cellName(w, cap).zh : '没有领土'}
          {cap !== undefined && !m.capitalLocked && <span class="hint">（自动）</span>}
        </span>
        {cap !== undefined && (
          <button class="icon-btn" onClick={() => focusOn([cap])} title="定位">
            <ScanSearch />
          </button>
        )}
        <button class="small" onClick={() => switchTool('capital')} title="在地图上点这一国的一格">
          挪动
        </button>
        {m.capitalLocked && (
          <button class="small" onClick={() => void run({ op: 'move_capital', id: m.id, cell: null })}>
            恢复自动
          </button>
        )}
      </Line>
    </section>
  );
}

function GovernmentSection({ w, m }: { w: World; m: CountryMeta }) {
  const list = governmentChoices(w, m.government);
  return (
    <section>
      <h5>政体</h5>
      <div class="list gov-list">
        {list.map((g) => {
          const next = titlePreview(w, m, g.id);
          return (
            <button class={`item ${g.id === m.government ? 'on' : ''}`} title={`${g.description ?? ''}${!m.nameLocked && g.id !== m.government ? `\n国名改为“${next}”` : ''}`} onClick={() => g.id !== m.government && void patch(m.id, { government: g.id })}>
              {g.color && <span class="swatch" style={{ background: g.color }} />}
              <span class="grow item-text">
                <span>{g.name}</span>
                <span class="hint ellipsis">{firstLine(g.description) || g.category.map(categoryName).join('、')}</span>
              </span>
              {g.id !== m.government && !m.nameLocked && <span class="hint ellipsis gov-title">{next}</span>}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function CultureSection({ w, m }: { w: World; m: CountryMeta }) {
  const groups = worldCultureGroups(w.small);
  const cultures = worldCultures(w.small);
  const primary = cultures.find((c) => c.id === m.primaryCulture);
  return (
    <section>
      <h5>文化</h5>
      <Line label="主流">
        {primary && <span class="swatch" style={{ background: primary.color }} />}
        <select class="grow" value={m.primaryCulture} onChange={(e) => void patch(m.id, { primaryCulture: (e.target as HTMLSelectElement).value })} title={m.nameLocked ? undefined : '没改过名字时国名按新文化的风格重起'}>
          {groups.map((g) => (
            <optgroup label={g.name}>
              {cultures
                .filter((c) => c.group === g.id)
                .map((c) => (
                  <option value={c.id}>{c.name}</option>
                ))}
            </optgroup>
          ))}
        </select>
      </Line>
      <p class="hint">兼容的文化组</p>
      <div class="check-grid">
        {groups.map((g) => {
          const on = m.acceptedGroups.includes(g.id);
          const fixed = g.id === primary?.group;
          return (
            <label class="check" title={fixed ? '主流文化的组总是兼容' : g.description}>
              <input
                type="checkbox"
                checked={on}
                disabled={fixed}
                onChange={() => void patch(m.id, { acceptedGroups: on ? m.acceptedGroups.filter((x) => x !== g.id) : [...m.acceptedGroups, g.id] })}
              />
              <span class="swatch" style={{ background: g.color }} />
              {g.name}
            </label>
          );
        })}
      </div>
    </section>
  );
}

function StatsSection({ w, m }: { w: World; m: CountryMeta }) {
  const st = statsOf(w).get(m.id);
  if (!st) return null;
  const top = st.cultures.slice(0, 5);
  const other = Math.max(0, 1 - top.reduce((a, x) => a + x.share, 0));
  return (
    <section>
      <h5>统计</h5>
      <div class="stat-grid">
        <span class="hint">人口</span>
        <b>{popText(st.population)}</b>
        <span class="hint">面积</span>
        <b>{Math.round(st.areaKm2).toLocaleString()} km²</b>
        <span class="hint">密度</span>
        <b>{densityText(st.density)}</b>
        <span class="hint">省份</span>
        <b>{st.provinces} 个</b>
      </div>
      {st.population > 0 && (
        <>
          <p class="hint">文化</p>
          <StackBar items={st.cultures} />
          {top.map((c) => (
            <ShareRow color={c.color} label={c.name} share={c.share} title={`${popText(c.people)} 人`} />
          ))}
          {other > 0.005 && <ShareRow color="var(--faint)" label="其他" share={other} />}
          {st.values.map((v) =>
            v.items.length ? (
              <>
                <p class="hint">{v.label}</p>
                <StackBar items={v.items} />
              </>
            ) : null,
          )}
          {st.minorityShare > 0.005 && <p class="hint">不兼容的少数群体 {shareText(st.minorityShare)}</p>}
        </>
      )}
    </section>
  );
}

// 城市（第二十四轮）：首都、陪都，按人口排的城市（点一座打开它的档案）
function CitySection({ w, m }: { w: World; m: CountryMeta }) {
  if (!hasAnySettle(w)) return null;
  const rows = countryCityRows(w, m.id);
  const caps = rows.filter((c) => c.capital || c.secondCapital).sort((a, b) => Number(b.capital) - Number(a.capital));
  return (
    <section>
      <h5>城市 · {rows.length} 座</h5>
      {caps.length > 0 && (
        <Line label="首都">
          <span class="chips grow">
            {caps.map((c) => (
              <button class="link" onClick={() => selectSettle({ kind: c.point ? 'point' : 'city', id: c.id })} title={c.capital ? '首都' : '陪都'}>
                {c.name}
                {c.capital ? '' : '（陪都）'}
              </button>
            ))}
          </span>
        </Line>
      )}
      <CityList cities={rows} limit={12} />
    </section>
  );
}

function FactionSection({ w, m }: { w: World; m: CountryMeta }) {
  const list = countryFactions(w, m.id, statsOf(w).get(m.id));
  const [draft, setDraft] = useState<{ id: string; v: number } | null>(null);
  if (!list.length) return null;
  const shown = draft ? Object.entries(factionPatch(list, draft.id, draft.v)).map(([id, influence]) => ({ ...list.find((f) => f.id === id)!, influence })) : list;
  return (
    <section>
      <div class="row between">
        <h5>派系</h5>
        {m.factions ? (
          <button class="small" onClick={() => void patch(m.id, { factions: null })} title="按人口构成算">
            恢复自动
          </button>
        ) : (
          <span class="hint">自动</span>
        )}
      </div>
      <StackBar items={shown.map((f) => ({ name: f.name, color: f.color, share: f.influence }))} />
      {shown.map((f) => (
        <div class="faction-row">
          <span class="swatch" style={{ background: f.color }} />
          <Slider
            label={f.name}
            pos={f.influence}
            text={shareText(f.influence)}
            changed={draft?.id === f.id}
            onDraft={(p) => setDraft({ id: f.id, v: Math.round(p * 100) / 100 })}
            onCommit={(p) => {
              setDraft(null);
              void patch(m.id, { factions: factionPatch(list, f.id, Math.round(p * 100) / 100) });
            }}
            onCancel={() => setDraft(null)}
          />
        </div>
      ))}
    </section>
  );
}

// 外交里一组国家（同盟、敌对）：一个个小块（点了选中那一国），× 去掉，最后一个下拉框加一国
function CountryChips({ w, ids, others, onChange, label }: { w: World; ids: number[]; others: CountryMeta[]; onChange: (ids: number[]) => void; label: string }) {
  const metas = w.small.countries ?? {};
  const free = others.filter((x) => !ids.includes(x.id));
  return (
    <Line label={label}>
      <span class="chips grow">
        {ids.map((id) =>
          metas[id] ? (
            <span class="chip static">
              <span class="swatch" style={{ background: metas[id].color }} />
              <button class="link" onClick={() => showCountry(w, id)}>
                {metas[id].name}
              </button>
              <button class="icon-btn" onClick={() => onChange(withoutId(ids, id))} title="去掉">
                <X />
              </button>
            </span>
          ) : null,
        )}
        {!ids.length && <span class="hint">无</span>}
        {free.length > 0 && (
          <select
            class="chip-add"
            value=""
            onChange={(e) => {
              const v = Number((e.target as HTMLSelectElement).value);
              if (v) onChange(withId(ids, v));
            }}
          >
            <option value="">加一国</option>
            {free.map((x) => (
              <option value={x.id}>{x.name}</option>
            ))}
          </select>
        )}
      </span>
    </Line>
  );
}

// 所在的帝国、联邦、同盟：点名字打开集团的档案，× 退出；下拉框加入一个，或以这一国为盟主新建
function BlocLine({ w, m }: { w: World; m: CountryMeta }) {
  const mine = blocsOf(w, m.id);
  const free = joinableBlocs(w, m.id);
  return (
    <Line label="集团">
      <span class="chips grow">
        {mine.map((b) => (
          <span class="chip static">
            <span class="swatch" style={{ background: b.color }} />
            <button class="link" onClick={() => selectBloc(b.id)} title={BLOC_NAMES[b.kind]}>
              {b.name}
            </button>
            <button class="icon-btn" onClick={() => void run(leaveBlocCommand(b, m.id))} title="退出">
              <X />
            </button>
          </span>
        ))}
        {!mine.length && <span class="hint">无</span>}
        <select
          class="chip-add"
          value=""
          onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            const [op, x] = v.split(':');
            const b = op === 'join' ? free.find((y) => y.id === Number(x)) : undefined;
            if (b) void run(joinBlocCommand(b, m.id));
            else if (op === 'new') void run(newBlocCommand(x as (typeof BLOC_KIND_OPTIONS)[number][0], m.id));
          }}
        >
          <option value="">{free.length ? '加入、新建' : '新建'}</option>
          {free.length > 0 && (
            <optgroup label="加入">
              {free.map((b) => (
                <option value={`join:${b.id}`} title={joinNote(w, b, m.id)}>
                  {b.name}（{BLOC_NAMES[b.kind]}）
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="新建">
            {BLOC_KIND_OPTIONS.map(([k, label]) => (
              <option value={`new:${k}`}>{label}</option>
            ))}
          </optgroup>
        </select>
      </span>
    </Line>
  );
}

function DiplomacySection({ w, m }: { w: World; m: CountryMeta }) {
  const metas = w.small.countries ?? {};
  const others = Object.values(metas)
    .filter((x) => x.id !== m.id)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  // 宗主不能是自己的附庸（一层层往下）
  const below = new Set<number>();
  const walk = (id: number) => {
    for (const v of vassalsOf(w, id)) if (!below.has(v.id)) (below.add(v.id), walk(v.id));
  };
  walk(m.id);
  const vassals = vassalsOf(w, m.id);
  const overlord = m.overlord !== undefined ? metas[m.overlord] : undefined;
  return (
    <section>
      <h5>外交</h5>
      <Line label="宗主">
        {overlord && <span class="swatch" style={{ background: overlord.color }} />}
        <select class="grow" value={m.overlord ?? ''} onChange={(e) => void patch(m.id, { overlord: Number((e.target as HTMLSelectElement).value) || null })}>
          <option value="">无</option>
          {others
            .filter((x) => !below.has(x.id))
            .map((x) => (
              <option value={x.id}>{x.name}</option>
            ))}
        </select>
      </Line>
      <Line label="从属">
        <select
          class="grow"
          value={m.subject ?? 'vassal'}
          disabled={!overlord}
          title={overlord ? undefined : '先选宗主'}
          onChange={(e) => void run(subjectCommand(m, (e.target as HTMLSelectElement).value as (typeof SUBJECT_OPTIONS)[number][0]))}
        >
          {SUBJECT_OPTIONS.map(([k, label]) => (
            <option value={k}>{label}</option>
          ))}
        </select>
      </Line>
      <Line label="附庸">
        <span class="chips grow">
          {vassals.map((v) => (
            <span class="chip static">
              <span class="swatch" style={{ background: v.color }} />
              <button class="link" onClick={() => showCountry(w, v.id)}>
                {v.name}
              </button>
            </span>
          ))}
          {!vassals.length && <span class="hint">无</span>}
        </span>
      </Line>
      <BlocLine w={w} m={m} />
      <CountryChips w={w} label="同盟" ids={m.allies} others={others.filter((x) => !m.rivals.includes(x.id))} onChange={(allies) => void patch(m.id, { allies })} />
      <CountryChips w={w} label="敌对" ids={m.rivals} others={others.filter((x) => !m.allies.includes(x.id))} onChange={(rivals) => void patch(m.id, { rivals })} />
    </section>
  );
}

function RulerSection({ m }: { m: CountryMeta }) {
  const r = m.ruler;
  const set = (name: string, orig: string, title: string) => void patch(m.id, rulerPatch(m, name, orig, title));
  return (
    <section>
      <h5>统治者</h5>
      <Line label="称号">
        <TextField value={r.title ?? ''} maxLength={16} placeholder="国王、可汗……" onCommit={(v) => set(r.name, r.orig ?? '', v)} />
      </Line>
      <Line label="名字">
        <TextField value={r.name} onCommit={(v) => set(v, r.orig ?? '', r.title ?? '')} />
        <TextField class="arch-orig" value={r.orig ?? ''} maxLength={80} placeholder="原文" onCommit={(v) => set(r.name, v, r.title ?? '')} />
      </Line>
    </section>
  );
}

// 历史：打字停下一秒、离开框时提交（快照：生成时写下，改名不跟着变）
function HistorySection({ m }: { m: CountryMeta }) {
  const [text, setText] = useState(m.history);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ id: m.id, text, base: m });
  latest.current = { id: m.id, text, base: m };
  useEffect(() => setText(m.history), [m.id, m.history]);
  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const l = latest.current;
    void patch(l.id, historyPatch(l.base, l.text));
  };
  // 换了国家、关上抽屉之前没提交的写进原来那一国
  useEffect(() => () => (timer.current ? flush() : undefined), [m.id]);
  return (
    <section>
      <h5>建国与历史</h5>
      <Line label="建国">
        <TextField value={String(m.founded)} maxLength={12} title={yearText(m.founded)} onCommit={(v) => void patch(m.id, foundedPatch(m, v))} />
        <span class="hint">{yearText(m.founded)}</span>
      </Line>
      <textarea
        class="arch-note-input"
        rows={5}
        maxLength={4000}
        value={text}
        onInput={(e) => {
          setText((e.target as HTMLTextAreaElement).value);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(flush, 1000);
        }}
        onBlur={flush}
      />
    </section>
  );
}

// ---------- 抽屉 ----------

export function CountryArchive() {
  const w = world.value;
  const id = selectedCountry.value;
  const m = w && id !== null ? w.small.countries?.[id] : undefined;
  void nameMode.value;
  if (!w || !m) return <p class="hint">没有选中国家</p>;
  const remove = async () => {
    const v = await askUser({
      title: '删除国家',
      text: `“${m.name}”的领土成为无主地。可以撤销。`,
      choices: [
        { value: 'cancel', label: '取消' },
        { value: 'ok', label: '删除', primary: true },
      ],
    });
    if (v === 'ok' && (await run({ op: 'remove_country', id: m.id }, '正在计算…'))) {
      selectedCountry.value = null;
      sheet.value = null;
    }
  };
  return (
    <div class="country-archive" key={m.id}>
      <div class="row arch-head">
        <Flag m={m} w={36} h={24} />
        <span class="grow item-text">
          <b>{m.name}</b>
          <span class="hint">{[TIER_NAMES[m.tier ?? 'medium'], m.orig].filter(Boolean).join(' · ')}</span>
        </span>
        <button class="icon-btn" onClick={() => focusOn(cellsOf(w, m.id))} title="定位">
          <ScanSearch />
        </button>
        <button class="icon-btn" onClick={() => void remove()} title="删除国家">
          <Trash2 />
        </button>
      </div>
      <Toggle on={!!m.locked} onChange={(locked) => void patch(m.id, { locked })} title="重新生成国家时领土、档案都不动">
        {m.locked ? <Lock /> : <LockOpen />} 锁定
      </Toggle>
      <NameSection m={m} />
      <FlagSection w={w} m={m} />
      <ColorCapital w={w} m={m} />
      <GovernmentSection w={w} m={m} />
      <CultureSection w={w} m={m} />
      <StatsSection w={w} m={m} />
      <CitySection w={w} m={m} />
      <FactionSection w={w} m={m} />
      <DiplomacySection w={w} m={m} />
      <RulerSection m={m} />
      <HistorySection m={m} />
    </div>
  );
}
