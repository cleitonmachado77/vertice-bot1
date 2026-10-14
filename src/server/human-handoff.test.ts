import assert from 'node:assert/strict';
import test from 'node:test';
import { looksLikeHumanHandoff } from './human-handoff.js';

test('detecta frases típicas de passagem para humano', () => {
  assert.equal(
    looksLikeHumanHandoff(
      'Vou passar seu atendimento para um atendente humano, que poderá te ajudar com essa informação.',
    ),
    true,
  );
  assert.equal(
    looksLikeHumanHandoff(
      'Claro! Vou passar seu atendimento para um atendente humano. Aguarde um momento, por favor.',
    ),
    true,
  );
  assert.equal(
    looksLikeHumanHandoff('Vou passar essa pergunta para um atendente humano, ok?'),
    true,
  );
  assert.equal(looksLikeHumanHandoff('Perfeito! Anotei tudo, obrigado.'), false);
  assert.equal(looksLikeHumanHandoff('Amanhã a vértice estará aberta?'), false);
});
