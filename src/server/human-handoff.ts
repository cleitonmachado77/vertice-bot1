import { foldText } from './questionnaire-rules.js';

/** Detecta quando a IA declara transferência para atendimento humano. */
export function looksLikeHumanHandoff(text: string): boolean {
  const normalized = foldText(text);
  if (!normalized) return false;
  return (
    /atendente humano/.test(normalized) ||
    /passar .{0,48}(atendimento|pergunta|conversa).{0,40}humano/.test(normalized) ||
    /passar .{0,24}para (um )?humano/.test(normalized) ||
    /humano (vai|ira|poder[aá]) (te )?ajudar/.test(normalized) ||
    /aguard(e|ar).{0,24}(atendente|humano)/.test(normalized)
  );
}
