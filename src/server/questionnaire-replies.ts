import type { MediaUnderstanding } from './media-understand.js';
import type { CycleAnswer } from './questionnaire-cycles.js';
import { coversQuestions, foldText } from './questionnaire-rules.js';
import type { QuestionnaireQuestion } from './questionnaires.js';

export type EditAction = 'append' | 'correct' | 'delete' | 'update';

export function formatAnswers(
  questions: QuestionnaireQuestion[],
  answers: CycleAnswer[],
): string {
  if (!answers.length) return '';
  const byId = new Map(answers.map((item) => [item.question_id, item]));
  return questions
    .map((question, index) => {
      const answer = byId.get(question.id);
      if (!answer) return '';
      const media = answer.media_url ? ` [${answer.answer_type}]` : '';
      return `${index + 1}. ${question.body} → ${answer.answer_text}${media}`;
    })
    .filter(Boolean)
    .join('\n');
}

export function defaultQuestionnaireReply(
  questions: QuestionnaireQuestion[],
  answers: CycleAnswer[],
  missing: QuestionnaireQuestion[],
  complete: boolean,
  media: MediaUnderstanding,
  contactName: string,
): string {
  if (complete) return completionReply(contactName);
  if (!answers.length) {
    const name = firstName(contactName);
    const hello = name ? `Certo, ${name}!` : 'Certo!';
    return `${hello} Segue o questionário:\n${questionList(questions)}`;
  }
  const thanks =
    media.type === 'audio'
      ? 'Ouvi seu áudio.'
      : media.type === 'image'
        ? 'Recebi a imagem.'
        : media.type === 'video'
          ? 'Recebi o vídeo.'
          : 'Recebi.';
  return `${thanks} Ainda falta:\n${questionList(missing)}`;
}

export function ensureMissingAsked(input: {
  reply: string;
  missing: QuestionnaireQuestion[];
  answers: CycleAnswer[];
  media: MediaUnderstanding;
  contactName: string;
  questions: QuestionnaireQuestion[];
}): string {
  if (!input.missing.length) return input.reply;
  if (asksConfirmation(input.reply) || !coversQuestions(input.reply, input.missing)) {
    return defaultQuestionnaireReply(
      input.questions,
      input.answers,
      input.missing,
      false,
      input.media,
      input.contactName,
    );
  }
  return input.reply;
}

export function completionReply(contactName: string): string {
  const name = firstName(contactName);
  return name ? `Perfeito, ${name}! Anotei tudo, obrigado.` : 'Perfeito! Anotei tudo, obrigado.';
}

export function editReply(contactName: string, action: EditAction): string {
  const name = firstName(contactName);
  if (action === 'delete') {
    return name ? `Pronto, ${name}! Removi os dados como pediu.` : 'Pronto! Removi os dados como pediu.';
  }
  if (action === 'correct') {
    return name ? `Certo, ${name}! Corrigi os dados, obrigado.` : 'Certo! Corrigi os dados, obrigado.';
  }
  if (action === 'append') {
    return name ? `Certo, ${name}! Atualizei os dados, obrigado.` : 'Certo! Atualizei os dados, obrigado.';
  }
  return name ? `Certo, ${name}! Registrei a alteração, obrigado.` : 'Certo! Registrei a alteração, obrigado.';
}

export function mentionsUnderstoodAnswers(reply: string): boolean {
  const text = foldText(reply);
  return (
    /entendi/.test(text) ||
    /anot(ei|ado)/.test(text) ||
    /registre(i|amos)/.test(text) ||
    /agora temos/.test(text) ||
    /vamos la/.test(text) ||
    /voce me respondeu/.test(text) ||
    /ja respondido/.test(text) ||
    /recebi (sua|as) resposta/.test(text)
  );
}

export function pretendsToHaveSaved(reply: string): boolean {
  const text = foldText(reply);
  return (
    mentionsUnderstoodAnswers(reply) ||
    /anotei tudo/.test(text) ||
    /parece que voce nao enviou/.test(text) ||
    /fornecedor\s*:/.test(text)
  );
}

export function asksForMore(reply: string): boolean {
  const text = reply.toLowerCase();
  return (
    /ainda falta/.test(text) ||
    /s[oó] falta/.test(text) ||
    /faltam?\s+(a |o |as |os )?(pergunta|item|dado|resposta)/.test(text) ||
    /quando estiver pronto/.test(text) ||
    /pode me responder/.test(text)
  );
}

export function asksConfirmation(reply: string): boolean {
  const text = reply.toLowerCase();
  return (
    /confirma/.test(text) ||
    /est[aá] correto/.test(text) ||
    /t[aá] certo/.test(text) ||
    /j[aá] respondido/.test(text)
  );
}

function questionList(questions: QuestionnaireQuestion[]): string {
  return questions.map((item, index) => `${index + 1}) ${item.body}`).join('\n');
}

function firstName(contactName: string): string {
  return contactName?.trim().split(/\s+/)[0] || '';
}
