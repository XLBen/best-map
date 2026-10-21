import { useRef, useState } from 'preact/hooks';
import { labelGroups, mapStyle, mode, overlays, reference, season, setReference, showToast, world } from '../../state';
import { Seg } from '../common';
import { LABEL_GROUPS, OVERLAYS, SEASONS, VIEWS } from '../defs/layers';

// “图层”：底图着色、画风、叠加在上面的东西、季节、参考图

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
          <p class="muted small">
            把手绘的草图铺在地图上，照着画陆地。{world.value?.settings.globe ? '整个星球的草图：宽是高的两倍，左右两边接得上。' : ''}图只存在这个浏览器里，不写进世界文件，也不进导出的图片。
          </p>
          <button onClick={pick}>导入图片…</button>
        </>
      ) : (
        <>
          <label class="check">
            <input type="checkbox" checked={r.visible} onChange={() => void setReference({ ...r, visible: !r.visible })} />
            显示参考图
          </label>
          <label class={`adj-row ${r.visible ? '' : 'off'}`}>
            <span class="row between">
              <span>浓淡</span>
              <span class="muted">{Math.round(r.opacity * 100)}%</span>
            </span>
            <input
              type="range"
              min={10}
              max={100}
              step={5}
              disabled={!r.visible}
              value={Math.round(r.opacity * 100)}
              onInput={(e) => void setReference({ ...r, opacity: Number((e.target as HTMLInputElement).value) / 100 }, false)}
              onChange={() => reference.value && void setReference(reference.value)}
            />
          </label>
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
    <button class={mode.value === id ? 'on' : ''} onClick={() => (mode.value = id)}>
      {label}
    </button>
  );
  const hint = VIEWS.find((v) => v.id === mode.value)?.hint;
  return (
    <>
      <section>
        <h5>底图</h5>
        <div class="view-grid">{VIEWS.filter((v) => !v.more).map((v) => viewButton(v.id, v.label))}</div>
        <button class="link" onClick={() => setMore(!more)}>
          {more ? '收起' : '更多底图…'}
        </button>
        {more && (
          <div class="view-grid">
            {VIEWS.filter((v) => v.more).map((v) => viewButton(v.id, v.label))}
            {fields.map((f) => viewButton(`field:${f}`, `场：${f}`))}
          </div>
        )}
        {hint && <p class="muted small">{hint}</p>}
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
      <section>
        <h5>显示</h5>
        {OVERLAYS.filter((o) => !o.planetOnly || planet).map((o) => (
          <>
            <label class="check">
              <input type="checkbox" checked={overlays.value[o.key]} onChange={() => (overlays.value = { ...overlays.value, [o.key]: !overlays.value[o.key] })} />
              {(planet && o.planetLabel) || o.label}
              {((planet && o.planetHint) || o.hint) && <span class="muted small">（{(planet && o.planetHint) || o.hint}）</span>}
            </label>
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
