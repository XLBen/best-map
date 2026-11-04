import { ChevronRight, Copy, Download, LocateFixed, Lock, Pencil, RotateCcw, Save, Trash2 } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { itemName, kindOf } from '../../../core/content/registry';
import type { Era } from '../../../core/human';
import { askUser } from '../../state';
import { focusOn } from '../camera';
import { EditorKind, FieldsBox } from './ContentEditor';
import { DEDICATED, restoreCommand } from './edit';
import { type Obj, editorIssues } from './fields';
import { commitItem, copyItemIn, deleteFromLibrary } from './page-actions';
import { type Segment, initialOpen, segmentBrief } from './page-segments';
import { type ItemAction, type ItemPage, type PageCtx, type Route, type SourceRef, itemActions, itemPage, refRoute, rowsOf } from './pages';
import { copyToMine, goBack, goTo, openSegments, rememberSegments, replaceTop } from './panel-store';
import { ChildSegments, WorldVariables } from './PageChildren';
import { BiomeWaterSegment, WaterBiomesSegment } from './PageWater';
import { RefGo } from './RefPicker';
import { refLabel, refOptionsOf } from './refs';
import { type RepoRow, addCommand, defaultStyleCommand, removeCommand, rowUsage, saveableItem } from './repo';
import { exportRow, fmt, openDedicated, runTrusted, sampleLine, saveRow, swatchOf } from './repo-actions';

// 一项的页面（第五十九轮）：几段可折叠的卡片，收起时标题旁写一句当前内容；表单是 ContentEditor 的 FieldsBox。
// 松开滑块、打完字（框失去焦点、回车）就存：本世界是一条命令，我的库走自己的撤销；有错的留在页面上、不存。只读的库整个表单不能动，引用照样能点过去

