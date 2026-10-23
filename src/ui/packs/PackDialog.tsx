import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  PACK_MAX_CHARS,
  PACK_SECTIONS,
  type PackItem,
  type ResourcePack,
  defaultPicks,
  endemicCount,
  exportableBiomes,
  packFileName,
  packFromWorld,
  packProblems,
  packScripts,
  packSummary,
  readPack,
  sameItem,
} from '../../../core/packs';
import { FANTASY_PACK } from '../../../core/packs/fantasy';
import { PATTERN_LABEL } from '../../../core/species';
import type { FoundScript } from '../../../core/script';
import { type LibraryEntry, inLibrary, installPack, keepSavedForms, library, removePack } from '../../library';
import { trustScripts, untrustedScripts } from '../../trust';
import { ScriptList, TrustBlock } from './Scripts';
import { download, knowIsolation, showToast, world } from '../../state';
import { type DialogView, fileLabel, openPackApply, openPackImport, openPackLibrary, packDialog } from './store';

// 资源包弹窗（世界 → 资源包…）：资源库的列表、导入（解析、检查、信任，不运行任何脚本）、从这个世界导出。
// “用到这个世界”换成一张不挡地图的卡片（PackApply），在地图上看用了之后的样子

const close = () => (packDialog.value = null);

const exportFile = (pack: ResourcePack) => download(packFileName(pack), JSON.stringify(pack, null, 2), 'application/json');

// 读一个文件：资源包或旧的生态、文字包文件（只解析、检查）。大得离谱的文件不读进来
export function importPackFile(file: File) {
  if (file.size > 3 * PACK_MAX_CHARS) {
    openPackImport({ ok: false, errors: [`文件太大（${Math.round(file.size / 1e6)} MB），不像是资源包`] }, file.name);
    return;
  }
  void file.text().then((text) => {
    openPackImport(readPack(text, fileLabel(file.name)), file.name);
  });
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
export function PackContents({ pack }: { pack: ResourcePack }) {
  return (
    <div class="pack-contents">
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
      {!!pack.planetForms?.length && (
        <>
          <h5>星球形态 {pack.planetForms.length}</h5>
          <ItemChips items={pack.planetForms.map((f) => ({ name: itemName(f) }))} />
        </>
      )}
      {!!pack.textPacks?.length && (
        <>
          <h5>文字包</h5>
          <ItemChips items={pack.textPacks.map((t) => ({ name: t.name }))} />
        </>
      )}
      {!!pack.fields?.length && <p class="muted small">用到的自定义场：{pack.fields.join('、')}</p>}
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
  const w = world.value;
  return (
    <div class="pack-row">
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
          <div class="muted small pack-desc">
            {e.pack.author ? `${e.pack.author}　` : ''}
            {e.pack.description ?? ''}
          </div>
        )}
      </div>
      <div class="row">
        <button class="primary" disabled={!w} onClick={() => openPackApply(e.pack, defaultPicks(e.pack))} title={w ? '挑几样加进这个世界' : '先新建或打开一个世界'}>
          用到这个世界
        </button>
        <button onClick={() => exportFile(e.pack)} title="存成 .map2pack.json 文件，可以发给别人">
          导出
        </button>
        {!e.builtin && (
          <button
            class="danger"
            onClick={() => {
              if (confirm(`从资源库里删掉「${e.pack.name}」？用过它的世界不受影响。`)) void removePack(e.key);
            }}
          >
            删除
          </button>
        )}
      </div>
    </div>
  );
}

