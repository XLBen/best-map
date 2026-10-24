import { useEffect, useRef, useState } from 'preact/hooks';
import { speciesColor } from '../../../core/species';
import type { World } from '../../../core/world';
import { type ProjectionPref, type ViewMode, focusSpecies, labelGroups, mapStyle, mode, overlays, prefs, reference, season, setPrefs, setReference, showToast, world } from '../../state';
import { Seg } from '../common';
import { Slider, linear } from '../components/Slider';
import { Toggle } from '../components/Toggle';
import { LABEL_GROUPS, OVERLAYS, SEASONS, VIEWS, suitabilityFocus } from '../defs/layers';

// 整个星球的投影（第十三轮 G4）：只是看的方式，存在这个浏览器里，不写进世界文件
const PROJECTIONS: [ProjectionPref, string][] = [
  ['equirect', '等距圆柱'],
  ['equalEarth', '等面积'],
  ['globe', '球形'],
];
const PROJECTION_TITLES: Record<ProjectionPref, string> = {
  equirect: '平铺成 2:1 的长方形（原来的样子）',
  equalEarth: '椭圆形，各处面积按真实比例',
  globe: '从太空看的一面，拖动转动',
};
const PROJECTION_HINTS: Record<ProjectionPref, string> = {
  equirect: '平铺成 2:1 的长方形，东西接着重复。每条纬线都画得和赤道一样长，所以越靠近两极横向拉得越宽。',
  equalEarth: '椭圆形，各处面积按真实比例，两极不再拉宽。整个椭圆放得下时左右拖动是转动中央经线，放大以后拖动是平移。',
  globe: '从太空看的一面：拖动转动，滚轮或捏合缩放。越往边上是斜着看的，挤得越紧。',
};

// 参考图的浓淡：10%–100%，每格 5%
const OPACITY = linear(10, 100, 5);

// “图层”：底图着色、画风、叠加在上面的东西、季节、参考图

// 换底图。“某种生态的适宜程度”先定下看哪一种（没选过、选的那种没了时是第一种）
export function showView(id: ViewMode) {
  if (id === 'suitability') focusSpecies.value = suitabilityFocus(world.value?.small.species ?? [], focusSpecies.value);
  mode.value = id;
}

// 适宜程度底图下面：看哪一种生态
function SuitabilityPick({ w }: { w: World }) {
  const id = suitabilityFocus(w.small.species, focusSpecies.value);
  // 选的那种被删掉了（撤销、删生态）：换成第一种，地图上不是一片灰
  useEffect(() => {
    if (id !== focusSpecies.value) focusSpecies.value = id;
  }, [id]);
  const sp = w.small.species.find((s) => s.id === id);
  return (
    <label class="row suit-pick">
      <span class="swatch" style={{ background: sp ? speciesColor(sp) : 'transparent' }} />
      <select value={id ?? ''} onChange={(e) => (focusSpecies.value = (e.target as HTMLSelectElement).value)}>
        {w.small.species.map((s) => (
          <option value={s.id}>{s.name || s.id}</option>
        ))}
      </select>
    </label>
  );
}

// 读进来的图缩到最长边 4096 像素以内，存成 PNG（保留透明的底）
async function readImage(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w0 = img.naturalWidth || 2048;
    const h0 = img.naturalHeight || 1024;
    const k = Math.min(1, 4096 / Math.max(w0, h0));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w0 * k));
    c.height = Math.max(1, Math.round(h0 * k));
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('图片转换失败'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

function ReferenceBox() {
  const file = useRef<HTMLInputElement>(null);
  const r = reference.value;
  const pick = () => file.current?.click();
  const onFile = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    try {
      const blob = await readImage(f);
      const ok = await setReference({ url: URL.createObjectURL(blob), blob, opacity: r?.opacity ?? 0.5, fit: r?.fit ?? 'contain', visible: true });
      showToast(ok ? '参考图铺好了：照着用“画陆地”的画笔或“圈一片”描' : '参考图存不进浏览器：这次能用，关掉页面后要重新导入', !ok);
    } catch {
      showToast('这张图读不了：换一张 PNG 或 JPG 试试', true);
    }
  };
  return (
    <section>
      <h5>参考图</h5>
      <input ref={file} type="file" accept="image/*" hidden onChange={onFile} />
      {!r ? (
        <>
          <p class="hint">
            把手绘的草图铺在地图上，照着画陆地。{world.value?.settings.globe ? '整个星球的草图：宽是高的两倍，左右两边接得上。' : ''}图只存在这个浏览器里，不写进世界文件，也不进导出的图片。
          </p>
          <button onClick={pick}>导入图片…</button>
        </>
      ) : (
        <>
          <Toggle on={r.visible} onChange={(visible) => void setReference({ ...r, visible })}>
            显示参考图
          </Toggle>
          <Slider
            stacked
            label="浓淡"
            disabled={!r.visible}
            pos={OPACITY.pos(Math.round(r.opacity * 100))}
            text={`${Math.round(r.opacity * 100)}%`}
            onDraft={(p) => void setReference({ ...r, opacity: OPACITY.at(p) / 100 }, false)}
            onCommit={(p) => {
              // 松手才存进浏览器
              const cur = reference.value;
              if (cur) void setReference({ ...cur, opacity: OPACITY.at(p) / 100 });
            }}
          />
          <Seg
            value={r.fit}
            options={[
              ['contain', '保持比例'],
              ['stretch', '铺满地图'],
            ]}
            titles={{ contain: '按图片原来的比例，放在地图中间', stretch: '拉伸到和整张地图一样大' }}
            onChange={(fit) => void setReference({ ...r, fit })}
            wide
          />
          <div class="row">
            <button onClick={pick}>换一张…</button>
            <button onClick={() => void setReference(null)}>移除</button>
          </div>
        </>
      )}
    </section>
  );
}

