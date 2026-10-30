import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeReminderDays, sanitizeReminderTime } from './forms-reminder.js';

test('horário padrão do lembrete: normaliza HH:MM e cai em 08:00 quando inválido', () => {
  assert.equal(sanitizeReminderTime('7:30'), '07:30');
  assert.equal(sanitizeReminderTime('18:05'), '18:05');
  assert.equal(sanitizeReminderTime('25:00'), '08:00');
  assert.equal(sanitizeReminderTime(''), '08:00');
});

test('dias do lembrete: só “dias úteis” ou todos os dias', () => {
  assert.equal(sanitizeReminderDays('weekdays'), 'weekdays');
  assert.equal(sanitizeReminderDays('weekly'), 'daily');
  assert.equal(sanitizeReminderDays(undefined), 'daily');
});
