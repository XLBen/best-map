import { type DirtyLevel, itemId, itemName, kindOf, usageOf } from '../content/registry';
import { type ApplyContext, Dirty, formatIssues, nextId, type RunResult, styleLabel } from './shared';
import { regionSchema, type World } from '../world';
import { CommandError } from '../errors';
import type { Command } from './schema';
import { REGION_KIND_INFO } from '../features';
import { styleById, worldStyleId } from '../name-styles';
import { worldMapStyleId, worldMapStyles } from '../map-style';

// 地名、片区、内容（set_content / order_content）、地名风格、画风的命令（第四十一轮从 commands.ts 原样搬来）

export const DIRTY_OF: Record<DirtyLevel, Dirty> = {
  none: Dirty.None,
  names: Dirty.Names,
  human: Dirty.Human,
  vegetation: Dirty.Vegetation,
  solve: Dirty.Solve,
  climate: Dirty.Climate,
  elevation: Dirty.Elevation,
};

// 启用、修改、停用一项放在 small.content 里的内容（set_content）：按登记的格式检查，重算到登记的那一层
export function setContent(world: World, kindId: string, id: string, raw: Record<string, unknown> | null): { dirty: Dirty; summary: string } {
  const kind = kindOf(kindId);
  if (!kind || kind.store !== 'content') throw new CommandError(`不认识的内容种类 "${kindId}"`);
  const small = world.small;
  const store = { ...(small.content?.[kindId] ?? {}) };
  const before = store[id];
  // 改之前这一种的全部 id（按编号的先后）：停用一种之后画过的格按它换编号
  const idsBefore = kind.afterSet ? kind.inWorld(world).map((x) => itemId(kind, x)) : [];
  let after: unknown;
  if (raw === null) {
    if (before === undefined) throw new CommandError(`世界里没有${kind.label} "${id}"`);
    delete store[id];
    // 第二十八轮：在用的不能移出世界。
    // 画过的格会跟着整理的种类（地形类别、资源：画成它的格恢复自动，见 afterSet）引擎照旧让移出，只在资源库里拦
    const gone = !kind.afterSet;
    const used = gone ? usageOf(kind, { small, causes: world.causes }, id) : null;
    if (used) throw new CommandError(`${kind.label}“${itemName(kind, before)}”还在用（${used.label}），先把用到它的地方改掉`);
  } else {
    const r = kind.schema.safeParse(raw);
    if (!r.success) throw new CommandError(`${kind.label}无效：${formatIssues(r.error)}`);
    after = r.data;
    if (itemId(kind, after) !== id) throw new CommandError(`${kind.label}的 id 与命令里的不同`);
    kind.check?.(after, world);
    if (before === undefined && kind.maxInWorld !== undefined && Object.keys(store).length >= kind.maxInWorld) throw new CommandError(`${kind.label}最多 ${kind.maxInWorld} 种`);
    store[id] = after;
  }
  // 空了就去掉，世界与没启用过时一样
  const content = { ...small.content, [kindId]: store };
  if (!Object.keys(store).length) delete content[kindId];
  if (Object.keys(content).length) small.content = content;
  else delete small.content;
  kind.afterSet?.(world, idsBefore);
  const level = kind.dirty?.(before, after, world) ?? 'none';
  const name = itemName(kind, after ?? before);
  const what = raw === null ? '停用' : before === undefined ? '启用' : '修改';
  return { dirty: DIRTY_OF[level], summary: `${what}${kind.label}“${name}”` };
}

