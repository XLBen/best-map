import { useEffect, useRef, useState } from 'preact/hooks';
import { WORLD_TYPES, WORLD_TYPE_INFO, type WorldgenInput, type WorldType } from '../../core/generate';
import { type PlanetForm, hasFormScripts } from '../../core/planet-form';
import { CLIMATE_BELT_NOTE } from './copy';
import {
  CLIMATE_ZONES,
  type ClimateZone,
  LAT_BELTS,
  MAP_SIZES,
  type MapSize,
  PLANET_CELL_KM,
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
  planetCells,
  planetSettings,
  settingsAt,
} from '../../core/presets';
import { library, refreshLibrary } from '../library';
import { autosaved, newWorld, resumeLast, safeMode, thumbnail, trustFormScripts, wizardOpen, world } from '../state';
import { resetTools } from './defs/tools';
import { FormEditor } from './FormEditor';
import { closeFormEditor, openFormEditor } from './form-store';
import { type FormChoice, blankForm, formChoices, formGen, formSource, newWorldCommands, planetTypeName, wizardWorldName } from './forms';
import { RES, fromPos, toPos } from './panels/AdjustPanel';
import { Seg } from './common';
import { Slider } from './components/Slider';
import { TERRAIN_SLIDERS, type TerrainKey, type TerrainSlider, type WizardTerrain, terrainCommands, terrainDefaults, withTerrain } from './wizardTerrain';
import { Toggle } from './components/Toggle';
import { HumanChoices } from './panels/culture';
import { type HumanChoice, defaultChoice, eraChoices, estimateLandKm2, generateCommand } from './human';

// 新建向导：先选一块地区还是整个星球。
// 一块地区：选世界类型、大小、放在星球的哪里；整个星球：选星球类型（六种之后是星球形态：内置的示例和资源库里装的，
// 带脚本的标上“脚本”，卡片上的“编辑…”打开形态编辑器）、大小。
// → Worker 用 4000 格生成 6 张缩略图 → 点一张开始。
// 缩略图与成品的大格局一致（生成器的随机都按地图上的位置取，与格数无关）。
// 地图本来就跨好几个气候带：第 3 步只是把它放在星球上的某个纬度。
// “地形”（第十四轮从“调整”挪过来）：陆地多少、岛多少、山多高、海岸曲折、最高的山；不动就是这种世界本来的样子。
// “人文”（第二十二轮）：要不要生成人文，时代、文化组与各占多少、总人口（按地图的面积 × 陆地多少估，建好后按真的陆地面积）。缩略图不画人文

const THUMB_W = 240;
const THUMB_H = 120;
const COUNT = 6;
const CELLS = 40000;
// 整个星球每格约 100 km：格数随半径（小 1.78 万、类地 6.26 万、大 13.92 万），见 core/presets.ts 的 planetCells

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
        <span class="hint">包括 {beltsIn(north, south).join('、')}</span>
        <span class="hint">{CLIMATE_BELT_NOTE}</span>
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
    <button class={`thumb ${data ? '' : 'pending'}`} onClick={onPick} disabled={!data}>
      <canvas ref={ref} width={THUMB_W} height={THUMB_H} />
      <span>{label}</span>
    </button>
  );
}

// 向导里的一个地形滑块：拖的时候只改写的数，松手才换（缩略图松手后重画）
function TerrainRow({ s, value, base, onChange }: { s: TerrainSlider; value: number; base: number; onChange: (v: number) => void }) {
  const [draft, setDraft] = useState<number | null>(null);
  const v = draft ?? value;
  const at = (p: number) => fromPos(s, p * RES, s.range);
  return (
    <Slider
      stacked
      label={s.label}
      title={s.hint}
      changed={Math.abs(v - base) >= s.step / 2}
      pos={toPos(s, v, s.range) / RES}
      text={s.format(v)}
      onDraft={(p) => setDraft(at(p))}
      onCommit={(p) => {
        setDraft(null);
        onChange(at(p));
      }}
      onCancel={() => setDraft(null)}
    />
  );
}

