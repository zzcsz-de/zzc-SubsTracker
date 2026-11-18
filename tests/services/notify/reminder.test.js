// @ts-check
/**
 * 提醒通知正文（formatNotificationContent）单元测试
 * 免费订阅（金额为 0）应显示「金额: 免费」，而不是 ¥0.00/周期。
 */
import { describe, it, expect } from 'vitest';
import { formatNotificationContent } from '../../../src/services/notify/reminder.js';

/**
 * @param {Record<string, any>} [overrides]
 */
function makeSub(overrides = {}) {
  return {
    name: '测试订阅',
    customType: '服务器',
    periodValue: 1,
    periodUnit: 'month',
    category: '开发',
    expiryDate: '2026-11-27T00:00:00.000Z',
    daysRemaining: 8,
    amount: 0,
    currency: 'CNY',
    useLunar: false,
    autoRenew: true,
    notes: '',
    reminderDays: 7,
    ...overrides,
  };
}

const config = { TIMEZONE: 'Asia/Shanghai', SHOW_LUNAR: false };

describe('formatNotificationContent 金额显示', () => {
  it('金额为 0 显示「金额: 免费」，不显示 0.00', () => {
    const content = formatNotificationContent([makeSub({ amount: 0 })], config);
    expect(content).toContain('金额: 免费');
    expect(content).not.toContain('0.00');
    expect(content).not.toContain('金额: 免费/周期');
  });

  it('金额为付费值时照常显示金额/周期', () => {
    const content = formatNotificationContent([makeSub({ amount: 15 })], config);
    expect(content).toContain('金额: ¥15.00/周期');
    expect(content).not.toContain('免费');
  });

  it('金额未设置时不显示金额行', () => {
    const content = formatNotificationContent([makeSub({ amount: null })], config);
    expect(content).not.toContain('金额:');
  });
});
