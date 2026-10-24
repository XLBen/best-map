// 地名显示中文、原文还是两者（第二十轮，图层“地名”里选；默认中文）。只是显示的选项，不进世界。
// 没有原文的名字（内置中文风格起的、自己起的）三种都显示中文

export type NameMode = 'zh' | 'orig' | 'both';

export const NAME_MODES: readonly { id: NameMode; label: string }[] = [
  { id: 'zh', label: '中文' },
  { id: 'orig', label: '原文' },
  { id: 'both', label: '两者' },
];

export const DEFAULT_NAME_MODE: NameMode = 'zh';

// 地图上标的字：中文“卡尔维尔斯堡”，原文“Karvilsburg”，两者“卡尔维尔斯堡 Karvilsburg”
export function nameText(name: string, orig: string | undefined, mode: NameMode = DEFAULT_NAME_MODE): string {
  if (!orig || mode === 'zh' || orig === name) return name;
  if (mode === 'orig') return orig;
  return `${name} ${orig}`;
}

// 分成几行标时（两者：中文一行、原文一行）
export function nameLines(name: string, orig: string | undefined, mode: NameMode = DEFAULT_NAME_MODE): string[] {
  if (!orig || mode === 'zh' || orig === name) return [name];
  if (mode === 'orig') return [orig];
  return [name, orig];
}
