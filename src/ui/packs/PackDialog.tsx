import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  type PackItem,
  type ResourcePack,
  endemicCount,
  packFileName,
  packFromWorld,
  packItems,
  packProblems,
  packScripts,
  packSummary,
  sameItem,
} from '../../../core/packs';
import { builtinPacks } from '../../../core/packs/builtin-tree';
import { type ContentKind, itemId } from '../../../core/content/registry';
import { PATTERN_LABEL } from '../../../core/species';
import type { FoundScript } from '../../../core/script';
import { type LibraryEntry, inLibrary, installPack, keepSavedForms, library, removePack } from '../../library';
import { trustScripts, untrustedScripts } from '../../trust';
import { ScriptList, TrustBlock } from './Scripts';
import { ModalHead } from '../common';
import { askUser, download, knowIsolation, showToast, world } from '../../state';
import { repoKinds } from './repo';
import { type DialogView, openRepo, packDialog } from './store';

// 资源库角落“⋯”打开的弹窗：资源包（资源库里的包：查看、导出、删除）、从文件导入（解析、检查、信任，不运行任何脚本）、
// 从本世界存进资源库（第二十八轮：每一种内容都能勾，人文的也在）。添加到本世界在资源库里一项一项点（RepoPanel）

const close = () => (packDialog.value = null);

const exportFile = (pack: ResourcePack) => download(packFileName(pack), JSON.stringify(pack, null, 2), 'application/json');

// 在资源库里看这个包：资源库一栏只列它（展开着），种类是全部
function showInRepo(key: string, _pack: ResourcePack) {
  openRepo({ entry: key, kind: 'all', filter: 'all', query: '' });
}

// 颜色小方块（最多几个）
function Swatches({ pack, max = 6 }: { pack: ResourcePack; max?: number }) {
  const colors = [...(pack.biomes ?? []).map((b) => b.color), ...[...(pack.riverTypes ?? []), ...(pack.lakeTypes ?? [])].flatMap((r) => (r.color ? [r.color] : []))].slice(0, max);
  return (
    <span class="pack-swatches">
      {colors.map((c) => (
        <span class="swatch big" style={{ background: c }} />
      ))}
    </span>
  );
}

function ItemChips({ items }: { items: { name: string; color?: string; title?: string }[] }) {
  return (
    <div class="palette">
      {items.map((x) => (
        <span class="chip static" title={x.title}>
          {x.color && <span class="swatch" style={{ background: x.color }} />}
          {x.name}
        </span>
      ))}
    </div>
  );
}

const itemName = (x: PackItem) => (typeof x.name === 'string' && x.name) || x.id;

// 一项的色块（岛的颜色可能是“沙”这样的字）
const colorOf = (x: PackItem): string | undefined => (typeof x.color === 'string' && x.color.startsWith('#') ? x.color : undefined);

// 资源包里有什么：每一种一行小标题和几个名字（生态写花纹），自定义场
function PackContents({ pack }: { pack: ResourcePack }) {
  return (
    <div>
      {repoKinds().map((k) => {
        const items = packItems<PackItem>(pack, k.pack.key);
        if (!items.length) return null;
        return (
          <>
            <h5>
              {k.label} {items.length}
            </h5>
            <ItemChips
              items={items.map((x) => ({
                name: itemName(x),
                color: colorOf(x),
                title: k.id === 'biome' && x.visual && (x.visual as { pattern?: string }).pattern && (x.visual as { pattern: string }).pattern !== 'none' ? `花纹：${PATTERN_LABEL[(x.visual as { pattern: keyof typeof PATTERN_LABEL }).pattern]}` : undefined,
              }))}
            />
          </>
        );
      })}
      {!!pack.fields?.length && <p class="hint">用到的自定义场：{pack.fields.join('、')}</p>}
    </div>
  );
}

