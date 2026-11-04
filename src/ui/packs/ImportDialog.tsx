import { useMemo, useRef, useState } from 'preact/hooks';
import { importPreview } from '../../../core/packs/closure';
import { library } from '../../library';
import { showToast, world } from '../../state';
import { LibraryPick } from '../components/LibraryPick';
import { ModalHead } from '../common';
import { ImportBasket } from './ImportBasket';
import { ImportList } from './ImportList';
import { askOf, chooseFile, chooseFrom, closeImport, doneLine, importWindow, pickSections, regenLine, runImport, sourceOf, targetOf, targetTitle } from './page-import';
import { type LookCtx, refKey } from './page-import-tree';
import type { PageCtx } from './page-source';
import { openPackImport } from './store';

// 导入窗口（第六十一轮，第六十五轮重写成两栏）：左边选（ImportList），右边看清单（ImportBasket）。一次从一个库导入，换库清空勾选。
// 确认后写入（一步）。逻辑都在 page-import.ts、page-import-tree.ts

function Body() {
  const st = importWindow.value!;
  const ctx: PageCtx = { world: world.value, lib: library.value };
  const target = targetOf(st, ctx);
  const source = sourceOf(st, ctx);
  const [working, setWorking] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const sections = useMemo(() => (source && target ? pickSections(source, target) : []), [source, target?.t]);
  const ask = askOf(st, ctx);
  const preview = useMemo(() => (ask ? importPreview(ask) : null), [ask?.source, ask?.target.t === 'world' ? ask.target.world : ask?.target.pack, st.picks, st.off]);
  const look = useMemo<LookCtx | null>(
    () => (preview ? { picks: new Set(st.picks.map(refKey)), planned: new Map(preview.rows.map((r) => [refKey(r), r])), gates: preview.gates, here: st.target.t === 'world' ? '本世界' : '这个库' } : null),
    [preview],
  );
  const count = preview?.count ?? 0;
  const confirm = async () => {
    setWorking(true);
    try {
      const r = await runImport(st, ctx);
      if (r.error) showToast(r.error, true);
      if (r.ok) {
        showToast(doneLine(r, preview && target ? regenLine(preview, target) : null));
        closeImport();
      }
    } finally {
      setWorking(false);
    }
  };
  const read = st.file?.read;
  return (
    <>
      <ModalHead title={`导入到${targetTitle(st, ctx)}`} onClose={closeImport} closeTitle="取消" />
      <div class="imp-body">
        <div class="imp-left">
          <div class="imp-source">
            <span class="hint">从</span>
            {st.file ? (
              <b class="ellipsis grow" title={st.file.name}>
                {read?.ok ? read.pack.name : st.file.name}
              </b>
            ) : (
              <span class="grow imp-pick">
                <LibraryPick compact any exclude={st.target.t === 'lib' ? st.target.key : undefined} value={st.from} lib={ctx.lib} onChange={chooseFrom} />
              </span>
            )}
            {st.file && (
              <button class="small" onClick={() => chooseFrom(st.from ?? '')}>
                选库
              </button>
            )}
            <button class="small" title="读资源包文件，不运行脚本" onClick={() => fileInput.current?.click()}>
              读文件…
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(ev) => {
                const f = (ev.target as HTMLInputElement).files?.[0];
                if (f) void chooseFile(f);
                (ev.target as HTMLInputElement).value = '';
              }}
            />
          </div>
          {read && !read.ok && (
            <>
              <p class="warn">读不了“{st.file!.name}”：</p>
              <ul class="small">
                {read.errors.slice(0, 8).map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </>
          )}
          {read?.ok && (
            <p class="hint imp-file">
              只导入勾的。
              <button class="small" onClick={() => openPackImport(read, st.file!.name)}>
                装进资源库…
              </button>
            </p>
          )}
          {/* 换库时从头来：展开的、搜索的都不留 */}
          {source && target && look && <ImportList key={st.file?.name ?? st.from ?? ''} sections={sections} look={look} ctx={ctx} picks={st.picks} />}
        </div>
        <ImportBasket p={preview} source={source} target={target} ctx={ctx} />
      </div>
      <div class="modal-foot">
        <button onClick={closeImport}>取消</button>
        <button class="primary" disabled={!count || working} onClick={() => void confirm()}>
          导入 {count} 项
        </button>
      </div>
    </>
  );
}

export function ImportDialog() {
  if (!importWindow.value) return null;
  return (
    <div class="modal-backdrop" onClick={closeImport}>
      <div class="modal import" onClick={(e) => e.stopPropagation()}>
        <Body />
      </div>
    </div>
  );
}