function Actions({ p, row, src, ctx, embedded }: { p: ItemPage; row: RepoRow | undefined; src: SourceRef; ctx: PageCtx; embedded: boolean }) {
  const w = ctx.world;
  const usage = row && w && src.t === 'world' ? rowUsage(row, w) : null;
  const remove = row && w && src.t === 'world' ? removeCommand(row, w) : null;
  const restore = w && src.t === 'world' && row?.status.modified ? restoreCommand(p.kind, p.id, w) : null;
  const def = row && w && p.kind.id === 'nameStyle' ? defaultStyleCommand(row, w) : null;
  const list = itemActions(src, row, ctx, {
    remove: !!remove,
    usage: usage ? `有 ${fmt(usage.count)} 处在用：${usage.label}` : null,
    restore: !!restore,
    setDefault: !!def,
    hasCells: !!usage?.cells?.length,
    saveable: !!row && src.t === 'world' && !row.path && saveableItem(row) !== null,
    dedicated: DEDICATED.has(p.kind.id),
    newable: !!p.kind.blank,
  });
  const button = (a: ItemAction) => {
    const dis = a.disabled;
    const common = { disabled: !!dis, title: dis };
    switch (a.id) {
      case 'copyLibrary':
        return (
          <button class="small primary" onClick={() => void copyToMine(src)}>
            <Copy /> 复制成我的库
          </button>
        );
      case 'addToWorld':
        return (
          <button
            class="small"
            {...common}
            onClick={() => {
              const cmd = row && w ? addCommand(row, w) : null;
              if (cmd) void runTrusted(cmd, '正在添加…');
            }}
          >
            添加到本世界
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
      case 'restore':
        return (
          <button class="small" title="换回内置的原样" onClick={() => restore && void runTrusted(restore, '正在计算…')}>
            <RotateCcw /> 恢复内置
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
          <button class="small" title="别的世界也能用" onClick={() => row && void saveRow(row)}>
            <Save /> 存进资源库
          </button>
        );
      case 'exportItem':
        return (
          <button class="small" title="单独这一项导出成文件" onClick={() => row && exportRow(row)}>
            <Download /> 导出文件
          </button>
        );
      case 'copyItem':
        return (
          <button
            class="small"
            title="另起一项"
            onClick={() =>
              void Promise.resolve(copyItemIn(src, p.kind, p.item, ctx)).then((r) => {
                if (r) (embedded ? goTo : replaceTop)(r);
              })
            }
          >
            <Copy /> 复制
          </button>
        );
      case 'removeFromWorld':
        return (
          <span title={dis}>
            <button class="small" {...common} onClick={() => remove && void runTrusted(remove, '正在移出…').then((ok) => ok && !embedded && goBack())}>
              <Trash2 /> 移出本世界
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
              if (v === 'delete' && deleteFromLibrary(src, p.kind, p.id, p.name) && !embedded) goBack();
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

// embedded：在上级页面里展开着改（第六十轮）：不写名字（上面那一行就是），删了不返回
export function PageItem({ route, src, ctx, embedded = false }: { route: Extract<Route, { p: 'item' }>; src: SourceRef; ctx: PageCtx; embedded?: boolean }) {
  const p = itemPage(src, route, ctx);
  const kindId = route.kind;
  // 改了没存的（有错、或者世界还在算）。这一份里的这一项变了（存上了、撤销了、别处改了）就去掉
  const [draft, setDraft] = useState<Obj | null>(null);
  const live = p?.item;
  // 世界里连着改几项时前一步算完不去掉草稿（不然后一步改的先闪回去）
  const pending = useRef(0);
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
  if (!p || !item) return null;
  const toggle = (id: string) => {
    const next = new Set(open);
    if (!next.delete(id)) next.add(id);
    setOpen(next);
    rememberSegments(kindId, next);
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
    return to ? () => goTo(to) : null;
  };
  const swatch = row ? swatchOf(row) : typeof item.color === 'string' ? item.color : null;
  const sample = p.kind.id === 'nameStyle' && row ? sampleLine(row) : '';
  const segment = (s: Segment) => (
    <SegmentCard key={s.id} seg={s} open={open.has(s.id)} onToggle={() => toggle(s.id)} brief={segmentBrief(s, item, labelOf)}>
      {s.hint && <p class="hint">{s.hint}</p>}
      {s.custom === 'biomeWater' && <BiomeWaterSegment src={src} ctx={ctx} sp={item as never} />}
      {s.custom === 'samples' && <Samples item={item} kindId={p.kind.id} />}
      {s.custom === 'eraDims' && src.t === 'world' ? (
        <WorldVariables era={item as unknown as Era} ctx={ctx} />
      ) : s.custom === 'waterBiomes' ? (
        <>
          <FieldsBox fields={s.fields.filter((f) => f.key === 'natural')} scope={p.kind.fields} value={item} onChange={save} issues={issues.errors} />
          <WaterBiomesSegment src={src} ctx={ctx} kindId={p.kind.id} type={item as never} />
          <FieldsBox fields={s.fields.filter((f) => f.key === 'when')} scope={p.kind.fields} value={item} onChange={save} issues={issues.errors} />
        </>
      ) : (
        s.custom !== 'biomeWater' && s.fields.length > 0 && <FieldsBox fields={s.fields} scope={p.kind.fields} value={item} onChange={save} issues={issues.errors} />
      )}
    </SegmentCard>
  );
  return (
    <div class={`lp-item ${embedded ? 'embedded' : ''}`}>
      {!embedded && (
        <>
          <div class="row lp-item-head">
            {swatch && <span class="swatch big" style={{ background: swatch }} />}
            <h3 class="grow ellipsis">{itemName(p.kind, item)}</h3>
            {row?.status.modified && <span class="chip static">改过</span>}
            {row?.status.isDefault && <span class="chip static">{p.kind.id === 'mapStyle' ? '在用' : '默认'}</span>}
          </div>
          <p class="hint">
            {p.kind.label}
            {p.partOf.length > 0 && ' · 在 '}
            {p.partOf.slice(0, 4).map((x, k) => (
              <>
                {k > 0 && '、'}
                <a class="ref-link" onClick={() => goTo({ p: 'item', kind: x.kind, id: x.id })}>
                  {x.name}
                </a>
              </>
            ))}
            {p.partOf.length > 4 && ` 等 ${p.partOf.length} 个`}
          </p>
        </>
      )}
      {sample && <p class="small repo-sample">{sample}</p>}
      {p.readonly && !embedded && (
        <div class="lp-readonly">
          <Lock />
          <span class="grow">{p.readonly}</span>
          {p.canCopyLibrary && (
            <button class="small primary" onClick={() => void copyToMine(src)}>
              复制成我的库
            </button>
          )}
        </div>
      )}
      {p.note && <p class="hint">{p.note}</p>}
      <EditorKind.Provider value={p.kind.id}>
        <RefGo.Provider value={go}>
          <fieldset class="lp-fields" disabled={!!p.readonly}>
            {segs.slice(0, 1).map(segment)}
          </fieldset>
          {/* 下面的几段在第一段后面，不在只读的 fieldset 里：内置的库里也能点开看 */}
          <ChildSegments list={p.children} parent={item} parentKind={p.kind.id} src={src} ctx={ctx} />
          {segs.length > 1 && (
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
      <Actions p={p} row={row} src={src} ctx={ctx} embedded={embedded} />
    </div>
  );
}

function SegmentCard({ seg, open, onToggle, brief, children }: { seg: Segment; open: boolean; onToggle: () => void; brief: string; children: ComponentChildren }) {
  return (
    <section class={`lp-seg ${open ? 'open' : ''}`}>
      <div class="lp-seg-head" role="button" tabIndex={0} onClick={onToggle} onKeyDown={(e) => e.key === 'Enter' && onToggle()}>
        <ChevronRight class="lp-seg-twist" />
        <b>{seg.title}</b>
        {!open && brief && <span class="lp-seg-brief ellipsis">{brief}</span>}
      </div>
      {open && <div class="lp-seg-body">{children}</div>}
    </section>
  );
}
