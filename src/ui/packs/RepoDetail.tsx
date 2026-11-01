import { Download, LocateFixed, Pencil, RotateCcw, Save, Trash2 } from 'lucide-preact';
import { useMemo, useState } from 'preact/hooks';
import type { Command } from '../../../core/commands';
import { type ContentKind, itemName } from '../../../core/content/registry';
import type { World } from '../../../core/world';
import { saveItem } from '../../library';
import { exec, openPanel, showToast } from '../../state';
import { focusOn } from '../camera';
import { setCategory } from '../defs/tools';
import { EditorKind, FieldsBox } from './ContentEditor';
import { DEDICATED, applyEdit, isDirty, restoreCommand } from './edit';
import { type Obj, copyItem, editorIssues } from './fields';
import { GOV_KINDS, HUMAN_KINDS, type RepoRow, SETTLE_KINDS, SOURCE_LABEL, addCommand, canDeleteFromLibrary, defaultStyleCommand, removeCommand, rowUsage, saveableItem } from './repo';
import { deleteRow, descOf, exportRow, fmt, openDedicated, runTrusted, sampleLine, saveRow, swatchOf, takenIds } from './repo-actions';
import { hoverOf } from './RepoList';
import type { Hover } from './RepoPreview';
import { type RepoEdit, closeRepo, patchRepo } from './store';
import { restyleOffer } from './styles';

// 资源库的右栏（第四十五轮）：左栏选中的一项的详情（说明、示例、在用的地方、几个按钮）和它的编辑器；
// 新建、复制的也在这里。什么都没选时写一句怎么用，和“生成人文…”这类入口

interface SideProps {
  row: RepoRow | null;
  edit: RepoEdit | undefined;
  editKind: ContentKind | null;
  kind: ContentKind | null;
  w: World | null;
  onHover: (h: Hover | null) => void;
  onRun: () => void;
}

export function RepoSide({ row, edit, editKind, kind, w, onHover, onRun }: SideProps) {
  const run = async (cmd: Command | null, busy: string) => {
    if (!cmd) return;
    onRun();
    await runTrusted(cmd, busy);
  };
  return (
    <div class="repo-side-body">
      {row && <ItemDetail row={row} w={w} run={run} onHover={onHover} />}
      {edit && editKind && <EditorView key={`${editKind.id}|${edit.row ?? edit.how}`} kind={editKind} edit={edit} w={w} row={row} />}
      {!row && !edit && <p class="hint repo-side-hint">点一项查看、编辑；双击改名</p>}
      <KindActions kind={kind ?? editKind ?? row?.kind ?? null} w={w} />
    </div>
  );
}

// ---------- 一项的详情 ----------

function ItemDetail({ row, w, run, onHover }: { row: RepoRow; w: World | null; run: (cmd: Command | null, busy: string) => Promise<void>; onHover: (h: Hover | null) => void }) {
  const st = row.status;
  const lib = row.source !== 'world';
  const desc = descOf(row);
  const style = row.kind.id === 'nameStyle';
  const sample = style ? sampleLine(row) : '';
  const usage = w ? rowUsage(row, w) : null;
  const def = w && style ? defaultStyleCommand(row, w) : null;
  const add = lib && w && !st.on && !st.locked ? addCommand(row, w) : null;
  const remove = !lib && w ? removeCommand(row, w) : null;
  const restore = w && st.on && st.modified && !st.always ? restoreCommand(row.kind, st.worldId ?? row.id, w) : null;
  const dedicated = DEDICATED.has(row.kind.id) && st.on;
  // 本世界做的（离群）：存进“我的资源”
  const saveable = !lib && !row.path && !st.always && saveableItem(row) !== null;
  const swatch = swatchOf(row);
  const from = lib ? `${SOURCE_LABEL[row.source]} · ${row.from}` : row.path ? '本世界' : '本世界做的';
  return (
    <section class="repo-detail">
      <div class="row repo-detail-head">
        {swatch && <span class="swatch" style={{ background: swatch }} />}
        <h3 class="grow">{row.name}</h3>
        {st.modified && !st.always && <span class="chip static repo-mod">改过</span>}
        {st.isDefault && <span class="chip static">{row.kind.id === 'mapStyle' ? '在用' : '默认'}</span>}
      </div>
      <p class="hint">
        {row.kind.label} · {from}
      </p>
      {desc && <p class="small">{desc}</p>}
      {sample && <p class="small repo-sample">{sample}</p>}
      {!st.on && st.rename && <p class="hint">本世界里已有另一份，添加后叫“{st.rename}”</p>}
      {st.locked && !usage && <p class="hint">{st.locked}</p>}
      {usage && (
        <p class="hint">
          有 {fmt(usage.count)} 处在用：{usage.label}
        </p>
      )}
      <div class="row wrap repo-detail-actions">
        {add && (
          <button class="small primary" onPointerEnter={() => onHover(hoverOf(row, add, 'on'))} onPointerLeave={() => onHover(null)} onClick={() => void run(add, '正在添加…')}>
            添加到本世界
          </button>
        )}
        {remove && (
          <button class="small" onPointerEnter={() => onHover(hoverOf(row, remove, 'off'))} onPointerLeave={() => onHover(null)} onClick={() => void run(remove, '正在移出…')}>
            移出本世界
          </button>
        )}
        {usage?.cells?.length ? (
          <button class="small" title="把镜头移到用到它的地方" onClick={() => focusOn(usage.cells!)}>
            <LocateFixed /> 定位
          </button>
        ) : null}
        {restore && (
          <button class="small" title="换回内置的原样" onClick={() => void run(restore, '正在计算…')}>
            <RotateCcw /> 恢复内置
          </button>
        )}
        {dedicated && (
          <button class="small" onClick={() => openDedicated(row)}>
            <Pencil /> 编辑
          </button>
        )}
        {def && (
          <button class="small" onPointerEnter={() => onHover(hoverOf(row, def, 'default'))} onPointerLeave={() => onHover(null)} onClick={() => void run(def, '正在起名…')}>
            设为默认
          </button>
        )}
        {saveable && (
          <button class="small" title="别的世界也能用" onClick={() => void saveRow(row)}>
            <Save /> 存进资源库
          </button>
        )}
        <button class="small" title="单独这一项导出成文件" onClick={() => exportRow(row)}>
          <Download /> 导出文件
        </button>
        {canDeleteFromLibrary(row) && (
          <button class="small danger" title="用过它的世界不受影响" onClick={() => void deleteRow(row)}>
            <Trash2 /> 从库里删除
          </button>
        )}
      </div>
      {DEDICATED.has(row.kind.id) && !st.on && <p class="hint">添加到本世界后编辑</p>}
    </section>
  );
}

