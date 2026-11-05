import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFormsBotAgendaItems,
  compareFormsBotAgendaItems,
  formatFormsBotAgendaOffer,
  looksLikeFormsBotAgendaMeta,
  outboundOffersFormsAgenda,
  parseFormsBotAgendaIntent,
  pickPrimaryFormsBotAgendaItem,
  remainingFormsBotAgendaItems,
  type FormsBotAgendaItem,
} from './forms-bot-agenda.js';
import type { ActiveCycleContext } from './questionnaire-cycles.js';
import type { QuestionnaireQuestion } from './questionnaires.js';

const questions: QuestionnaireQuestion[] = [
  {
    id: 'q',
    questionnaire_id: 'forms-preset:p1',
    body: 'Fornecedor?',
    expected_type: 'any',
    export_field: 'vendor',
    sort_order: 0,
  },
];

function item(partial: {
  id: string;
  kind: 'purchase' | 'sale' | 'product';
  name: string;
  sendTime: string;
  status?: FormsBotAgendaItem['status'];
  cycleStatus?: ActiveCycleContext['cycle']['status'];
}): FormsBotAgendaItem {
  const questionnaireId = `forms-preset:${partial.id}`;
  const context: ActiveCycleContext = {
    cycle: {
      id: `cycle-${partial.id}`,
      questionnaire_id: questionnaireId,
      contact_id: 'c1',
      revision_id: 'r1',
      occurrence_date: '2026-10-22',
      status: partial.cycleStatus || 'open',
      template_sent_at: '',
      completed_at: '',
      error: '',
      last_prompted_at: partial.status === 'in_progress' ? '2026-10-22T10:00:00.000Z' : '',
      last_inbound_at: '',
    },
    questionnaire: {
      id: questionnaireId,
      name: `[Forms] ${partial.name}`,
      greeting: '',
      frequency: 'daily',
      weekday: 3,
      send_time: partial.sendTime,
      active: 1,
      template_id: '',
      version: 1,
      created_at: '',
      updated_at: '',
      defaultValues: {},
      sourcePresetId: partial.id,
      formKind: partial.kind,
      companyOdooId: '1',
      contactIds: ['c1'],
      questions,
    },
    answers: [],
    missing: questions,
  };
  return {
    questionnaireId,
    cycleId: context.cycle.id,
    presetId: partial.id,
    kind: partial.kind,
    name: partial.name,
    label: partial.name,
    sendTime: partial.sendTime,
    status: partial.status || 'pending',
    context,
  };
}

test('compareFormsBotAgendaItems prefere horário mais próximo e kind estável', () => {
  const compras = item({ id: '1', kind: 'purchase', name: 'Compras', sendTime: '08:00' });
  const vendas = item({ id: '2', kind: 'sale', name: 'Vendas', sendTime: '18:00' });
  const inv = item({ id: '3', kind: 'product', name: 'Inventário', sendTime: '12:00' });
  // 11:00 → inventário (12:00) mais perto que compras (08:00) e vendas (18:00)
  assert.equal(compareFormsBotAgendaItems(inv, compras, 11 * 60) < 0, true);
  assert.equal(compareFormsBotAgendaItems(inv, vendas, 11 * 60) < 0, true);
  const primary = pickPrimaryFormsBotAgendaItem([compras, vendas, inv], 11 * 60);
  assert.equal(primary?.kind, 'product');
});

test('pickPrimaryFormsBotAgendaItem prioriza em andamento', () => {
  const pending = item({ id: '1', kind: 'purchase', name: 'Compras', sendTime: '08:00' });
  const active = item({
    id: '2',
    kind: 'sale',
    name: 'Vendas',
    sendTime: '18:00',
    status: 'in_progress',
  });
  const primary = pickPrimaryFormsBotAgendaItem([pending, active], 8 * 60);
  assert.equal(primary?.kind, 'sale');
});

test('nome do padrão não escolhe a agenda; o número escolhe', () => {
  const agenda = [
    item({ id: '1', kind: 'purchase', name: 'Ademir - Compras', sendTime: '08:00' }),
    item({ id: '2', kind: 'sale', name: 'Vendas do Dia', sendTime: '18:00' }),
    item({ id: '3', kind: 'product', name: 'Produção do Dia', sendTime: '12:00' }),
  ];
  assert.equal(parseFormsBotAgendaIntent('hoje só inventário', agenda).action, 'none');
  assert.equal(parseFormsBotAgendaIntent('hoje não temos inventário', agenda).action, 'none');
  assert.equal(parseFormsBotAgendaIntent('respondi compras, vou responder vendas', agenda).action, 'none');
  const picked = parseFormsBotAgendaIntent('3', agenda, { awaitingOffer: true });
  assert.equal(picked.action, 'select');
  if (picked.action === 'select') assert.equal(picked.item.kind, 'product');
});

