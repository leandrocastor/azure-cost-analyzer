import { Cache } from '@/utils/cache';

describe('Cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores and retrieves values', () => {
    const cache = new Cache<number>(1_000);
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
  });

  it('returns undefined for missing keys', () => {
    const cache = new Cache<number>(1_000);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('expires values after ttl', () => {
    const cache = new Cache<number>(1_000);
    cache.set('a', 1);
    vi.advanceTimersByTime(1_001);
    expect(cache.get('a')).toBeUndefined();
  });

  it('reports has correctly', () => {
    const cache = new Cache<number>(1_000);
    cache.set('a', 1);
    expect(cache.has('a')).toBe(true);
    vi.advanceTimersByTime(1_001);
    expect(cache.has('a')).toBe(false);
  });

  it('invalidates a specific key', () => {
    const cache = new Cache<number>(1_000);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.invalidate('a');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
  });

  it('clears all keys when invalidating without argument', () => {
    const cache = new Cache<number>(1_000);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.invalidate();
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
  });

  it('refreshes expiry when setting the same key again', () => {
    const cache = new Cache<number>(1_000);
    cache.set('a', 1);
    vi.advanceTimersByTime(900);
    cache.set('a', 2);
    vi.advanceTimersByTime(900);
    expect(cache.get('a')).toBe(2);
  });

  it('supports object payloads', () => {
    const cache = new Cache<{ ready: boolean }>(1_000);
    cache.set('obj', { ready: true });
    expect(cache.get('obj')).toEqual({ ready: true });
  });
});
