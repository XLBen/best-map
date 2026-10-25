import { Lock, LockOpen, ScanSearch, Trash2 } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Command } from '../../core/commands';
import { cityArchive, landmarkTypeById, pointTypeById } from '../../core/human';
import type { World } from '../../core/world';
import { iconOf } from '../render/settle-draw';
import { type SettleRef, exec, nameMode, selectedSettle, world } from '../state';
import { focusOn } from './camera';
import { Line, ShareRow, StackBar, TextField } from './CountryArchive';
import { Toggle } from './components/Toggle';
import { capitalCommand, yearText } from './countries';
import { popText, shareText } from './human';
import { showCountry } from './panels/countries';
import { CityGlyph } from './panels/settlements';
import {
  CATEGORY_NAMES,
  cityFoundedPatch,
  cityIconOf,
  cityPatchCommand,
  landmarkChoices,
  landmarkPatchCommand,
  pointChoices,
  pointPatchCommand,
  rankChoices,
  settleLists,
  settleNamePatch,
  textPatch,
} from './settlements';
import { deleteSelected, selectSettle } from './tools/settlements';

// 城市、地标、自定义点的档案（第二十四轮）：右边的抽屉（同国家的档案），选中的那一样。
// 改的都是 set_city / set_landmark / set_point 的 patch；字在离开框（或回车）时提交，简介、备注停下一秒也提交

const run = (cmd: Command | null) => (cmd ? exec(cmd, '正在保存…') : Promise.resolve(false));

export const SETTLE_TITLES: Record<SettleRef['kind'], string> = { city: '城市档案', road: '道路', landmark: '地标档案', point: '自定义点' };

// 一段长字：停下一秒、离开框时提交；换了一样之前没提交的写进原来那一样
function LongText({ id, value, placeholder, rows = 3, onCommit }: { id: string; value: string; placeholder?: string; rows?: number; onCommit: (text: string) => void }) {
  const [text, setText] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ text, value, onCommit });
  latest.current = { text, value, onCommit };
  useEffect(() => setText(value), [id, value]);
  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const l = latest.current;
    if (l.text !== l.value) l.onCommit(l.text);
  };
  useEffect(() => () => (timer.current ? flush() : undefined), [id]);
  return (
    <textarea
      class="arch-note-input"
      rows={rows}
      maxLength={2000}
      placeholder={placeholder}
      value={text}
      onInput={(e) => {
        setText((e.target as HTMLTextAreaElement).value);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(flush, 1000);
      }}
      onBlur={flush}
    />
  );
}

function Head({ icon, name, orig, locate, remove, title }: { icon: ComponentChildren; name: string; orig?: string; locate: () => void; remove: () => void; title: string }) {
  return (
    <div class="row arch-head">
      {icon}
      <span class="grow item-text">
        <b>{name}</b>
        {orig && <span class="hint">{orig}</span>}
      </span>
      <button class="icon-btn" onClick={locate} title="定位">
        <ScanSearch />
      </button>
      <button class="icon-btn" onClick={remove} title={title}>
        <Trash2 />
      </button>
    </div>
  );
}

// 名字：中文、原文，自己起过时可以恢复自动
function NameBox({ cur, onPatch, reroll }: { cur: { name: string; orig?: string; customName: boolean }; onPatch: (p: { name: string; orig?: string }) => void; reroll?: () => void }) {
  const [orig, setOrig] = useState(cur.orig ?? '');
  useEffect(() => setOrig(cur.orig ?? ''), [cur.orig]);
  const send = (name: string, o: string) => {
    const p = settleNamePatch(cur, name, o);
    if (p) onPatch(p);
  };
  return (
    <section>
      <h5>名字</h5>
      <Line label="中文">
        <TextField value={cur.name} onCommit={(v) => send(v, orig)} placeholder="空着恢复自动" />
      </Line>
      <Line label="原文">
        <TextField value={cur.orig ?? ''} maxLength={80} onCommit={(v) => (setOrig(v), send(cur.name, v))} placeholder="原文" />
      </Line>
      <div class="row between">
        <span class="hint">{cur.customName ? '自己起的名字' : '按当地的地名风格自动起'}</span>
        <span class="row">
          {reroll && (
            <button class="small" onClick={reroll} title="换一个自动的名字">
              换一个
            </button>
          )}
          {cur.customName && (
            <button class="small" onClick={() => onPatch({ name: '' })}>
              恢复自动
            </button>
          )}
        </span>
      </div>
    </section>
  );
}

