// 几个面板共用的小部件

export function Seg<T extends string | number>({
  value,
  options: opts,
  onChange,
  wide = false,
  titles,
}: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
  wide?: boolean;
  titles?: Partial<Record<T, string>>;
}) {
  return (
    <div class={`seg ${wide ? 'wide' : ''}`}>
      {opts.map(([v, label]) => (
        <button class={value === v ? 'on' : ''} onClick={() => onChange(v)} title={titles?.[v]}>
          {label}
        </button>
      ))}
    </div>
  );
}
