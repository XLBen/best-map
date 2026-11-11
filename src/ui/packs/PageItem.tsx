import { ChevronRight, Copy, Download, LocateFixed, Pencil, RotateCcw, Save, Trash2 } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { itemName, kindOf } from '../../../core/content/registry';
import type { Era } from '../../../core/human';
import { askUser } from '../../state';
import { focusOn } from '../camera';
import { EditorKind, FieldsBox } from './ContentEditor';
import { EraPatterns, PatternTip } from './EraPatterns';
import { type Obj, editorIssues } from './fields';
import { commitItem, copyItemIn, deleteFromLibrary, saveBackToLibrary, useSourceVersion } from './page-actions';
import { type Segment, initialOpen, segmentBrief } from './page-segments';
import type { UsedBy } from './page-used-by';
import { type ItemAction, type ItemPage, type PageCtx, type Route, type SourceRef, itemActions, itemPage, refRoute, rowsOf, sourceKind } from './pages';
import { closeSide, copyToMine, goBack, goTo, openRoute, openSegments, rememberSegments, replaceTop } from './panel-store';
import { DELETE, DELETE_WORLD_TIP, EXPORT_FILE, SAVE_BACK_TIP, SAVE_TO_MINE, SAVE_TO_MINE_TIP } from './copy';
import { TimingMark } from './TimingMark';
import { OnMapLine } from './OnMapLine';
import { FlagSamples, LandmarkNameSamples, TitleReplace } from './ItemPreviews';
import { TitleHelpCtx } from './editors';
import { titleHelpOf } from './title-help';
import { type SegmentTiming, segmentTiming, timingLine } from './timing';
import { oneMark } from './page-marks';
import { PickBox } from './PickBox';
import { kindPickable, lookOf, shownPick } from './pick-view';
import { ChildSegments, WorldVariables } from './PageChildren';
import { WaterBiomesSegment } from './PageEcology';
import { BiomeEditor } from '../ecology/BiomeEditor';
import { RefGo } from './RefPicker';
import { refLabel, refOptionsOf } from './refs';
import { exportRow, openDedicated, runTrusted, sampleLine, saveRow, swatchOf } from './row-actions';
import { DEDICATED, type ItemRow, defaultStyleCommand, removeCommand, rowUsage, saveableItem } from './rows';

// 一项的页面（第五十九轮）：几段可折叠的卡片，收起时标题旁写一句当前内容；表单是 ContentEditor 的 FieldsBox。
// 松开滑块、打完字（框失去焦点、回车）就存：本世界是一条命令，我的库走自己的撤销；有错的留在页面上、不存。只读的库整个表单不能动，引用照样能点过去