// 排一种内容的先后（order_content）：列着的按列的先后排进它们占着的位置，别的不动。编号跟着先后的种类（地形类别、资源）
// 画过的格按 id 换编号（afterSet）
export function orderContent(world: World, kindId: string, ids: readonly string[]): { dirty: Dirty; summary: string } {
  const kind = kindOf(kindId);
  if (!kind || kind.store !== 'content') throw new CommandError(`不认识的内容种类 "${kindId}"`);
  const small = world.small;
  const store = small.content?.[kindId];
  const summary = `排${kind.label}的先后`;
  if (!store) return { dirty: Dirty.None, summary };
  const keys = Object.keys(store);
  const rank = new Map(ids.map((id, k) => [id, k]));
  const slots = keys.filter((k) => rank.has(k)).sort((a, b) => rank.get(a)! - rank.get(b)!);
  let at = 0;
  const order = keys.map((k) => (rank.has(k) ? slots[at++] : k));
  if (order.every((k, i) => k === keys[i])) return { dirty: Dirty.None, summary };
  const idsBefore = kind.afterSet ? kind.inWorld(world).map((x) => itemId(kind, x)) : [];
  small.content = { ...small.content, [kindId]: Object.fromEntries(order.map((k) => [k, store[k]])) };
  kind.afterSet?.(world, idsBefore);
  const first = store[slots[0]];
  return { dirty: DIRTY_OF[kind.dirty?.(first, first, world) ?? 'none'], summary };
}