export function LayersPanel() {
  const w = world.value;
  const planet = w?.mesh.kind === 'sphere';
  const [more, setMore] = useState(VIEWS.some((v) => v.more && v.id === mode.value) || mode.value.startsWith('field:'));
  if (!w) return null;
  const fields = Object.keys(w.causes.fields);
  const viewButton = (id: typeof mode.value, label: string) => (
    <button class={mode.value === id ? 'on' : ''} onClick={() => showView(id)}>
      {label}
    </button>
  );
  const hint = VIEWS.find((v) => v.id === mode.value)?.hint;
  return (
    <>
      <section>
        <h5>底图</h5>
        <div class="view-grid">{VIEWS.filter((v) => !v.more).map((v) => viewButton(v.id, v.label))}</div>
        <button class="link-btn" onClick={() => setMore(!more)}>
          {more ? '收起' : '更多底图…'}
        </button>
        {more && (
          <div class="view-grid">
            {VIEWS.filter((v) => v.more).map((v) => viewButton(v.id, v.label))}
            {fields.map((f) => viewButton(`field:${f}`, `场：${f}`))}
          </div>
        )}
        {hint && <p class="hint">{hint}</p>}
        {mode.value === 'suitability' && <SuitabilityPick w={w} />}
      </section>
      <section>
        <h5>画风</h5>
        <Seg
          value={mapStyle.value}
          options={[
            ['realistic', '写实'],
            ['atlas', '地图册'],
          ]}
          onChange={(v) => (mapStyle.value = v)}
          wide
        />
      </section>
      {planet && (
        <section>
          <h5>投影</h5>
          <Seg value={prefs.value.projection} options={PROJECTIONS} titles={PROJECTION_TITLES} onChange={(v) => setPrefs({ projection: v })} wide />
          <p class="hint">
            {PROJECTION_HINTS[prefs.value.projection]}
            {prefs.value.projection !== 'equirect' ? '风向、洋流、参考图只在等距圆柱里显示。' : ''}
          </p>
        </section>
      )}
      <section>
        <h5>显示</h5>
        {OVERLAYS.filter((o) => !o.planetOnly || planet).map((o) => (
          <>
            <Toggle on={overlays.value[o.key]} onChange={(on) => (overlays.value = { ...overlays.value, [o.key]: on })} title={(planet && o.planetHint) || o.hint}>
              {(planet && o.planetLabel) || o.label}
            </Toggle>
            {o.key === 'labels' && overlays.value.labels && (
              <div class="sub-checks">
                {LABEL_GROUPS.map(({ group, label }) => (
                  <label class="check">
                    <input
                      type="checkbox"
                      checked={labelGroups.value.has(group)}
                      onChange={() => {
                        const s = new Set(labelGroups.value);
                        if (s.has(group)) s.delete(group);
                        else s.add(group);
                        labelGroups.value = s;
                      }}
                    />
                    {label}
                  </label>
                ))}
              </div>
            )}
          </>
        ))}
      </section>
      <section>
        <h5>季节</h5>
        <Seg value={season.value} options={SEASONS} onChange={(v) => (season.value = v)} wide />
      </section>
      <ReferenceBox />
    </>
  );
}