// 所属国家：点国名打开它的档案
function CountryLink({ w, id }: { w: World; id: number | null }) {
  const m = id !== null ? w.small.countries?.[id] : undefined;
  if (!m) return <span class="grow">无主地</span>;
  return (
    <span class="grow">
      <span class="swatch" style={{ background: m.color }} />{' '}
      <button class="link" onClick={() => showCountry(w, m.id)} title="打开档案">
        {m.name}
      </button>
    </span>
  );
}

// 设为首都（第二十七轮）：城市在这一国的领土上、还不是首都时
function CapitalButton({ w, country, cell, capital }: { w: World; country: number | null; cell: number; capital: boolean }) {
  if (country === null || capital || !w.small.countries?.[country]) return null;
  const own = w.causes.country?.[cell] === country;
  return (
    <button class="small" disabled={!own} onClick={() => void exec(capitalCommand(country, cell), '正在计算…')} title={own ? undefined : '城市不在这一国的领土上'}>
      设为首都
    </button>
  );
}

// ---------- 城市 ----------

function CityView({ w, id }: { w: World; id: number }) {
  const a = cityArchive(w, id);
  if (!a) return <p class="hint">没有这座城市</p>;
  const meta = w.small.cities![id];
  const patch = (p: Extract<Command, { op: 'set_city' }>['patch'] | null) => run(p ? cityPatchCommand(id, p) : null);
  const countries = Object.values(w.small.countries ?? {}).sort((x, y) => x.name.localeCompare(y.name, 'zh'));
  const hosts = settleLists(w).points.filter((p) => p.attachedCity === id);
  return (
    <div class="country-archive settle-archive" key={`city:${id}`}>
      <Head
        icon={<CityGlyph icon={cityIconOf(a.rank)} hollow={a.secondCapital && !a.capital} />}
        name={a.name}
        orig={a.orig}
        locate={() => focusOn([a.cell])}
        remove={() => deleteSelected(['city'])}
        title="删除城市（连着它的自动道路一起删）"
      />
      {(a.capital || a.secondCapital) && (
        <div class="chips">
          {a.capital && <span class="chip static">首都</span>}
          {a.secondCapital && <span class="chip static">陪都</span>}
          {hosts.map((p) => (
            <button class="link" onClick={() => selectSettle({ kind: 'point', id: p.id })}>
              {p.name}
            </button>
          ))}
        </div>
      )}
      <Toggle on={a.locked} onChange={(locked) => void patch({ locked })} title="重新生成城市时留着">
        {a.locked ? <Lock /> : <LockOpen />} 锁定
      </Toggle>
      <NameBox cur={a} onPatch={(p) => void patch(p)} reroll={() => void patch({ reroll: true })} />
      <section>
        <h5>等级与所属</h5>
        <Line label="等级">
          <select class="grow" value={a.rankAuto ? '' : a.rank.id} onChange={(e) => void patch({ rank: (e.target as HTMLSelectElement).value || null })}>
            <option value="">自动：{a.autoRank.name}</option>
            {rankChoices(w).map((r) => (
              <option value={r.id}>{r.name}</option>
            ))}
          </select>
        </Line>
        <Line label="国家">
          <CountryLink w={w} id={a.country} />
          <CapitalButton w={w} country={a.country} cell={a.cell} capital={a.capital} />
        </Line>
        {countries.length > 0 && (
          <Line label="归属">
            <select class="grow" value={a.countryAuto ? '' : String(a.country ?? '')} onChange={(e) => void patch({ country: Number((e.target as HTMLSelectElement).value) || null })}>
              <option value="">自动：按领土</option>
              {countries.map((m) => (
                <option value={m.id}>{m.name}</option>
              ))}
            </select>
          </Line>
        )}
      </section>
      <section>
        <h5>人口</h5>
        <div class="stat-grid">
          <span class="hint">人口</span>
          <b>{a.population > 0 ? popText(a.population) : '无人'}</b>
          <span class="hint">占全国</span>
          <b>{shareText(a.share)}</b>
          <span class="hint">海拔</span>
          <b>{a.elevation} m</b>
          <span class="hint">道路</span>
          <b>{a.roads} 条</b>
          {a.terrainClass && (
            <>
              <span class="hint">地形</span>
              <b>{a.terrainClass}</b>
            </>
          )}
          {a.provinceName && (
            <>
              <span class="hint">省份</span>
              <b class="ellipsis">{a.provinceName}</b>
            </>
          )}
        </div>
        {a.cultures.length > 0 && (
          <>
            <p class="hint">文化</p>
            <StackBar items={a.cultures} />
            {a.cultures.slice(0, 4).map((c) => (
              <ShareRow color={c.color} label={c.name} share={c.share} />
            ))}
          </>
        )}
      </section>
      <section>
        <h5>建城与简介</h5>
        <Line label="建城">
          <TextField value={String(a.founded)} maxLength={12} title={yearText(a.founded)} onCommit={(v) => void patch(cityFoundedPatch(a, v))} placeholder="空着恢复自动" />
          <span class="hint">
            {yearText(a.founded)}
            {a.foundedAuto ? '（自动）' : ''}
          </span>
        </Line>
        {!a.foundedAuto && (
          <button class="small" onClick={() => void patch({ founded: null })}>
            年份恢复自动
          </button>
        )}
        <LongText id={`city:${id}:d`} value={a.descriptionAuto ? '' : a.description} placeholder={a.descriptionAuto ? a.description : '空着恢复自动'} onCommit={(t) => {
          const v = textPatch(meta.description, t);
          if (v !== undefined) void patch({ description: v });
        }} />
      </section>
      <section>
        <h5>备注</h5>
        <LongText id={`city:${id}:n`} value={a.notes ?? ''} placeholder="备注" rows={2} onCommit={(t) => {
          const v = textPatch(meta.notes, t);
          if (v !== undefined) void patch({ notes: v });
        }} />
      </section>
    </div>
  );
}