function Problems({ list }: { list: string[] }) {
  if (!list.length) return null;
  return (
    <div class="box pack-problems">
      <b class="small">要留意</b>
      <ul class="small">
        {list.slice(0, 12).map((p) => (
          <li>{p}</li>
        ))}
        {list.length > 12 && <li>还有 {list.length - 12} 条…</li>}
      </ul>
    </div>
  );
}

// ---------- 资源库 ----------

function LibraryRow({ e }: { e: LibraryEntry }) {
  return (
    <div class="file-row">
      <Swatches pack={e.pack} />
      <div class="file-info">
        <div class="file-name">
          <b>
            {e.pack.name}
            {e.builtin ? '（内置）' : ''}
          </b>
          <span class="hint ellipsis">{packSummary(e.pack)}</span>
        </div>
        {(e.pack.author || e.pack.description) && (
          <div class="hint pack-desc one-line" title={e.pack.description}>
            {e.pack.author ? `${e.pack.author}　` : ''}
            {e.pack.description ?? ''}
          </div>
        )}
      </div>
      <div class="file-actions">
        <button class="small primary" onClick={() => showInRepo(e.key, e.pack)} title="在资源库里一项一项添加到本世界">
          查看
        </button>
        <button class="small" onClick={() => exportFile(e.pack)} title="存成文件，可以发给别人">
          导出
        </button>
        {!e.builtin && (
          <button
            class="small danger"
            onClick={async () => {
              const v = await askUser({
                title: `删除“${e.pack.name}”`,
                text: '用过它的世界不受影响。',
                choices: [
                  { value: 'delete', label: '删除', primary: true },
                  { value: 'cancel', label: '取消' },
                ],
              });
              if (v === 'delete') void removePack(e.key);
            }}
          >
            删除
          </button>
        )}
      </div>
    </div>
  );
}

function PacksView() {
  const list = library.value;
  const groups: [string, LibraryEntry[]][] = [
    ['内置', list.filter((e) => e.builtin)],
    ['我的资源', list.filter((e) => e.mine)],
    ['导入的', list.filter((e) => !e.builtin && !e.mine)],
  ];
  return (
    <>
      <ModalHead title="资源包" onClose={close} />
      <p class="hint">资源库里的内容按包存着。删除包不影响用过它的世界。</p>
      {groups.map(([title, entries]) =>
        entries.length ? (
          <>
            <h5>{title}</h5>
            {entries.map((e) => (
              <LibraryRow e={e} />
            ))}
          </>
        ) : null,
      )}
    </>
  );
}

// ---------- 导入 ----------

