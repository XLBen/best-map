import { Ellipsis, Pencil, Plus, X } from 'lucide-preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Command } from '../../../core/commands';
import { type ContentKind, enableCommand, itemId, itemName, kindOf } from '../../../core/content/registry';
import { hexToRgb } from '../../../core/export';
import type { IslandType } from '../../../core/island-types';
import { PACK_MAX_CHARS, readPack } from '../../../core/packs';
import type { World } from '../../../core/world';
import { library, saveItem } from '../../library';
import type { HighlightLayer } from '../../render/colors';
import {
  adjustPreviewWorld,
  askUser,
  cancelWorldPreview,
  exactDelay,
  exec,
  execAdjust,
  focusSpecies,
  knowIsolation,
  openPanel,
  openWaterTypeEditor,
  previewWorld,
  sheet,
  showToast,
  world,
  worldPreviewError,
} from '../../state';
import { trustScripts, untrustedScripts } from '../../trust';
import { Seg } from '../common';
import { Toggle } from '../components/Toggle';
import { scriptTrustText } from '../copy';
import { category, setTool } from '../defs/tools';
import { createAndUse as createIslandType, islandSwatch, requestIslandTypeEditor } from '../panels/islandTypes';
import { createAndUse as createWaterType } from '../panels/waterTypes';
import { FieldsBox } from './ContentEditor';
import { type Obj, blankItem, copyItem, editorIssues } from './fields';
import { REPO_FILTERS, type RepoRow, defaultStyleCommand, enabledCount, filterRows, repoKinds, repoRows, toggleCommand } from './repo';
import { isolationNote } from './Scripts';
import { type RepoEdit, closeRepo, fileLabel, openPackImport, openPackList, packDialog, patchRepo, repo } from './store';
import { missingCount, restyleOffer } from './styles';

// 仓库（世界 → 仓库）：浮在地图左边，不挡地图。左边按类（地名风格、生态、河流类型……），右边是这一类的内容：
// 内置的、我的、导入的、只在这个世界的。每一项一个开关“用在这个世界”（一整步，可以撤销），地名风格还有“默认”。
// 鼠标停在一项上，地图上先画出开关之后的样子（在 Worker 里的世界副本上执行同一条命令）。
// “编辑”：生态、河、湖、岛的种类打开各自的编辑器，地名风格（和以后的种类）用通用编辑器。导入、导出在角落的“⋯”里

const WHITE: [number, number, number] = [255, 255, 255];
const fmt = (n: number) => n.toLocaleString('en-US');

// 有自己编辑器的几种（编辑的是世界里的那一项）
const DEDICATED = new Set(['biome', 'riverType', 'lakeType', 'islandType']);

// 开关、“默认”之前：没信任过的脚本先问
async function runTrusted(cmd: Command, busy: string): Promise<boolean> {
  const list = await untrustedScripts(cmd);
  if (list.length) {
    await knowIsolation();
    const v = await askUser({
      title: '信任脚本',
      text: `${scriptTrustText(list.length)}${isolationNote()}`,
      scripts: list,
      choices: [
        { value: 'ok', label: '信任并启用', primary: true },
        { value: 'cancel', label: '取消' },
      ],
    });
    if (v !== 'ok') return false;
    await trustScripts(list);
  }
  return execAdjust(cmd, busy);
}

function swatchOf(row: RepoRow): string | null {
  if (row.kind.id === 'islandType') return islandSwatch(row.item as IslandType);
  const c = (row.item as { color?: unknown }).color;
  return typeof c === 'string' && c.startsWith('#') ? c : null;
}

// 卡片上的几个示例名字（地名风格）：每类地物的第一个，最多三类
const sampleCache = new WeakMap<object, string>();
function sampleLine(row: RepoRow): string {
  const it = row.item as object;
  let s = sampleCache.get(it);
  if (s === undefined) {
    try {
      s = (row.kind.samples?.(row.item, 1) ?? [])
        .slice(0, 3)
        .map((g) => g.lines[0])
        .filter(Boolean)
        .join('、');
    } catch {
      s = '';
    }
    sampleCache.set(it, s);
  }
  return s;
}

// ---------- 停一下预览 ----------

// nameOnly：只是多一种能选的风格（地图上不变）；names：地图上只有地名变（世界默认的风格换了）
type Hover = { key: string; cmd: Command; action: 'on' | 'off' | 'default'; nameOnly: boolean; names: boolean };
type Note = { key: string; text: string; warn?: boolean } | null;

