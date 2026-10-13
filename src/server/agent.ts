import { getSetting } from './db.js';

export type Draft = {
  text: string;
  source: 'model' | 'fallback' | 'none';
  detail: string;
};

export type ChatPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type ChatMessage = {
  role: string;
  content: string | ChatPart[];
};

type HistoryItem = { direction: string; text: string };

export async function draftReply(input: {
  contactName: string;
  contactPhone: string;
  notes: string;
  instructions: string;
  prompt: string;
  history: HistoryItem[];
  inbound: string;
  hasText: boolean;
  force?: boolean;
  allowReply?: boolean;
}): Promise<Draft> {
  if (!input.force && getSetting('agent_active') !== '1') {
    return { text: '', source: 'none', detail: 'Agente desligado' };
  }
  if (!input.force && !input.allowReply && getSetting('agent_auto_reply') !== '1') {
    return { text: '', source: 'none', detail: 'Resposta automática desligada' };
  }
  if (!input.hasText) {
    return { text: '', source: 'none', detail: 'Mensagem sem conteúdo' };
  }

  const apiKey = getSetting('agent_api_key');
  const fallback = getSetting('agent_fallback');
  if (!apiKey) {
    return fallback
      ? { text: fallback, source: 'fallback', detail: 'Sem chave do modelo' }
      : { text: '', source: 'none', detail: 'Sem chave do modelo e sem mensagem reserva' };
  }

  const history = input.history
    .filter((item) => item.text.trim())
    .map((item) => ({
      role: item.direction === 'OUTBOUND' ? 'assistant' : 'user',
      content: item.text,
    }));

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(input) },
    ...history,
    { role: 'user', content: input.inbound },
  ];

  try {
    const text = await completeChat(messages);
    if (!text) {
      return { text: fallback, source: 'fallback', detail: 'Modelo devolveu vazio' };
    }
    if (isNoReply(text)) {
      return { text: '', source: 'none', detail: 'Sem necessidade de resposta' };
    }
    return { text: text.slice(0, 1500), source: 'model', detail: getSetting('agent_model') };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Falha no modelo';
    return fallback
      ? { text: fallback, source: 'fallback', detail }
      : { text: '', source: 'none', detail };
  }
}

export async function previewReply(sample: string): Promise<Draft> {
  return draftReply({
    contactName: 'Contato de teste',
    contactPhone: '',
    notes: '',
    instructions: '',
    prompt: '',
    history: [],
    inbound: sample,
    hasText: true,
    force: true,
  });
}

export async function completeChat(
  messages: ChatMessage[],
  options: { temperature?: number; timeoutMs?: number } = {},
): Promise<string> {
  const base = getSetting('agent_base_url').replace(/\/$/, '');
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getSetting('agent_api_key')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: getSetting('agent_model'),
      temperature: options.temperature ?? Number(getSetting('agent_temperature') || '0.4'),
      messages,
    }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
  });
  const payload = (await response.json()) as {
    error?: { message?: string };
    choices?: { message?: { content?: string } }[];
  };
  if (!response.ok) {
    throw new Error(payload.error?.message || `Modelo respondeu ${response.status}`);
  }
  return payload.choices?.[0]?.message?.content?.trim() || '';
}

function systemPrompt(input: {
  contactName: string;
  contactPhone: string;
  notes: string;
  instructions: string;
  prompt: string;
}): string {
  const base = input.prompt.trim() || getSetting('agent_prompt');
  const script = input.instructions.trim() || 'Nenhuma instrução específica. Use só as regras gerais.';
  const notes = input.notes.trim() || 'nenhuma';
  return [
    base,
    '',
    'Modo: conversa livre. Não colete respostas de questionário neste modo.',
    'Siga as instruções deste contato. Não invente etapas, preços ou promessas fora delas.',
    'Se a mensagem for áudio, vídeo ou imagem, confirme o recebimento e continue as instruções.',
    'Se não souber responder com segurança, diga que vai passar o atendimento para um atendente humano.',
    'Interprete a intenção: se o usuário só agradece, confirma ou encerra sem trazer pergunta/assunto novo (ex.: "ok", "por nada", "valeu", "obrigado", "tchau"), NÃO continue o papo.',
    'Nesses casos de encerramento curto, responda exatamente com a palavra: NO_REPLY',
    'Evite loops de educação ("estou à disposição", "se precisar é só chamar") quando a conversa já está se encerrando.',
    `Instruções: ${script}`,
    `Contato: ${input.contactName || 'não informado'} ${input.contactPhone}`.trim(),
    `Notas internas: ${notes}`,
  ].join('\n');
}

function isNoReply(text: string): boolean {
  const normalized = text.trim().replace(/^["'`]+|["'`]+$/g, '');
  return /^no[_\s-]?reply$/i.test(normalized);
}
