import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReminderOccurrences,
  localDateTimeToUtc,
  reminderIsCurrent
} from '../lib/reminders.js';

function state(schedule, overrides = {}) {
  return {
    timezone: 'Europe/Moscow',
    actionsByArea: { health: ['Сон до 23:30'] },
    schedules: { 'health::Сон до 23:30': schedule },
    days: {},
    ...overrides
  };
}

test('converts Moscow local schedule time to UTC', () => {
  assert.equal(localDateTimeToUtc('2026-08-03', '09:00', 'Europe/Moscow').toISOString(), '2026-08-03T06:00:00.000Z');
});

test('builds the next daily reminder and preserves task context', () => {
  const value = state({ date: '2026-08-03', time: '09:00', repeat: 'daily', timezone: 'Europe/Moscow', notifyTelegram: true });
  const reminders = buildReminderOccurrences('mila', value, {
    now: new Date('2026-08-03T05:00:00.000Z'),
    horizon: new Date('2026-08-05T08:00:00.000Z'),
    maxOccurrencesPerTask: 1
  });
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].dueAt, '2026-08-03T06:00:00.000Z');
  assert.equal(reminders[0].areaName, 'Здоровье и энергия');
  assert.equal(reminders[0].text, 'Сон до 23:30');
});

test('skips completed occurrence and Telegram-disabled schedules', () => {
  const scheduled = { date: '2026-08-03', time: '09:00', repeat: 'daily', timezone: 'Europe/Moscow', notifyTelegram: true };
  const completed = state(scheduled, { days: { '2026-08-03': { done: ['health::Сон до 23:30'] } } });
  const options = { now: new Date('2026-08-03T05:00:00.000Z'), horizon: new Date('2026-08-03T08:00:00.000Z') };
  assert.equal(buildReminderOccurrences('mila', completed, options).length, 0);
  assert.equal(buildReminderOccurrences('mila', state({ ...scheduled, notifyTelegram: false }), options).length, 0);
});

test('rejects queued reminder after schedule was edited', () => {
  const scheduled = { date: '2026-08-03', time: '09:00', repeat: 'none', timezone: 'Europe/Moscow', notifyTelegram: true };
  const original = state(scheduled);
  const [message] = buildReminderOccurrences('mila', original, {
    now: new Date('2026-08-03T05:00:00.000Z'),
    horizon: new Date('2026-08-03T08:00:00.000Z')
  });
  assert.equal(reminderIsCurrent(original, message), true);
  assert.equal(reminderIsCurrent(state({ ...scheduled, time: '10:00' }), message), false);
});
