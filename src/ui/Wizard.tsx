import { CircleHelp } from 'lucide-preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { WORLD_TYPES, WORLD_TYPE_INFO, type WorldgenInput, type WorldType } from '../../core/generate';
import { type PlanetForm, hasFormScripts } from '../../core/planet-form';
import { CLIMATE_BELT_NOTE, ERA_NOTE, STOP_TEXT, WIZARD_MINE_NOTE } from './copy';
import { BusyLine } from './shell/BusyLine';
import {
  CLIMATE_ZONES,
  type ClimateZone,
  LAT_BELTS,
  MAP_SIZES,
  type MapSize,
  PLANET_CELL_KM,
  PLANET_SIZES,
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
} from '../../core/presets';
import { library, refreshLibrary } from '../library';
import { autosaved, busy, helpOpen, newWorld, progressView, resumeLast, safeMode, stalled, thumbnail, toast, trustFormScripts, wizardOpen, world } from '../state';
import { BackupBanner } from './shell/BackupBanner';
import { resetTools } from './defs/tools';
import { FormEditor } from './FormEditor';
import { closeFormEditor, openFormEditor } from './form-store';
import { type FormChoice, blankForm, formChoices, formGen, formSource, formsInPacks, isBuiltinPlanet, planetTypeName } from './domain/forms';
import { type WizardChoice, chosenForm, defaultWizardChoice, wizardBaseGen, wizardCommands, wizardGen, wizardSettings, wizardSummary, wizardWorld } from './domain/wizardChoice';
import { setWizardCustom, wizardCustom } from './wizard-prefs';
import { RES, fromPos, toPos } from './panels/AdjustPanel';
import { ModalHead, Seg } from './common';
import { Slider } from './components/Slider';
import { TERRAIN_SLIDERS, type TerrainKey, type TerrainSlider, type WizardTerrain, terrainDefaults, withTerrain } from './domain/wizardTerrain';
import { Toggle } from './components/Toggle';
import { HumanChoices } from './panels/culture';
import { type HumanChoice, chooseLibrary, groupByPack } from './domain/human';
import { LibraryPick } from './components/LibraryPick';
import { openGenSettings } from './packs/open-era';
import { GEN_AFTER_CREATE } from './packs/copy';
import { choicePacks, libraryOptions, packLabel, worldContentCommands } from './domain/packChoice';
import { HELP_KEY_TIP } from './copy';

// 新建向导。第九十八轮：第一屏就是一排缩略图——上面“一块地区 / 整个星球”，一句“挑一张开始”，旁边“换一批”和“自定义…”；
// 别的（世界的种类、多大、放在星球哪里、地形的滑块、库与文化组、人文的开关）都收在“自定义…”里（在原地展开，展开过就记在这台机器上，
// wizard-prefs.ts），收着时一行小字写明现在用的是什么。什么都不选时的默认、点一张发出去的命令在 domain/wizardChoice.ts。
// “自定义…”里：一块地区选世界类型、大小、放在星球的哪里；整个星球选星球类型（六种之后是星球形态：内置的示例和资源库里装的，
// 带脚本的标上“脚本”，卡片上的“编辑…”打开形态编辑器）、大小。
// Worker 用 4000 格生成 6 张缩略图 → 点一张开始。
// 缩略图与成品的大格局一致（生成器的随机都按地图上的位置取，与格数无关）。
// 地图本来就跨好几个气候带：第 3 步只是把它放在星球上的某个纬度。
// “地形”（第十四轮从“调整”挪过来）：陆地多少、岛多少、山多高、海岸曲折、最高的山；不动就是这种世界本来的样子。
// “库”（第五十二轮）：选一个库，默认中世纪与近世。世界的底子（基础、自然、中文地名、画风、国家等级）在新建的那一步里加进世界
// （缩略图也按它们画），库里生成要用的在生成人文时加。星球形态只列这个库里的，别的库里的收在“其他库里的形态”里。
// “人文”（第二十二轮）：要不要生成人文，文化组（库里的）与各占多少、总人口（按地图的面积 × 陆地多少估，建好后按真的
// 陆地面积）。缩略图不画人文

