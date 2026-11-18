// @ts-check
/**
 * 调度器：日规则按本地日去重；发送失败不占 dedupe；after_expiry 写 lastFire
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-ignore
import { env } from 'cloudflare:test';
import { checkExpiringSubscriptions } from '../../src/services/scheduler.js';
import * as subRepo from '../../src/data/subscriptions.repo.js';
import * as remindersRepo from '../../src/data/reminders.repo.js';

async function clearKv() {
  const list = await env.SUBSCRIPTIONS_KV.list();
  await Promise.all(list.keys.map((k) => env.SUBSCRIPTIONS_KV.delete(k.name)));
}

beforeEach(clearKv);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('日级去重与成功后占位', () => {
  it('日规则：同一天不同小时第二次应被 dedupe', async () => {
    vi.useFakeTimers();
    // 到期 2026-06-08，当前 6/1 → daysDiff=7
    vi.setSystemTime(new Date('2026-06-01T08:00:00Z'));
    await env.SUBSCRIPTIONS_KV.put(
      'config',
      JSON.stringify({
        TIMEZONE: 'UTC',
        NOTIFICATION_HOURS: [],
        ENABLED_NOTIFIERS: ['webhook'],
        WEBHOOK_URL: 'https://example.com/h',
        WEBHOOK_METHOD: 'POST'
      })
    );
    await subRepo.save(env, {
      id: 'day-1',
      name: 'DayRule',
      expiryDate: '2026-06-08T00:00:00.000Z',
      isActive: true,
      autoRenew: false
    });
    await remindersRepo.replaceForSubscription(env, 'day-1', [
      remindersRepo.normalizeRule({
        id: 'r7',
        type: 'before_expiry',
        value: 7,
        unit: 'days',
        isEnabled: true
      })
    ]);

    vi.stubGlobal(
      'fetch',
      async () =>
        /** @type {any} */ ({
          ok: true,
          json: async () => ({ ok: true }),
          text: async () => 'ok'
        })
    );

    const first = await checkExpiringSubscriptions(env);
    expect(first.matchedCount).toBeGreaterThanOrEqual(1);
    expect(first.sentCount).toBeGreaterThanOrEqual(1);

    // 同一天晚些时候
    vi.setSystemTime(new Date('2026-06-01T20:00:00Z'));
    const second = await checkExpiringSubscriptions(env);
    expect(second.dedupedCount).toBeGreaterThanOrEqual(1);
    expect(second.sentCount).toBe(0);
  });

  it('发送全失败时不写 dedupe，同小时可重试', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T08:00:00Z'));
    await env.SUBSCRIPTIONS_KV.put(
      'config',
      JSON.stringify({
        TIMEZONE: 'UTC',
        NOTIFICATION_HOURS: [],
        ENABLED_NOTIFIERS: ['webhook'],
        WEBHOOK_URL: 'https://example.com/h',
        WEBHOOK_METHOD: 'POST'
      })
    );
    await subRepo.save(env, {
      id: 'fail-1',
      name: 'FailSend',
      expiryDate: '2026-06-08T00:00:00.000Z',
      isActive: true,
      autoRenew: false
    });
    await remindersRepo.replaceForSubscription(env, 'fail-1', [
      remindersRepo.normalizeRule({
        id: 'r7',
        type: 'before_expiry',
        value: 7,
        unit: 'days',
        isEnabled: true
      })
    ]);

    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      if (calls === 1) {
        return /** @type {any} */ ({
          ok: false,
          status: 500,
          json: async () => ({ error: 'down' }),
          text: async () => 'down'
        });
      }
      return /** @type {any} */ ({
        ok: true,
        json: async () => ({ ok: true }),
        text: async () => 'ok'
      });
    });

    const first = await checkExpiringSubscriptions(env);
    expect(first.sentCount).toBe(0);

    const second = await checkExpiringSubscriptions(env);
    expect(second.dedupedCount).toBe(0);
    expect(second.sentCount).toBeGreaterThanOrEqual(1);
  });

  it('after_expiry：成功后写 lastFire，间隔内不再匹配发送', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T08:00:00Z'));
    await env.SUBSCRIPTIONS_KV.put(
      'config',
      JSON.stringify({
        TIMEZONE: 'UTC',
        NOTIFICATION_HOURS: [],
        ENABLED_NOTIFIERS: ['webhook'],
        WEBHOOK_URL: 'https://example.com/h',
        WEBHOOK_METHOD: 'POST'
      })
    );
    await subRepo.save(env, {
      id: 'ae-1',
      name: 'After',
      expiryDate: '2026-06-01T00:00:00.000Z',
      isActive: true,
      autoRenew: false
    });
    await remindersRepo.replaceForSubscription(env, 'ae-1', [
      remindersRepo.normalizeRule({
        id: 'ra',
        type: 'after_expiry',
        value: 0,
        unit: 'days',
        repeatInterval: 24,
        isEnabled: true
      })
    ]);
    vi.stubGlobal(
      'fetch',
      async () =>
        /** @type {any} */ ({
          ok: true,
          json: async () => ({}),
          text: async () => 'ok'
        })
    );

    const first = await checkExpiringSubscriptions(env);
    expect(first.matchedCount).toBeGreaterThanOrEqual(1);
    expect(first.sentCount).toBeGreaterThanOrEqual(1);

    // +2 小时仍在 24h 间隔内，且不同小时桶
    vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
    const second = await checkExpiringSubscriptions(env);
    // shouldFire 因 lastFire 拒绝 → matched 可为 0
    expect(second.sentCount).toBe(0);
  });

  it('weekday：周一触发、同天去重、周二不触发', async () => {
    vi.useFakeTimers();
    // 2026-06-01 是周一
    vi.setSystemTime(new Date('2026-06-01T08:00:00Z'));
    await env.SUBSCRIPTIONS_KV.put(
      'config',
      JSON.stringify({
        TIMEZONE: 'UTC',
        NOTIFICATION_HOURS: [],
        ENABLED_NOTIFIERS: ['webhook'],
        WEBHOOK_URL: 'https://example.com/h',
        WEBHOOK_METHOD: 'POST'
      })
    );
    await subRepo.save(env, {
      id: 'wd-1',
      name: 'WeekdayRule',
      expiryDate: '2026-06-08T00:00:00.000Z',
      isActive: true,
      autoRenew: false
    });
    await remindersRepo.replaceForSubscription(env, 'wd-1', [
      remindersRepo.normalizeRule({
        id: 'rw',
        type: 'weekday',
        value: 0,
        unit: 'days',
        days: [1, 2, 3, 4, 5],
        isEnabled: true
      })
    ]);
    vi.stubGlobal(
      'fetch',
      async () =>
        /** @type {any} */ ({
          ok: true,
          json: async () => ({ ok: true }),
          text: async () => 'ok'
        })
    );

    const monday = await checkExpiringSubscriptions(env);
    expect(monday.matchedCount).toBeGreaterThanOrEqual(1);
    expect(monday.sentCount).toBeGreaterThanOrEqual(1);

    // 同一天晚些时候：按天去重，不再发送
    vi.setSystemTime(new Date('2026-06-01T20:00:00Z'));
    const mondayEvening = await checkExpiringSubscriptions(env);
    expect(mondayEvening.dedupedCount).toBeGreaterThanOrEqual(1);
    expect(mondayEvening.sentCount).toBe(0);

    // 周二：同样是工作日，应再次触发
    vi.setSystemTime(new Date('2026-06-02T08:00:00Z'));
    const tuesday = await checkExpiringSubscriptions(env);
    expect(tuesday.matchedCount).toBeGreaterThanOrEqual(1);
    expect(tuesday.sentCount).toBeGreaterThanOrEqual(1);

    // 周六：不在选中星期，不触发
    vi.setSystemTime(new Date('2026-06-06T08:00:00Z'));
    const saturday = await checkExpiringSubscriptions(env);
    expect(saturday.matchedCount).toBe(0);
    expect(saturday.sentCount).toBe(0);
  });

  it('weekday 设了 hours：只在选中小时触发，同小时去重、不同小时可再发', async () => {
    vi.useFakeTimers();
    await env.SUBSCRIPTIONS_KV.put(
      'config',
      JSON.stringify({
        TIMEZONE: 'UTC',
        NOTIFICATION_HOURS: [],
        ENABLED_NOTIFIERS: ['webhook'],
        WEBHOOK_URL: 'https://example.com/h',
        WEBHOOK_METHOD: 'POST'
      })
    );
    await subRepo.save(env, {
      id: 'wdh-1',
      name: 'WeekdayHours',
      expiryDate: '2026-06-08T00:00:00.000Z',
      isActive: true,
      autoRenew: false
    });
    await remindersRepo.replaceForSubscription(env, 'wdh-1', [
      remindersRepo.normalizeRule({
        id: 'rwh',
        type: 'weekday',
        value: 0,
        unit: 'days',
        days: [1, 2, 3, 4, 5],
        hours: [11, 13, 22],
        isEnabled: true
      })
    ]);
    vi.stubGlobal(
      'fetch',
      async () =>
        /** @type {any} */ ({
          ok: true,
          json: async () => ({ ok: true }),
          text: async () => 'ok'
        })
    );

    // 周一 11:00：命中
    vi.setSystemTime(new Date('2026-06-01T11:00:00Z'));
    const at11 = await checkExpiringSubscriptions(env);
    expect(at11.matchedCount).toBeGreaterThanOrEqual(1);
    expect(at11.sentCount).toBeGreaterThanOrEqual(1);

    // 周一 11:30：同一小时桶，去重不重发
    vi.setSystemTime(new Date('2026-06-01T11:30:00Z'));
    const at1130 = await checkExpiringSubscriptions(env);
    expect(at1130.dedupedCount).toBeGreaterThanOrEqual(1);
    expect(at1130.sentCount).toBe(0);

    // 周一 12:00：不在选中小时，不命中
    vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
    const at12 = await checkExpiringSubscriptions(env);
    expect(at12.matchedCount).toBe(0);
    expect(at12.sentCount).toBe(0);

    // 周一 13:00：新的小时桶，再次发送
    vi.setSystemTime(new Date('2026-06-01T13:00:00Z'));
    const at13 = await checkExpiringSubscriptions(env);
    expect(at13.matchedCount).toBeGreaterThanOrEqual(1);
    expect(at13.sentCount).toBeGreaterThanOrEqual(1);

    // 周二 11:00：新的一天，同样触发
    vi.setSystemTime(new Date('2026-06-02T11:00:00Z'));
    const tue11 = await checkExpiringSubscriptions(env);
    expect(tue11.matchedCount).toBeGreaterThanOrEqual(1);
    expect(tue11.sentCount).toBeGreaterThanOrEqual(1);
  });
});
