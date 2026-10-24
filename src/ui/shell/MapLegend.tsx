import { useState } from 'preact/hooks';
import { cornerLift, mode, world } from '../../state';
import { Legend } from '../components/Legend';
import { legendFor } from '../legend';

// 左下角、量距离按钮上面：按类着色的底图的图例（地形类别、资源、生态分区）。收起、展开记在这次打开的页面里
export function MapLegend() {
  const w = world.value;
  const [open, setOpen] = useState(true);
  if (!w) return null;
  const data = legendFor(w, mode.value);
  if (!data) return null;
  return <Legend title={data.title} items={data.items} open={open} onToggle={() => setOpen(!open)} style={{ bottom: `${46 + cornerLift.value}px` }} />;
}