// 地名、片区、内容、地名风格、画风的命令（第四十一轮从 runOp 拆出来，case 原样）；不是这一类的命令返回 undefined
export function runFeatureOp(world: World, cmd: Command, _ctx: ApplyContext): RunResult | undefined {
  const { small, mesh } = world;
  const n = mesh.n;
  const checkCells = (list: number[]) => {
    const bad = list.find((i) => i >= n);
    if (bad !== undefined) throw new CommandError(`格编号 ${bad} 超出范围（共 ${n} 格）`);
  };
  switch (cmd.op) {
    case 'rename_feature': {
      if (cmd.name === undefined && cmd.label === undefined && cmd.hidden === undefined && cmd.orig === undefined) throw new CommandError('rename_feature 要写 name、orig、label 或 hidden');
      const ov = { ...(small.featureNames[cmd.key] ?? {}) };
      // 删掉地名（第十六轮）：地物照旧，只是不标；恢复就去掉这一项
      if (cmd.hidden !== undefined) {
        if (cmd.hidden) ov.hidden = true;
        else delete ov.hidden;
      }
      if (cmd.name !== undefined) {
        if (cmd.name.trim()) ov.name = cmd.name.trim();
        else delete ov.name;
      }
      // 原文（第二十轮）：跟着自己起的名字；改了中文名没写原文时去掉
      const orig = cmd.orig?.trim();
      if (orig && ov.name) ov.orig = orig;
      else if (cmd.orig !== undefined || cmd.name !== undefined) delete ov.orig;
      if (cmd.orig !== undefined && cmd.name === undefined && cmd.label === undefined && cmd.hidden === undefined) {
        small.featureNames = { ...small.featureNames, [cmd.key]: ov };
        return { dirty: Dirty.Names, summary: orig ? `原文改为“${orig}”` : '去掉原文' };
      }
      const label = cmd.label?.trim();
      if (cmd.label !== undefined) {
        if (label) ov.label = label;
        else delete ov.label;
      }
      small.featureNames = { ...small.featureNames, [cmd.key]: ov };
      if (cmd.hidden !== undefined && cmd.name === undefined && cmd.label === undefined) return { dirty: Dirty.Names, summary: cmd.hidden ? '隐藏地名' : '显示地名' };
      if (cmd.name === undefined) return { dirty: Dirty.Names, summary: label ? `类型改叫“${label}”` : '类型恢复自动' };
      return { dirty: Dirty.Names, summary: cmd.name.trim() ? `改名为“${cmd.name.trim()}”` : '名字恢复自动' };
    }
    case 'reroll_feature': {
      const ov = { ...(small.featureNames[cmd.key] ?? {}) };
      delete ov.name;
      delete ov.orig;
      ov.salt = (ov.salt ?? 0) + 1;
      small.featureNames = { ...small.featureNames, [cmd.key]: ov };
      return { dirty: Dirty.Names, summary: '换名字' };
    }
    case 'add_region': {
      checkCells(cmd.region.cells);
      const region = regionSchema.parse({ ...cmd.region, id: cmd.region.id ?? nextId(world, 'region') });
      if (small.regions.some((r) => r.id === region.id)) throw new CommandError(`地名 ${region.id} 已存在`);
      if (region.kind === 'spot' && region.cells.length !== 1) throw new CommandError('点状地名只占一格');
      if (region.kind === 'spot' && region.auto) throw new CommandError('点状地名没有类型可以自动判断');
      region.name = region.name.trim();
      small.regions = [...small.regions, region];
      const what = region.kind === 'spot' ? '放地名' : `圈${REGION_KIND_INFO[region.kind].label}`;
      return { dirty: Dirty.Names, summary: region.name ? `${what}“${region.name}”` : what };
    }
    case 'update_region': {
      const r = small.regions.find((x) => x.id === cmd.id);
      if (!r) throw new CommandError(`找不到地名 ${cmd.id}`);
      const next = { ...r };
      if (cmd.kind !== undefined) {
        if ((cmd.kind === 'spot') !== (r.kind === 'spot')) throw new CommandError('点状地名和区块不能互换');
        next.kind = cmd.kind;
        delete next.auto;
      }
      if (cmd.auto !== undefined) {
        if (r.kind === 'spot') throw new CommandError('点状地名没有类型可以自动判断');
        if (cmd.auto) next.auto = true;
        else delete next.auto;
      }
      if (cmd.name !== undefined) next.name = cmd.name.trim();
      if (cmd.reroll) {
        next.name = '';
        next.salt = r.salt + 1;
      }
      const label = cmd.label?.trim();
      if (cmd.label !== undefined) {
        if (label) next.label = label;
        else delete next.label;
      }
      small.regions = small.regions.map((x) => (x.id === r.id ? next : x));
      const onlyLabel = cmd.label !== undefined && cmd.name === undefined && cmd.kind === undefined && cmd.auto === undefined && !cmd.reroll;
      const summary = onlyLabel
        ? label
          ? `类型改叫“${label}”`
          : '类型恢复自动'
        : cmd.reroll
        ? '换名字'
        : next.auto && !r.auto
          ? '类型改成自动'
          : next.kind !== r.kind || (r.auto && !next.auto)
            ? `改成${REGION_KIND_INFO[next.kind].label}`
            : next.name
              ? `改名为“${next.name}”`
              : '名字恢复自动';
      return { dirty: Dirty.Names, summary };
    }
    case 'remove_region': {
      const r = small.regions.find((x) => x.id === cmd.id);
      if (!r) throw new CommandError(`找不到地名 ${cmd.id}`);
      small.regions = small.regions.filter((x) => x.id !== cmd.id);
      const what = r.kind === 'spot' ? '地名' : REGION_KIND_INFO[r.kind].label;
      return { dirty: Dirty.Names, summary: r.name ? `删除${what}“${r.name}”` : `删除${what}` };
    }
    case 'set_content':
      return setContent(world, cmd.kind, cmd.id, cmd.item);
    case 'order_content':
      return orderContent(world, cmd.kind, cmd.ids);
    case 'set_name_style': {
      if (cmd.id !== null && !styleById(small, cmd.id)) throw new CommandError(`世界里没有地名风格 "${cmd.id}"`);
      if (cmd.id === null) delete small.nameStyle;
      else small.nameStyle = cmd.id;
      return { dirty: Dirty.Names, summary: `地名风格改为“${styleLabel(small, worldStyleId(small))}”` };
    }
    case 'set_map_style': {
      const styles = worldMapStyles(small);
      if (cmd.id !== null && !styles[cmd.id]) throw new CommandError(`世界里没有画风 "${cmd.id}"`);
      if (cmd.id === null) delete small.mapStyle;
      else small.mapStyle = cmd.id;
      const now = styles[worldMapStyleId(small)];
      return { dirty: Dirty.None, summary: `画风改为“${now?.name ?? '写实'}”` };
    }
    case 'set_feature_style': {
      if (cmd.style !== null && !styleById(small, cmd.style)) throw new CommandError(`世界里没有地名风格 "${cmd.style}"`);
      const ov = { ...(small.featureNames[cmd.key] ?? {}) };
      if (cmd.style === null) delete ov.style;
      else ov.style = cmd.style;
      const names = { ...small.featureNames };
      if (Object.keys(ov).length) names[cmd.key] = ov;
      else delete names[cmd.key];
      small.featureNames = names;
      return { dirty: Dirty.Names, summary: cmd.style === null ? '地名风格恢复自动' : `地名风格改为“${styleLabel(small, cmd.style)}”` };
    }
  }
}

