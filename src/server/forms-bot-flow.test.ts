import assert from 'node:assert/strict';
import test from 'node:test';
import { tryFormsBotCapture } from './forms-bot-capture.js';
import { buildFormsBotGuidedPrompt, formatCatalogListPage } from './forms-bot-catalog-context.js';
import { FORMS_BOT_LINES_FIELD, FORMS_BOT_LINES_MORE_FIELD, quantityOnlyLinesQuestion } from './forms-bot-fields.js';
import { planBotLines } from './forms-bot-lines.js';
import { fromOdooNumber, toOdooNumber } from './odoo-number.js';
import type { CycleAnswer } from './questionnaire-cycles.js';
import { isFullyAnswered } from './questionnaire-rules.js';
import type { Questionnaire, QuestionnaireQuestion } from './questionnaires.js';

// Caminho completo do Forms Bot sem banco: convite → respostas → linhas do documento → números do Odoo.

const question = (
  id: string,
  body: string,
  exportField: string,
  sortOrder: number,
  fixedValue = '',
): QuestionnaireQuestion => ({
  id,
  questionnaire_id: 'forms-preset:p1',
  body,
  expected_type: 'any',
  export_field: exportField,
  sort_order: sortOrder,
  fixed_value: fixedValue,
});

const questions = [
  question('v', 'Fornecedor?', 'vendor', 0),
  question('l', quantityOnlyLinesQuestion('ABACATE - KG'), FORMS_BOT_LINES_FIELD, 1, 'ABACATE - KG'),
  question('m', 'Mais produtos? (produto + qtd, ou “não”)', FORMS_BOT_LINES_MORE_FIELD, 2),
];
const questionnaire = {
  id: 'forms-preset:p1',
  sourcePresetId: 'p1',
  formKind: 'purchase',
  companyOdooId: '1',
  questions,
} as unknown as Questionnaire;

const presetLines = [{ values: { product: 'ABACATE - KG', quantity: '', unit_price: '15.5', taxes: '17% ICMS I' } }];

const vendors = ['Associação do Desenvolvimento Comunitário', 'Fornecedor Teste Vertice', 'Marcio Luiz Pietsrzak'].map(
  (name) => ({ value: name, label: name, score: 100 }),
);
const invite = [
  'Oi Cleiton! Compras — Ademir - Compras',
  '',
  formatCatalogListPage({ key: 'vendor', label: 'Fornecedor', required: true }, vendors),
  '',
  'Depois: Qtd de ABACATE - KG; Mais produtos? (produto + qtd, ou “não”).',
].join('\n');

type Turn = { inbound: string; pendingQuestionId: string };

async function runConversation(turns: Turn[]): Promise<CycleAnswer[]> {
  const answers: CycleAnswer[] = [];
  const history = [{ direction: 'OUTBOUND', text: invite }];
  for (const turn of turns) {
    const captured = await tryFormsBotCapture({
      inbound: turn.inbound,
      questionnaire,
      questions,
      alreadySaved: answers,
      history,
      pendingQuestionId: turn.pendingQuestionId,
    });
    assert.equal(captured?.kind, 'answers', `“${turn.inbound}” deveria ser capturado sem o modelo`);
    if (captured?.kind !== 'answers') break;
    for (const item of captured.accepted) {
      const row = { id: item.questionId, cycle_id: 'c', question_id: item.questionId, answer_text: item.text, answer_type: 'text', media_url: '' };
      const index = answers.findIndex((answer) => answer.question_id === item.questionId);
      if (index >= 0) answers[index] = row;
      else answers.push(row);
    }
    history.push({ direction: 'INBOUND', text: turn.inbound }, { direction: 'OUTBOUND', text: `Anotei: ${captured.summary}.` });
  }
  return answers;
}

function answerFor(answers: CycleAnswer[], questionId: string): string {
  return answers.find((row) => row.question_id === questionId)?.answer_text || '';
}

test('conversa do Cleiton vira documento com fornecedor e quantidades corretas', async () => {
  // pending “l” reproduz o estado ruim observado em produção: a lista visível precisa prevalecer.
  const answers = await runConversation([
    { inbound: '3', pendingQuestionId: 'l' },
    { inbound: '50 kg de abacate e 20 kg de mandioca', pendingQuestionId: 'l' },
    { inbound: 'não', pendingQuestionId: 'm' },
  ]);

  assert.equal(answerFor(answers, 'v'), 'Marcio Luiz Pietsrzak');
  assert.ok(isFullyAnswered(questions, answers));

  const plan = planBotLines({
    kind: 'purchase',
    presetLines,
    visibleLineKeys: ['quantity'],
    linesAnswer: answerFor(answers, 'l'),
    moreAnswer: answerFor(answers, 'm'),
  });
  assert.deepEqual(plan.primary, [
    // Produto fixo do padrão prevalece sobre o “abacate” digitado.
    { product: 'ABACATE - KG', quantity: '50', unit_price: '15.5', taxes: '17% ICMS I' },
    // Linha além do padrão não herda o preço do abacate.
    { product: 'mandioca', quantity: '20', taxes: '17% ICMS I' },
  ]);
  assert.deepEqual(plan.extra, []);
  assert.deepEqual(plan.primary.map((row) => toOdooNumber(row.quantity, 1)), [50, 20]);
});

test('só a quantidade para o produto fixo do padrão', async () => {
  const answers = await runConversation([
    { inbound: '2', pendingQuestionId: 'v' },
    { inbound: '50 kg', pendingQuestionId: 'l' },
    // Itens em “Mais produtos?” já encerram o questionário.
    { inbound: '12 kg de mandioca', pendingQuestionId: 'm' },
  ]);
  assert.equal(answerFor(answers, 'v'), 'Fornecedor Teste Vertice');
  assert.ok(isFullyAnswered(questions, answers));

  const plan = planBotLines({
    kind: 'purchase',
    presetLines,
    visibleLineKeys: ['quantity'],
    linesAnswer: answerFor(answers, 'l'),
    moreAnswer: answerFor(answers, 'm'),
  });
  assert.deepEqual(plan.primary, [{ product: 'ABACATE - KG', quantity: '50', unit_price: '15.5', taxes: '17% ICMS I' }]);
  assert.deepEqual(plan.extra, [{ product: 'mandioca', quantity: '12' }]);
});

test('pergunta de linhas com produto fixo não mostra o catálogo de produtos', async () => {
  const prompt = await buildFormsBotGuidedPrompt({ questionnaire, questions: questions.slice(1) });
  assert.equal(prompt, 'Qtd de ABACATE - KG?\n\nDepois: Mais produtos? (produto + qtd, ou “não”).');
});

test('números vindos do Odoo viram texto limpo', () => {
  assert.equal(fromOdooNumber(50), '50');
  assert.equal(fromOdooNumber(0.1 + 0.2), '0.3');
  assert.equal(fromOdooNumber(false), '');
  assert.equal(fromOdooNumber('20 kg'), '20');
  assert.equal(toOdooNumber('R$ 15,50'), 15.5);
});
