// @ts-check
/**
 * 提醒规则仓库单元测试
 */
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-ignore
import { env } from 'cloudflare:test';

import * as repo from '../../src/data/reminders.repo.js';

async function clearKv() {
  const list = await env.SUBSCRIPTIONS_KV.list();
  await Promise.all(list.keys.map((k) => env.SUBSCRIPTIONS_KV.delete(k.name)));
}

beforeEach(clearKv);

describe('reminders.repo', () => {
  it('listForSubscription 空返回空数组', async () => {
    expect(await repo.listForSubscription(env, 's1')).toEqual([]);
  });

  it('addRule + listForSubscription', async () => {
    const r = await repo.addRule(env, 's1', { type: 'before_expiry', value: 7, unit: 'days' });
    expect(r.id).toBeTruthy();
    expect(r.value).toBe(7);
    const list = await repo.listForSubscription(env, 's1');
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(r.id);
  });

  it('updateRule 合并 patch', async () => {
    const r = await repo.addRule(env, 's1', { type: 'before_expiry', value: 7, unit: 'days' });
    const upd = await repo.updateRule(env, 's1', r.id, { value: 3, isEnabled: false });
    expect(upd?.value).toBe(3);
    expect(upd?.isEnabled).toBe(false);
    const list = await repo.listForSubscription(env, 's1');
    expect(list[0].value).toBe(3);
  });

  it('deleteRule 不存在返回 false', async () => {
    expect(await repo.deleteRule(env, 's1', 'nope')).toBe(false);
  });

  it('deleteRule 存在返回 true', async () => {
    const r = await repo.addRule(env, 's1', { type: 'on_expiry', value: 0, unit: 'days' });
    expect(await repo.deleteRule(env, 's1', r.id)).toBe(true);
    expect(await repo.listForSubscription(env, 's1')).toEqual([]);
  });

  it('clearForSubscription 清空整个 key', async () => {
    await repo.addRule(env, 's1', { type: 'before_expiry', value: 7, unit: 'days' });
    await repo.clearForSubscription(env, 's1');
    expect(await repo.listForSubscription(env, 's1')).toEqual([]);
  });

  it('defaultPresetRules 返回 4 条预设（7/3/1/当天）', () => {
    const rules = repo.defaultPresetRules();
    expect(rules).toHaveLength(4);
    expect(rules.map((r) => `${r.type}:${r.value}${r.unit[0]}`)).toEqual([
      'before_expiry:7d',
      'before_expiry:3d',
      'before_expiry:1d',
      'on_expiry:0d'
    ]);
    rules.forEach((r) => expect(r.isEnabled).toBe(true));
  });

  it('legacyFieldToRule：day 单位 7 → before_expiry/7/days', () => {
    const r = repo.legacyFieldToRule({ reminderUnit: 'day', reminderValue: 7 });
    expect(r).toMatchObject({ type: 'before_expiry', value: 7, unit: 'days' });
  });

  it('legacyFieldToRule：hour 单位', () => {
    const r = repo.legacyFieldToRule({ reminderUnit: 'hour', reminderValue: 12 });
    expect(r).toMatchObject({ type: 'before_expiry', value: 12, unit: 'hours' });
  });

  it('legacyFieldToRule：value=0 → on_expiry', () => {
    const r = repo.legacyFieldToRule({ reminderUnit: 'day', reminderValue: 0 });
    expect(r.type).toBe('on_expiry');
  });

  it('legacyFieldToRule：缺失值兜底 7 天', () => {
    const r = repo.legacyFieldToRule({});
    expect(r).toMatchObject({ type: 'before_expiry', value: 7, unit: 'days' });
  });

  it('normalizeRule：非法 type 兜底为 before_expiry', () => {
    const r = repo.normalizeRule({ type: 'lol', value: 5, unit: 'days' });
    expect(r.type).toBe('before_expiry');
  });

  it('normalizeRule：repeatInterval 仅 after_expiry 保留', () => {
    const a = repo.normalizeRule({ type: 'before_expiry', value: 1, unit: 'days', repeatInterval: 24 });
    expect(a.repeatInterval).toBeNull();
    const b = repo.normalizeRule({ type: 'after_expiry', value: 0, unit: 'days', repeatInterval: 24 });
    expect(b.repeatInterval).toBe(24);
  });

  it('normalizeRule：weekday 保留 days，去重排序、过滤非法值', () => {
    const r = repo.normalizeRule({ type: 'weekday', value: 9, unit: 'hours', days: [5, 1, 1, 9, -1, '3'] });
    expect(r.type).toBe('weekday');
    expect(r.days).toEqual([1, 3, 5]);
    expect(r.value).toBe(0);
    expect(r.unit).toBe('days');
  });

  it('normalizeRule：weekday 缺 days 时默认周一至周五', () => {
    expect(repo.normalizeRule({ type: 'weekday' }).days).toEqual([1, 2, 3, 4, 5]);
    expect(repo.normalizeRule({ type: 'weekday', days: [] }).days).toEqual([1, 2, 3, 4, 5]);
  });

  it('normalizeRule：weekday 的 hours 去重排序、过滤非法值，缺失为 null', () => {
    expect(repo.normalizeRule({ type: 'weekday', hours: [22, 11, 11, 25, -1, '13'] }).hours).toEqual([11, 13, 22]);
    expect(repo.normalizeRule({ type: 'weekday' }).hours).toBeNull();
    expect(repo.normalizeRule({ type: 'weekday', hours: [] }).hours).toBeNull();
  });

  it('normalizeRule：非 weekday 类型不存 days/hours', () => {
    const r = repo.normalizeRule({ type: 'before_expiry', value: 7, unit: 'days', days: [1, 2], hours: [11] });
    expect(r.days).toBeNull();
    expect(r.hours).toBeNull();
  });

  it('formatWeekdayDays：常见组合', () => {
    expect(repo.formatWeekdayDays([1, 2, 3, 4, 5])).toBe('每周一至五');
    expect(repo.formatWeekdayDays([0, 6])).toBe('每周六/日');
    expect(repo.formatWeekdayDays([0, 1, 2, 3, 4, 5, 6])).toBe('每天');
    expect(repo.formatWeekdayDays([1, 3, 5])).toBe('每周一/三/五');
    expect(repo.formatWeekdayDays([0])).toBe('每周日');
    expect(repo.formatWeekdayDays(null)).toBe('每周一至五');
  });

  it('formatWeekdayDays：带 hours 追加时间', () => {
    expect(repo.formatWeekdayDays([1, 2, 3, 4, 5], [11, 13, 22])).toBe('每周一至五 11/13/22点');
    expect(repo.formatWeekdayDays([3], [13, 22])).toBe('每周三 13/22点');
    expect(repo.formatWeekdayDays([1, 2, 3, 4, 5], null)).toBe('每周一至五');
    expect(repo.formatWeekdayDays([1, 2, 3, 4, 5], [])).toBe('每周一至五');
  });

  it('formatRulesSummary：含带时间的 weekday 规则', () => {
    const summary = repo.formatRulesSummary([
      { id: '1', type: 'weekday', value: 0, unit: 'days', days: [1, 2, 3, 4, 5], hours: [11, 13, 22], isEnabled: true, createdAt: '' }
    ]);
    expect(summary).toBe('每周一至五 11/13/22点');
  });

  it('formatRulesSummary：含 weekday 规则', () => {
    const summary = repo.formatRulesSummary([
      { id: '1', type: 'before_expiry', value: 7, unit: 'days', isEnabled: true, createdAt: '' },
      { id: '2', type: 'weekday', value: 0, unit: 'days', days: [1, 2, 3, 4, 5], isEnabled: true, createdAt: '' }
    ]);
    expect(summary).toContain('提前 7 天');
    expect(summary).toContain('每周一至五');
  });

  it('formatRulesSummary：多规则摘要', () => {
    const summary = repo.formatRulesSummary([
      { id: '1', type: 'before_expiry', value: 30, unit: 'days', isEnabled: true, createdAt: '' },
      { id: '2', type: 'before_expiry', value: 7, unit: 'days', isEnabled: true, createdAt: '' },
      { id: '3', type: 'on_expiry', value: 0, unit: 'days', isEnabled: true, createdAt: '' }
    ]);
    expect(summary).toContain('30');
    expect(summary).toContain('7');
    expect(summary).toContain('到期当天');
  });

  it('deriveLegacyFromRules：取最大 before_expiry', () => {
    const legacy = repo.deriveLegacyFromRules([
      { id: '1', type: 'before_expiry', value: 30, unit: 'days', isEnabled: true, createdAt: '' },
      { id: '2', type: 'before_expiry', value: 7, unit: 'days', isEnabled: true, createdAt: '' },
      { id: '3', type: 'on_expiry', value: 0, unit: 'days', isEnabled: true, createdAt: '' }
    ]);
    expect(legacy).toEqual({ unit: 'day', value: 30 });
  });

  it('deriveLegacyFromRules：仅 on_expiry 时 value=0', () => {
    const legacy = repo.deriveLegacyFromRules([
      { id: '1', type: 'on_expiry', value: 0, unit: 'days', isEnabled: true, createdAt: '' }
    ]);
    expect(legacy).toEqual({ unit: 'day', value: 0 });
  });
});