function TerrainBox({ defaults, value, onChange }: { defaults: Record<TerrainKey, number>; value: WizardTerrain; onChange: (t: WizardTerrain) => void }) {
  const touched = Object.keys(value).length > 0;
  return (
    <div class="wizard-terrain">
      <div class="grid2">
        {TERRAIN_SLIDERS.map((s) => (
          <TerrainRow s={s} value={value[s.key] ?? defaults[s.key]} base={defaults[s.key]} onChange={(v) => onChange({ ...value, [s.key]: v })} />
        ))}
      </div>
      <p class="hint">
        不调时按这种世界生成；建好后用“地形”里的工具改。
        {touched && (
          <button class="link" onClick={() => onChange({})}>
            恢复自动
          </button>
        )}
      </p>
    </div>
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
  // 地形：只记动过的几项
  const [terrain, setTerrain] = useState<WizardTerrain>({});
  // 人文：默认生成（内置的第一个时代与它的文化组）
  const [human, setHuman] = useState<HumanChoice>(() => defaultChoice(null, true));
  const request = useRef(0);
  const savedAt = !world.value ? autosaved.value : null;

  const seeds = Array.from({ length: COUNT }, (_, k) => (base + k * 7919) % 0xffffffff);
  // 星球形态：内置的示例与资源库里装的（打开向导时再读一遍资源库）
  const choices = formChoices(library.value);
  const chosen = choices.find((c) => c.key === ptype);
  const planet = PLANET_TYPES.find((t) => t.key === ptype) ?? PLANET_TYPES[0];
  const baseGen = (seed: number): WorldgenInput =>
    kind === 'planet' ? (chosen ? formGen(seed, chosen.form) : { seed, type: planet.type, islands: planet.islands }) : { seed, type };
  const genOf = (seed: number): WorldgenInput => withTerrain(baseGen(seed), terrain);
  // 这种世界不动滑块时的地形（陆地多少、岛多少按世界类型、星球形态）
  const terrainBase = terrainDefaults(baseGen(0), kind === 'planet');
  // 历史里的“新世界：像地球”“新世界：双子大陆”
  const nameOf = () => wizardWorldName(kind, ptype, choices, type);
  const settingsOf = (cells: number) => (kind === 'planet' ? planetSettings(psize, cells) : settingsAt(size, center, cells));
  // 缩略图按形态的内容重算（资源库每读一遍都是新的对象，内容没变时不重算）
  const formKey = chosen ? JSON.stringify(chosen.form) : '';
  // 陆地多少、岛多少各种世界不一样：换了世界的种类就回到那一种的默认（别的几项照旧）
  useEffect(() => {
    setTerrain((t) => {
      if (t.landFraction === undefined && t.islands === undefined) return t;
      const { landFraction: _l, islands: _i, ...rest } = t;
      return rest;
    });
  }, [kind, type, ptype]);
  const terrainKey = JSON.stringify([terrain.landFraction, terrain.islands, terrain.mountains]);

  useEffect(() => {
    if (!wizardOpen.value) {
      closeFormEditor();
      return;
    }
    void refreshLibrary();
  }, [wizardOpen.value]);
  // 选着的形态不在资源库里了（删掉了）：换回“像地球”
  useEffect(() => {
    if (!chosen && !PLANET_TYPES.some((t) => t.key === ptype)) setPtype('continents');
  }, [chosen, ptype]);

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
  }, [kind, ptype, formKey, psize, type, size, center, base, terrainKey, wizardOpen.value]);

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

  // 新建：gen、name 是这个世界的生成参数和叫法；cells 是格数
  const create = async (gen: WorldgenInput, name: string, seed: number, cells: Parameters<typeof settingsOf>[0]): Promise<boolean> => {
    setCreating(true);
    const ok = await newWorld(settingsOf(cells), newWorldCommands(gen, name, seed, terrainCommands(terrain), generateCommand(human)));
    setCreating(false);
    if (ok) {
      wizardOpen.value = false;
      resetTools();
    }
    return ok;
  };
  // 总人口的默认：时代的默认密度 × 估的陆地面积
  const era = eraChoices(null).find((e) => e.id === human.era);
  const landKm2 = estimateLandKm2({ globe: kind === 'planet', radiusKm: PLANET_SIZES[psize].radiusKm, mapKm: MAP_SIZES[size].km, landFraction: terrain.landFraction ?? terrainBase.landFraction });
  const popDefault = Math.round((era?.popDensity ?? 1) * landKm2);
  const humanBox = (
    <div class="wizard-human">
      <Toggle on={human.on} onChange={(on) => setHuman({ ...human, on })} disabled={creating}>
        生成人文
      </Toggle>
      {human.on ? <HumanChoices choice={human} onChange={setHuman} small={null} defaultPop={popDefault} disabled={creating} countries /> : <p class="hint">建好后可在“文化”里生成</p>}
    </div>
  );
  const pick = (seed: number) => void create(genOf(seed), nameOf(), seed, kind === 'planet' ? planetCells(PLANET_SIZES[psize].radiusKm) : CELLS);

  // 点一张形态的卡片：里面有没见过的脚本先问（缩略图就会运行它），不信任就不选
  const chooseForm = async (c: FormChoice) => {
    if (await trustFormScripts(c.form)) setPtype(c.key);
  };
  // 编辑一个形态（c 为 null：自己做一个）。编辑器里的缩略图会运行脚本，没见过的先问
  const editForm = async (c: FormChoice | null) => {
    if (c && !(await trustFormScripts(c.form))) return;
    const initial: PlanetForm = c ? structuredClone(c.form) : blankForm();
    openFormEditor({
      initial,
      original: c?.form ?? null,
      originalKey: c?.key ?? null,
      mine: c?.mine ?? false,
      others: choices.map((x) => x.form),
      settings: planetSettings(psize, 4000),
      radiusKm: PLANET_SIZES[psize].radiusKm,
      seed: seeds[0],
      onSaved: (_f, key) => setPtype(key),
      // 形态里有自己的陆地多少、岛多少：向导“地形”里只带上山多高、海岸曲折、最高的山
      onCreate: (f, seed) => create(withTerrain(formGen(seed, f), { mountains: terrain.mountains }), f.name, seed, planetCells(PLANET_SIZES[psize].radiusKm)),
    });
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
            <span>上次的世界已自动保存（{new Date(savedAt).toLocaleString()}）</span>
            <button
              class="primary"
              disabled={creating}
              onClick={async () => {
                setCreating(true);
                const ok = await resumeLast();
                setCreating(false);
                if (ok) wizardOpen.value = false;
              }}
            >
              继续上次的世界
            </button>
          </div>
        )}
        <Seg<'region' | 'planet'>
          value={kind}
          options={[
            ['region', '一块地区'],
            ['planet', '整个星球'],
          ]}
          onChange={setKind}
          disabled={creating}
          wide
        />
        {kind === 'region' ? (
          <>
            <h5>1. 选一种世界</h5>
            <div class="cards three">
              {WORLD_TYPES.map((t) => (
                <button class={`card ${type === t ? 'on' : ''}`} onClick={() => chooseType(t)}>
                  <b>{WORLD_TYPE_INFO[t].name}</b>
                  <span class="hint">{WORLD_TYPE_INFO[t].hint}</span>
                </button>
              ))}
            </div>
            <div class="grid2">
              <div>
                <h5>2. 多大</h5>
                <div class="cards">
                  {(Object.keys(MAP_SIZES) as MapSize[]).map((s) => (
                    <button class={`card ${size === s ? 'on' : ''}`} onClick={() => chooseSize(s)}>
                      <b>{MAP_SIZES[s].name}</b>
                      <span class="hint">{MAP_SIZES[s].hint}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <h5>3. 放在星球的哪里</h5>
                <PlanetBand size={size} center={center} onChange={setCenter} />
              </div>
            </div>
            <h5>4. 地形</h5>
            <TerrainBox defaults={terrainBase} value={terrain} onChange={setTerrain} />
            <h5>5. 人文</h5>
            {humanBox}
          </>
        ) : (
          <>
            <h5>1. 选一种星球</h5>
            <div class="cards three">
              {PLANET_TYPES.map((t) => (
                <button class={`card ${ptype === t.key ? 'on' : ''}`} onClick={() => setPtype(t.key)}>
                  <b>{t.name}</b>
                  <span class="hint">{t.hint}</span>
                </button>
              ))}
            </div>
            <h5>星球形态</h5>
            <div class="cards three">
              {choices.map((c) => (
                <div class="form-card">
                  <button class={`card ${ptype === c.key ? 'on' : ''}`} onClick={() => void chooseForm(c)} disabled={creating}>
                    <b>
                      {c.form.name}
                      {hasFormScripts(c.form) && <span class="tag">脚本</span>}
                    </b>
                    <span class="hint">{c.form.hint ?? `从“${planetTypeName(c.form.base)}”改起`}</span>
                    {!c.builtin && <span class="hint">{formSource(c)}</span>}
                  </button>
                  <button class="small ghost form-edit" onClick={() => void editForm(c)} disabled={creating} title="改名字、滑块、脚本">
                    编辑…
                  </button>
                </div>
              ))}
              <button class="card dashed" onClick={() => void editForm(null)} disabled={creating}>
                <b>新建…</b>
                <span class="hint">从一种星球改起，可写脚本</span>
              </button>
            </div>
            {safeMode.value && chosen && hasFormScripts(chosen.form) && <p class="hint">安全模式：缩略图不含脚本的效果</p>}
            <h5>2. 多大</h5>
            <div class="cards three">
              {(Object.keys(PLANET_SIZES) as PlanetSize[]).map((s) => (
                <button class={`card ${psize === s ? 'on' : ''}`} onClick={() => setPsize(s)}>
                  <b>{PLANET_SIZES[s].name}</b>
                  <span class="hint">
                    半径约 {PLANET_SIZES[s].radiusKm.toLocaleString()} km，{equatorText(PLANET_SIZES[s].radiusKm)}
                  </span>
                  <span class="hint">每格约 {PLANET_CELL_KM} km</span>
                </button>
              ))}
            </div>
            <h5>3. 地形</h5>
            <TerrainBox defaults={terrainBase} value={terrain} onChange={setTerrain} />
            <h5>4. 人文</h5>
            {humanBox}
          </>
        )}
        <div class="row between">
          <h5>{kind === 'region' ? 6 : 5}. 挑一张开始</h5>
          <button onClick={() => setBase(randomBase())} disabled={creating}>
            换一组
          </button>
        </div>
        <div class="thumbs">
          {seeds.map((seed, k) => (
            <Thumb data={thumbs[k]} label={`第 ${k + 1} 个`} onPick={() => void pick(seed)} />
          ))}
        </div>
        <p class="hint">
          {kind === 'planet' ? '左右相连，上下是两极。' : ''}
          缩略图是粗略版，看不到很小的岛。{creating ? ' 正在生成…' : ''}
        </p>
      </div>
      <FormEditor />
    </div>
  );
}
