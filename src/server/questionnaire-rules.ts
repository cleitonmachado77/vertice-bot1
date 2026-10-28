import {
  FORMS_BOT_CONFIRM_FIELD,
  FORMS_BOT_LINES_MORE_FIELD,
  isConfirmYesAnswer,
  isMarkedNewValue,
  isUsableLinesMoreAnswer,
} from './forms-bot-fields.js';
import type { MediaUnderstanding } from './media-understand.js';
import type { CycleAnswer } from './questionnaire-cycles.js';
import type { QuestionnaireQuestion } from './questionnaires.js';

export function foldText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ç/g, 'c')
    .trim();
}

export function isNonAnswerText(text: string): boolean {
  const normalized = foldText(text);
  return !normalized || /^(\.+|-+)$/.test(normalized);
}

/** Saudação / confirmação curta — não é resposta de campo. */
export function isGreetingOrAck(text: string): boolean {
  const folded = foldText(text).replace(/[!?.,;:]+$/g, '').trim();
  if (!folded) return true;
  if (
    /^(bom dia|boa tarde|boa noite|oi+|ola|hey|eai|e ai|tudo bem|td bem|beleza|blz|valeu|obrigad\w*|ok|certo|sim|nao|pode|claro|show|top|por nada|de nada|disponha|imagina|tranquilo|tmg|tmj|nades)$/.test(
      folded,
    )
  ) {
    return true;
  }
  if (/^(bom dia|boa tarde|boa noite)(\s+[!?.]*)?$/.test(folded)) return true;
  return isAckPhrase(folded);
}

// Só palavras de saudação/aceite (“bom dia posso sim”, “pode sim, vamos lá”). “não” fica de fora:
// “não posso” é recusa, não aceite.
const ACK_PHRASE_RE =
  /^(?:(?:bom dia|boa tarde|boa noite|tudo bem|td bem|tudo certo|com certeza|sim senhor|sim senhora|pode ser|pode mandar|pode perguntar|pode comecar|vamos la|bora la|por favor|oi+|ola|opa|eai|e ai|hey|beleza|blz|ok|okay|certo|sim|s|pode|posso|podemos|claro|vamos|bora|manda|show|top|otimo|perfeito|tranquilo|combinado|fechado|valeu|obrigad\w*|agora|aqui|to|estou|e|ai|sr|senhor|senhora|pf|pfv)(?:\s+|$))+$/;

/** Frase composta só de saudação/aceite: aceita o convite, não responde nenhum campo. */
export function isAckPhrase(text: string): boolean {
  const folded = foldText(text)
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!folded) return false;
  return ACK_PHRASE_RE.test(folded);
}

export function looksLikeQuestionnaireAnswer(
  inboundType: string,
  inbound: string,
  mediaUrl = '',
): boolean {
  if (inboundType && inboundType !== 'text' && mediaUrl) return true;
  return looksLikeAnswerPayload(
    {
      type: inboundType || 'text',
      summary: inbound,
      transcript: '',
      caption: '',
      mediaUrl,
      understood: true,
    },
    inbound,
  );
}

export function looksLikeQuestionnaireEdit(
  inboundType: string,
  inbound: string,
  mediaUrl = '',
): boolean {
  const text = String(inbound || '').toLowerCase();
  if (text.length < 4 && !(inboundType !== 'text' && mediaUrl)) return false;
  return (
    /engan/.test(text) ||
    /corrig/.test(text) ||
    /erra(do|da|mos)?/.test(text) ||
    /apag(ar|ue|a|o)?/.test(text) ||
    /delet/.test(text) ||
    /remov(er|a|e)/.test(text) ||
    /limpar|limpa/.test(text) ||
    /alter(ar|e)|trocar|mudar/.test(text) ||
    /n[aã]o foi/.test(text) ||
    /na verdade/.test(text) ||
    /\b(ontem|anteontem)\b/.test(text) ||
    /foi \d+/.test(text)
  );
}

/** Perguntas sobre o próprio questionário (listar, lembrar, etc.). */
export function looksLikeQuestionnaireMeta(inbound: string): boolean {
  const text = foldText(inbound);
  if (!text || text.length < 4) return false;
  if (/questionario/.test(text)) return true;
  if (
    /perguntas?/.test(text) &&
    /(quais|qual|lembre|lembrar|lista|sao|seria|mostrar|manda|falar|diz|me fala)/.test(text)
  ) {
    return true;
  }
  return /me lembre/.test(text) && /pergunt/.test(text);
}

/**
 * Conteúdo que parece resposta/registro RFQ (kg, produto, “registrar”…).
 * Mais restrito que looksLikeAnswerPayload para não sequestrar conversa livre.
 */