function ImportView({ read, file, installed }: Extract<DialogView, { view: 'import' }>) {
  const pack = read.ok ? read.pack : null;
  const scripts = useMemo(() => (pack ? packScripts(pack) : []), [pack]);
  const problems = useMemo(() => (pack ? packProblems(pack) : []), [pack]);
  // 还没信任过的脚本（null：还在查）
  const [untrusted, setUntrusted] = useState<FoundScript[] | null>(null);
  const [working, setWorking] = useState(false);
  useEffect(() => {
    setUntrusted(null);
    // 问要不要信任之前先知道脚本能不能隔离运行（问话里怎么说）
    if (pack) void Promise.all([untrustedScripts(pack), knowIsolation()]).then(([list]) => setUntrusted(list));
  }, [pack]);
  if (!read.ok) {
    return (
      <>
        <ModalHead title="导入资源包" onClose={close} />
        <p class="warn">读不了“{file}”：</p>
        <ul class="small">
          {read.errors.slice(0, 8).map((e) => (
            <li>{e}</li>
          ))}
          {read.errors.length > 8 && <li>还有 {read.errors.length - 8} 处…</li>}
        </ul>
        <div class="modal-foot">
          <button onClick={close}>关闭</button>
        </div>
      </>
    );
  }
  const p = read.pack;
  const replaces = inLibrary(p);
  // 就是内置的大包（比如导出过又导入）：资源库里本来就有，不再装一份
  if (installed || builtinPacks().some((b) => sameItem(p, b))) {
    return (
      <>
        <ModalHead title={installed ? '已安装' : '已在资源库里'} onClose={close} />
        <p>{installed ? `“${p.name}”已在资源库里。` : `“${p.name}”是内置的。`}</p>
        <div class="modal-foot">
          <button onClick={close}>关闭</button>
          <button class="primary" onClick={() => showInRepo(installed ?? '', p)} title="在资源库里一项一项添加到本世界">
            查看
          </button>
        </div>
      </>
    );
  }
  const install = async () => {
    setWorking(true);
    try {
      // 信任：包里全部脚本记进信任列表（trust.ts，按源码的 SHA-256；之后打开用了它的世界不再问）
      await trustScripts(scripts);
      const r = await installPack(p);
      if (!r.ok) showToast('存不进浏览器：资源包只在这次打开的页面里');
      packDialog.value = { view: 'import', read, file, installed: r.entry.key };
    } finally {
      setWorking(false);
    }
  };
  const ask = !!untrusted?.length;
  return (
    <>
      <ModalHead title="从文件导入" onClose={close} closeTitle="取消" />
      <p>
        <b>{p.name}</b>
        {p.author && <span class="muted">　作者：{p.author}</span>}
      </p>
      {p.description && <p class="hint">{p.description}</p>}
      {read.legacy === 'biomes' && <p class="hint">旧版的生态文件，装进资源库后可以用</p>}
      {read.legacy === 'wordPack' && <p class="hint">地名风格，装进资源库后可以用</p>}
      <PackContents pack={p} />
      <Problems list={problems} />
      {ask && <TrustBlock scripts={scripts} />}
      {!ask && untrusted !== null && scripts.length > 0 && (
        <details class="small">
          <summary>脚本（{scripts.length} 段，已信任）</summary>
          <ScriptList scripts={scripts} />
        </details>
      )}
      {replaces && <p class="hint">会替换资源库里的“{replaces.pack.name}”</p>}
      <div class="modal-foot">
        <button onClick={close}>取消</button>
        <button class="primary" disabled={untrusted === null || working} onClick={() => void install()}>
          {ask ? '信任并安装' : '安装'}
        </button>
      </div>
    </>
  );
}

// ---------- 导出 ----------

// 本世界里能导出的（每一种按登记表的 fromWorld：不是内置原样的；人文的几种也在），按资源库的分类先后
export function exportSections(w: PackWorldLike): { kind: ContentKind; items: PackItem[] }[] {
  return repoKinds()
    .map((kind) => ({ kind, items: (kind.pack.fromWorld?.(w) ?? []) as PackItem[] }))
    .filter((x) => x.items.length > 0);
}
type PackWorldLike = Parameters<typeof packFromWorld>[0];

// 勾了哪些：每一种的 id（去掉的记在 off 里：“段名:id”）
export function exportPicks(sections: readonly { kind: ContentKind; items: readonly PackItem[] }[], off: ReadonlySet<string>, wordPack: boolean): Record<string, string[] | boolean> {
  const picks: Record<string, string[] | boolean> = { wordPack };
  for (const { kind, items } of sections) picks[kind.pack.key] = items.map((x) => itemId(kind, x)).filter((id) => !off.has(`${kind.pack.key}:${id}`));
  // 没有能导出的种类也写上空的（packFromWorld 省略的段取全部）
  for (const k of repoKinds()) if (!(k.pack.key in picks)) picks[k.pack.key] = [];
  return picks;
}

// 做出来的包里有没有内容
export const packEmpty = (pack: ResourcePack): boolean => repoKinds().every((k) => !packItems(pack, k.pack.key).length);

