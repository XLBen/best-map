import { FS_COMPOSE } from './compose';
import { FS_COMPOSE_PLANET, FS_COMPOSE_PROJ, FS_TERRAIN_PLANET, FS_TERRAIN_POLAR, VS_CELL_PLANET, VS_CELL_POLAR, VS_ID_PLANET, VS_ID_POLAR, VS_SEAM_POLAR } from './sphere';
import { FOCUS_GLSL, FS_ID, FS_SEAM, FS_TERRAIN, VS_CELL, VS_ID, VS_QUAD, VS_SEAM } from './plane';
import { FJORD_GLSL, FRAG_GLSL, LITH_LAND_GLSL, SPECK_MARK, STYLE_GLSL, STYLE_N2, STYLE_N3, styleMain, withoutFx } from './common';

// 着色器源码（第四十一轮从 renderer.ts 拆出来）：common 片段 → plane 平面的程序 → compose 合成 → sphere 星球、极地、投影（按 must / mustAll 替换）
export { FJORD_GLSL, FRAG_GLSL, LITH_LAND_GLSL, SPECK_MARK, STYLE_GLSL, STYLE_N2, STYLE_N3, TEX_W, styleMain, withoutFx } from './common';
export { FOCUS_GLSL } from './plane';

// 测试用（没有 WebGL 时检查拼出来的源码）：合成着色器的平面、星球两份
export const COMPOSE_SOURCES = { plane: FS_COMPOSE, planet: FS_COMPOSE_PLANET };
// 地形着色器的平面、星球两份（第十八轮：破碎度那一段与 CPU 对照）
export const TERRAIN_SOURCES = { plane: FS_TERRAIN, planet: FS_TERRAIN_PLANET };
// 投影（第十三轮 G4）：合成着色器与极地的场景的几个着色器
export const PROJ_SOURCES = { compose: FS_COMPOSE_PROJ, polarCellVs: VS_CELL_POLAR, polarIdVs: VS_ID_POLAR, polarSeamVs: VS_SEAM_POLAR, polarTerrainFs: FS_TERRAIN_POLAR };
// 第四十一轮：渲染器编译的每个程序的源码（测试按 sha256 查拆文件前后逐字节相同）
export const SHADER_PROGRAMS: Record<string, string> = {
  VS_QUAD, VS_ID, FS_ID, VS_CELL, FS_TERRAIN, FS_COMPOSE, VS_SEAM, FS_SEAM,
  VS_ID_PLANET, VS_CELL_PLANET, FS_TERRAIN_PLANET, FS_COMPOSE_PLANET,
  VS_ID_POLAR, VS_CELL_POLAR, VS_SEAM_POLAR, FS_TERRAIN_POLAR, FS_COMPOSE_PROJ,
  FS_COMPOSE_NOFX: withoutFx(FS_COMPOSE), FS_COMPOSE_PLANET_NOFX: withoutFx(FS_COMPOSE_PLANET), FS_COMPOSE_PROJ_NOFX: withoutFx(FS_COMPOSE_PROJ),
  FRAG_GLSL, STYLE_GLSL, FJORD_GLSL, FOCUS_GLSL, LITH_LAND_GLSL,
  STYLE_N2: JSON.stringify(STYLE_N2), STYLE_N3: JSON.stringify(STYLE_N3), styleMain_N2: styleMain(STYLE_N2), styleMain_N3: styleMain(STYLE_N3),
  SPECK_MARK: String(SPECK_MARK),
};