test('número na oferta escolhe o item da lista, não um formulário já fechado', () => {
  const agenda = [
    item({ id: '1', kind: 'purchase', name: 'Compras · SEPARAÇÃO', sendTime: '08:00' }),
    item({ id: '2', kind: 'sale', name: 'Fabricação · Produção de Fardos', sendTime: '09:00' }),
    item({ id: '3', kind: 'sale', name: 'Vendas · Entrega de Fardos', sendTime: '10:00' }),
    item({ id: '4', kind: 'product', name: 'Inventário · Separação de Bags', sendTime: '11:00' }),
  ];
  const picked = parseFormsBotAgendaIntent('4', agenda, { awaitingOffer: true });
  assert.equal(picked.action, 'select');
  if (picked.action === 'select') assert.equal(picked.item.kind, 'product');
  const offer = formatFormsBotAgendaOffer(agenda);
  assert.equal(outboundOffersFormsAgenda(`Perfeito! Anotei tudo, obrigado.\n\n${offer}`), true);
  assert.equal(outboundOffersFormsAgenda('Anotei o produto SUCATA DE FERRO. Qual a quantidade?'), false);
});

test('oferta de um padrão aceita 1 e encerra com 2', () => {
  const agenda = [
    item({ id: '1', kind: 'sale', name: 'Vendas do Dia', sendTime: '18:00' }),
  ];
  assert.equal(parseFormsBotAgendaIntent('1', agenda, { awaitingOffer: true }).action, 'accept_offer');
  assert.equal(parseFormsBotAgendaIntent('2', agenda, { awaitingOffer: true }).action, 'decline_offer');
  assert.equal(parseFormsBotAgendaIntent('sim', agenda, { awaitingOffer: true }).action, 'none');
  assert.equal(parseFormsBotAgendaIntent('sim, vamos', agenda, { awaitingOffer: true }).action, 'none');
  assert.equal(looksLikeFormsBotAgendaMeta('não'), false);
  assert.equal(looksLikeFormsBotAgendaMeta('pular vendas'), false);
});

test('“já respondi o fornecedor” fala de um campo — não pula o formulário', () => {
  const agenda = [
    item({ id: '1', kind: 'purchase', name: 'Ademir - Compras', sendTime: '08:00', status: 'in_progress' }),
  ];
  assert.equal(looksLikeFormsBotAgendaMeta('Já respondi o fornecedor'), false);
  assert.equal(looksLikeFormsBotAgendaMeta('não tem mais'), false);
  assert.equal(looksLikeFormsBotAgendaMeta('não temos mais produtos para lançar'), false);
  assert.equal(parseFormsBotAgendaIntent('Já respondi o fornecedor', agenda).action, 'none');
  assert.equal(looksLikeFormsBotAgendaMeta('já respondi compras'), false);
});

test('formatFormsBotAgendaOffer lista pendentes', () => {
  const remaining = remainingFormsBotAgendaItems([
    item({ id: '1', kind: 'purchase', name: 'Compras', sendTime: '08:00', status: 'completed' }),
    item({ id: '2', kind: 'sale', name: 'Vendas', sendTime: '18:00' }),
  ]);
  const text = formatFormsBotAgendaOffer(remaining);
  assert.match(text, /1\) Sim, seguir/);
  assert.match(text, /2\) Não, encerrar/);
  assert.match(text, /Digite o número da opção/);
});

test('buildFormsBotAgendaItems aplica skipped e completed', () => {
  const purchase = item({ id: '1', kind: 'purchase', name: 'Compras', sendTime: '08:00' });
  const sale = item({
    id: '2',
    kind: 'sale',
    name: 'Vendas',
    sendTime: '18:00',
    cycleStatus: 'completed',
  });
  sale.context.cycle.status = 'completed';
  const agenda = buildFormsBotAgendaItems(
    [purchase.context, sale.context],
    new Set([purchase.questionnaireId]),
    9 * 60,
  );
  assert.equal(agenda.find((entry) => entry.kind === 'purchase')?.status, 'skipped');
  assert.equal(agenda.find((entry) => entry.kind === 'sale')?.status, 'completed');
});
