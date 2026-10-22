import { useEffect, useRef, useState } from 'preact/hooks';
import type { Command } from '../../../core/commands';
import type { Worldgen } from '../../../core/generate';
import { sameItem } from '../../../core/packs';
import { type PlanetForm, hasFormScripts } from '../../../core/planet-form';
import type { World } from '../../../core/world';
import { library, refreshLibrary } from '../../library';
import type { HighlightLayer } from '../../render/colors';
import { adjustPreviewWorld, cancelWorldPreview, exactDelay, execAdjust, previewWorld, trustFormScripts, worldPreviewError } from '../../state';
import { type FormChoice, currentFormName, formChoices, genWithForm, planetTypeName } from '../forms';

// “调整”的“地形”里（只在整个星球上）：星球形态：双子大陆 [换…]。
// 点“换…”列出内置的示例和资源库里的形态（还有“不用形态”）；选一个，地图上先画出换了之后的样子
// （在 Worker 里的世界副本上执行同一条命令：多出的陆地淡淡涂上，会变成海的画斜线），点“换成它”时直接采用算好的结果。
// 你画过的陆地、放的岛照样叠在新的地形上，调过的滑块照旧；一步，可以撤销

const GAINED: HighlightLayer['color'] = [255, 226, 120];
const LOST: HighlightLayer['color'] = [255, 255, 255];
const fmt = (n: number) => n.toLocaleString('en-US');

// 换成这个形态的命令（null：不用形态）
export function formCommand(gen: Worldgen, form: PlanetForm | null): Command {
  return { op: 'set_worldgen', params: genWithForm(gen, form) };
}

// 预览之后说的一句：会多出、少掉多少格陆地
export function landNote(gained: number, lost: number): string {
  if (!gained && !lost) return '陆地看不出变化';
  const parts = [gained ? `多出 ${fmt(gained)} 格陆地` : '', lost ? `少掉 ${fmt(lost)} 格` : ''].filter(Boolean);
  return `会${parts.join('、')}（地图上淡黄的是多出的，斜线是会变成海的）`;
}

type Pick = { key: string; form: PlanetForm | null };
type Note = { key: string; text: string; warn?: boolean; ready?: boolean };

function Picker({ w, gen, onClose }: { w: World; gen: Worldgen; onClose: () => void }) {
  useEffect(() => void refreshLibrary(), []);
  const choices = formChoices(library.value);
  const [pick, setPick] = useState<Pick | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [applying, setApplying] = useState(false);
  const isNow = (form: PlanetForm | null) => (form ? !!gen.form && sameItem(gen.form, form) : !gen.form);
  // 选的就是现在用的（比如刚换好、结果已经换上）：不算预览
  const cmd = pick && !isNow(pick.form) ? formCommand(gen, pick.form) : null;
  const key = cmd ? JSON.stringify(cmd) : '';
  // 这个列表放到地图上的预览（关上时去掉；“换成它”之后由结果换掉）
  const mine = useRef('');
  const applyingRef = useRef(false);
  const dropMine = () => {
    if (mine.current && adjustPreviewWorld.value?.key === mine.current) adjustPreviewWorld.value = null;
    mine.current = '';
  };

  // 选一个：有没见过的脚本先问（预览就会运行它）
  const choose = async (c: FormChoice | null) => {
    if (c && !(await trustFormScripts(c.form, true))) return;
    setPick(c ? { key: c.key, form: c.form } : { key: '', form: null });
  };

  // 地图上的确切预览：选好停一下再算；世界变了（撤销、别的编辑）重新算
  useEffect(() => {
    if (!cmd) {
      setNote(null);
      dropMine();
      return;
    }
    setNote({ key, text: '正在算换了之后的样子…' });
    let live = true;
    const t = setTimeout(() => {
      void previewWorld(cmd).then((r) => {
        if (!live) return;
        if (!r) {
          const why = worldPreviewError(cmd);
          setNote({ key, text: why ? `用不上：${why}` : '预览没算出来，可以再选一次', warn: !!why });
          return;
        }
        const layers: HighlightLayer[] = [
          { cells: r.result.landGained, color: GAINED, alpha: 0.4 },
          { cells: r.result.landLost, color: LOST, alpha: 0.6, pattern: 'hatch' },
        ];
        adjustPreviewWorld.value = { key, base: r.base, world: r.world, layers };
        mine.current = key;
        setNote({ key, text: landNote(r.result.landGained.length, r.result.landLost.length), ready: true });
      });
    }, exactDelay(150));
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key, w]);

  // 关上：去掉地图上的预览（“换成它”之后由执行的结果换掉，不先闪回原样）
  useEffect(
    () => () => {
      cancelWorldPreview();
      if (!applyingRef.current) dropMine();
    },
    [],
  );

  const apply = async () => {
    if (!cmd) return;
    setApplying(true);
    applyingRef.current = true;
    let ok = false;
    try {
      ok = await execAdjust(cmd, '正在换星球形态…');
    } finally {
      applyingRef.current = false;
      setApplying(false);
    }
    if (ok) onClose();
  };

  const shown = note && note.key === key ? note : null;
  // 调过“陆地多少”时照调过的（形态里的陆地多少不起作用）
  const keptLand = pick?.form?.profile?.landFraction !== undefined && gen.landFraction !== undefined;
  const row = (k: string, label: string, how: string, form: PlanetForm | null, c: FormChoice | null) => (
    <button key={k} class={`card ${pick && pick.key === k ? 'on' : ''}`} disabled={isNow(form) || applying} onClick={() => void choose(c)}>
      <b>
        {label}
        {form && hasFormScripts(form) && <span class="tag">脚本</span>}
        {isNow(form) && <span class="muted small">（现在用的）</span>}
      </b>
      <span class="how">{how}</span>
    </button>
  );
  return (
    <div class="form-picker">
      <div class="cards">
        {choices.map((c) => row(c.key, c.form.name, c.form.hint ?? `从“${planetTypeName(c.form.base)}”改起`, c.form, c))}
        {gen.form && row('', '不用形态', `回到“${planetTypeName(gen.type)}”`, null, null)}
      </div>
      {shown && <p class={`small ${shown.warn ? 'warn' : ''}`}>{shown.text}</p>}
      {shown?.ready && <p class="muted small">你画过的陆地、放的岛照样叠在新的地形上{keptLand ? `；陆地多少照你调过的 ${Math.round(gen.landFraction! * 100)}%` : ''}。</p>}
      <div class="row between">
        <span class="muted small">换形态是一步，可以撤销</span>
        <span class="row">
          <button class="small" onClick={onClose} disabled={applying}>
            取消
          </button>
          <button class="small primary" disabled={!shown?.ready || applying} onClick={() => void apply()}>
            换成它
          </button>
        </span>
      </div>
    </div>
  );
}

// 调整面板里的一行：星球形态：X [换…]（只在整个星球上、有生成参数时）
export function FormRow({ w }: { w: World }) {
  const gen = w.small.terrain.gen;
  const [open, setOpen] = useState(false);
  if (!w.settings.globe || !gen) return null;
  return (
    <div class="adj-row">
      <span class="row between">
        <span>星球形态：{currentFormName(gen)}</span>
        <button class="small" onClick={() => setOpen(!open)}>
          {open ? '收起' : '换…'}
        </button>
      </span>
      {open && <Picker w={w} gen={gen} onClose={() => setOpen(false)} />}
    </div>
  );
}
