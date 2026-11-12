import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mergeCycleCandidates,
  preferPromptedRecentCycle,
} from './questionnaire-routing.js';
import type { ActiveCycleContext } from './questionnaire-cycles.js';
import type { QuestionnaireQuestion } from './questionnaires.js';

const questions: QuestionnaireQuestion[] = [
  {
    id: 'kg',
    questionnaire_id: 'q1',
    body: 'Quantos kg?',
    expected_type: 'any',
    export_field: 'quantity',
    sort_order: 0,
  },
];

function ctx(
  id: string,
  date: string,
  status: ActiveCycleContext['cycle']['status'],
  promptedAt = '',
): ActiveCycleContext {
  return {
    cycle: {
      id,
      questionnaire_id: 'q1',
      contact_id: 'c1',
      revision_id: 'r1',
      occurrence_date: date,
      status,
      template_sent_at: promptedAt,
      completed_at: '',
      error: '',
      last_prompted_at: promptedAt,
      last_inbound_at: '',
    },
    questionnaire: {
      id: 'q1',
      name: 'Teste 1',
      greeting: '',
      frequency: 'daily',
      weekday: 1,
      send_time: '20:53',
      active: 1,
      template_id: '',
      version: 1,
      created_at: '',
      updated_at: '',
      defaultValues: {},
      sourcePresetId: '',
      formKind: '',
      companyOdooId: '',
      contactIds: [],
      questions,
    },
    answers: [],
    missing: questions,
  };
}

test('preferPromptedRecentCycle ignora ciclo de ontem (fecha à meia-noite)', () => {
  const today = ctx('today', '2026-10-19', 'open');
  const yesterday = ctx(
    'yest',
    '2026-10-18',
    'notified',
    '2026-10-18T23:53:23.619Z',
  );
  const preferred = preferPromptedRecentCycle([today, yesterday], '2026-10-19');
  assert.equal(preferred, undefined);
});

test('preferPromptedRecentCycle escolhe o last_prompted_at mais recente do dia', () => {
  const older = ctx('a', '2026-10-19', 'notified', '2026-10-19T12:00:00.000Z');
  const newer = ctx('b', '2026-10-19', 'notified', '2026-10-19T18:00:00.000Z');
  const preferred = preferPromptedRecentCycle([older, newer], '2026-10-19');
  assert.equal(preferred?.cycle.id, 'b');
});

test('mergeCycleCandidates une só o dia atual, sem duplicar', () => {
  const today = ctx('today', '2026-10-19', 'open');
  const yesterday = ctx(
    'yest',
    '2026-10-18',
    'notified',
    '2026-10-18T23:53:23.619Z',
  );
  const merged = mergeCycleCandidates([today], [yesterday, today], '2026-10-19');
  assert.equal(merged.length, 1);
  assert.equal(merged[0].cycle.id, 'today');
});
