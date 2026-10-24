import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  type PackItem,
  packSection,
  type ResourcePack,
  endemicCount,
  exportableBiomes,
  packFileName,
  packFromWorld,
  packItems,
  packProblems,
  packScripts,
  packSummary,
  sameItem,
} from '../../../core/packs';
import { FANTASY_PACK } from '../../../core/packs/fantasy';
import { PATTERN_LABEL } from '../../../core/species';
import type { FoundScript } from '../../../core/script';
import { type LibraryEntry, inLibrary, installPack, keepSavedForms, library, removePack } from '../../library';
import { trustScripts, untrustedScripts } from '../../trust';
import { ScriptList, TrustBlock } from './Scripts';
import { askUser, download, knowIsolation, showToast, world } from '../../state';
import { repoKinds } from './repo';
import { type DialogView, openRepo, packDialog } from './store';

// 仓库角落“⋯”打开的弹窗：资源包（资源库里的包：查看、导出、删除）、导入文件（解析、检查、信任，不运行任何脚本）、
// 从这个世界存进仓库。用到世界在仓库里一项一项开关（RepoPanel）

const close = () => (packDialog.value = null);

const exportFile = (pack: ResourcePack) => download(packFileName(pack), JSON.stringify(pack, null, 2), 'application/json');

// 在仓库里看这个包：选上它有内容的第一类，只列它的
function showInRepo(key: string, pack: ResourcePack) {
  const kind = repoKinds().find((k) => packItems(pack, k.pack.key).length)?.id;
  openRepo({ entry: key, ...(kind ? { kind } : {}) });
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

// 资源包里有什么：生态（色块、花纹）、河流类型、星球形态、文字包、自定义场
function PackContents({ pack }: { pack: ResourcePack }) {
  return (
    <div>
      {!!pack.biomes?.length && (
        <>
          <h5>生态 {pack.biomes.length}</h5>
          <ItemChips
            items={pack.biomes.map((b) => ({
              name: b.name || b.id,
              color: b.color,
              title: b.visual && b.visual.pattern !== 'none' ? `花纹：${PATTERN_LABEL[b.visual.pattern]}` : undefined,
            }))}
          />
        </>
      )}
      {!!pack.riverTypes?.length && (
        <>
          <h5>河流类型 {pack.riverTypes.length}</h5>
          <ItemChips items={pack.riverTypes.map((r) => ({ name: itemName(r), color: r.color }))} />
        </>
      )}
      {!!pack.lakeTypes?.length && (
        <>
          <h5>湖泊类型 {pack.lakeTypes.length}</h5>
          <ItemChips items={pack.lakeTypes.map((r) => ({ name: itemName(r), color: r.color }))} />
        </>
      )}
      {!!pack.islandTypes?.length && (
        <>
          <h5>岛的种类 {pack.islandTypes.length}</h5>
          <ItemChips items={pack.islandTypes.map((r) => ({ name: itemName(r), color: typeof r.color === 'string' && r.color.startsWith('#') ? r.color : undefined }))} />
        </>
      )}
      {!!pack.planetForms?.length && (
        <>
          <h5>星球形态 {pack.planetForms.length}</h5>
          <ItemChips items={pack.planetForms.map((f) => ({ name: itemName(f) }))} />
        </>
      )}
      {!!pack.nameStyles?.length && (
        <>
          <h5>地名风格 {pack.nameStyles.length}</h5>
          <ItemChips items={pack.nameStyles.map((t) => ({ name: t.name }))} />
        </>
      )}
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
    <div class="item big">
      <Swatches pack={e.pack} />
      <div class="grow">
        <div>
          <b>
            {e.pack.name}
            {e.builtin ? '（内置）' : ''}
          </b>
          <span class="muted">　{packSummary(e.pack)}</span>
        </div>
        {(e.pack.author || e.pack.description) && (
          <div class="hint pack-desc">
            {e.pack.author ? `${e.pack.author}　` : ''}
            {e.pack.description ?? ''}
          </div>
        )}
      </div>
      <div class="row">
        <button class="primary" onClick={() => showInRepo(e.key, e.pack)} title="在仓库里一项一项启用">
          查看
        </button>
        <button onClick={() => exportFile(e.pack)} title="存成文件，可以发给别人">
          导出
        </button>
        {!e.builtin && (
          <button
            class="danger"
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
      <div class="row between">
        <h2>资源包</h2>
        <button onClick={close}>关闭</button>
      </div>
      <p class="hint">仓库里的内容按包存着。删除包不影响用过它的世界。</p>
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
        <h2>导入资源包</h2>
        <p class="warn">读不了“{file}”：</p>
        <ul class="small">
          {read.errors.slice(0, 8).map((e) => (
            <li>{e}</li>
          ))}
          {read.errors.length > 8 && <li>还有 {read.errors.length - 8} 处…</li>}
        </ul>
        <div class="row">
          <button onClick={close}>关闭</button>
        </div>
      </>
    );
  }
  const p = read.pack;
  const replaces = inLibrary(p);
  // 就是内置的示例包（比如导出过又导入）：资源库里本来就有，不再装一份
  if (installed || sameItem(p, FANTASY_PACK)) {
    return (
      <>
        <h2>{installed ? '已安装' : '已在仓库里'}</h2>
        <p>{installed ? `“${p.name}”已在仓库里。` : `“${p.name}”是内置的。`}</p>
        <div class="row">
          <button class="primary" onClick={() => showInRepo(installed ?? '', p)} title="在仓库里一项一项启用">
            查看
          </button>
          <button onClick={close}>关闭</button>
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
      <h2>导入资源包</h2>
      <p>
        <b>{p.name}</b>
        {p.author && <span class="muted">　作者：{p.author}</span>}
      </p>
      {p.description && <p class="hint">{p.description}</p>}
      {read.legacy === 'biomes' && <p class="hint">旧版的生态文件，装进仓库后可以用</p>}
      {read.legacy === 'wordPack' && <p class="hint">地名风格，装进仓库后可以用</p>}
      <PackContents pack={p} />
      <Problems list={problems} />
      {ask && <TrustBlock scripts={scripts} />}
      {!ask && untrusted !== null && scripts.length > 0 && (
        <details class="small">
          <summary>脚本（{scripts.length} 段，已信任）</summary>
          <ScriptList scripts={scripts} />
        </details>
      )}
      {replaces && <p class="hint">会替换仓库里的“{replaces.pack.name}”</p>}
      <div class="row between">
        <span />
        <span class="row">
          <button onClick={close}>取消</button>
          <button class="primary" disabled={untrusted === null || working} onClick={() => void install()}>
            {ask ? '信任并安装' : '安装'}
          </button>
        </span>
      </div>
    </>
  );
}

// ---------- 导出 ----------

function ExportView() {
  const w = world.value;
  const [name, setName] = useState('我的资源');
  const [author, setAuthor] = useState('');
  const [desc, setDesc] = useState('');
  const biomes = useMemo(() => (w ? exportableBiomes(w) : []), [w]);
  const fromWorld = (key: string): PackItem[] => (w ? ((packSection(key)?.pack.fromWorld?.(w) ?? []) as PackItem[]) : []);
  const rivers = useMemo(() => fromWorld('riverTypes'), [w]);
  const lakes = useMemo(() => fromWorld('lakeTypes'), [w]);
  const isles = useMemo(() => fromWorld('islandTypes'), [w]);
  const forms = useMemo(() => fromWorld('planetForms'), [w]);
  const styles = useMemo(() => fromWorld('nameStyles'), [w]);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [words, setWords] = useState(false);
  if (!w) return null;
  const toggle = (key: string) => {
    const next = new Set(off);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setOff(next);
  };
  const on = (sec: string, id: string) => !off.has(`${sec}:${id}`);
  const make = () =>
    packFromWorld(
      w,
      {
        biomes: biomes.filter((b) => on('b', b.id)).map((b) => b.id),
        riverTypes: rivers.filter((r) => on('r', r.id)).map((r) => r.id),
        lakeTypes: lakes.filter((r) => on('l', r.id)).map((r) => r.id),
        islandTypes: isles.filter((r) => on('i', r.id)).map((r) => r.id),
        planetForms: forms.filter((f) => on('f', f.id)).map((f) => f.id),
        nameStyles: styles.filter((s) => on('s', s.id)).map((s) => s.id),
        wordPack: words,
      },
      { name: name.trim() || '我的资源', author: author.trim() || undefined, description: desc.trim() || undefined },
    );
  const preview = make();
  const empty = !preview.biomes && !preview.riverTypes && !preview.lakeTypes && !preview.islandTypes && !preview.planetForms && !preview.nameStyles;
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
    showToast(r.ok ? `“${preview.name}”已存进仓库` : '存不进浏览器：只在这次打开的页面里');
    close();
  };
  return (
    <>
      <h2>从世界存进仓库</h2>
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
      {biomes.map((b) => (
        check(`b:${b.id}`, b.name || b.id, b.color)
      ))}
      {rivers.map((r) => (
        check(`r:${r.id}`, `河流类型：${itemName(r)}`, r.color)
      ))}
      {lakes.map((r) => (
        check(`l:${r.id}`, `湖泊类型：${itemName(r)}`, r.color)
      ))}
      {isles.map((r) => (
        check(`i:${r.id}`, `岛的种类：${itemName(r)}`, typeof r.color === 'string' && r.color.startsWith('#') ? r.color : undefined)
      ))}
      {forms.map((f) => (
        check(`f:${f.id}`, `星球形态：${itemName(f)}`)
      ))}
      {styles.map((s) => (
        check(`s:${s.id}`, `地名风格：${itemName(s)}`)
      ))}
      {w.small.wordPack && (
        <label class="check">
          <input type="checkbox" checked={words} onChange={() => setWords(!words)} />
          <span>文字包“{w.small.wordPack.name}”</span>
        </label>
      )}
      {!biomes.length && !rivers.length && !lakes.length && !isles.length && !forms.length && !styles.length && <p class="hint">没有自己做的内容</p>}
      {endemic > 0 && <p class="hint">只长在某处的生态不带</p>}
      {replaces && (
        <p class="hint">
          会替换仓库里的“{replaces.pack.name}”，换个名字则另存。{keptForms > 0 && `编辑器存的 ${keptForms} 项保留。`}
        </p>
      )}
      <div class="row between">
        <span />
        <span class="row">
          <button onClick={close}>取消</button>
          <button disabled={empty} onClick={() => void save()} title="存进“我的资源”，可用到别的世界">
            存进仓库
          </button>
          <button class="primary" disabled={empty} onClick={() => exportFile(preview)} title="存成文件，可以发给别人">
            导出文件
          </button>
        </span>
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
