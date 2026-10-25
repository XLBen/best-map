import { useEffect, useRef, useState } from 'preact/hooks';
import { speciesColor } from '../../../core/species';
import type { World } from '../../../core/world';
import { NAME_MODES } from '../../../core/name-display';
import { type ProjectionPref, type ViewMode, focusSpecies, labelGroups, mapKind, mapStyle, mode, nameMode, overlays, prefs, reference, season, setNameMode, setPrefs, setReference, showToast, world } from '../../state';
import { Seg } from '../common';
import { Slider, linear } from '../components/Slider';
import { Toggle } from '../components/Toggle';
import { CULTURE_VIEWS, LABEL_GROUPS, OVERLAYS, SEASONS, VIEWS, humanViews, suitabilityFocus } from '../defs/layers';
import { hasCountries, setMapKind } from '../countries';
import { hasAnySettle } from '../settlements';
import { MAP_KINDS, MAP_KIND_TITLES } from '../shell/MapKind';

// 整个星球的投影（第十三轮 G4）：只是看的方式，存在这个浏览器里，不写进世界文件
const PROJECTIONS: [ProjectionPref, string][] = [
  ['equirect', '等距圆柱'],
  ['equalEarth', '等面积'],
  ['globe', '球形'],
];
const PROJECTION_TITLES: Record<ProjectionPref, string> = {
  equirect: '2:1 的长方形',
  equalEarth: '椭圆，面积按真实比例',
  globe: '从太空看，拖动转动',
};
const PROJECTION_HINTS: Record<ProjectionPref, string> = {
  equirect: '越靠近两极，横向拉得越宽。',
  equalEarth: '面积按真实比例，两极不拉宽。',
  globe: '拖动转动，越往边上挤得越紧。',
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
      showToast(ok ? '参考图已铺好' : '参考图存不进浏览器，关闭页面后要重新导入', !ok);
    } catch {
      showToast('无法读取这张图，请换 PNG 或 JPG', true);
    }
  };
  return (
    <section>
      <h5>参考图</h5>
      <input ref={file} type="file" accept="image/*" hidden onChange={onFile} />
      {!r ? (
        <>
          <p class="hint">
            铺一张草图，照着画陆地。{world.value?.settings.globe ? '宽是高的两倍。' : ''}只存在这个浏览器里。
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
            titles={{ contain: '按原比例放在中间', stretch: '拉伸到整张地图' }}
            onChange={(fit) => void setReference({ ...r, fit })}
            wide
          />
          <div class="row">
            <button onClick={pick}>换一张…</button>
            <button onClick={() => void setReference(null)}>删除</button>
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
  const human = humanViews(w);
  const hint = [...VIEWS, ...human].find((v) => v.id === mode.value)?.hint;
  return (
    <>
      {hasCountries(w) && (
        <section>
          <h5>地图</h5>
          <Seg value={mapKind.value} options={MAP_KINDS} titles={MAP_KIND_TITLES} onChange={setMapKind} wide />
          <p class="hint">{mapKind.value === 'political' ? '国界、国名；自然的地名只留海、湖、山脉' : '地貌与自然的地名'}</p>
        </section>
      )}
      <section>
        <h5>底图</h5>
        <div class="view-grid">{VIEWS.filter((v) => !v.more).map((v) => viewButton(v.id, v.label))}</div>
        <button class="link-btn" onClick={() => setMore(!more)}>
          {more ? '更少底图' : '更多底图'}
        </button>
        {more && (
          <div class="view-grid">
            {VIEWS.filter((v) => v.more).map((v) => viewButton(v.id, v.label))}
            {fields.map((f) => viewButton(`field:${f}`, `场：${f}`))}
          </div>
        )}
        {hint && VIEWS.some((v) => v.id === mode.value) && <p class="hint">{hint}</p>}
        {mode.value === 'suitability' && <SuitabilityPick w={w} />}
      </section>
      <section>
        <h5>人文</h5>
        <div class="view-grid">
          {human.map((v) =>
            v.id === 'culture' ? (
              <button class={mode.value === 'culture' || mode.value === 'cultureGroup' ? 'on' : ''} onClick={() => showView(mode.value === 'cultureGroup' ? 'cultureGroup' : 'culture')}>
                {v.label}
              </button>
            ) : (
              viewButton(v.id, v.label)
            ),
          )}
        </div>
        {(mode.value === 'culture' || mode.value === 'cultureGroup') && <Seg value={mode.value} options={CULTURE_VIEWS} onChange={showView} wide />}
        {!w.small.human && <p class="hint">生成人文后有文化圈、人口密度</p>}
        {hint && human.some((v) => v.id === mode.value) && <p class="hint">{hint}</p>}
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
        {OVERLAYS.filter((o) => (!o.planetOnly || planet) && (!o.settle || (w && hasAnySettle(w)))).map((o) => (
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
                {/* 中文 / 原文 / 两者：只是显示，不改世界；没有原文的名字照旧写中文 */}
                <Seg value={nameMode.value} options={NAME_MODES.map((m): [typeof m.id, string] => [m.id, m.label])} onChange={setNameMode} titles={{ orig: '没有原文的照旧写中文' }} wide />
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
