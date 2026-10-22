/// <reference lib="webworker" />
import { CheckpointKeeper, type SavedCheckpoint } from './checkpoint-store';
import { idbGet, idbTx } from './idb';

// 存储 Worker：与页面同源，只读写检查点，从不运行脚本（不引用 core/script，见 isolation.test.ts）。
// 计算 Worker 在隔离的环境里打不开 IndexedDB：检查点由这里读写，经主线程给的通道直接与计算 Worker 来往（不经过主线程）。
// 只听主线程的（open、commit）；计算 Worker 那一头只能把检查点发过来，写不写由主线程核对后说了算。见 checkpoint-store.ts

const keeper = new CheckpointKeeper({
  get: () => idbGet<unknown>('checkpoint', 'current'),
  // put 时结构化克隆（在这个 Worker 里），写盘在后台进行
  put: (saved: SavedCheckpoint) => idbTx(['checkpoint'], 'readwrite', (s) => s.put(saved, 'current')),
});

self.onmessage = (ev: MessageEvent) => keeper.handle(ev.data);