function ExportView() {
  const w = world.value;
  const [name, setName] = useState('我的资源');
  const [author, setAuthor] = useState('');
  const [desc, setDesc] = useState('');
  const sections = useMemo(() => (w ? exportSections(w) : []), [w]);
  const [off, setOff] = useState<Set<string>>(new Set());
  if (!w) return null;
  const toggle = (key: string) => {
    const next = new Set(off);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setOff(next);
  };
  const make = () => packFromWorld(w, exportPicks(sections, off, false), { name: name.trim() || '我的资源', author: author.trim() || undefined, description: desc.trim() || undefined });
  const preview = make();
  const empty = packEmpty(preview);
  const endemic = endemicCount(w);
  // 普通函数（不是组件）：每次重画不会把勾选框换成新的
  const check = (k: string, label: string, color?: string) => (
    <label class="check">
      <input type="checkbox" checked={!off.has(k)} onChange={() => toggle(k)} />
      <span>
        {color && <span class="swatch" style={{ background: color }} />} {label}
      </span>
    </label>
  );
  // 资源库里已经有同名（同一个 id）的：存进去会替换它
  const replaces = inLibrary(preview);
  // 替换的是自己的包时，形态编辑器存在里面的星球形态留着（见 keepSavedForms）
  const stored = keepSavedForms(preview, replaces);
  const countItems = (p: ResourcePack) => repoKinds().reduce((n, k) => n + packItems(p, k.pack.key).length, 0);
  const keptForms = countItems(stored) - countItems(preview);
  const save = async () => {
    // 不在这里把脚本记为信任：世界里的脚本可能来自别人的世界文件（没运行脚本打开的），
    // 自己写的、信任过的包里的本来就信任了；没信任过的，以后用到世界时照样先问
    const r = await installPack(stored, { mine: true });
    showToast(r.ok ? `“${preview.name}”已存进资源库` : '存不进浏览器：只在这次打开的页面里');
    close();
  };
  return (
    <>
      <ModalHead title="从本世界存进资源库" onClose={close} closeTitle="取消" />
      <div class="grid2">
        <label>
          <span class="hint">名字</span>
          <input class="wide-input" value={name} maxLength={60} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </label>
        <label>
          <span class="hint">作者（选填）</span>
          <input class="wide-input" value={author} maxLength={60} onInput={(e) => setAuthor((e.target as HTMLInputElement).value)} />
        </label>
      </div>
      <label>
        <span class="hint">说明（选填）</span>
        <textarea rows={2} maxLength={2000} value={desc} onInput={(e) => setDesc((e.target as HTMLTextAreaElement).value)} />
      </label>
      <h5>带上哪些</h5>
      {sections.map(({ kind, items }) =>
        items.map((x) => check(`${kind.pack.key}:${itemId(kind, x)}`, kind.id === 'biome' ? itemName(x) : `${kind.label}：${itemName(x)}`, colorOf(x))),
      )}
      {!sections.length && <p class="hint">没有自己做的、改过的内容</p>}
      {endemic > 0 && <p class="hint">只长在某处的生态不带</p>}
      {replaces && (
        <p class="hint">
          会替换资源库里的“{replaces.pack.name}”，换个名字则另存。{keptForms > 0 && `编辑器存的 ${keptForms} 项保留。`}
        </p>
      )}
      <div class="modal-foot">
        <button onClick={close}>取消</button>
        <button disabled={empty} onClick={() => void save()} title="存进“我的资源”，可用到别的世界">
          存进资源库
        </button>
        <button class="primary" disabled={empty} onClick={() => exportFile(preview)} title="存成文件，可以发给别人">
          导出文件
        </button>
      </div>
    </>
  );
}

export function PackDialog() {
  const d = packDialog.value;
  if (!d) return null;
  return (
    <div class="modal-backdrop" onClick={close}>
      <div class="modal packs" onClick={(e) => e.stopPropagation()}>
        {d.view === 'packs' && <PacksView />}
        {d.view === 'import' && <ImportView {...d} />}
        {d.view === 'export' && <ExportView />}
      </div>
    </div>
  );
}
