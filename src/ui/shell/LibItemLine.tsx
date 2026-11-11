import { Library } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { showToast, world } from '../../state';
import { OPEN_IN_LIBRARY, OPEN_IN_LIBRARY_TIP, QUICK_EDIT_TIP } from '../copy';
import { type LibTarget, quickFields, quickNext } from '../packs/open-item';
import { commitItem } from '../packs/page-actions';
import { WORLD_SOURCE } from '../packs/page-source';
import { openWorldItem, pageCtx } from '../packs/panel-store';

// 档案、“这里”卡片里的一行（第九十二轮）：地图上点到的东西在资源库里的那一项——色块、名字、“在资源库里打开”（直达这张地图里那一项的页面）。
// edit：名字、颜色在这一行上直接改，和资源库面板里改是同一条路（commitItem：一步，能撤销）；别的字段去面板里改。
// 哪几项、能改哪两样在 packs/open-item.ts

function commit(t: LibTarget, patch: { name?: string; color?: string }) {
  const w = world.value;
  const hit = w && quickNext(w, t.kind, t.id, patch);
  if (!hit) return;
  const r = commitItem(WORLD_SOURCE, hit.kind, t.id, hit.next, pageCtx());
  if (r === 'invalid') showToast('这样改不了，去资源库里看', true);
}

export function LibItemLine({ t, edit = false }: { t: LibTarget; edit?: boolean }) {
  const can = edit ? quickFields(t.kind) : { name: false, color: false };
  const [name, setName] = useState(t.name);
  useEffect(() => setName(t.name), [t.kind, t.id, t.name]);
  return (
    <div class="arch-line lib-item-line">
      <span class="arch-label">{t.label}</span>
      {can.color && t.color ? (
        <input type="color" value={t.color} title={QUICK_EDIT_TIP} onChange={(e) => commit(t, { color: (e.target as HTMLInputElement).value })} />
      ) : (
        t.color && <span class="swatch" style={{ background: t.color }} />
      )}
      {can.name ? (
        <input
          class="grow"
          value={name}
          maxLength={40}
          title={QUICK_EDIT_TIP}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              e.stopPropagation();
              setName(t.name);
            }
          }}
          onBlur={() => (name.trim() && name.trim() !== t.name ? commit(t, { name }) : setName(t.name))}
        />
      ) : (
        <span class="grow ellipsis">{t.name}</span>
      )}
      <button class="link-btn small lib-item-open" title={OPEN_IN_LIBRARY_TIP} onClick={() => openWorldItem(t.kind, t.id)}>
        <Library /> {OPEN_IN_LIBRARY}
      </button>
    </div>
  );
}

// 几项排成一段（没有时不画）
export function LibItemLines({ list, edit = false, title }: { list: readonly LibTarget[]; edit?: boolean; title?: string }) {
  if (!list.length) return null;
  return (
    <section class="lib-item-lines">
      {title && <h5>{title}</h5>}
      {list.map((t) => (
        <LibItemLine key={`${t.kind}:${t.id}`} t={t} edit={edit} />
      ))}
    </section>
  );
}
