import assert from 'node:assert/strict';
import test from 'node:test';
import { effectiveReminder, sanitizeReminderDays, sanitizeReminderTime } from './forms-reminder.js';

test('horário padrão do lembrete: normaliza HH:MM e cai em 08:00 quando inválido', () => {
  assert.equal(sanitizeReminderTime('7:30'), '07:30');
  assert.equal(sanitizeReminderTime('18:05'), '18:05');
  assert.equal(sanitizeReminderTime('25:00'), '08:00');
  assert.equal(sanitizeReminderTime(''), '08:00');
});

test('horário do contato substitui o padrão; sem horário próprio, vale o padrão', () => {
  assert.deepEqual(
    effectiveReminder({
      defaultTime: '08:00',
      defaultDays: 'weekdays',
      contactTime: '17:00',
      contactDays: 'daily',
    }),
    { sendTime: '17:00', frequency: 'daily' },
  );
  assert.deepEqual(
    effectiveReminder({ defaultTime: '08:00', defaultDays: 'weekdays', contactTime: '', contactDays: '' }),
    { sendTime: '08:00', frequency: 'weekdays' },
  );
  assert.deepEqual(
    effectiveReminder({ defaultTime: '9:05', defaultDays: 'daily', contactTime: null, contactDays: null }),
    { sendTime: '09:05', frequency: 'daily' },
  );
});

test('dias do lembrete: só “dias úteis” ou todos os dias', () => {
  assert.equal(sanitizeReminderDays('weekdays'), 'weekdays');
  assert.equal(sanitizeReminderDays('weekly'), 'daily');
  assert.equal(sanitizeReminderDays(undefined), 'daily');
});