function LibraryView() {
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
        <button onClick={close}>关上</button>
      </div>
      <p class="muted small">资源包里是做好的生态、河流类型、湖泊类型、星球形态和文字包。挑几样用到这个世界后，世界会带上用到的全部内容：资源包删了、发给没有这个包的人，都照样能打开。</p>
      <div class="row wrap">
        <label class="file-button">
          导入资源包…
          <input
            type="file"
            accept=".json,application/json"
            onChange={(ev) => {
              const f = (ev.target as HTMLInputElement).files?.[0];
              if (f) importPackFile(f);
              (ev.target as HTMLInputElement).value = '';
            }}
          />
        </label>
        <button disabled={!world.value} onClick={() => (packDialog.value = { view: 'export' })}>
          从这个世界导出…
        </button>
      </div>
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
      {list.length === 1 && <p class="muted small">还没有别的资源包。导入别人发来的 .map2pack.json，或者把这个世界里自己做的生态导出来。</p>}
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
        <p class="warn">读不了「{file}」：</p>
        <ul class="small">
          {read.errors.slice(0, 8).map((e) => (
            <li>{e}</li>
          ))}
          {read.errors.length > 8 && <li>还有 {read.errors.length - 8} 处…</li>}
        </ul>
        <div class="row">
          <button onClick={openPackLibrary}>回到资源库</button>
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
        <h2>{installed ? '装好了' : '资源库里已经有了'}</h2>
        <p>{installed ? `「${p.name}」在资源库里了。` : `这就是内置的「${p.name}」，不用再装。`}</p>
        <div class="row">
          <button class="primary" disabled={!world.value} onClick={() => openPackApply(p, defaultPicks(p))}>
            用到这个世界
          </button>
          <button onClick={openPackLibrary}>回到资源库</button>
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
      if (!r.ok) showToast('浏览器不让存：资源包只在这一次打开的页面里');
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
      {p.description && <p class="muted small">{p.description}</p>}
      {read.legacy === 'biomes' && <p class="muted small">这是以前导出的生态文件。装进资源库后，可以挑几种加进世界。</p>}
      {read.legacy === 'wordPack' && <p class="muted small">这是一个文字包。装进资源库后，可以在“用到这个世界”里换用它。</p>}
      <PackContents pack={p} />
      <Problems list={problems} />
      {ask && <TrustBlock scripts={scripts} />}
      {!ask && untrusted !== null && scripts.length > 0 && (
        <details class="small">
          <summary>查看脚本（{scripts.length} 段，以前信任过）</summary>
          <ScriptList scripts={scripts} />
        </details>
      )}
      {replaces && <p class="muted small">资源库里已经有「{replaces.pack.name}」，装进去会替换它。</p>}
      <div class="row between">
        <span />
        <span class="row">
          <button onClick={openPackLibrary}>取消</button>
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
  const rivers = useMemo(() => (w ? (PACK_SECTIONS.riverTypes.fromWorld?.(w) ?? []) : []), [w]);
  const lakes = useMemo(() => (w ? (PACK_SECTIONS.lakeTypes.fromWorld?.(w) ?? []) : []), [w]);
  const forms = useMemo(() => (w ? (PACK_SECTIONS.planetForms.fromWorld?.(w) ?? []) : []), [w]);
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
        planetForms: forms.filter((f) => on('f', f.id)).map((f) => f.id),
        wordPack: words,
      },
      { name: name.trim() || '我的资源', author: author.trim() || undefined, description: desc.trim() || undefined },
    );
  const preview = make();
  const empty = !preview.biomes && !preview.riverTypes && !preview.lakeTypes && !preview.planetForms && !preview.textPacks;
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
  const keptForms = (stored.planetForms?.length ?? 0) - (preview.planetForms?.length ?? 0);
  const save = async () => {
    // 不在这里把脚本记为信任：世界里的脚本可能来自别人的世界文件（没运行脚本打开的），
    // 自己写的、信任过的包里的本来就信任了；没信任过的，以后用到世界时照样先问
    const r = await installPack(stored, { mine: true });
    showToast(r.ok ? `「${preview.name}」存进资源库了` : '浏览器不让存：只在这一次打开的页面里');
    openPackLibrary();
  };
  return (
    <>
      <h2>从这个世界导出</h2>
      <div class="grid2">
        <label>
          <span class="small muted">名字</span>
          <input class="wide-input" value={name} maxLength={60} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </label>
        <label>
          <span class="small muted">作者（可以不写）</span>
          <input class="wide-input" value={author} maxLength={60} onInput={(e) => setAuthor((e.target as HTMLInputElement).value)} />
        </label>
      </div>
      <label>
        <span class="small muted">说明（可以不写）</span>
        <textarea class="wide-input" rows={2} maxLength={2000} value={desc} onInput={(e) => setDesc((e.target as HTMLTextAreaElement).value)} />
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
      {forms.map((f) => (
        check(`f:${f.id}`, `星球形态：${itemName(f)}`)
      ))}
      {w.small.wordPack && (
        <label class="check">
          <input type="checkbox" checked={words} onChange={() => setWords(!words)} />
          <span>文字包「{w.small.wordPack.name}」</span>
        </label>
      )}
      {!biomes.length && !rivers.length && !lakes.length && !forms.length && <p class="muted small">这个世界里还没有自己做的生态（内置的原样不用导出）。</p>}
      {endemic > 0 && <p class="muted small">岛上特有的生态只属于这个世界，不带。</p>}
      {replaces && (
        <p class="muted small">
          资源库里已经有「{replaces.pack.name}」：存进资源库会替换它（换个名字就另存一份）。{keptForms > 0 && `里面存的 ${keptForms} 个星球形态照样留着。`}
        </p>
      )}
      <div class="row between">
        <span />
        <span class="row">
          <button onClick={openPackLibrary}>取消</button>
          <button disabled={empty} onClick={() => void save()} title="存进资源库的“我的资源”，以后用到别的世界">
            存进资源库
          </button>
          <button class="primary" disabled={empty} onClick={() => exportFile(preview)} title="存成 .map2pack.json 文件，可以发给别人">
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
        {d.view === 'library' && <LibraryView />}
        {d.view === 'import' && <ImportView {...d} />}
        {d.view === 'export' && <ExportView />}
      </div>
    </div>
  );
}