// ---------- 地标 ----------

function LandmarkView({ w, id }: { w: World; id: number }) {
  const l = settleLists(w).landmarks.find((x) => x.id === id);
  const meta = w.small.landmarks?.[id];
  if (!l || !meta) return <p class="hint">没有这个地标</p>;
  const patch = (p: Extract<Command, { op: 'set_landmark' }>['patch']) => run(landmarkPatchCommand(id, p));
  const I = iconOf(l.icon);
  const types = landmarkChoices(w);
  const t = landmarkTypeById(w.small, l.type);
  return (
    <div class="country-archive settle-archive" key={`landmark:${id}`}>
      <Head icon={I ? <I /> : null} name={l.name} orig={l.orig} locate={() => focusOn([l.cell])} remove={() => deleteSelected(['landmark'])} title="删除地标" />
      <Toggle on={l.locked} onChange={(locked) => void patch({ locked })} title="重新生成地标时留着">
        {l.locked ? <Lock /> : <LockOpen />} 锁定
      </Toggle>
      <NameBox cur={l} onPatch={(p) => void patch(p)} />
      <section>
        <h5>类型</h5>
        <Line label="类型">
          <select class="grow" value={l.type} onChange={(e) => void patch({ type: (e.target as HTMLSelectElement).value })}>
            {(['natural', 'manmade'] as const).map((c) => (
              <optgroup label={CATEGORY_NAMES[c]}>
                {types
                  .filter((x) => x.category === c)
                  .map((x) => (
                    <option value={x.id}>{x.name}</option>
                  ))}
              </optgroup>
            ))}
          </select>
        </Line>
        <Line label="国家">
          <CountryLink w={w} id={l.country} />
        </Line>
        <Line label="海拔">
          <span class="grow">{l.elevation} m</span>
        </Line>
      </section>
      <section>
        <h5>简介</h5>
        <LongText id={`landmark:${id}`} value={meta.description ?? ''} placeholder={t?.description ?? '简介'} onCommit={(text) => {
          const v = textPatch(meta.description, text);
          if (v !== undefined) void patch({ description: v });
        }} />
      </section>
    </div>
  );
}

