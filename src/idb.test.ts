import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from './idb';

// 打开库时被别的页面挡住（要升级，旧页面占着不放）：不一直等

class FakeOpen {
  result: { close: () => void; onversionchange: (() => void) | null } = { close: vi.fn(), onversionchange: null };
  error: unknown = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onblocked: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
}

afterEach(() => vi.unstubAllGlobals());

describe('openDb', () => {
  it('被挡住时报错；之后那边放开了才打开的连接直接关掉', async () => {
    const req = new FakeOpen();
    vi.stubGlobal('indexedDB', { open: () => req });
    const p = openDb();
    req.onblocked!();
    await expect(p).rejects.toThrow(/占着/);
    req.onsuccess!();
    expect(req.result.close).toHaveBeenCalled();
  });

  it('打开的连接在别人要升级时自己关掉', async () => {
    const req = new FakeOpen();
    vi.stubGlobal('indexedDB', { open: () => req });
    const p = openDb();
    req.onsuccess!();
    const db = (await p) as unknown as FakeOpen['result'];
    expect(db.close).not.toHaveBeenCalled();
    db.onversionchange!();
    expect(db.close).toHaveBeenCalled();
  });
});
