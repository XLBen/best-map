import type { World } from '../world';
import type { Command } from './schema';
import { provinceLand } from '../island-types';
import { classOfKind, fitProvincesToCountries, generateProvinces, isConnected, nameNewProvince, PROVINCE_KIND_INFO, type ProvinceKind, provinceSizes, regenerateProvinces, regenTargets, renameProvince, splitCells } from '../provinces';
import { provinceSeed } from '../province-rules';
import { afterCountries, type ApplyContext, Dirty, nextId, type RunResult, styleLabel } from './shared';
import { CommandError } from '../errors';
import { cutSeams, dropSeams, inheritSeams, seamsAfterCut } from '../seams';
import { tidyCountries } from '../human/country-edit';
import { cutProvinces } from '../select';
import { styleById } from '../name-styles';

// 省份的命令（第四十一轮从 commands.ts 原样搬来）

// 新建一个空的省份：陆海随这些格，类型随这些格原来所在省份的多数（assign_province 'new' 与剪刀共用）
export function newProvince(world: World, cells: number[]): number {
  const { causes, small } = world;
  const land = cells.length ? provinceLand(world)[cells[0]] === 1 : true;
  const kinds = new Map<ProvinceKind, number>();
  for (const i of cells) {
    const k = small.provinces[causes.province[i]]?.kind;
    if (k) kinds.set(k, (kinds.get(k) ?? 0) + 1);
  }
  let kind: ProvinceKind = land ? 'land' : 'sea';
  let bk = 0;
  for (const [k, c] of kinds) if (c > bk && (k === 'sea') !== land) {
    bk = c;
    kind = k;
  }
  const id = small.nextProvince++;
  small.provinces[id] = { name: '', locked: false, land, kind };
  return id;
}

