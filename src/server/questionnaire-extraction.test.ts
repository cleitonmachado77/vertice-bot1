import assert from 'node:assert/strict';
import test from 'node:test';
import {
  autoAssignMedia,
  heuristicExtractAnswers,
  normalizeExtractedAnswers,
} from './questionnaire-extraction.js';
import type { QuestionnaireQuestion } from './questionnaires.js';

const question = (
  id: string,
  expected_type = 'any',
): QuestionnaireQuestion => ({
  id,
  questionnaire_id: 'q1',
  body: `Pergunta ${id} completa`,
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
    [{ questionId: 'quantidade', text: 'Recebi 10 kg', type: 'text' }],
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
