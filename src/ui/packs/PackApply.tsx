import { X } from 'lucide-preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { hexToRgb } from '../../../core/export';
import { PACK_SECTIONS, type PackPicks, newBiomeCells, packScripts, planPack } from '../../../core/packs';
import type { FoundScript } from '../../../core/script';
import type { World } from '../../../core/world';
import { trustScripts, untrustedScripts } from '../../library';
import type { HighlightLayer } from '../../render/colors';
import { adjustPreviewWorld, cancelWorldPreview, execAdjust, previewWorld, world, worldPreviewError } from '../../state';
import { TrustBlock } from './Scripts';
import { type ApplyState, packApply } from './store';

// “用到这个世界”：浮在地图左边的卡片（不挡地图）。勾选要用的项，地图上先画出用了之后的样子
// （在 Worker 里的世界副本上执行同一条命令：会变的格描边，新生态的格淡淡涂上），点“用上”时直接采用算好的结果。
// 一整步，可以撤销。包里有还没信任过的脚本时先问，信任之前不算预览（算预览就会运行脚本）

const WHITE: [number, number, number] = [255, 255, 255];
const fmt = (n: number) => n.toLocaleString('en-US');

type Shown = { key: string; text: string; warn?: boolean } | null;

function ApplyCard({ st, w }: { st: ApplyState; w: World }) {
  const { pack } = st;
  const [picks, setPicks] = useState<PackPicks>(st.picks);
  const [untrusted, setUntrusted] = useState<FoundScript[] | null>(null);
  const [note, setNote] = useState<Shown>(null);
  const [applying, setApplying] = useState(false);
  useEffect(() => {
    setPicks(st.picks);
    setUntrusted(null);
    void untrustedScripts(pack).then(setUntrusted);
  }, [st]);

  const plan = useMemo(() => planPack(w, pack, picks), [w, pack, picks]);
  const cmd = plan.command;
  const key = JSON.stringify(cmd);
  const keyRef = useRef(key);
  keyRef.current = key;
  // 正在“用上”：卡片关上时预览的世界留着，等执行的结果换上
  const applyingRef = useRef(false);
  // 这张卡片放到地图上的预览是哪条命令的（勾选改了、新的预览还没算好时，地图上先留着上一个，不闪回原样）
  const mine = useRef('');
  const dropMine = () => {
    if (mine.current && adjustPreviewWorld.value?.key === mine.current) adjustPreviewWorld.value = null;
    mine.current = '';
  };
  const trusted = untrusted !== null && !untrusted.length;

  // 地图上的预览：勾选停下 150 毫秒后算；世界变了（撤销、别的编辑）重新算
  useEffect(() => {
    if (!trusted || !cmd.commands.length) {
      setNote(null);
      dropMine();
      return;
    }
    setNote({ key, text: '正在算预览…' });
    let live = true;
    const t = setTimeout(() => {
      void previewWorld(cmd).then((r) => {
        if (!live || keyRef.current !== key) return;
        if (!r) {
          const why = worldPreviewError();
          setNote({ key, text: why ? `用不上：${why}` : '预览没算出来', warn: !!why });
          return;
        }
        // 变成新生态的格（按生态分开，用各自的颜色淡淡涂上）
        const bySpecies = newBiomeCells(plan, r.world);
        const sp = r.world.small.species;
        const anyNew = plan.added.some((a) => a.section === 'biomes');
        let count = 0;
        for (const cells of bySpecies.values()) count += cells.length;
        const layers: HighlightLayer[] = [
          { cells: r.result.changedCells, color: WHITE, pattern: 'outline' },
          ...[...bySpecies].map(([s, cells]): HighlightLayer => ({ cells, color: hexToRgb(sp[s].color), alpha: 0.35 })),
        ];
        adjustPreviewWorld.value = { key, base: r.base, world: r.world, layers };
        mine.current = key;
        const parts: string[] = [];
        if (anyNew) parts.push(count ? `会有 ${fmt(count)} 格变成新生态` : '新生态在这个世界上一格都长不出来（冷暖干湿都不合适）');
        if (plan.textPack) parts.push('地名按新的文字包重起');
        if (!parts.length) parts.push(r.result.changedCells.length ? `会有 ${fmt(r.result.changedCells.length)} 格的生态变化` : '地图上看不出变化');
        setNote({ key, text: parts.join('，') });
      });
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key, trusted, w]);

  // 关上：去掉地图上的预览（“用上”之后由执行的结果换掉，不先闪回原样）
  useEffect(
    () => () => {
      cancelWorldPreview();
      if (!applyingRef.current) dropMine();
    },
    [],
  );

  const close = () => (packApply.value = null);
  // 用上：直接采用预览算好的结果（预览的世界留到结果换上）。做成了关上卡片；没做成（提示条说原因）卡片留着，可以去掉出问题的那项
  const apply = async () => {
    setApplying(true);
    applyingRef.current = true;
    let ok = false;
    try {
      // 改了名的生态，脚本里的 river('x') 换过，哈希也变了：也记为信任（信任的是这个包）
      await trustScripts(packScripts(cmd).map((s) => s.hash));
      ok = await execAdjust(cmd, `正在用「${pack.name}」…`);
    } finally {
      applyingRef.current = false;
      setApplying(false);
      if (ok && packApply.value?.pack === pack) close();
    }
  };

  const togglePick = (sec: 'biomes' | 'riverTypes', id: string) => {
    const cur = picks[sec] ?? [];
    setPicks({ ...picks, [sec]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  };
  const status = (sec: 'biomes' | 'riverTypes', id: string): string => {
    const s = plan.skipped.find((x) => x.section === sec && x.from === id);
    if (s) return '已经有了';
    const a = plan.added.find((x) => x.section === sec && x.from === id);
    return a && a.id !== a.from ? `世界里有同名的不一样的，改叫 ${a.id}` : '';
  };
  const rivers = pack.riverTypes ?? [];
  const riverSec = PACK_SECTIONS.riverTypes;
  const forms = pack.planetForms ?? [];
  const texts = pack.textPacks ?? [];
  const total = w.small.species.length + plan.added.filter((a) => a.section === 'biomes').length;
  const shown = note && note.key === key ? note : null;
  return (
    <div class="pack-apply">
      <div class="popover-head">
        <b>用到这个世界 · {pack.name}</b>
        <button class="icon-btn" onClick={close} title="关上（Esc）">
          <X size={16} />
        </button>
      </div>
      <div class="sheet-body">
        {!!pack.biomes?.length && <h5>生态</h5>}
        {(pack.biomes ?? []).map((b) => (
          <label class="check">
            <input type="checkbox" checked={!!picks.biomes?.includes(b.id)} onChange={() => togglePick('biomes', b.id)} />
            <span>
              <span class="swatch" style={{ background: b.color }} /> {b.name || b.id}
              {picks.biomes?.includes(b.id) && status('biomes', b.id) && <span class="muted small">（{status('biomes', b.id)}）</span>}
            </span>
          </label>
        ))}
        {st.only !== 'biomes' && !!rivers.length && (
          <>
            <h5>河流类型</h5>
            {rivers.map((r) => (
              <label class="check">
                <input type="checkbox" disabled={!riverSec.command} checked={!!riverSec.command && !!picks.riverTypes?.includes(r.id)} onChange={() => togglePick('riverTypes', r.id)} />
                <span>
                  {r.color && <span class="swatch" style={{ background: r.color }} />} {r.name || r.id}
                  {picks.riverTypes?.includes(r.id) && status('riverTypes', r.id) && <span class="muted small">（{status('riverTypes', r.id)}）</span>}
                </span>
              </label>
            ))}
            {riverSec.note && <p class="muted small">{riverSec.note}</p>}
          </>
        )}
        {st.only !== 'biomes' && !!forms.length && (
          <>
            <h5>星球形态</h5>
            <p class="small">{forms.map((f) => f.name || f.id).join('、')}</p>
            {PACK_SECTIONS.planetForms.note && <p class="muted small">{PACK_SECTIONS.planetForms.note}</p>}
          </>
        )}
        {st.only !== 'biomes' && !!texts.length && (
          <>
            <h5>文字包</h5>
            {texts.map((t) => (
              <label class="check">
                <input type="checkbox" checked={picks.textPack === t.id} onChange={() => setPicks({ ...picks, textPack: picks.textPack === t.id ? null : t.id })} />
                <span>换用文字包「{t.name}」（地名会跟着变）</span>
              </label>
            ))}
          </>
        )}
        {!!plan.fields.length && <p class="muted small">会新加自定义场：{plan.fields.join('、')}（在“自然”的自定义场里可以涂）</p>}
        {total > 48 && <p class="warn small">这个世界会有 {total} 种生态：太多时界面会很挤，计算也会变慢</p>}
        {untrusted !== null && !!untrusted.length && (
          <>
            <TrustBlock scripts={packScripts(pack)} />
            <div class="row">
              <button
                onClick={async () => {
                  await trustScripts(packScripts(pack).map((s) => s.hash));
                  setUntrusted([]);
                }}
              >
                信任，看看用了之后的样子
              </button>
            </div>
          </>
        )}
        {!cmd.commands.length && <p class="muted small">{plan.skipped.length ? '勾选的这些世界里都已经有了。' : '还没勾选要用的。'}</p>}
        {shown && <p class={`small ${shown.warn ? 'warn' : ''}`}>{shown.text}</p>}
        <div class="row between">
          <span class="muted small">用上是一步，可以撤销</span>
          <span class="row">
            <button onClick={close}>取消</button>
            <button class="primary" disabled={!trusted || !cmd.commands.length || applying || !!shown?.warn} onClick={() => void apply()}>
              用上
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

export function PackApply() {
  const st = packApply.value;
  const w = world.value;
  if (!st || !w) return null;
  return <ApplyCard st={st} w={w} />;
}
