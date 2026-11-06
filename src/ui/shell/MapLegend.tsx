import { useState } from 'preact/hooks';
import { cornerLift, flowSeason, mode, overlays, world } from '../../state';
import { Seg } from '../common';
import { Legend } from '../components/Legend';
import { SEASONS } from '../defs/layers';
import { flowHint, flowLegend, legendFor } from '../domain/legend';

// 左下角、量距离按钮上面：按类着色的底图的图例（地形类别、资源、生态分区）。收起、展开记在这次打开的页面里。
// 风向、洋流（第四十八轮）：开着才有这一张，写风的三档、暖流寒流，上面是风的季节（只换风，不影响地貌的雪）。
// 底图也有图例时两张叠着放：底图的在下面、不挪地方，风向洋流的在它上面
export function MapLegend() {
  const w = world.value;
  const [open, setOpen] = useState(true);
  const [flowOpen, setFlowOpen] = useState(true);
  if (!w) return null;
  const style = { bottom: `${46 + cornerLift.value}px` };
  const { wind, currents } = overlays.value;
  const flow = flowLegend(wind, currents);
  const data = legendFor(w, mode.value);
  if (!flow) return data && <Legend title={data.title} items={data.items} open={open} onToggle={() => setOpen(!open)} style={style} />;
  return (
    <div class="legend-stack" style={style}>
      <Legend title={flow.title} items={flow.items} open={flowOpen} onToggle={() => setFlowOpen(!flowOpen)} wide hint={flowHint(wind, currents, w.small.planet.currents)}>
        <Seg value={flowSeason.value} options={SEASONS} titles={{ annual: '风取冬夏平均' }} onChange={(v) => (flowSeason.value = v)} wide />
      </Legend>
      {data && <Legend title={data.title} items={data.items} open={open} onToggle={() => setOpen(!open)} />}
    </div>
  );
}