// ---------- 编辑器 ----------

function EditorView({ kind, edit, w, row }: { kind: ContentKind; edit: RepoEdit; w: World | null; row: RepoRow | null }) {
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
  const dirty = isDirty(edit);
  const ok = !errors.length;
  const save = async () => {
    setWorking(true);
    try {
      const r = await saveItem(kind.pack.key, item);
      if (!r.ok) showToast(r.error, true);
      else showToast(r.stored ? `“${name}”已存进资源库（我的资源）` : '存不进浏览器：只在这次打开的页面里', !r.stored);
    } finally {
      setWorking(false);
    }
  };
  const apply = async () => {
    if (!w) return;
    const cmd = applyEdit(edit, kind, w, row ?? undefined);
    if (!cmd) return;
    setWorking(true);
    try {
      if (await runTrusted(cmd, '正在计算…')) {
        // 用到了：开始时的样子换成现在的（不再算改过）；新建、复制的换到本世界里的那一行
        if (edit.how === 'edit') patchRepo({ edit: { ...edit, base: structuredClone(item) as Obj } });
        else patchRepo({ edit: undefined, sel: `w:${kind.id}:${String(item.id ?? '')}` });
      }
    } finally {
      setWorking(false);
    }
  };
  const title = edit.how === 'new' ? `新的${kind.label}` : edit.how === 'copy' ? `${kind.label} · 副本` : null;
  return (
    <section class="repo-editor">
      {title && <h3>{title}</h3>}
      <EditorKind.Provider value={kind.id}>
        <FieldsBox fields={kind.fields} value={item} onChange={set} issues={errors} />
      </EditorKind.Provider>
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
        <span class="row">
          {dirty && edit.base && (
            <button title="放弃没用上的改动" onClick={() => patchRepo({ edit: { ...edit, item: structuredClone(edit.base!) } })}>
              还原
            </button>
          )}
          <button disabled={!ok} title="另起 id 复制一份" onClick={() => patchRepo({ sel: undefined, edit: { item: copyItem(kind, item, takenIds(kind)), how: 'copy', kind: kind.id } })}>
            复制
          </button>
        </span>
        <span class="row">
          <button disabled={!ok || working} onClick={() => void save()} title="存进资源库的“我的资源”，别的世界也能用">
            存进资源库
          </button>
          <button
            class="primary"
            disabled={!ok || working || !w || (!dirty && edit.worldId !== undefined)}
            onClick={() => void apply()}
            title={edit.worldId !== undefined ? '换掉本世界里的这一项' : '添加到本世界'}
          >
            用到本世界
          </button>
        </span>
      </div>
    </section>
  );
}

// ---------- 一种内容的入口：生成人文、城市、国家，重起省名 ----------

function openCat(cat: 'culture' | 'settlements' | 'countries') {
  closeRepo();
  setCategory(cat);
  openPanel.value = `cat:${cat}`;
}

function KindActions({ kind, w }: { kind: ContentKind | null; w: World | null }) {
  if (!w) return null;
  const restyle = !kind || kind.id === 'nameStyle' ? restyleOffer(w) : null;
  return (
    <>
      {kind && HUMAN_KINDS.has(kind.id) && (
        <div class="row between repo-restyle">
          <span class="hint">{w.small.human ? '改了内容后重新生成才用到' : '还没有生成人文'}</span>
          <button class="small" onClick={() => openCat('culture')}>
            {w.small.human ? '重新生成…' : '生成人文…'}
          </button>
        </div>
      )}
      {kind && SETTLE_KINDS.has(kind.id) && (
        <div class="row between repo-restyle">
          <span class="hint">{w.small.settlementRules ? '改了以后重新生成才放到地图上' : '还没有生成城市'}</span>
          <button class="small" onClick={() => openCat('settlements')}>
            {w.small.settlementRules ? '重新生成…' : '生成城市…'}
          </button>
        </div>
      )}
      {kind && GOV_KINDS.has(kind.id) && (
        <div class="row between repo-restyle">
          <span class="hint">{w.small.human?.countryRules ? '改了内容后重新生成才用到' : '还没有生成国家'}</span>
          <button class="small" onClick={() => openCat('countries')}>
            {w.small.human?.countryRules ? '重新生成…' : '生成国家…'}
          </button>
        </div>
      )}
      {restyle && (
        <div class="row between repo-restyle">
          <span class="hint">换了默认，已有的省名不变</span>
          <button class="small" title="锁定的、自己选了风格的不动" onClick={() => void exec(restyle, '正在起名…')}>
            重起省名
          </button>
        </div>
      )}
    </>
  );
}