const ACTION_TEXT = { on: '启用后', off: '停用后', default: '设为默认后' } as const;

function usePreview(w: World | null) {
  const [hover, setHover] = useState<Hover | null>(null);
  const [note, setNote] = useState<Note>(null);
  // 放到地图上的预览是哪条命令的（JSON，与 execAdjust 认的一样：点下去时直接采用算好的结果）
  const mine = useRef('');
  // 点下去了：预览的世界留到执行的结果换上（execAdjust 自己去掉），不先闪回原样
  const keep = useRef(false);
  const drop = () => {
    cancelWorldPreview();
    if (!keep.current && mine.current && adjustPreviewWorld.value?.key === mine.current) adjustPreviewWorld.value = null;
    keep.current = false;
    mine.current = '';
  };
  useEffect(() => {
    if (!hover || !w) {
      setNote(null);
      drop();
      return;
    }
    keep.current = false;
    const { key, cmd, action } = hover;
    let live = true;
    const t = setTimeout(async () => {
      const untrusted = await untrustedScripts(cmd);
      if (!live) return;
      if (untrusted.length) {
        setNote({ key, text: '有没信任过的脚本，启用时先问' });
        return;
      }
      if (hover.nameOnly) {
        setNote({ key, text: action === 'on' ? '启用后可在“地名”里选用' : '停用后，用它的地方按世界默认' });
        return;
      }
      setNote({ key, text: '正在计算…' });
      const r = await previewWorld(cmd);
      if (!live) return;
      if (!r) {
        const why = worldPreviewError(cmd);
        setNote({ key, text: why ? `用不上：${why}` : '预览失败', warn: !!why });
        return;
      }
      // 新加的生态长在哪里（按各自的颜色淡淡涂上），会变的格描边
      const had = new Set(w.small.species.map((s) => s.id));
      const sp = r.world.small.species;
      const isNew = sp.map((s) => !had.has(s.id));
      const byNew = new Map<number, number[]>();
      const dom = r.world.derived.dominant;
      for (let i = 0; i < dom.length; i++) {
        const s = dom[i];
        if (s >= 0 && isNew[s]) (byNew.get(s) ?? byNew.set(s, []).get(s)!).push(i);
      }
      const layers: HighlightLayer[] = [
        { cells: r.result.changedCells, color: WHITE, pattern: 'outline' },
        ...[...byNew].map(([s, cells]): HighlightLayer => ({ cells, color: hexToRgb(sp[s].color), alpha: 0.35 })),
      ];
      const cmdKey = JSON.stringify(cmd);
      adjustPreviewWorld.value = { key: cmdKey, base: r.base, world: r.world, layers };
      mine.current = cmdKey;
      let grown = 0;
      for (const c of byNew.values()) grown += c.length;
      const changed = r.result.changedCells.length;
      const text = hover.names
        ? action === 'default'
          ? '地名按这种风格重起'
          : '停用后地名按内置中文重起'
        : isNew.some(Boolean)
            ? grown
              ? `${ACTION_TEXT[action]} ${fmt(grown)} 格变成新生态`
              : '新生态在这里长不出来'
            : changed
              ? `${ACTION_TEXT[action]} ${fmt(changed)} 格会变`
              : '地图上没有变化';
      setNote({ key, text });
    }, exactDelay(300));
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [hover?.key, w]);
  // 关上仓库：去掉地图上的预览
  useEffect(() => drop, []);
  const settle = () => {
    keep.current = true;
    setHover(null);
  };
  return { hover, setHover, settle, note: note && hover && note.key === hover.key ? note : null };
}

// ---------- 一项 ----------

function Card({ row, w, onHover, onRun }: { row: RepoRow; w: World | null; onHover: (h: Hover | null) => void; onRun: () => void }) {
  const st = row.status;
  const toggle = w ? toggleCommand(row, w) : null;
  const def = w ? defaultStyleCommand(row, w) : null;
  const style = row.kind.id === 'nameStyle';
  // 点过之后鼠标移开之前不再预览（不然地图上会先画出“再点一下”的样子）
  const [armed, setArmed] = useState(true);
  // 鼠标停着的时候这一项没了（换了类、筛掉了、打开了编辑器）：移开的事件不会来，一并去掉预览
  const hovering = useRef(false);
  useEffect(
    () => () => {
      if (hovering.current) onHover(null);
    },
    [],
  );
  const hoverOf = (cmd: Command | null, action: Hover['action']): Hover | null =>
    cmd && armed ? { key: `${row.key}|${action}|${JSON.stringify(cmd)}`, cmd, action, nameOnly: style && action !== 'default' && !st.isDefault, names: style } : null;
  const run = async (cmd: Command | null, busy: string) => {
    if (!cmd) return;
    setArmed(false);
    onRun();
    await runTrusted(cmd, busy);
  };
  const swatch = swatchOf(row);
  const sample = style ? sampleLine(row) : '';
  const desc = (row.item as { description?: unknown; hint?: unknown }).description ?? (row.item as { hint?: unknown }).hint;
  const canEdit = DEDICATED.has(row.kind.id) ? st.on : row.kind.id !== 'planetForm' && row.kind.fields.length > 0;
  return (
    <div
      class={`repo-card ${st.on ? 'on' : ''}`}
      onPointerEnter={() => {
        hovering.current = true;
        onHover(hoverOf(toggle, st.on ? 'off' : 'on'));
      }}
      onPointerLeave={() => {
        hovering.current = false;
        setArmed(true);
        onHover(null);
      }}
    >
      {swatch && <span class="swatch big" style={{ background: swatch }} />}
      <div class="grow repo-card-text">
        <div>
          <b>{row.name}</b>
          <span class="hint">　{row.from}</span>
        </div>
        {typeof desc === 'string' && desc && (
          <div class="hint pack-desc one-line" title={desc}>
            {firstSentence(desc)}
          </div>
        )}
        {sample && <div class="small repo-sample">{sample}</div>}
        {!st.on && st.rename && <div class="hint">世界里已有另一份，启用后叫“{st.rename}”</div>}
        {st.locked && !st.on && <div class="hint">{st.locked}</div>}
      </div>
      <div class="repo-card-side">
        <Toggle on={st.on} disabled={!toggle} title={st.locked} onChange={() => void run(toggle, st.on ? '正在停用…' : '正在启用…')}>
          用在这个世界
        </Toggle>
        {style && (
          <label class="check" title="世界默认的地名风格" onPointerEnter={() => onHover(hoverOf(def, 'default'))} onPointerLeave={() => onHover(hoverOf(toggle, st.on ? 'off' : 'on'))}>
            <input type="radio" name="default-style" checked={!!st.isDefault} disabled={!def && !st.isDefault} onChange={() => void run(def, '正在起名…')} />
            默认
          </label>
        )}
        {canEdit && (
          <button class="small" title={row.source === 'builtin' && !st.on ? '复制一份改' : undefined} onClick={() => editRow(row)}>
            <Pencil /> 编辑
          </button>
        )}
      </div>
    </div>
  );
}

// 编辑：生态、河、湖、岛的种类打开各自的编辑器；别的用通用编辑器（内置中文、没启用的内置项复制一份改）
function editRow(row: RepoRow) {
  const wid = row.status.worldId ?? row.id;
  switch (row.kind.id) {
    case 'biome':
      focusSpecies.value = wid;
      sheet.value = 'species';
      return;
    case 'riverType':
    case 'lakeType':
      openWaterTypeEditor(row.kind.id === 'riverType' ? 'river' : 'lake', wid);
      return;
    case 'islandType':
      if (category.value !== 'terrain') setTool('island');
      requestIslandTypeEditor(wid);
      openPanel.value = 'cat:terrain';
      return;
  }
  const copy = row.status.locked || (row.source === 'builtin' && !row.status.on);
  const item = copy ? copyItem(row.kind, row.item, takenIds(row.kind)) : (structuredClone(row.item) as Obj);
  patchRepo({ edit: { item, how: copy ? 'copy' : 'edit', ...(row.status.on && !copy ? { worldId: wid } : {}) } });
}

// 新建：有自己编辑器的在那里新建，别的用登记的空样子
function newItem(kind: ContentKind) {
  switch (kind.id) {
    case 'biome':
      sheet.value = 'species';
      return;
    case 'riverType':
    case 'lakeType':
      void createWaterType(kind.id === 'riverType' ? 'river' : 'lake', null);
      return;
    case 'islandType':
      if (category.value !== 'terrain') setTool('island');
      void createIslandType(null);
      return;
  }
  const item = blankItem(kind, takenIds(kind));
  if (item) patchRepo({ edit: { item, how: 'new' } });
}

// 这一种里已用的 id（世界里的、仓库里的）：新建、复制时避开
function takenIds(kind: ContentKind): Set<string> {
  const w = world.value;
  return new Set(repoRows(kind, w, library.value).map((r) => r.id).concat(w ? kind.inWorld(w).map((x) => itemId(kind, x)) : []));
}

const canNew = (kind: ContentKind) => DEDICATED.has(kind.id) || !!kind.blank;

// ---------- 编辑器 ----------

function EditorView({ kind, edit, w }: { kind: ContentKind; edit: RepoEdit; w: World | null }) {
  const [seed, setSeed] = useState(1);
  const item = edit.item;
  const { errors, notes } = useMemo(() => editorIssues(kind, item, w), [kind, item, w]);
  const samples = useMemo(() => {
    if (errors.length || !kind.samples) return [];
    try {
      return kind.samples(kind.schema.parse(item), seed);
    } catch {
      return [];
    }
  }, [kind, item, seed, errors.length]);
  const [working, setWorking] = useState(false);
  const set = (v: Obj) => patchRepo({ edit: { ...edit, item: v } });
  const name = itemName(kind, item);
  const title = edit.how === 'new' ? `新的${kind.label}` : edit.how === 'copy' ? `${kind.label} · 副本` : `${kind.label} · ${name}`;
  const ok = !errors.length;
  const save = async () => {
    setWorking(true);
    try {
      const r = await saveItem(kind.pack.key, item);
      if (!r.ok) showToast(r.error, true);
      else showToast(r.stored ? `“${name}”已存进“我的资源”` : '存不进浏览器：只在这次打开的页面里', !r.stored);
    } finally {
      setWorking(false);
    }
  };
  const apply = async () => {
    if (!w) return;
    setWorking(true);
    try {
      const cmd = enableCommand(kind, item, w);
      if (await runTrusted(cmd, '正在计算…')) patchRepo({ edit: { ...edit, how: 'edit', worldId: itemId(kind, item) } });
    } finally {
      setWorking(false);
    }
  };
  return (
    <div class="repo-editor">
      <div class="row between">
        <h3>{title}</h3>
        <button onClick={() => patchRepo({ edit: undefined })}>返回</button>
      </div>
      <FieldsBox fields={kind.fields} value={item} onChange={set} issues={errors} />
      {errors.length > 0 && (
        <div class="box pack-problems">
          <b class="small">要改</b>
          <ul class="small">
            {errors.slice(0, 8).map((e) => (
              <li>
                {e.where ? `${e.where}：` : ''}
                {e.message}
              </li>
            ))}
            {errors.length > 8 && <li>还有 {errors.length - 8} 处…</li>}
          </ul>
        </div>
      )}
      {notes.map((n) => (
        <p class="hint warn">{n}</p>
      ))}
      {samples.length > 0 && (
        <section class="ed-samples">
          <div class="row between">
            <h5>示例</h5>
            <button class="small" onClick={() => setSeed(seed + 1)}>
              换一批
            </button>
          </div>
          {samples.map((g) => (
            <div class="ed-sample">
              <span class="hint">{g.label}</span>
              <span>{g.lines.join('、')}</span>
            </div>
          ))}
        </section>
      )}
      <div class="row between repo-editor-foot">
        <button disabled={!ok} onClick={() => patchRepo({ edit: { item: copyItem(kind, item, takenIds(kind)), how: 'copy' } })}>
          复制
        </button>
        <span class="row">
          <button disabled={!ok || working} onClick={() => void save()} title="存进“我的资源”">
            存进仓库
          </button>
          <button class="primary" disabled={!ok || working || !w} onClick={() => void apply()} title={edit.worldId ? '换掉世界里的这一项' : '启用这一项'}>
            用到世界
          </button>
        </span>
      </div>
    </div>
  );
}

// ---------- 角落的“⋯” ----------

function importFile(file: File) {
  if (file.size > 3 * PACK_MAX_CHARS) {
    openPackImport({ ok: false, errors: [`文件太大（${Math.round(file.size / 1e6)} MB），不是资源包`] }, file.name);
    return;
  }
  void file.text().then((text) => openPackImport(readPack(text, fileLabel(file.name)), file.name));
}

function CornerMenu({ w }: { w: World | null }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', off, true);
    return () => window.removeEventListener('pointerdown', off, true);
  }, [open]);
  return (
    <div class="repo-corner" ref={box}>
      <button class={`icon-btn ${open ? 'open' : ''}`} title="导入、导出" onClick={() => setOpen(!open)}>
        <Ellipsis />
      </button>
      {open && (
        <div class="repo-menu menu">
          <label class="item file-item">
            <span class="grow">导入文件…</span>
            <input
              type="file"
              accept=".json,application/json"
              onChange={(ev) => {
                const f = (ev.target as HTMLInputElement).files?.[0];
                if (f) importFile(f);
                (ev.target as HTMLInputElement).value = '';
                setOpen(false);
              }}
            />
          </label>
          <button
            class="item"
            disabled={!w}
            onClick={() => {
              setOpen(false);
              packDialog.value = { view: 'export' };
            }}
          >
            <span class="grow">从世界存进仓库…</span>
          </button>
          <button
            class="item"
            onClick={() => {
              setOpen(false);
              openPackList();
            }}
          >
            <span class="grow">资源包…</span>
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- 整个仓库 ----------

export function RepoPanel() {
  const st = repo.value;
  const w = world.value;
  const lib = library.value;
  const preview = usePreview(st && !st.edit ? w : null);
  const kinds = repoKinds();
  const kind = (st && kindOf(st.kind)) || kinds[0];
  const rows = useMemo(() => (st ? repoRows(kind, w, lib) : []), [kind, w, lib, !!st]);
  if (!st) return null;
  const shown = filterRows(rows, st.filter, st.query, st.entry);
  const entryName = st.entry ? lib.find((e) => e.key === st.entry)?.pack.name : undefined;
  const style = kind.id === 'nameStyle';
  const missing = style && w ? missingCount(w.small) : 0;
  const restyle = style && w ? restyleOffer(w) : null;
  return (
    <div class="repo">
      <div class="popover-head">
        <b>仓库</b>
        <span class="row">
          <CornerMenu w={w} />
          <button class="icon-btn" onClick={closeRepo} title="关闭">
            <X />
          </button>
        </span>
      </div>
      <div class="repo-body">
        <nav class="repo-kinds">
          {kinds.map((k) => (
            <button class={`item ${k.id === kind.id ? 'on' : ''}`} onClick={() => patchRepo({ kind: k.id, edit: undefined })}>
              <span class="grow">{k.label}</span>
              {w && <span class="hint">{enabledCount(k, w)}</span>}
            </button>
          ))}
        </nav>
        <div class="repo-main">
          {st.edit ? (
            <EditorView key={st.kind} kind={kind} edit={st.edit} w={w} />
          ) : (
            <>
              <div class="repo-tools">
                <Seg value={st.filter} options={REPO_FILTERS} onChange={(filter) => patchRepo({ filter })} wide />
                <div class="row">
                  <input class="grow" type="search" placeholder="搜索" value={st.query} onInput={(e) => patchRepo({ query: (e.target as HTMLInputElement).value })} />
                  {canNew(kind) && (
                    <button onClick={() => newItem(kind)} title={`新建${kind.label}`}>
                      <Plus /> 新建
                    </button>
                  )}
                </div>
                {st.entry && (
                  <span class="chip static">
                    只看“{entryName ?? st.entry}”
                    <button class="small icon ghost" title="看全部" onClick={() => patchRepo({ entry: undefined })}>
                      <X />
                    </button>
                  </span>
                )}
                {kind.pack.note && <p class="hint">{kind.pack.note}</p>}
                {missing > 0 && <p class="hint warn">{missing} 处用的风格已停用，按世界默认起名</p>}
              </div>
              <div class="repo-list">
                {shown.map((r) => (
                  <Card key={r.key} row={r} w={w} onHover={preview.setHover} onRun={preview.settle} />
                ))}
                {!shown.length && <p class="hint">没有内容</p>}
              </div>
              {restyle && (
                <div class="row between repo-restyle">
                  <span class="hint">换了默认，已有的省名不变</span>
                  <button class="small" title="锁定的、自己选了风格的不动" onClick={() => void exec(restyle, '正在起名…')}>
                    重起省名
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {!st.edit && (
        <div class="repo-foot">
          {preview.note ? <p class={`small ${preview.note.warn ? 'warn' : ''}`}>{preview.note.text}</p> : <p class="hint">可以撤销</p>}
        </div>
      )}
    </div>
  );
}

// 卡片上只放说明的第一句（一行，放不下省略），全文在悬停里
export function firstSentence(s: string): string {
  const k = s.indexOf('。');
  return k > 0 ? s.slice(0, k) : s;
}