// onMap：页面顶上有“在地图上”一行（第九十轮）：定位在那一行上，这里不再放一个
function Actions({ p, row, src, ctx, embedded, side, onMap }: { p: ItemPage; row: ItemRow | undefined; src: SourceRef; ctx: PageCtx; embedded: boolean; side: boolean; onMap: boolean }) {
  // 右栏里：删了收起右栏，复制出来的在右栏打开
  const back = side ? closeSide : goBack;
  const replace = side ? openRoute : replaceTop;
  const w = ctx.world;
  const usage = row && w && src.t === 'world' ? rowUsage(row, w) : null;
  const remove = row && w && src.t === 'world' ? removeCommand(row, w) : null;
  const def = row && w && p.kind.id === 'nameStyle' ? defaultStyleCommand(row, w) : null;
  const list = itemActions(src, row, ctx, {
    remove: !!remove,
    usage: usage ? `有 ${usage.count.toLocaleString('en-US')} 处在用：${usage.label}` : null,
    changed: p.diff.t === 'changed',
    setDefault: !!def,
    hasCells: !!usage?.cells?.length,
    saveable: !!row && src.t === 'world' && !row.path && saveableItem(row) !== null,
    dedicated: DEDICATED.has(p.kind.id),
    newable: !!p.kind.blank,
    // 第八十一轮：整个库复制成我的库在右上角的“⋯”里，一项的页面上不放（只读的库顶上一行是“在本世界打开 / 添加到本世界…”）
  }).filter((a) => a.id !== 'copyLibrary' && !(onMap && a.id === 'locate') && !(p.kind.id === 'biome' && src.t === 'world' && (a.id === 'copyItem' || a.id === 'removeFromWorld')));
  const button = (a: ItemAction) => {
    const dis = a.disabled;
    switch (a.id) {
      case 'copyLibrary':
        return (
          <button class="small primary" onClick={() => void copyToMine(src)}>
            <Copy /> 复制成我的库
          </button>
        );
      case 'setDefault':
        return (
          <button class="small" onClick={() => def && void runTrusted(def, '正在起名…')}>
            设为默认
          </button>
        );
      case 'locate':
        return (
          <button class="small" onClick={() => usage?.cells && focusOn(usage.cells)}>
            <LocateFixed /> 定位
          </button>
        );
      case 'useSource':
        return (
          <button class="small" title={`换成“${p.diffLib}”里的这一项`} onClick={() => void useSourceVersion(p.kind, p.id, ctx)}>
            <RotateCcw /> 用库里的版本
          </button>
        );
      case 'saveBack':
        return (
          <button class="small" title={SAVE_BACK_TIP(p.diffLib ?? '')} onClick={() => void saveBackToLibrary(p.kind, p.id, ctx)}>
            <Save /> {SAVE_TO_MINE}
          </button>
        );
      case 'dedicated':
        return (
          <button class="small" title="图表、滑块和脚本检查" onClick={() => row && openDedicated(row)}>
            <Pencil /> 详细编辑
          </button>
        );
      case 'saveToMine':
        return (
          <button class="small" title={SAVE_TO_MINE_TIP} onClick={() => row && void saveRow(row)}>
            <Save /> {SAVE_TO_MINE}
          </button>
        );
      case 'exportItem':
        return (
          <button class="small" title="单独这一项导出成文件" onClick={() => row && exportRow(row)}>
            <Download /> {EXPORT_FILE}
          </button>
        );
      case 'copyItem':
        return (
          <button
            class="small"
            title="另起一项"
            onClick={() =>
              void Promise.resolve(copyItemIn(src, p.kind, p.item, ctx)).then((r) => {
                if (r) (embedded ? openRoute : replace)(r);
              })
            }
          >
            <Copy /> 复制
          </button>
        );
      case 'removeFromWorld':
        return (
          <span title={dis}>
            <button class="small" disabled={!!dis} title={dis ?? DELETE_WORLD_TIP} onClick={() => remove && void runTrusted(remove, '正在删除…').then((ok) => ok && !embedded && back())}>
              <Trash2 /> {DELETE}
            </button>
          </span>
        );
      case 'deleteItem':
        return (
          <button
            class="small danger"
            onClick={async () => {
              const v = await askUser({
                title: `删除“${p.name}”`,
                text: '可以撤销。别的内容写到它的地方不会跟着改。',
                choices: [
                  { value: 'delete', label: '删除', primary: true },
                  { value: 'cancel', label: '取消' },
                ],
              });
              if (v === 'delete' && deleteFromLibrary(src, p.kind, p.id, p.name) && !embedded) back();
            }}
          >
            <Trash2 /> 删除
          </button>
        );
    }
  };
  return <div class="row wrap lp-item-actions">{list.map(button)}</div>;
}

function Samples({ item, kindId }: { item: Obj; kindId: string }) {
  const kind = kindOf(kindId);
  const [seed, setSeed] = useState(1);
  const groups = useMemo(() => {
    if (!kind?.samples) return [];
    try {
      return kind.samples(kind.schema.parse(item), seed);
    } catch {
      return [];
    }
  }, [kind, item, seed]);
  if (!groups.length) return <p class="hint">没有示例</p>;
  return (
    <section class="ed-samples">
      {groups.map((g) => (
        <div class="ed-sample">
          <span class="hint">{g.label}</span>
          <span>{g.lines.join('、')}</span>
        </div>
      ))}
      <button class="small" onClick={() => setSeed(seed + 1)}>
        换一批
      </button>
    </section>
  );
}

