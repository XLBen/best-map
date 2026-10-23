import { X } from 'lucide-preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { hexToRgb } from '../../../core/export';
import { packProblems as wordPackProblems } from '../../../core/names';
import { PACK_SECTIONS, type PackPicks, type ResourcePack, newBiomeCells, packScripts, planPack } from '../../../core/packs';
import type { FoundScript } from '../../../core/script';
import type { World } from '../../../core/world';
import { trustScripts, untrustedScripts } from '../../trust';
import type { HighlightLayer } from '../../render/colors';
import { adjustPreviewWorld, cancelWorldPreview, exactDelay, execAdjust, knowIsolation, previewWorld, world, worldPreviewError } from '../../state';
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
  // 还没信任过的脚本，按是哪个包查的记：换了包（卡片开着又点了别的包）时，查好之前一律当作没信任，不先算预览
  const [checked, setChecked] = useState<{ pack: ResourcePack; list: FoundScript[] } | null>(null);
  const untrusted = checked?.pack === pack ? checked.list : null;
  const [note, setNote] = useState<Shown>(null);
  const [applying, setApplying] = useState(false);
  useEffect(() => {
    setPicks(st.picks);
    let live = true;
    // 问要不要信任之前先知道脚本能不能隔离运行（问话里怎么说）
    void Promise.all([untrustedScripts(pack), knowIsolation()]).then(([list]) => live && setChecked({ pack, list }));
    return () => {
      live = false;
    };
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

  // 地图上的预览：勾选停下 150 毫秒后算（上次算得久就多等一会儿：大星球上一边画一边开着卡片时，
  // 每一笔之后不急着重算，Worker 先算笔画）；世界变了（撤销、别的编辑）重新算
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
          const why = worldPreviewError(cmd);
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
    }, exactDelay(150));
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
      // 改了名的生态，脚本里的 river('x') 换过，源码也变了：也记为信任（信任的是这个包）
      await trustScripts(packScripts(cmd));
      ok = await execAdjust(cmd, `正在用「${pack.name}」…`);
    } finally {
      applyingRef.current = false;
      setApplying(false);
      if (ok && packApply.value?.pack === pack) close();
    }
  };

  const togglePick = (sec: 'biomes' | 'riverTypes' | 'lakeTypes', id: string) => {
    const cur = picks[sec] ?? [];
    setPicks({ ...picks, [sec]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  };
  const status = (sec: 'biomes' | 'riverTypes' | 'lakeTypes', id: string, name: string): string => {
    const s = plan.skipped.find((x) => x.section === sec && x.from === id);
    if (s) return '已经有了';
    const a = plan.added.find((x) => x.section === sec && x.from === id);
    if (!a || a.id === a.from) return '';
    return a.name !== name ? `世界里已有不一样的「${name}」，这一份叫「${a.name}」` : '世界里已有一份不一样的，这一份另外加上';
  };
  // 有问题的文字包换不了（命令会拒绝）：不能勾，说一句
  const badText = useMemo(() => new Set((pack.textPacks ?? []).filter((t) => wordPackProblems(t).length).map((t) => t.id)), [pack]);
  const rivers = pack.riverTypes ?? [];
  const riverSec = PACK_SECTIONS.riverTypes;
  const lakes = pack.lakeTypes ?? [];
  const lakeSec = PACK_SECTIONS.lakeTypes;
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
              {picks.biomes?.includes(b.id) && status('biomes', b.id, b.name || b.id) && <span class="muted small">（{status('biomes', b.id, b.name || b.id)}）</span>}
              {b.dispersal && <span class="muted small">（岛上特有的：只在做它的那个世界里有意义）</span>}
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
                  {picks.riverTypes?.includes(r.id) && status('riverTypes', r.id, r.name || r.id) && <span class="muted small">（{status('riverTypes', r.id, r.name || r.id)}）</span>}
                </span>
              </label>
            ))}
            {riverSec.note && <p class="muted small">{riverSec.note}</p>}
          </>
        )}
        {st.only !== 'biomes' && !!lakes.length && (
          <>
            <h5>湖泊类型</h5>
            {lakes.map((r) => (
              <label class="check">
                <input type="checkbox" disabled={!lakeSec.command} checked={!!lakeSec.command && !!picks.lakeTypes?.includes(r.id)} onChange={() => togglePick('lakeTypes', r.id)} />
                <span>
                  {r.color && <span class="swatch" style={{ background: r.color }} />} {r.name || r.id}
                  {picks.lakeTypes?.includes(r.id) && status('lakeTypes', r.id, r.name || r.id) && <span class="muted small">（{status('lakeTypes', r.id, r.name || r.id)}）</span>}
                </span>
              </label>
            ))}
            {lakeSec.note && <p class="muted small">{lakeSec.note}</p>}
          </>
        )}
        {st.only !== 'biomes' && !!forms.length && (
          <>
            <h5>星球形态</h5>
            <p class="small">{forms.map((f) => f.name || f.id).join('、')}</p>
            {/* 一块地区上没有“调整 → 星球形态”：形态只用在整个星球上 */}
            <p class="muted small">{w.settings.globe ? PACK_SECTIONS.planetForms.note : '星球形态只用在整个星球上：新建世界时选“整个星球”就能选它们'}</p>
          </>
        )}
        {st.only !== 'biomes' && !!texts.length && (
          <>
            <h5>文字包</h5>
            {texts.map((t) => (
              <label class="check">
                <input
                  type="checkbox"
                  disabled={badText.has(t.id)}
                  checked={picks.textPack === t.id && !badText.has(t.id)}
                  onChange={() => setPicks({ ...picks, textPack: picks.textPack === t.id ? null : t.id })}
                />
                <span>
                  换用文字包「{t.name}」{badText.has(t.id) ? <span class="muted small">（模板里有不存在的词表，换不了）</span> : '（地名会跟着变）'}
                </span>
              </label>
            ))}
          </>
        )}
        {!!plan.fields.length && <p class="muted small">会新加自定义场：{plan.fields.join('、')}（用“气候 → 涂自定义场”可以涂）</p>}
        {total > 48 && <p class="warn small">这个世界会有 {total} 种生态：太多时界面会很挤，计算也会变慢</p>}
        {untrusted !== null && !!untrusted.length && (
          <>
            <TrustBlock scripts={packScripts(pack)} />
            <div class="row">
              <button
                onClick={async () => {
                  await trustScripts(packScripts(pack));
                  setChecked({ pack, list: [] });
                }}
              >
                信任，看看用了之后的样子
              </button>
            </div>
          </>
        )}
        {!cmd.commands.length && <p class="muted small">{plan.skipped.length ? '勾选的这些世界里都已经有了。' : '还没勾选要用的。'}</p>}
      </div>
      {/* 底部一直看得到（上面的说明很长时也不被挤到看不见的地方） */}
      <div class="pack-apply-foot">
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
