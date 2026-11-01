import { useEffect, useRef, useState } from 'preact/hooks';
import type { Command } from '../../../core/commands';
import { hexToRgb } from '../../../core/export';
import type { World } from '../../../core/world';
import type { HighlightLayer } from '../../render/colors';
import { adjustPreviewWorld, cancelWorldPreview, exactDelay, previewWorld, worldPreviewError } from '../../state';
import { untrustedScripts } from '../../trust';
import { fmt } from './repo-actions';

// 停一下预览（第二十八轮；第四十五轮从 RepoPanel.tsx 分出来）：鼠标停在“添加”“移出”“设为默认”上，
// 地图上先画出之后的样子（在 Worker 里的世界副本上执行同一条命令），底下写一句

const WHITE: [number, number, number] = [255, 255, 255];

// nameOnly：只是多一种能选的风格（地图上不变）；names：地图上只有地名变（世界默认的风格换了）
export type Hover = { key: string; cmd: Command; action: 'on' | 'off' | 'default'; nameOnly: boolean; names: boolean };
type Note = { key: string; text: string; warn?: boolean } | null;

const ACTION_TEXT = { on: '添加后', off: '移出后', default: '设为默认后' } as const;

export function usePreview(w: World | null) {
  const [hover, setHover] = useState<Hover | null>(null);
  const [note, setNote] = useState<Note>(null);
  // 放到地图上的预览是哪条命令的（JSON，与 execAdjust 认的一样：点下去时直接采用算好的结果）
  const mine = useRef('');
  // 点下去了：预览的世界留到执行的结果换上（execAdjust 自己去掉），不先闪回原样
  const keep = useRef(false);
  const drop = () => {
    cancelWorldPreview();
    if (!keep.current && mine.current && adjustPreviewWorld.value?.key === mine.current) adjustPreviewWorld.value = null;
    keep.current = false;
    mine.current = '';
  };
  useEffect(() => {
    if (!hover || !w) {
      setNote(null);
      drop();
      return;
    }
    keep.current = false;
    const { key, cmd, action } = hover;
    let live = true;
    const t = setTimeout(async () => {
      const untrusted = await untrustedScripts(cmd);
      if (!live) return;
      if (untrusted.length) {
        setNote({ key, text: '有没信任过的脚本，添加时先问' });
        return;
      }
      if (hover.nameOnly) {
        setNote({ key, text: action === 'on' ? '添加后可在“地名”里选用' : '移出后不再列在“地名”里' });
        return;
      }
      setNote({ key, text: '正在计算…' });
      const r = await previewWorld(cmd);
      if (!live) return;
      if (!r) {
        const why = worldPreviewError(cmd);
        setNote({ key, text: why ? `用不上：${why}` : '预览失败', warn: !!why });
        return;
      }
      // 新加的生态长在哪里（按各自的颜色淡淡涂上），会变的格描边
      const had = new Set(w.small.species.map((s) => s.id));
      const sp = r.world.small.species;
      const isNew = sp.map((s) => !had.has(s.id));
      const byNew = new Map<number, number[]>();
      const dom = r.world.derived.dominant;
      for (let i = 0; i < dom.length; i++) {
        const s = dom[i];
        if (s >= 0 && isNew[s]) (byNew.get(s) ?? byNew.set(s, []).get(s)!).push(i);
      }
      const layers: HighlightLayer[] = [
        { cells: r.result.changedCells, color: WHITE, pattern: 'outline' },
        ...[...byNew].map(([s, cells]): HighlightLayer => ({ cells, color: hexToRgb(sp[s].color), alpha: 0.35 })),
      ];
      const cmdKey = JSON.stringify(cmd);
      adjustPreviewWorld.value = { key: cmdKey, base: r.base, world: r.world, layers };
      mine.current = cmdKey;
      let grown = 0;
      for (const c of byNew.values()) grown += c.length;
      const changed = r.result.changedCells.length;
      const text = hover.names
        ? action === 'default'
          ? '地名按这种风格重起'
          : '移出后地名按内置中文重起'
        : isNew.some(Boolean)
          ? grown
            ? `${ACTION_TEXT[action]} ${fmt(grown)} 格变成新生态`
            : '新生态在这里长不出来'
          : changed
            ? `${ACTION_TEXT[action]} ${fmt(changed)} 格会变`
            : '地图上没有变化';
      setNote({ key, text });
    }, exactDelay(300));
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [hover?.key, w]);
  // 关上资源库：去掉地图上的预览
  useEffect(() => drop, []);
  const settle = () => {
    keep.current = true;
    setHover(null);
  };
  return { hover, setHover, settle, note: note && hover && note.key === hover.key ? note : null };
}