// embedded：在上级页面里展开着改（第六十轮）：不写名字（上面那一行就是），删了不返回。
// side：在右栏打开的（第六十七轮，能勾的库）：名字前面有勾；删了收起右栏
export function PageItem({ route, src, ctx, embedded = false, side = false }: { route: Extract<Route, { p: 'item' }>; src: SourceRef; ctx: PageCtx; embedded?: boolean; side?: boolean }) {
  const p = itemPage(src, route, ctx);
  const kindId = route.kind;
  // 改了没存的（有错、或者世界还在算）。这一份里的这一项变了（存上了、撤销了、别处改了）就去掉
  const [draft, setDraft] = useState<Obj | null>(null);
  const live = p?.item;
  // 世界里连着改几项时前一步算完不去掉草稿（不然后一步改的先闪回去）
  const pending = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pending.current) setDraft(null);
  }, [live]);
  const segs = p?.segments ?? [];
  const [open, setOpen] = useState<ReadonlySet<string>>(() => (route.seg ? initialOpen(segs, route.seg) : (openSegments(kindId) ?? initialOpen(segs))));
  useEffect(() => {
    if (route.seg) setOpen(new Set([...open, route.seg]));
  }, [route.seg]);
  const item = (draft ?? live) as Obj | undefined;
  const issues = useMemo(() => (item && p ? editorIssues(p.kind, item, ctx.world) : { errors: [], notes: [] }), [p?.kind, item, ctx.world]);
  const row = useMemo(() => (p ? rowsOf(src, p.kind, ctx).find((r) => r.id === p.id) : undefined), [p?.kind, p?.id, live, ctx.world, ctx.lib, src.t]);
  // 第九十一轮：政体的称号旁的示例、“谁盖过它”
  const titleHelp = useMemo(() => (p?.kind.id === 'government' && item ? titleHelpOf(item, src, ctx) : null), [p?.kind.id, item, src.t, ctx.world, ctx.lib]);
  if (!p || !item) return null;
  const toggle = (id: string) => {
    const next = new Set(open);
    if (!next.delete(id)) next.add(id);
    setOpen(next);
    rememberSegments(kindId, next);
  };
  // “在地图上”那一行的按钮要看某一段（“还没选生态 · 去选”）：展开它，滚到那里
  const showSegment = (id: string) => {
    const next = new Set([...open, id]);
    setOpen(next);
    rememberSegments(kindId, next);
    requestAnimationFrame(() => root.current?.querySelector(`[data-seg="${id}"]`)?.scrollIntoView({ block: 'nearest' }));
  };
  const save = (next: Obj) => {
    if (p.readonly) return;
    setDraft(next);
    const r = commitItem(src, p.kind, p.id, next, ctx);
    if (r === 'same' || r === 'readonly' || r === 'failed') setDraft(null);
    if (r instanceof Promise) {
      pending.current++;
      void r.then((v) => {
        pending.current--;
        if (v === 'failed' || !pending.current) setDraft(null);
      });
    }
  };
  const labelOf = (ref: string | readonly string[], id: string) => refLabel(refOptionsOf(ref, ctx), id);
  const go = (ref: string | readonly string[], id: string) => {
    const to = refRoute(ref, id, src, ctx);
    return to ? () => openRoute(to) : null;
  };
  const v = !embedded ? shownPick(src, ctx) : null;
  const pick = v && kindPickable(v, p.kind.id) ? v : null;
  const note = pick ? lookOf(pick, { kind: p.kind.id, id: p.id }).note : null;
  const swatch = row ? swatchOf(row) : typeof item.color === 'string' ? item.color : null;
  const sample = p.kind.id === 'nameStyle' && row ? sampleLine(row) : '';
  const biome = p.kind.id === 'biome';
  const mark = oneMark({ isDefault: row?.status.isDefault, inUse: p.kind.id === 'mapStyle', changed: p.diff.t === 'changed', modified: src.t === 'lib' && row?.status.modified });
  // 第九十轮：每一段标改了什么时候用上（timing.ts）；只读的不标
  const source = p.readonly ? null : sourceKind(src, ctx);
  // 页面顶上的“在地图上”一行：只在看本世界、不是在上级页面里展开着时
  const onMap = src.t === 'world' && !embedded;
  const segment = (s: Segment) => {
    const timing = segmentTiming(source, p.kind, s);
    const line = timing && timingLine(timing);
    return (
      <SegmentCard key={s.id} seg={s} open={open.has(s.id)} onToggle={() => toggle(s.id)} brief={segmentBrief(s, item, labelOf)} timing={timing}>
        {line && <p class="hint lp-timing-line">{line}</p>}
        {s.hint && <p class="hint">{s.hint}</p>}
        {s.custom === 'samples' && <Samples item={item} kindId={p.kind.id} />}
        {s.custom === 'eraDims' && src.t === 'world' ? (
          <WorldVariables era={item as unknown as Era} ctx={ctx} />
        ) : s.custom === 'eraPatterns' ? (
          <>
            <FieldsBox fields={s.fields.filter((f) => f.key !== 'patterns' && f.key !== 'nationalism')} scope={p.kind.fields} value={item} onChange={save} issues={issues.errors} />
            <EraPatterns era={item} src={src} ctx={ctx} onChange={save} />
          </>
        ) : s.custom === 'patternTip' ? (
          <>
            <FieldsBox fields={s.fields} scope={p.kind.fields} value={item} onChange={save} issues={issues.errors} />
            <PatternTip item={item} />
          </>
        ) : s.custom === 'waterBiomes' ? (
          <>
            <FieldsBox fields={s.fields.filter((f) => f.key === 'natural')} scope={p.kind.fields} value={item} onChange={save} issues={issues.errors} />
            <WaterBiomesSegment src={src} ctx={ctx} kindId={p.kind.id} type={item as never} />
            <FieldsBox fields={s.fields.filter((f) => f.key === 'when')} scope={p.kind.fields} value={item} onChange={save} issues={issues.errors} />
          </>
        ) : p.kind.id === 'government' && s.id === 'titles' ? (
          // 第九十一轮：每行称号下面的示例、哪几条换说法盖过它（title-help.ts）
          <TitleHelpCtx.Provider value={titleHelp}>
            <FieldsBox fields={s.fields} scope={p.kind.fields} value={item} onChange={save} issues={issues.errors} />
          </TitleHelpCtx.Provider>
        ) : (
          s.fields.length > 0 && <FieldsBox fields={s.fields} scope={p.kind.fields} value={item} onChange={save} issues={issues.errors} />
        )}
        {p.kind.id === 'government' && s.id === 'titles' && !p.readonly && <TitleReplace src={src} ctx={ctx} />}
        {/* 第九十轮：表单旁的小预览（previews.ts） */}
        {p.kind.id === 'landmarkType' && s.id === 'label' && <LandmarkNameSamples item={item} src={src} ctx={ctx} />}
        {p.kind.id === 'government' && s.id === 'flag' && <FlagSamples item={item} />}
      </SegmentCard>
    );
  };
  return (
    <div class={`lp-item ${embedded ? 'embedded' : ''}`} ref={root}>
      {!embedded && (
        <>
          <div class="row lp-item-head">
            {pick && <PickBox v={pick} r={{ kind: p.kind.id, id: p.id }} ctx={ctx} />}
            {swatch && <span class="swatch big" style={{ background: swatch }} />}
            <h3 class="grow ellipsis">{itemName(p.kind, item)}</h3>
            {mark && <span class={`chip static ${mark.diff ? 'lp-diff-chip' : ''}`}>{mark.text}</span>}
          </div>
          <p class="hint">
            {p.kind.label}
            {note && ` · ${note}`}
          </p>
        </>
      )}
      {onMap && <OnMapLine kind={p.kind} id={p.id} item={live} ctx={ctx} onSegment={showSegment} />}
      <DiffLine p={p} />
      {sample && <p class="small lp-sample">{sample}</p>}
      <EditorKind.Provider value={p.kind.id}>
        <RefGo.Provider value={go}>
          {/* 第七十二轮：生态是自己的编辑器（气候图、滑块、脚本框），不按字段表画 */}
          {biome ? (
            <BiomeEditor sp={item as never} src={src} ctx={ctx} onSelect={(id) => (side ? openRoute : replaceTop)({ p: 'item', kind: 'biome', id })} />
          ) : (
            <fieldset class="lp-fields" disabled={!!p.readonly}>
              {segs.slice(0, 1).map(segment)}
            </fieldset>
          )}
          {/* 下面的几段在第一段后面，不在只读的 fieldset 里：内置的库里也能点开看 */}
          <ChildSegments list={p.children} parent={item} parentKind={p.kind.id} src={src} ctx={ctx} Item={PageItem} />
          {!biome && segs.length > 1 && (
            <fieldset class="lp-fields" disabled={!!p.readonly}>
              {segs.slice(1).map(segment)}
            </fieldset>
          )}
        </RefGo.Provider>
      </EditorKind.Provider>
      {issues.errors.length > 0 && (
        <div class="box pack-problems">
          <b class="small">要改（改好才会存）</b>
          <ul class="small">
            {issues.errors.slice(0, 8).map((e) => (
              <li>
                {e.where ? `${e.where}：` : ''}
                {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {issues.notes.map((n) => (
        <p class="hint warn">{n}</p>
      ))}
      {p.related.map((r) => (
        <button class="lp-related" onClick={() => goTo(r.route)}>
          <span class="grow">{r.label}</span>
          <span class="lp-count">{r.count}</span>
          <ChevronRight />
        </button>
      ))}
      <UsedBySegment u={p.usedBy} kindId={kindId} />
      <Actions p={p} row={row} src={src} ctx={ctx} embedded={embedded} side={side} onMap={onMap} />
    </div>
  );
}

// 和来源的库差在哪里（第六十二轮）。导入时去掉了这个世界没有的引用的不算不同，写一句
function DiffLine({ p }: { p: ItemPage }) {
  const d = p.diff;
  if (d.t === 'changed') return <p class="hint">和“{p.diffLib}”不同{d.fields.length ? `：${d.fields.slice(0, 4).join('、')}` : ''}</p>;
  if (d.t === 'trimmed') {
    return (
      <p class="hint">
        和“{p.diffLib}”一样，这个世界没有的没带：{d.gone.slice(0, 4).join('、')}
        {d.gone.length > 4 ? ' 等' : ''}
      </p>
    );
  }
  return null;
}

// 编辑页底部的“谁用到它”：引用它的内容能点过去，地图上用到的地方写一句
const USED_SHOW = 12;
function UsedByNames({ rows }: { rows: readonly { kind: string; id: string; name: string }[] }) {
  const [more, setMore] = useState(false);
  const shown = more ? rows : rows.slice(0, USED_SHOW);
  return (
    <span class="lp-used-names">
      {shown.map((x, k) => (
        <>
          {k > 0 && '、'}
          <a class="ref-link" onClick={() => openRoute({ p: 'item', kind: x.kind, id: x.id })}>
            {x.name}
          </a>
        </>
      ))}
      {!more && rows.length > USED_SHOW && (
        <>
          {' '}
          <a class="ref-link" onClick={() => setMore(true)}>
            还有 {rows.length - USED_SHOW} 个
          </a>
        </>
      )}
    </span>
  );
}

const USED_SEG = { id: 'usedBy', title: '谁用到它', fields: [] } as unknown as Segment;

function UsedBySegment({ u, kindId }: { u: UsedBy; kindId: string }) {
  const memoKey = `${kindId}:usedBy`;
  const [open, setOpen] = useState(() => openSegments(memoKey)?.has('open') ?? false);
  const toggle = () => {
    setOpen(!open);
    rememberSegments(memoKey, new Set(open ? [] : ['open']));
  };
  return (
    <SegmentCard seg={USED_SEG} open={open} onToggle={toggle} brief={u.brief}>
      {u.empty && <p class="hint">没有内容引用它，地图上也没用到</p>}
      {u.parents.length > 0 && (
        <div class="arch-line">
          <span class="hint lp-used-kind">在</span>
          <UsedByNames rows={u.parents} />
        </div>
      )}
      {u.groups.map((g) => (
        <div class="arch-line" key={g.kind}>
          <span class="hint lp-used-kind">
            {g.title} {g.rows.length}
          </span>
          <UsedByNames rows={g.rows} />
        </div>
      ))}
      {u.places && (
        <div class="arch-line">
          <span class="hint lp-used-kind">地图</span>
          <span>{u.places}</span>
        </div>
      )}
    </SegmentCard>
  );
}

function SegmentCard({ seg, open, onToggle, brief, children, timing }: { seg: Segment; open: boolean; onToggle: () => void; brief: string; children: ComponentChildren; timing?: SegmentTiming | null }) {
  return (
    <section class={`lp-seg ${open ? 'open' : ''}`} data-seg={seg.id}>
      <div class="lp-seg-head" role="button" tabIndex={0} onClick={onToggle} onKeyDown={(e) => e.key === 'Enter' && onToggle()}>
        <ChevronRight class="lp-seg-twist" />
        <b>{seg.title}</b>
        {timing && <TimingMark t={timing.timing} />}
        {!open && brief && <span class="lp-seg-brief ellipsis">{brief}</span>}
      </div>
      {open && <div class="lp-seg-body">{children}</div>}
    </section>
  );
}

