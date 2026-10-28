import { describe, expect, it } from 'vitest';
import { checkSupport } from './support';

const iphone = (v: string) =>
  `Mozilla/5.0 (iPhone; CPU iPhone OS ${v} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${v.replace('_', '.')} Mobile/15E148 Safari/604.1`;

describe('checkSupport (N-BROWSER-1)', () => {
  it('accepts Safari on iOS 17 in a tab and 18.4 installed', () => {
    expect(checkSupport(iphone('17_5'), false, 5).ok).toBe(true);
    expect(checkSupport(iphone('18_4'), true, 5).ok).toBe(true);
    expect(checkSupport(iphone('26_0'), true, 5).ok).toBe(true);
  });

  it('rejects older iOS, installed before 18.4, other browsers and desktop', () => {
    expect(checkSupport(iphone('16_7'), false, 5).ok).toBe(false);
    expect(checkSupport(iphone('18_3'), true, 5).ok).toBe(false);
    expect(checkSupport(iphone('18_0').replace('Safari', 'CriOS/120 Safari'), false, 5).message).toMatch(/Safari/);
    const desktop = checkSupport('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130 Safari/537.36', false, 0);
    expect(desktop.ok).toBe(false);
    expect(desktop.message).toMatch(/iOS 17/);
  });
});
