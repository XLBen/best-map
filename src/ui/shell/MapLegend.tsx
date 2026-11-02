import { useState } from 'preact/hooks';
import { type FlowShow, cornerLift, flowShow, mode, season, world } from '../../state';
import { Seg } from '../common';
import { Legend } from '../components/Legend';
import { SEASONS } from '../defs/layers';
import { WIND_LEGEND, legendFor } from '../legend';

const SHOW: [FlowShow, string][] = [
  ['both', '风与洋流'],
  ['wind', '只看风'],
  ['currents', '只看洋流'],
];

// 左下角、量距离按钮上面：按类着色的底图的图例（地形类别、资源、生态分区）。收起、展开记在这次打开的页面里。
// 风与洋流（第四十六轮）：风的三档、暖流寒流，上面是季节（风按季节，洋流是全年平均）
export function MapLegend() {
  const w = world.value;
  const [open, setOpen] = useState(true);
  if (!w) return null;
  const style = { bottom: `${46 + cornerLift.value}px` };
  if (mode.value === 'wind')
    return (
      <Legend title={WIND_LEGEND.title} items={WIND_LEGEND.items} open={open} onToggle={() => setOpen(!open)} style={style} wide hint={w.small.planet.currents === 0 ? '洋流强弱是 0：没有洋流' : '洋流是全年平均的'}>
        <Seg value={flowShow.value} options={SHOW} onChange={(v) => (flowShow.value = v)} wide />
        <Seg value={season.value} options={SEASONS} titles={{ annual: '风取冬夏平均' }} onChange={(v) => (season.value = v)} wide />
      </Legend>
    );
  const data = legendFor(w, mode.value);
  if (!data) return null;
  return <Legend title={data.title} items={data.items} open={open} onToggle={() => setOpen(!open)} style={style} />;
}
