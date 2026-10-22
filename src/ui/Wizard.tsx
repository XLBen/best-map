import { useEffect, useRef, useState } from 'preact/hooks';
import { WORLD_TYPES, WORLD_TYPE_INFO, type WorldType } from '../../core/generate';
import {
  CLIMATE_ZONES,
  type ClimateZone,
  LAT_BELTS,
  MAP_SIZES,
  type MapSize,
  PLANET_SIZES,
  PLANET_TYPES,
  type PlanetSize,
  type PlanetType,
  TYPE_DEFAULTS,
  beltsIn,
  clampCenter,
  equatorText,
  latSpan,
  latText,
  planetSettings,
  settingsAt,
} from '../../core/presets';
import { autosaved, loadDoc, newWorld, readAutosave, thumbnail, wizardOpen, world } from '../state';
import { resetTools } from './defs/tools';

// 新建向导：先选一块地区还是整个星球。
// 一块地区：选世界类型、大小、放在星球的哪里；整个星球：选星球类型、大小。
// → Worker 用 4000 格生成 6 张缩略图 → 点一张开始。
// 缩略图与成品的大格局一致（生成器的随机都按地图上的位置取，与格数无关）。
// 地图本来就跨好几个气候带：第 3 步只是把它放在星球上的某个纬度

const THUMB_W = 240;
const THUMB_H = 120;
const COUNT = 6;
const CELLS = 40000;
// 整个星球默认精细：约 10 万格（类地星球每格约 75 km）
const PLANET_CELLS = 100000;

// 星球竖条：从北极到南极画出各气候带，地图的纬度范围是上面一个可以拖的窗
const STRIP_H = 168;
function PlanetBand({ size, center, onChange }: { size: MapSize; center: number; onChange: (c: number) => void }) {
  const strip = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(false);
  const span = latSpan(size);
  const north = center + span / 2;
  const south = center - span / 2;
  const y = (lat: number) => ((90 - lat) / 180) * STRIP_H;
  const setFrom = (e: PointerEvent) => {
    const r = strip.current!.getBoundingClientRect();
    onChange(clampCenter(size, Math.round(90 - ((e.clientY - r.top) / r.height) * 180)));
  };
  // 南北半球各画一遍
  const belts = LAT_BELTS.flatMap((b) => [
    { ...b, top: y(b.to), h: y(b.from) - y(b.to) },
    { ...b, top: y(-b.from), h: y(-b.to) - y(-b.from) },
  ]);
  return (
    <div class="planet">
      <div
        class="planet-strip"
        ref={strip}
        style={{ height: `${STRIP_H}px` }}
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          setDrag(true);
          setFrom(e);
        }}
        onPointerMove={(e) => drag && setFrom(e)}
        onPointerUp={() => setDrag(false)}
        title="拖动选地图在星球上的位置"
      >
        {belts.map((b) => (
          <div class="belt" style={{ top: `${b.top}px`, height: `${b.h}px`, background: b.color }} />
        ))}
        <div class="equator" style={{ top: `${y(0)}px` }} />
        <div class="band" style={{ top: `${y(north)}px`, height: `${y(south) - y(north)}px` }} />
      </div>
      <div class="planet-info">
        <b>
          {latText(north)} — {latText(south)}
        </b>
        <span class="muted small">包括 {beltsIn(north, south).join('、')}</span>
        <span class="muted small">地图里本来就有好几种气候：越往极地越冷，靠海、山上也都不一样。这里只是选地图放在星球上的哪里。</span>
        <div class="row wrap">
          {(Object.keys(CLIMATE_ZONES) as ClimateZone[]).map((z) => (
            <button class="small" title={CLIMATE_ZONES[z].hint} onClick={() => onChange(clampCenter(size, CLIMATE_ZONES[z].lat))}>
              {CLIMATE_ZONES[z].name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Thumb({ data, onPick, label }: { data: Uint8ClampedArray | null; onPick: () => void; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !data) return;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data), THUMB_W, THUMB_H), 0, 0);
  }, [data]);
  return (
    <button class={`thumb ${data ? '' : 'loading'}`} onClick={onPick} disabled={!data}>
      <canvas ref={ref} width={THUMB_W} height={THUMB_H} />
      <span>{label}</span>
    </button>
  );
}

const randomBase = () => Math.floor(Math.random() * 1e6);