// 省份的命令（第四十一轮从 runOp 拆出来，case 原样）；不是这一类的命令返回 undefined
export function runProvinceOp(world: World, cmd: Command, ctx: ApplyContext): RunResult | undefined {
  const { causes, small, mesh } = world;
  const n = mesh.n;
  const checkCells = (list: number[]) => {
    const bad = list.find((i) => i >= n);
    if (bad !== undefined) throw new CommandError(`格编号 ${bad} 超出范围（共 ${n} 格）`);
  };
  switch (cmd.op) {
    case 'generate_provinces': {
      const d = ctx.ensureDerived();
      // 规则是世界里的省份划分（第七十八轮）；种子省略时沿用
      generateProvinces(world, d, cmd.seed ?? provinceSeed(small));
      // 锁定的省可能跨着国界（第二十三轮）
      fitProvincesToCountries(world);
      // 整张图重新划分：切线都不要了
      delete small.provinceSeams;
      return { dirty: Dirty.None, summary: `划分省份 · ${Object.keys(small.provinces).length} 个` };
    }
    case 'regenerate_provinces': {
      checkCells(cmd.cells);
      const ids = regenTargets(world, cmd.cells);
      if (!ids.length) throw new CommandError('要涂满省份的一大半才会重新划分');
      const d = ctx.ensureDerived();
      // 碰到重新划分的省的切线不要了（看划分前的省份）
      const regen = new Set(ids);
      dropSeams(world, (p) => regen.has(p));
      const fresh = regenerateProvinces(world, d, ids);
      fitProvincesToCountries(world);
      return { dirty: Dirty.None, summary: `重新划分 · ${ids.length} → ${fresh.length} 个省份` };
    }
    case 'assign_province': {
      checkCells(cmd.cells);
      let id: number;
      if (cmd.province === 'new') id = newProvince(world, cmd.cells);
      else {
        id = cmd.province;
        if (!small.provinces[id]) throw new CommandError(`找不到省份 ${id}`);
      }
      const meta = small.provinces[id];
      // 归海省的岛（小礁）算海：只能划进海省
      const pland = provinceLand(world);
      const wrong = cmd.cells.filter((i) => (pland[i] === 1) !== meta.land);
      if (wrong.length) throw new CommandError(`${wrong.length} 格与省份的陆海不符（${meta.land ? '陆地省份；小礁算海' : '海省'}）`);
      // 湖省只收湖面的格，陆地省不收湖省里的格（湖单独成省时）：按格现在所在省份的大类判断
      const cls = classOfKind(meta.kind);
      const mixed = cmd.cells.filter((i) => {
        const p = small.provinces[causes.province[i]];
        return p && p.land && classOfKind(p.kind) !== cls;
      });
      if (mixed.length) throw new CommandError(cls === 'lake' ? `${mixed.length} 格不是湖面，不能划进湖省` : `${mixed.length} 格是湖面，不能划进陆地省`);
      const lockedHit = cmd.cells.find((i) => causes.province[i] >= 0 && causes.province[i] !== id && small.provinces[causes.province[i]]?.locked);
      if (lockedHit !== undefined) throw new CommandError(`格 ${lockedHit} 属于已锁定的省份 ${causes.province[lockedHit]}`);
      // 国家（第二十三轮）：涂进已有的陆地省的格跟着这个省换国家；新省按国界切开（见下）
      const cty = small.countries ? causes.country : undefined;
      let moved = false;
      if (cty && meta.land && cmd.province !== 'new') {
        const own = causes.province.findIndex((p, i) => p === id && pland[i] === 1);
        const to = own >= 0 ? cty[own] : -1;
        for (const i of cmd.cells) if (pland[i] && cty[i] !== to) {
          cty[i] = to;
          moved = true;
        }
      }
      for (const i of cmd.cells) causes.province[i] = id;
      // 新省份在格划进来之后再起名，名字才能按省内地形取字
      if (cmd.province === 'new') nameNewProvince(world, id);
      if (cty) afterCountries(world);
      const sizes = provinceSizes(world);
      for (const p of Object.keys(small.provinces).map(Number)) if (!sizes.has(p)) delete small.provinces[p];
      const cellsOf = (p: number) => {
        const out: number[] = [];
        for (let i = 0; i < n; i++) if (causes.province[i] === p) out.push(i);
        return out;
      };
      const warn = isConnected(world, cellsOf(id)) ? '' : ' · 不连通';
      return { dirty: moved ? Dirty.Human : Dirty.None, summary: `涂省份“${small.provinces[id]?.name || id}” · ${cmd.cells.length} 格${warn}` };
    }
    case 'merge_province': {
      const a = small.provinces[cmd.from];
      const b = small.provinces[cmd.into];
      if (!a || !b) throw new CommandError('找不到要合并的省份');
      if (a.land !== b.land) throw new CommandError('陆地省份与海省不能合并');
      if (classOfKind(a.kind) !== classOfKind(b.kind)) throw new CommandError('湖省与陆地省份不能合并');
      if (a.locked || b.locked) throw new CommandError('省份已锁定');
      // 国家（第二十三轮）：并进来的格跟着 into 的国家
      const cty = small.countries && a.land ? causes.country : undefined;
      const into = cty ? causes.province.findIndex((p) => p === cmd.into) : -1;
      let moved = false;
      for (let i = 0; i < n; i++) {
        if (causes.province[i] !== cmd.from) continue;
        causes.province[i] = cmd.into;
        if (cty && into >= 0 && causes.land[i] && cty[i] !== cty[into]) {
          cty[i] = cty[into];
          moved = true;
        }
      }
      delete small.provinces[cmd.from];
      if (moved) tidyCountries(world);
      return { dirty: moved ? Dirty.Human : Dirty.None, summary: `合并省份“${a.name || cmd.from}” → “${b.name || cmd.into}”` };
    }
    case 'split_province': {
      const meta = small.provinces[cmd.id];
      if (!meta) throw new CommandError(`找不到省份 ${cmd.id}`);
      if (meta.locked) throw new CommandError('省份已锁定');
      const list: number[] = [];
      for (let i = 0; i < n; i++) if (causes.province[i] === cmd.id) list.push(i);
      if (list.length < 2) throw new CommandError('省份太小，不能拆分');
      const [, right] = splitCells(world, list);
      const id = small.nextProvince++;
      small.provinces[id] = { name: '', locked: false, land: meta.land, kind: meta.kind };
      for (const i of right) causes.province[i] = id;
      nameNewProvince(world, id);
      // 剪刀切过这个省时：切线也管分出来的这一半（没有切线的世界不变）
      if (small.provinceSeams) small.provinceSeams = inheritSeams(small.provinceSeams, cmd.id, [id]);
      return { dirty: Dirty.None, summary: `拆分省份“${meta.name || cmd.id}”` };
    }
    case 'cut_province': {
      // 与界面上拖动时的预览同一个算法、同一条线，切出来的块与新省份的编号都与预览相同
      const cut = cutProvinces(world, cmd.line, { extend: false });
      if (!cut.plans.length) throw new CommandError('线没有把省份分开');
      const names = cut.plans.map((pl) => `“${small.provinces[pl.id].name || `省份 ${pl.id}`}”`).join('、');
      // 记下的切线：每个切开的省一条，只留线在那个省里的一段（按切之前的省份算，与预览的 cutSeams 相同）
      const seams = cutSeams(world, cmd.line, cut);
      let count = 0;
      for (const pl of cut.plans) {
        for (const part of pl.parts.slice(1)) {
          const id = newProvince(world, part);
          for (const i of part) causes.province[i] = id;
          nameNewProvince(world, id);
          count++;
        }
      }
      small.provinceSeams = seamsAfterCut(small.provinceSeams, seams, () => nextId(world, 'seam'));
      return { dirty: Dirty.None, summary: `切开${names} · 多出 ${count} 个省份` };
    }
    case 'set_province': {
      const meta = small.provinces[cmd.id];
      if (!meta) throw new CommandError(`找不到省份 ${cmd.id}`);
      if (cmd.kind !== undefined) {
        if (!meta.land) throw new CommandError('海省的类型不能改');
        meta.kind = cmd.kind;
      }
      if (cmd.name !== undefined) {
        meta.name = cmd.name;
        // 原文跟着名字：没写原文时去掉
        const orig = cmd.orig?.trim();
        if (orig) meta.orig = orig;
        else delete meta.orig;
      }
      if (cmd.locked !== undefined) meta.locked = cmd.locked;
      if (cmd.color !== undefined) {
        if (cmd.color) meta.color = cmd.color.toLowerCase();
        else delete meta.color;
      }
      if (cmd.style !== undefined) {
        if (cmd.style !== null && !styleById(small, cmd.style)) throw new CommandError(`世界里没有地名风格 "${cmd.style}"`);
        if (cmd.style === null) delete meta.style;
        else meta.style = cmd.style;
        // 按新的风格重新起名：起名要看这里的河、山、冷暖（推导），先算好
        if (cmd.name === undefined) {
          ctx.ensureDerived();
          renameProvince(world, cmd.id);
        }
        return { dirty: Dirty.None, summary: `省份“${meta.name || cmd.id}” · ${cmd.style === null ? '地名风格恢复自动' : `地名风格改为“${styleLabel(small, cmd.style)}”`}` };
      }
      const what =
        cmd.kind !== undefined
          ? `改成${PROVINCE_KIND_INFO[cmd.kind].name}`
          : cmd.locked !== undefined
            ? cmd.locked
              ? '锁定'
              : '解锁'
            : cmd.color !== undefined
              ? cmd.color
                ? '换颜色'
                : '颜色恢复自动'
              : '改名';
      return { dirty: Dirty.None, summary: `省份“${meta.name || cmd.id}” · ${what}` };
    }
  }
}