export function looksLikeRfqOrRegisterPayload(
  inboundType: string,
  inbound: string,
  mediaUrl = '',
): boolean {
  if (inboundType && inboundType !== 'text' && mediaUrl) return true;
  const text = foldText(inbound);
  if (!text || text.length < 4) return false;
  if (looksLikeQuestionnaireMeta(inbound)) return false;
  if (
    /\b\d+([.,]\d+)?\s?(kg|g|ton|t\b|un|unid|l\b|ml|m3|m2|m²)\b/.test(text) ||
    /\b(registrar|registre|anota|anotar|recebi|receber|entrega|entregue|comprei|compra)\b/.test(
      text,
    ) ||
    /\b(plastico|cobre|aluminio|ferro|papel|papelao|vidro|borracha|oleo|bateria|sucata)\b/.test(
      text,
    )
  ) {
    return true;
  }
  return looksLikeQuestionnaireEdit(inboundType, inbound, mediaUrl);
}

/** Deve preferir o agente de questionário em vez do modo livre. */
export function wantsQuestionnaireContext(
  inboundType: string,
  inbound: string,
  mediaUrl = '',
): boolean {
  return (
    looksLikeQuestionnaireEdit(inboundType, inbound, mediaUrl) ||
    looksLikeQuestionnaireMeta(inbound) ||
    looksLikeRfqOrRegisterPayload(inboundType, inbound, mediaUrl)
  );
}

export function looksLikeAnswerPayload(media: MediaUnderstanding, inbound: string): boolean {
  if (media.type !== 'text' && (media.mediaUrl || media.summary)) return true;
  const text = (media.summary || inbound || '').trim();
  if (text.length < 1 || isNonAnswerText(text)) return false;
  if (/pergunta/i.test(text) && /^(quais|qual|pode|me fala|manda)/i.test(text)) return false;
  if (/^(sim|n[aã]o|ok|certo|isso|isso mesmo|pode|claro|obrigad\w*)\.?$/i.test(text)) return false;
  return true;
}

/** Texto que não deve contar como resposta (pedido de lista, meta, etc.). */
export function isUnusableQuestionnaireAnswer(text: string): boolean {
  const raw = String(text || '').trim();
  if (!raw) return true;
  if (isMarkedNewValue(raw)) return true;
  if (isGreetingOrAck(raw)) return true;
  if (looksLikeQuestionnaireMeta(raw)) return true;
  const folded = foldText(raw);
  if (
    /(fornecedor|fornecedores|cliente|clientes|produto|produtos)/.test(folded) &&
    /(lista|quais|qual|disponiveis|opcoes|opcao|cadastrad)/.test(folded)
  ) {
    return true;
  }
  // “Já respondi o fornecedor” / “já confirmei” não é nome de parceiro.
  if (
    /(ja respondi|ja confirmei|eu ja|ja falei|ja disse)/.test(folded) &&
    /(fornecedor|cliente|produto|questionario|isso|tudo)/.test(folded)
  ) {
    return true;
  }
  return false;
}

export function isFullyAnswered(
  questions: QuestionnaireQuestion[],
  answers: CycleAnswer[],
): boolean {
  if (!questions.length) return false;
  return questions.every((question) => {
    const answer = answers.find((row) => row.question_id === question.id);
    return isUsableAnswerForQuestion(question, String(answer?.answer_text || ''));
  });
}

/** Resposta aproveitável para a pergunta (regra única para “faltantes” e “completo”). */
export function isUsableAnswerForQuestion(
  question: Pick<QuestionnaireQuestion, 'export_field'>,
  text: string,
): boolean {
  const raw = String(text || '').trim();
  if (!raw || isMarkedNewValue(raw)) return false;
  // “não” é resposta válida de “Mais produtos?” — avaliar antes da regra de saudação/ack.
  if (String(question.export_field || '').trim() === FORMS_BOT_LINES_MORE_FIELD) {
    return isUsableLinesMoreAnswer(raw);
  }
  // “sim” confirma o registro — também é ack, por isso vem antes da regra geral.
  if (String(question.export_field || '').trim() === FORMS_BOT_CONFIRM_FIELD) {
    return isConfirmYesAnswer(raw);
  }
  return !isUnusableQuestionnaireAnswer(raw);
}

export function coversQuestions(reply: string, questions: QuestionnaireQuestion[]): boolean {
  if (!reply.trim() || !questions.length) return false;
  const normalized = foldText(reply);
  return questions.every((question) => {
    const snippet = foldText(question.body).slice(0, 24);
    return snippet.length >= 8 && normalized.includes(snippet);
  });
}

export {
  formatBrDate,
  parseOccurrenceDateRef,
  relativeOccurrenceDate,
  splitDatedSegments,
  temporalRelation,
  temporalRelationLabel,
  weekdayFromIsoDate,
  type DatedSegment,
  type OccurrenceDateRef,
  type TemporalRelation,
} from './questionnaire-dates.js';
