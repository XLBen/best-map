// 几个面板共用的小部件

// 分段选择：全界面的“几个里选一个”只有这一种（底部条上工具的模式也是它）。
// swatches：选项前面的色块；off：现在不起作用（淡一些，照样能点）
export function Seg<T extends string | number>({
  value,
  options: opts,
  onChange,
  wide = false,
  titles,
  swatches,
  disabled = false,
  off = false,
  title,
}: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
  wide?: boolean;
  titles?: Partial<Record<T, string>>;
  swatches?: Partial<Record<T, string>>;
  disabled?: boolean;
  off?: boolean;
  title?: string;
}) {
  return (
    <div class={`seg ${wide ? 'wide' : ''} ${off ? 'off' : ''}`} title={title}>
      {opts.map(([v, label]) => (
        <button class={value === v ? 'on' : ''} onClick={() => onChange(v)} title={titles?.[v]} disabled={disabled}>
          {swatches?.[v] && <span class="swatch" style={{ background: swatches[v] }} />}
          {label}
        </button>
      ))}
    </div>
  );
}
