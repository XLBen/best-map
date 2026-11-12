import { describe, expect, it } from 'vitest';
import { GL_TEXT, MISHAP_TEXT, OPEN_TWICE_TEXT, RESCUE_TEXT, STOP_TEXT, rescueWhen, rescueWorldLine } from './crash-text';
import { looksEnglish } from './error-text';

// 第九十六轮：出了问题时说的话。每一句说清发生了什么、作品还在不在、现在能做什么；用界面上的那几个词

const all = (o: unknown): string[] =>
  typeof o === 'string' ? [o] : typeof o === 'function' ? [String((o as (...a: unknown[]) => unknown)('今天 14:05', '今天 14:05'))] : o && typeof o === 'object' ? Object.values(o).flatMap(all) : [];

describe('文字的规矩', () => {
  const texts = [RESCUE_TEXT, MISHAP_TEXT, STOP_TEXT, GL_TEXT, OPEN_TWICE_TEXT].flatMap(all);

  it('不用不该用的词：标签页、窗口（指页面）、备份、IndexedDB、Worker、崩溃、系统', () => {
    for (const t of texts) expect(t, t).not.toMatch(/标签页|备份|IndexedDB|Worker|崩溃|系统|缓存|线程|同步失败|保存失败/);
  });

  it('没有英文句子（WebGL2、Chrome 这样的名字除外）', () => {
    for (const t of texts) expect(looksEnglish(t.replace(/Chrome、Edge、Firefox 或 Safari/, '')), t).toBe(false);
  });

  it('自救页：说了作品还在不在，按钮是“导出文件”“重新载入”', () => {
    expect(RESCUE_TEXT.crash.title).toBe('页面出了问题');
    expect(RESCUE_TEXT.export).toBe('导出文件');
    expect(RESCUE_TEXT.reload).toBe('重新载入');
    expect(rescueWorldLine('live', 0, 0)).toContain('你的世界还在浏览器里');
    expect(rescueWorldLine('live-unsaved', 0, 0)).toContain('请先导出文件');
    expect(rescueWorldLine('none', 0, 0)).toContain('没有东西会丢');
    // 不支持 WebGL2：哪些浏览器可以、怎么打开硬件加速
    expect(RESCUE_TEXT.noWebgl.lead).toMatch(/Chrome/);
    expect(RESCUE_TEXT.noWebgl.lead).toContain('硬件加速');
  });

  it('自救页开头那一句只说发生了什么：先导出还是直接重新载入，只由“你的世界”那一行说（第九十九轮：以前两处说法不一样）', () => {
    expect(RESCUE_TEXT.crash.lead).not.toMatch(/请先导出|再重新载入/);
    expect(RESCUE_TEXT.crash.lead).toContain('看下面这一行');
    // 每一种情形那一行都说了现在做什么：导出，或重新载入，或什么都不会丢
    for (const w of ['live', 'live-unsaved', 'saved', 'partial', 'none'] as const) expect(rescueWorldLine(w, 0, 0), w).toMatch(/重新载入|导出|没有东西会丢/);
    // 只有没存好的两种才叫人先导出
    expect(rescueWorldLine('live', 0, 0)).not.toContain('导出');
    expect(rescueWorldLine('saved', 0, 0)).not.toContain('导出');
    expect(rescueWorldLine('none', 0, 0)).not.toContain('导出');
  });

  it('浏览器里存着的那一份：写着是什么时候存的', () => {
    const now = new Date(2026, 10, 11, 15, 0).getTime();
    expect(rescueWorldLine('saved', new Date(2026, 10, 11, 14, 5).getTime(), now)).toBe('你的世界还在浏览器里，是今天 14:05 存的。重新载入后接着做。');
    expect(rescueWhen(new Date(2026, 10, 10, 9, 12).getTime(), now)).toBe('昨天 09:12');
    expect(rescueWhen(new Date(2026, 10, 3, 20, 10).getTime(), now)).toBe('11月3日 20:10');
    expect(rescueWhen(0, now)).toBe('以前');
    expect(rescueWorldLine('partial', new Date(2026, 10, 11, 14, 5).getTime(), now)).toContain('不完整');
  });

  it('顶上的一条：说世界还在、可以接着用', () => {
    expect(MISHAP_TEXT.generic).toContain('世界还在');
    expect(MISHAP_TEXT.part('资源库')).toBe('“资源库”出了问题，已经关闭。世界还在，可以接着用');
  });

  it('地图的画面：存好了和没存好说的不一样', () => {
    expect(GL_TEXT.saved).toContain('重新载入');
    expect(GL_TEXT.unsaved).toContain('导出文件');
  });
});