export function Wizard() {
  const [kind, setKind] = useState<'region' | 'planet'>('region');
  const [ptype, setPtype] = useState<PlanetType>('continents');
  const [psize, setPsize] = useState<PlanetSize>('earth');
  const [type, setType] = useState<WorldType>('archipelago');
  const [size, setSize] = useState<MapSize>(TYPE_DEFAULTS.archipelago.size);
  // 地图的中心放在哪个纬度
  const [center, setCenter] = useState<number>(CLIMATE_ZONES[TYPE_DEFAULTS.archipelago.zone].lat);
  const [base, setBase] = useState(randomBase);
  const [thumbs, setThumbs] = useState<(Uint8ClampedArray | null)[]>(Array(COUNT).fill(null));
  const [creating, setCreating] = useState(false);
  const request = useRef(0);
  const savedAt = !world.value ? autosaved.value : null;

  const seeds = Array.from({ length: COUNT }, (_, k) => (base + k * 7919) % 0xffffffff);
  const planet = PLANET_TYPES.find((t) => t.key === ptype)!;
  const genOf = (seed: number) => (kind === 'planet' ? { seed, type: planet.type, islands: planet.islands } : { seed, type });
  const settingsOf = (cells: number) => (kind === 'planet' ? planetSettings(psize, cells) : settingsAt(size, center, cells));

  useEffect(() => {
    if (!wizardOpen.value) return;
    const id = ++request.current;
    setThumbs(Array(COUNT).fill(null));
    // 一张一张要：画好一张显示一张；选项又变了就不再要这一组剩下的
    const timer = setTimeout(async () => {
      for (let k = 0; k < COUNT && request.current === id; k++) {
        const t = await thumbnail(settingsOf(4000), genOf(seeds[k]), THUMB_W, THUMB_H);
        if (!t || request.current !== id) return;
        setThumbs((prev) => prev.map((p, j) => (j === k ? t : p)));
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [kind, ptype, psize, type, size, center, base, wizardOpen.value]);

  if (!wizardOpen.value) return null;

  const chooseType = (t: WorldType) => {
    setType(t);
    setSize(TYPE_DEFAULTS[t].size);
    setCenter(clampCenter(TYPE_DEFAULTS[t].size, CLIMATE_ZONES[TYPE_DEFAULTS[t].zone].lat));
  };
  const chooseSize = (z: MapSize) => {
    setSize(z);
    setCenter((c) => clampCenter(z, c));
  };

  const pick = async (seed: number) => {
    setCreating(true);
    const gen = genOf(seed);
    const ok = await newWorld(settingsOf(kind === 'planet' ? PLANET_CELLS : CELLS), [
      // 山挡风在划分省份之前打开（省份按拐过的风算出的气候来分）。与生成放在同一步里：只算一遍，历史里也只有“新世界”
      {
        op: 'batch',
        label: `新世界：${WORLD_TYPE_INFO[gen.type].name}`,
        commands: [
          { op: 'set_worldgen', params: gen, reset: true },
          { op: 'set_planet', patch: { terrainWind: 1 } },
        ],
      },
      { op: 'generate_provinces', rules: { seed } },
    ]);
    setCreating(false);
    if (ok) {
      wizardOpen.value = false;
      resetTools();
    }
  };

  return (
    <div class="modal-backdrop">
      <div class="modal wizard">
        <div class="row between">
          <h2>新建世界</h2>
          {world.value && (
            <button onClick={() => (wizardOpen.value = false)} disabled={creating}>
              取消
            </button>
          )}
        </div>
        {savedAt !== null && (
          <div class="box resume">
            <span>上次的世界自动保存在这个浏览器里（{new Date(savedAt).toLocaleString()}）。</span>
            <button
              class="primary"
              disabled={creating}
              onClick={async () => {
                setCreating(true);
                const saved = await readAutosave();
                const ok = saved ? await loadDoc(saved.doc) : false;
                setCreating(false);
                if (ok) wizardOpen.value = false;
              }}
            >
              继续上次的世界
            </button>
          </div>
        )}
        <div class="seg wide">
          <button class={kind === 'region' ? 'on' : ''} onClick={() => setKind('region')} disabled={creating}>
            一块地区
          </button>
          <button class={kind === 'planet' ? 'on' : ''} onClick={() => setKind('planet')} disabled={creating}>
            整个星球
          </button>
        </div>
        {kind === 'region' ? (
          <>
            <h4>1. 选一种世界</h4>
            <div class="cards three">
              {WORLD_TYPES.map((t) => (
                <button class={`card ${type === t ? 'on' : ''}`} onClick={() => chooseType(t)}>
                  <b>{WORLD_TYPE_INFO[t].name}</b>
                  <span class="how">{WORLD_TYPE_INFO[t].hint}</span>
                </button>
              ))}
            </div>
            <div class="grid2">
              <div>
                <h4>2. 多大</h4>
                <div class="cards">
                  {(Object.keys(MAP_SIZES) as MapSize[]).map((s) => (
                    <button class={`card ${size === s ? 'on' : ''}`} onClick={() => chooseSize(s)}>
                      <b>{MAP_SIZES[s].name}</b>
                      <span class="how">{MAP_SIZES[s].hint}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <h4>3. 放在星球的哪里</h4>
                <PlanetBand size={size} center={center} onChange={setCenter} />
              </div>
            </div>
          </>
        ) : (
          <>
            <h4>1. 选一种星球</h4>
            <div class="cards three">
              {PLANET_TYPES.map((t) => (
                <button class={`card ${ptype === t.key ? 'on' : ''}`} onClick={() => setPtype(t.key)}>
                  <b>{t.name}</b>
                  <span class="how">{t.hint}</span>
                </button>
              ))}
            </div>
            <h4>2. 多大</h4>
            <div class="cards three">
              {(Object.keys(PLANET_SIZES) as PlanetSize[]).map((s) => (
                <button class={`card ${psize === s ? 'on' : ''}`} onClick={() => setPsize(s)}>
                  <b>{PLANET_SIZES[s].name}</b>
                  <span class="how">
                    半径约 {PLANET_SIZES[s].radiusKm.toLocaleString()} km，{equatorText(PLANET_SIZES[s].radiusKm)}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
        <div class="row between">
          <h4>{kind === 'region' ? 4 : 3}. 挑一张开始</h4>
          <button onClick={() => setBase(randomBase())} disabled={creating}>
            换一组
          </button>
        </div>
        <div class="thumbs">
          {seeds.map((seed, k) => (
            <Thumb data={thumbs[k]} label={`第 ${k + 1} 个`} onPick={() => void pick(seed)} />
          ))}
        </div>
        <p class="muted small">
          {kind === 'planet' ? '整个星球平铺成一张图：左右两边连着，上下是南北极。' : ''}
          缩略图是同一个世界的粗略版：挑中后会用更精细的网格生成，大格局不变。{creating ? ' 正在生成，请稍等…' : ''}
        </p>
      </div>
    </div>
  );
}
