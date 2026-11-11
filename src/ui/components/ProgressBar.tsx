// 进度条（第九十七轮）：一条连续的条子，value 是 0–1。不认识世界；画到哪由调用方给（见 shell/BusyLine.tsx）
export function ProgressBar({ value, label }: { value: number; label?: string }) {
  const v = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  return (
    <span class="progress-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)}>
      <i style={{ width: `${(v * 100).toFixed(1)}%` }} />
    </span>
  );
}
