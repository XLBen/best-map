import { useEffect, useState } from 'preact/hooks';
import type { World } from '../../../core/world';
import { adjustPreviewNote, askText, askUser, commitTerrain, exec, execAdjust, mode, openPanel, previewAdjust, previewTerrain, setOptions, world } from '../../state';
import { Slider } from '../components/Slider';
import { Toggle } from '../components/Toggle';
import { ADJUSTMENTS, PLANET_TOGGLES } from '../defs/adjustments';
import { setTool } from '../defs/tools';
import type { AdjustmentDef } from '../defs/types';

// “调整”：整个世界的参数（气候与河流）。滑块停一下，地图上就是松手后的样子（在世界的副本上算好，松手时直接采用）。
// 松手才执行，一次一步，可以撤销。地形（陆地多少、海岸曲折……）在新建向导里定，这里不再有

export const RES = 1000;

// 滑块位置与值的换算（新建向导的“地形”也用）
type Scaled = Pick<AdjustmentDef, 'scale' | 'step'>;
export function toPos(def: Scaled, v: number, [lo, hi]: [number, number]) {
  const p = def.scale === 'log' ? Math.log(v / lo) / Math.log(hi / lo) : (v - lo) / (hi - lo);
  return Math.round(Math.max(0, Math.min(1, p)) * RES);
}

export function fromPos(def: Scaled, pos: number, [lo, hi]: [number, number]) {
  const p = pos / RES;
  const raw = def.scale === 'log' ? lo * Math.pow(hi / lo, p) : lo + (hi - lo) * p;
  // 按步长取整（避免 0.30000000000000004 这样的数）
  const digits = Math.max(0, -Math.floor(Math.log10(def.step)));
  return Number((Math.round(raw / def.step) * def.step).toFixed(digits));
}

function AdjustRow({ def, w }: { def: AdjustmentDef; w: World }) {
  const [draft, setDraft] = useState<number | null>(null);
  useEffect(() => setDraft(null), [w]);
  const avail = def.available(w);
  const now = def.read(w);
  const v = draft ?? now;
  const range = def.rangeOf?.(w) ?? def.range;
  // 正在拖这一行：预览算到哪一步了
  const note = adjustPreviewNote.value;
  const previewNote = def.preview === 'world' && draft !== null && note?.key === JSON.stringify(def.command(w, draft)) ? note.text : null;
  const at = (p: number) => fromPos(def, p * RES, range);
  const drop = () => {
    previewTerrain(null);
    setDraft(null);
    if (def.preview === 'world') previewAdjust(null);
  };
  return (
    <Slider
      stacked
      label={def.label}
      title={def.hint}
      disabled={!avail}
      changed={draft !== null && draft !== now}
      pos={toPos(def, v, range) / RES}
      text={avail ? def.format(v) : '—'}
      note={
        (def.note || previewNote) && (
          <>
            {def.note?.(w, v)}
            {previewNote && <span class="slider-note-line">{previewNote}</span>}
          </>
        )
      }
      onDraft={(p) => {
        const nv = at(p);
        setDraft(nv);
        if (def.preview === 'terrain' && def.patch) previewTerrain(def.patch(nv));
        // 停下 200 毫秒后预览将来的世界；拖回原来的值就不预览
        if (def.preview === 'world') previewAdjust(Math.abs(nv - now) < def.step / 2 ? null : def.command(w, nv));
      }}
      onCommit={(p) => {
        const nv = at(p);
        if (Math.abs(nv - now) < def.step / 2) return drop();
        // 地形类：将来的海岸线留在地图上，直到结果换上（算的期间不闪回旧的海岸）
        if (def.preview === 'terrain' && def.patch) void commitTerrain(def.command(w, nv), def.busyLabel, def.patch(nv));
        // 预览过的值：结果直接采用，预览的世界留到结果换上
        else if (def.preview === 'world') void execAdjust(def.command(w, nv), def.busyLabel);
        else void exec(def.command(w, nv), def.busyLabel);
      }}
      onCancel={drop}
    />
  );
}

function FieldsBox({ w }: { w: World }) {
  const names = Object.keys(w.causes.fields);
  const remove = async (f: string) => {
    const v = await askUser({
      title: `删除自定义场“${f}”？`,
      choices: [
        { value: 'delete', label: '删除', primary: true },
        { value: 'cancel', label: '取消' },
      ],
    });
    if (v === 'delete') void exec({ op: 'remove_field', name: f });
  };
  const add = async () => {
    const r = await askText({
      title: '新建自定义场',
      text: '名字只用字母、数字、下划线',
      input: 'magic',
      choices: [
        { value: 'ok', label: '新建', primary: true },
        { value: 'cancel', label: '取消' },
      ],
    });
    if (r.value === 'ok' && r.text.trim()) void exec({ op: 'add_field', name: r.text.trim() });
  };
  return (
    <section>
      <h5>自定义场</h5>
      <p class="hint">如“魔力”“文明度”，可在生态的“高级”条件里用</p>
      {names.map((f) => (
        <div class="item">
          <span class="grow ellipsis">{f}</span>
          <button
            class="small"
            onClick={() => {
              setOptions({ field: f });
              setTool('field');
              openPanel.value = null;
            }}
          >
            涂抹
          </button>
          <button class="small" onClick={() => (mode.value = `field:${f}`)}>
            查看
          </button>
          <button class="small danger" onClick={() => void remove(f)}>
            删除
          </button>
        </div>
      ))}
      <button onClick={() => void add()}>新建自定义场</button>
    </section>
  );
}

export function AdjustPanel() {
  // 面板关上：拖着的预览也不要了
  useEffect(() => () => previewAdjust(null), []);
  const w = world.value;
  if (!w) return null;
  const groups = [...new Set(ADJUSTMENTS.map((a) => a.group))];
  return (
    <>
      {groups.map((g) => (
        <section>
          <h5>{g}</h5>
          {ADJUSTMENTS.filter((a) => a.group === g && !a.hidden?.(w)).map((a) => (
            <AdjustRow def={a} w={w} />
          ))}
          {g === '气候与河流' &&
            PLANET_TOGGLES.filter((t) => !t.hidden?.(w)).map((t) => (
              <Toggle on={t.read(w)} title={t.hint} onChange={(on) => void exec({ op: 'set_planet', patch: t.patch(on) }, '正在计算…')}>
                {t.label}
              </Toggle>
            ))}
        </section>
      ))}
      <p class="hint">松手执行，可以撤销；地形用“地形”里的工具改</p>
      <FieldsBox w={w} />
    </>
  );
}
