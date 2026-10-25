import { CATEGORY_LABEL, worldResources, worldTerrainClasses } from '../../../core/human';
import { options, openPanel, setOptions, world } from '../../state';
import { TypePicker, TypePickerButton } from '../components/TypePicker';
import { chosenClass, chosenResource } from '../tools/human';

// 画地形类别、资源（第二十一轮）：底部条上的“类别：山地 ▾”“资源：铁 ▾”和弹出的列表（最后一项打开仓库）

const css = (c: readonly number[]) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

export function ClassPick() {
  const w = world.value;
  if (!w) return null;
  const c = chosenClass(w);
  const auto = !options.value.terrainClass;
  return <TypePickerButton panel="classpick" prefix="类别" swatch={c && !auto ? css(c.color) : undefined} name={c ? c.name : '选类别'} title="画成哪一种地形类别" />;
}

export function ResourcePick() {
  const w = world.value;
  if (!w) return null;
  const r = chosenResource(w);
  const auto = !options.value.resource;
  return <TypePickerButton panel="resourcepick" prefix="资源" swatch={r && !auto ? css(r.color) : undefined} name={r ? r.name : '选资源'} title="画成哪一种资源" />;
}

const pick = (patch: Partial<typeof options.value>) => {
  openPanel.value = null;
  setOptions(patch);
};

export function ClassMenu() {
  const w = world.value;
  if (!w) return null;
  const cur = options.value.terrainClass;
  return (
    <TypePicker
      items={[
        { label: '恢复自动', on: !cur, hint: '去掉画过的类别', onPick: () => pick({ terrainClass: '' }) },
        ...worldTerrainClasses(w.small).map((c) => ({ label: c.name, swatch: c.color, on: c.id === cur, hint: c.description, onPick: () => pick({ terrainClass: c.id }) })),
      ]}
      library="terrainClass"
    />
  );
}

export function ResourceMenu() {
  const w = world.value;
  if (!w) return null;
  const cur = options.value.resource;
  return (
    <TypePicker
      items={[
        { label: '恢复自动', on: !cur, hint: '去掉画过的资源', onPick: () => pick({ resource: '' }) },
        { label: '无', on: cur === 'none', hint: '这里没有资源', onPick: () => pick({ resource: 'none' }) },
        ...worldResources(w.small).map((r) => ({ label: r.name, swatch: r.color, meta: CATEGORY_LABEL[r.category], on: r.id === cur, hint: r.description, onPick: () => pick({ resource: r.id }) })),
      ]}
      library="resource"
    />
  );
}
