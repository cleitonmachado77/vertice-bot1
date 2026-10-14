import assert from 'node:assert/strict';
import test from 'node:test';
import {
  autoAssignMedia,
  cleanAnswerForQuestion,
  heuristicExtractAnswers,
  normalizeExtractedAnswers,
  parseExtracted,
} from './questionnaire-extraction.js';
import type { QuestionnaireQuestion } from './questionnaires.js';
import type { MediaUnderstanding } from './media-understand.js';

const textMedia = (summary = ''): MediaUnderstanding => ({
  type: 'text',
  summary,
  transcript: '',
  caption: '',
  mediaUrl: '',
  understood: true,
});

const question = (
  id: string,
  expected_type = 'any',
  body = `Pergunta ${id} completa`,
): QuestionnaireQuestion => ({
  id,
  questionnaire_id: 'q1',
  body,
  expected_type,
  export_field: '',
  sort_order: 0,
});

test('não remapeia questionId inventado silenciosamente', () => {
  const questions = [question('a'), question('b')];
  assert.deepEqual(
    normalizeExtractedAnswers(
      [{ questionId: 'inventado', text: 'resposta', type: 'text' }],
      questions,
      questions,
    ),
    [],
  );
});

test('não sobrescreve pergunta já respondida no fluxo normal', () => {
  const questions = [question('respondida'), question('pendente')];
  assert.deepEqual(
    normalizeExtractedAnswers(
      [{ questionId: 'respondida', text: 'novo valor indevido', type: 'text' }],
      questions,
      [questions[1]],
    ),
    [],
  );
});

test('fallback de quantidade não inventa resposta de fornecedor', () => {
  const quantity = { ...question('quantidade'), body: 'Qual foi o peso recebido em kg?' };
  const supplier = { ...question('fornecedor'), body: 'Qual foi o fornecedor?' };
  assert.deepEqual(
    heuristicExtractAnswers([quantity, supplier], 'Recebi 10 kg'),
    [{ questionId: 'quantidade', text: '10 kg', type: 'text' }],
  );
  assert.deepEqual(heuristicExtractAnswers([supplier], 'Recebi 10 kg'), []);
});

test('não associa mídia ambígua à primeira pergunta', () => {
  assert.deepEqual(
    autoAssignMedia([question('a'), question('b')], {
      type: 'image',
      summary: 'Imagem recebida.',
      transcript: '',
      caption: '',
      mediaUrl: 'https://example.test/image.jpg',
      understood: false,
    }),
    [],
  );
});

test('aceita mídia sem descrição quando o tipo esperado é explícito', () => {
  const result = autoAssignMedia([question('photo', 'image')], {
    type: 'image',
    summary: 'Imagem recebida.',
    transcript: '',
    caption: '',
    mediaUrl: 'https://example.test/image.jpg',
    understood: false,
  });
  assert.equal(result[0]?.questionId, 'photo');
});

test('separa kg e produto quando a mensagem mistura os dois', () => {
  const qty = question('kg', 'any', 'Quantos kg vc recebeu?');
  const product = question('produto', 'any', 'Qual produto vc recebeu?');
  assert.equal(cleanAnswerForQuestion('399kg de cobre', product), 'cobre');
  assert.equal(cleanAnswerForQuestion('Eu recebi 399kg de cobre', product), 'cobre');
  assert.equal(cleanAnswerForQuestion('hoje recebi 250 kg de Alumínio', product), 'alumínio');
  assert.equal(cleanAnswerForQuestion('Alumínio', product), 'alumínio');
  assert.equal(cleanAnswerForQuestion('cobre 399kg', product), 'cobre');
  assert.equal(cleanAnswerForQuestion('399kg de cobre', qty), '399 kg');
  assert.deepEqual(
    normalizeExtractedAnswers(
      [
        { questionId: 'kg', text: '399kg de cobre', type: 'text' },
        { questionId: 'produto', text: '399kg de cobre', type: 'text' },
      ],
      [qty, product],
      [qty, product],
    ),
    [
      { questionId: 'kg', text: '399 kg', type: 'text' },
      { questionId: 'produto', text: 'cobre', type: 'text' },
    ],
  );
  assert.deepEqual(heuristicExtractAnswers([qty, product], 'Eu recebi 399kg de cobre'), [
    { questionId: 'kg', text: '399 kg', type: 'text' },
    { questionId: 'produto', text: 'cobre', type: 'text' },
  ]);
});

test('parseExtracted respeita related=false para deferir ao agente geral', () => {
  const parsed = parseExtracted(
    '{"related":false,"reply":"","answers":[],"complete":false}',
    textMedia('oi'),
  );
  assert.equal(parsed.related, false);
  assert.equal(parsed.reply, '');
  assert.equal(parsed.answers.length, 0);
});
