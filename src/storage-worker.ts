/// <reference lib="webworker" />
import type { WorldDoc } from '../core/engine';
import { type SavedCheckpoint, type StorageRequest, type TakeReply, checkpointFits } from './checkpoint-store';
import { idbGet, idbTx } from './idb';
import { collectBuffers } from './transfer';

// 存储 Worker：与页面同源，只读写检查点，从不运行脚本（不引用 core/script，见 isolation.test.ts）。
// 计算 Worker 在隔离的环境里打不开 IndexedDB，检查点由这里写进去、打开时由这里经主线程给的通道直接发给计算 Worker。
// 只听主线程的（计算 Worker 只拿到一条只进不出的通道，碰不到这里）。见 checkpoint-store.ts

// 一件一件做：写完再读，读到的是刚写的
let chain: Promise<void> = Promise.resolve();
function queue(run: () => Promise<void>) {
  chain = chain.then(run).catch(() => undefined);
}

async function take(build: string, doc: WorldDoc, port: MessagePort) {
  let cp: SavedCheckpoint['cp'] | null = null;
  try {
    const saved = await idbGet<unknown>('checkpoint', 'current');
    if (checkpointFits(saved, build, doc)) cp = saved.cp;
  } catch {
    // 读不了：照旧重放
  }
  try {
    port.postMessage({ cp } satisfies TakeReply, cp ? collectBuffers(cp) : []);
  } catch {
    port.postMessage({ cp: null } satisfies TakeReply);
  }
  port.close();
}

self.onmessage = (ev: MessageEvent<StorageRequest>) => {
  const m = ev.data;
  if (m?.kind === 'put' && typeof m.build === 'string') {
    // put 时结构化克隆（在这个 Worker 里），写盘在后台进行
    queue(() => idbTx(['checkpoint'], 'readwrite', (s) => s.put({ build: m.build, cp: m.cp } satisfies SavedCheckpoint, 'current')));
  } else if (m?.kind === 'take' && m.port) {
    queue(() => take(m.build, m.doc, m.port));
  }
};
