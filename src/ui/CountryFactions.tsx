import { useEffect, useState } from 'preact/hooks';
import { countryFactions } from '../../core/human';
import type { CountryMeta, World } from '../../core/world';
import { exec } from '../state';
import { Slider } from './components/Slider';
import { factionPatch, patchCommand, statsOf } from './domain/countries';
import { shareText } from './domain/human';

// 国家档案里的派系（第五十三轮从 CountryArchive.tsx 搬出来）与一整条比例的条

// 一整条的构成（文化、宗教……），鼠标停着写名字与占比
export function StackBar({ items }: { items: { name: string; color: string; share: number }[] }) {
  const rest = Math.max(0, 1 - items.reduce((a, x) => a + x.share, 0));
  return (
    <div class="stack-bar">
      {items.map((x) => (
        <span style={{ width: `${x.share * 100}%`, background: x.color }} title={`${x.name} ${shareText(x.share)}`} />
      ))}
      {rest > 0.005 && <span class="stack-rest" style={{ width: `${rest * 100}%` }} title={`其他 ${shareText(rest)}`} />}
    </div>
  );
}

// 派系：名单来自政体，比重默认按派系的基础分量和这个国家的人口算；拖一下存一条命令，“恢复自动”去掉覆盖
export function FactionSection({ w, m }: { w: World; m: CountryMeta }) {
  const list = countryFactions(w, m.id, statsOf(w).get(m.id));
  const [draft, setDraft] = useState<{ id: string; v: number } | null>(null);
  // 换了国家：拖到一半的不留（第四十轮：抽屉不再按国家整个重建）
  useEffect(() => setDraft(null), [m.id]);
  if (!list.length) {
    return (
      <section>
        <h5>派系</h5>
        <p class="hint">这种政体没有派系，可以在资源库里选</p>
      </section>
    );
  }
  const shown = draft ? Object.entries(factionPatch(list, draft.id, draft.v)).map(([id, influence]) => ({ ...list.find((f) => f.id === id)!, influence })) : list;
  return (
    <section>
      <div class="row between">
        <h5>派系</h5>
        {m.factions ? (
          <button class="small" onClick={() => void exec(patchCommand(m.id, { factions: null }), '正在保存…')} title="按派系的“多少”和人口算">
            恢复自动
          </button>
        ) : (
          <span class="hint" title="按派系的“多少”和人口算，拖滑块可以改">
            自动
          </span>
        )}
      </div>
      <StackBar items={shown.map((f) => ({ name: f.name, color: f.color, share: f.influence }))} />
      {shown.map((f) => (
        <div class="faction-row">
          <span class="swatch" style={{ background: f.color }} />
          <Slider
            label={f.name}
            pos={f.influence}
            text={shareText(f.influence)}
            disabled={shown.length < 2}
            changed={draft?.id === f.id}
            onDraft={(p) => setDraft({ id: f.id, v: Math.round(p * 100) / 100 })}
            onCommit={(p) => {
              setDraft(null);
              void exec(patchCommand(m.id, { factions: factionPatch(list, f.id, Math.round(p * 100) / 100) }), '正在保存…');
            }}
            onCancel={() => setDraft(null)}
          />
        </div>
      ))}
    </section>
  );
}