const THUMB_W = 240;
const THUMB_H = 120;
const COUNT = 6;
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
      textAt={(p) => s.format(at(p))}
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
  // 一打开时的选择（第九十八轮：默认值在 domain/wizardChoice.ts，和以前逐项相同）
  const [first] = useState(() => defaultWizardChoice(library.value));
  const [kind, setKind] = useState<'region' | 'planet'>(first.kind);
  const [ptype, setPtype] = useState<PlanetType>(first.ptype);
  const [psize, setPsize] = useState<PlanetSize>(first.psize);
  const [type, setType] = useState<WorldType>(first.type);
  const [size, setSize] = useState<MapSize>(first.size);
  // 地图的中心放在哪个纬度
  const [center, setCenter] = useState<number>(first.center);
  const [base, setBase] = useState(randomBase);
  const [thumbs, setThumbs] = useState<(Uint8ClampedArray | null)[]>(Array(COUNT).fill(null));
  const [creating, setCreating] = useState(false);
  // 地形：只记动过的几项
  const [terrain, setTerrain] = useState<WizardTerrain>(first.terrain);
  // 库与人文：选的库（默认中世纪与近世）、生成人文（库默认带的文化组）
  const [human, setHuman] = useState<HumanChoice>(first.human);
  // 别的库里的星球形态：展开着
  const [moreForms, setMoreForms] = useState(false);
  // 第八十一轮：建好后打开资源库的“生成设置”（国家大小、人口、省份大小；向导里不另放这几个滑块）
  const [openGen, setOpenGen] = useState(false);
  const request = useRef(0);
  // 向导自己能滚的那一层（.modal-backdrop）：“回到缩略图”只滚它（第九十九轮；以前用 scrollIntoView，连外面的也滚了，整个向导往上挪了一截）
  const scroller = useRef<HTMLDivElement>(null);
  const savedAt = !world.value ? autosaved.value : null;
  // “自定义…”展开着（记在这台机器上）
  const custom = wizardCustom();

  const seeds = Array.from({ length: COUNT }, (_, k) => (base + k * 7919) % 0xffffffff);
  // 星球形态：内置的示例与资源库里装的（打开向导时再读一遍资源库）
  const lib = library.value;
  const choices = formChoices(lib);
  const choice: WizardChoice = { kind, ptype, psize, type, size, center, terrain, human };
  // 第三十轮：星球形态只列选的库里的（库里的“星球形态”是以前写死的 PLANET_TYPES），别的库里的收着
  const { shown, rest } = formsInPacks(choices, choicePacks(human));
  const chosen = chosenForm(choice, choices);
  const showRest = moreForms || !shown.length || rest.some((c) => c.key === ptype);
  // 新建那一步里加的内容（世界的底子）；缩略图按它画
  const thumbContent = useMemo(() => {
    const cmds = worldContentCommands(human, lib);
    return { cmds, key: JSON.stringify(cmds) };
  }, [human.library, lib]);
  const genOf = (seed: number): WorldgenInput => wizardGen(choice, seed, chosen);
  // 这种世界不动滑块时的地形（陆地多少、岛多少按世界类型、星球形态）
  const terrainBase = terrainDefaults(wizardBaseGen(choice, 0, chosen), kind === 'planet');
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
    if (!choices.some((c) => c.key === ptype)) setPtype(first.ptype);
  }, [chosen, ptype]);

  useEffect(() => {
    if (!wizardOpen.value) return;
    const id = ++request.current;
    setThumbs(Array(COUNT).fill(null));
    // 一张一张要：画好一张显示一张；选项又变了就不再要这一组剩下的
    const timer = setTimeout(async () => {
      for (let k = 0; k < COUNT && request.current === id; k++) {
        const t = await thumbnail(wizardSettings(choice, 4000), genOf(seeds[k]), THUMB_W, THUMB_H, thumbContent.cmds);
        if (!t || request.current !== id) return;
        setThumbs((prev) => prev.map((p, j) => (j === k ? t : p)));
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [kind, ptype, formKey, psize, type, size, center, base, terrainKey, thumbContent.key, wizardOpen.value]);

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

  // 新建：settings、commands 是这个世界的设置和命令
  const create = async (w: ReturnType<typeof wizardWorld>): Promise<boolean> => {
    setCreating(true);
    const ok = await newWorld(w.settings, w.commands);
    setCreating(false);
    if (ok) {
      wizardOpen.value = false;
      resetTools();
      if (openGen) openGenSettings();
    }
    return ok;
  };
  const humanBox = (
    <div class="wizard-human">
      <Toggle on={human.on} onChange={(on) => setHuman({ ...human, on })} disabled={creating}>
        生成人文
      </Toggle>
      {human.on ? <HumanChoices choice={human} onChange={setHuman} small={null} disabled={creating} countries picker={false} /> : <p class="hint">建好后可在“文化”里生成</p>}
    </div>
  );
  const contentBox = (
    <div class="wizard-content">
      <LibraryPick value={human.library} onChange={(key) => setHuman(chooseLibrary(human, key, lib))} options={libraryOptions(lib, true)} labelOf={(key) => packLabel(lib, [key])} disabled={creating} />
      <p class="hint">{ERA_NOTE}。建好后可以从别的库添加内容。</p>
      {/* 第九十二轮：“存到我的库”存进去的那个库就在这里选 */}
      {libraryOptions(lib, true).some((o) => !o.builtin) && <p class="hint">{WIZARD_MINE_NOTE}</p>}
      <Toggle on={openGen} onChange={setOpenGen} disabled={creating}>
        {GEN_AFTER_CREATE}
      </Toggle>
    </div>
  );
  const pick = (seed: number) => void create(wizardWorld(choice, seed, lib, choices));

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
      onCreate: (f, seed) => create({ settings: wizardSettings(choice, planetCells(PLANET_SIZES[psize].radiusKm)), commands: wizardCommands(choice, withTerrain(formGen(seed, f), { mountains: terrain.mountains }), f.name, seed, lib) }),
    });
  };

  // 星球形态的卡片，按库分段（默认的库里“星球形态”的是简单的卡片，别的带“编辑…”）；newCard：最后一段后面放“新建…”
  const formSections = (list: readonly FormChoice[], last = !showRest || !rest.length) => {
    const secs = groupByPack(list, (c) => packLabel(lib, c.path));
    return secs.map((sec, k) => (
      <>
        {(secs.length > 1 || list === rest) && <h6 class="choice-group">{sec.label}</h6>}
        <div class="cards three">
          {sec.items.map((c) =>
            isBuiltinPlanet(c) ? (
              <button class={`card ${ptype === c.key ? 'on' : ''}`} onClick={() => setPtype(c.key)} disabled={creating}>
                <b>{c.form.name}</b>
                <span class="hint">{c.form.hint}</span>
              </button>
            ) : (
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
            ),
          )}
          {last && k === secs.length - 1 && (
            <button class="card dashed" onClick={() => void editForm(null)} disabled={creating}>
              <b>新建…</b>
              <span class="hint">从一种星球改起，可写脚本</span>
            </button>
          )}
        </div>
      </>
    ));
  };

  // “自定义…”里的几段：一块地区、整个星球各一套，后面三段相同
  const customBody =
    kind === 'region' ? (
      <>
        <h5>世界的种类</h5>
        <div class="cards three">
          {WORLD_TYPES.map((t) => (
            <button class={`card ${type === t ? 'on' : ''}`} onClick={() => chooseType(t)} disabled={creating}>
              <b>{WORLD_TYPE_INFO[t].name}</b>
              <span class="hint">{WORLD_TYPE_INFO[t].hint}</span>
            </button>
          ))}
        </div>
        <div class="grid2">
          <div>
            <h5>多大</h5>
            <div class="cards">
              {(Object.keys(MAP_SIZES) as MapSize[]).map((s) => (
                <button class={`card ${size === s ? 'on' : ''}`} onClick={() => chooseSize(s)} disabled={creating}>
                  <b>{MAP_SIZES[s].name}</b>
                  <span class="hint">{MAP_SIZES[s].hint}</span>
                </button>
              ))}
            </div>
          </div>
          <div>
            <h5>放在星球的哪里</h5>
            <PlanetBand size={size} center={center} onChange={setCenter} />
          </div>
        </div>
      </>
    ) : (
      <>
        <h5>星球的种类</h5>
        {formSections(shown)}
        {!shown.length && <p class="hint">这个库里没有星球形态，下面是别的库里的</p>}
        {rest.length > 0 && shown.length > 0 && (
          <button class="link-btn" onClick={() => setMoreForms(!showRest)}>
            {showRest ? '收起' : `其他库里的形态（${rest.length}）`}
          </button>
        )}
        {showRest && rest.length > 0 && formSections(rest, true)}
        {!choices.length && (
          <div class="cards three">
            <button class="card dashed" onClick={() => void editForm(null)} disabled={creating}>
              <b>新建…</b>
              <span class="hint">从一种星球改起，可写脚本</span>
            </button>
          </div>
        )}
        {safeMode.value && chosen && hasFormScripts(chosen.form) && <p class="hint">安全模式：缩略图不含脚本的效果</p>}
        <h5>多大</h5>
        <div class="cards three">
          {(Object.keys(PLANET_SIZES) as PlanetSize[]).map((s) => (
            <button class={`card ${psize === s ? 'on' : ''}`} onClick={() => setPsize(s)} disabled={creating}>
              <b>{PLANET_SIZES[s].name}</b>
              <span class="hint">
                半径约 {PLANET_SIZES[s].radiusKm.toLocaleString()} km，{equatorText(PLANET_SIZES[s].radiusKm)}
              </span>
              <span class="hint">每格约 {PLANET_CELL_KM} km</span>
            </button>
          ))}
        </div>
      </>
    );

  // 这时说的话里和新建、打开有关的（“已取消，回到了原来的世界”、没能生成的原因）在向导里也写一遍——顶上的提示条被向导挡着。
  // 第九十八轮：别的话（上一笔排着没做成的“这一步没做”之类）不写在这里
  const note = toast.value?.about === 'open' ? toast.value : null;

  return (
    <div class="modal-backdrop" ref={scroller}>
      <div class="modal wizard">
        <ModalHead
          title="新建世界"
          onClose={world.value ? () => (wizardOpen.value = false) : undefined}
          closeTitle="取消"
          disabled={creating}
          extra={
            // 第九十八轮：没有世界时顶栏的“更多 → 帮助”点不了，这里一直有一个
            <button class="small ghost wizard-help" onClick={() => (helpOpen.value = true)} title={HELP_KEY_TIP}>
              <CircleHelp /> 帮助
            </button>
          }
        />
        {/* 第九十一轮：上次的世界这一版打不开时，说清楚它还留着 */}
        <BackupBanner box />
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
        <div class="row between wizard-lead">
          <h5>挑一张开始</h5>
          <span class="row">
            <button onClick={() => setBase(randomBase())} disabled={creating} title="换六张别的">
              换一批
            </button>
            <button class={`wizard-custom-btn ${custom ? 'open' : ''}`} aria-expanded={custom} onClick={() => setWizardCustom(!custom)} title="世界的种类、大小、地形、库、人文">
              自定义…
            </button>
          </span>
        </div>
        <div class="thumbs">
          {seeds.map((seed, k) => (
            <Thumb data={thumbs[k]} label={`第 ${k + 1} 个`} onPick={() => void pick(seed)} />
          ))}
        </div>
        {/* 收着时写明现在用的是什么：没选的东西不是没有，是默认的这些 */}
        {!custom && <p class="hint wizard-summary">现在用的：{wizardSummary(choice, lib, choices)}</p>}
        <p class="hint">
          {kind === 'planet' ? '左右相连，上下是两极。' : ''}
          缩略图是粗略版，看不到很小的岛。{creating && !(progressView.value || stalled.value) ? ' 正在生成…' : ''}
        </p>
        {/* 第九十七轮：生成、打开过了 1 秒（state/progress.ts 的 progressView）：到哪一步了、进度条、“取消”（回到这里） */}
        {busy.value && (progressView.value || stalled.value) && (
          <div class="row wizard-busy">
            <BusyLine text={busy.value} tip={STOP_TEXT.wizardTip} />
          </div>
        )}
        {note && <p class={`wizard-note ${note.error ? 'error' : ''}`}>{note.text}</p>}
        {custom && (
          <div class="wizard-custom">
            {customBody}
            <h5>地形</h5>
            <TerrainBox defaults={terrainBase} value={terrain} onChange={setTerrain} />
            <h5>库</h5>
            {contentBox}
            <h5>人文</h5>
            {humanBox}
            <p class="hint">
              改了以后上面的缩略图跟着重画。
              <button class="link wizard-to-top" onClick={() => scroller.current?.scrollTo({ top: 0, behavior: 'smooth' })}>
                回到缩略图
              </button>
            </p>
          </div>
        )}
      </div>
      <FormEditor />
    </div>
  );
}