// ---------- 自定义点 ----------

// 挂在哪座城市上：附近的城市（按远近，最多 20 座），再加上现在挂着的
function nearbyCities(w: World, x: number, y: number, cur?: number) {
  const d = (cx: number, cy: number) => {
    let dx = cx - x;
    if (w.mesh.kind === 'sphere') dx -= 2 * Math.round(dx / 2);
    return Math.hypot(dx, cy - y);
  };
  const list = settleLists(w).cities.filter((c) => !c.point);
  const near = [...list].sort((a, b) => d(a.x, a.y) - d(b.x, b.y)).slice(0, 20);
  const c = cur !== undefined ? list.find((x) => x.id === cur) : undefined;
  return c && !near.includes(c) ? [c, ...near] : near;
}

function PointView({ w, id }: { w: World; id: number }) {
  const p = settleLists(w).points.find((x) => x.id === id);
  const meta = w.small.points?.[id];
  if (!p || !meta) return <p class="hint">没有这个点</p>;
  const patch = (q: Extract<Command, { op: 'set_point' }>['patch']) => run(pointPatchCommand(id, q));
  const t = pointTypeById(w.small, p.type);
  const I = iconOf(p.icon ?? 'pin');
  const custom = meta.name !== t?.name;
  return (
    <div class="country-archive settle-archive" key={`point:${id}`}>
      <Head
        icon={p.image ? <img class="type-img" src={p.image} alt="" /> : I ? <I /> : null}
        name={p.name}
        locate={() => focusOn([p.cell])}
        remove={() => deleteSelected(['point'])}
        title="删除点"
      />
      <section>
        <h5>名字</h5>
        <Line label="名字">
          <TextField value={p.name} onCommit={(v) => v.trim() !== p.name && void patch({ name: v })} placeholder="空着用类型的名字" />
        </Line>
        {custom && t && (
          <button class="small" onClick={() => void patch({ name: '' })}>
            用类型的名字
          </button>
        )}
      </section>
      <section>
        <h5>类型</h5>
        <Line label="类型">
          <span class="swatch" style={{ background: p.color }} />
          <select class="grow" value={p.type} onChange={(e) => void patch({ type: (e.target as HTMLSelectElement).value })}>
            {pointChoices(w).map((x) => (
              <option value={x.id}>{x.name}</option>
            ))}
          </select>
        </Line>
        {t?.description && <p class="hint">{t.description}</p>}
        {p.actsAsCity && (
          <Line label="挂在">
            <select class="grow" value={p.attachedCity !== undefined ? String(p.attachedCity) : ''} onChange={(e) => void patch({ attachedCity: Number((e.target as HTMLSelectElement).value) || null })} title="挂着的城市算陪都；不挂时这个点自己当一座城市">
              <option value="">不挂（自己当一座城市）</option>
              {nearbyCities(w, p.x, p.y, p.attachedCity).map((c) => (
                <option value={c.id}>{c.name}</option>
              ))}
            </select>
          </Line>
        )}
        {p.attachedCity !== undefined && (
          <button class="link" onClick={() => selectSettle({ kind: 'city', id: p.attachedCity! })}>
            打开“{settleLists(w).cities.find((c) => !c.point && c.id === p.attachedCity)?.name ?? '城市'}”的档案
          </button>
        )}
      </section>
      <section>
        <h5>备注</h5>
        <LongText id={`point:${id}`} value={meta.note ?? ''} placeholder="备注" onCommit={(text) => {
          const v = textPatch(meta.note, text);
          if (v !== undefined) void patch({ note: v });
        }} />
      </section>
    </div>
  );
}

// ---------- 抽屉 ----------

export function SettleArchive() {
  const w = world.value;
  const r = selectedSettle.value;
  void nameMode.value;
  if (!w || !r) return <p class="hint">没有选中</p>;
  if (r.kind === 'city') return <CityView w={w} id={r.id} />;
  if (r.kind === 'landmark') return <LandmarkView w={w} id={r.id} />;
  if (r.kind === 'point') return <PointView w={w} id={r.id} />;
  return <p class="hint">道路在底部条上改</p>;
}
