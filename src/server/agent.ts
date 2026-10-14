import { getSetting } from './db.js';

export type Draft = {
  text: string;
  source: 'model' | 'fallback' | 'none';
  detail: string;
};

const FALLBACK_CHAT_MODELS = [
  'gpt-4o-mini',
  'gpt-4o',
  'gpt-4.1-mini',
  'gpt-4.1',
  'gpt-4.1-nano',
  'o4-mini',
  'o3-mini',
];

function isChatModelId(id: string): boolean {
  const value = id.toLowerCase();
  if (!value) return false;
  if (
    /(embedding|whisper|tts|dall-e|moderation|realtime|audio|transcribe|search|instruct|davinci|babbage|curie|ada)/.test(
      value,
    )
  ) {
    return false;
  }
  return /^(gpt-|o[1-9]|chatgpt-)/.test(value) || value.includes('gpt');
}

/** Lista modelos de chat disponíveis na API configurada (`GET /models`). */
export async function listAgentModels(): Promise<{ models: string[]; error: string }> {
  const current = getSetting('agent_model').trim();
  const apiKey = getSetting('agent_api_key');
  const base = getSetting('agent_base_url').replace(/\/$/, '');
  if (!apiKey) {
    const models = uniqueModels([current, ...FALLBACK_CHAT_MODELS]);
    return { models, error: 'Salve uma chave do modelo para listar os disponíveis na API.' };
  }
  if (!base) {
    return { models: uniqueModels([current, ...FALLBACK_CHAT_MODELS]), error: 'URL do modelo não configurada' };
  }
  try {
    const response = await fetch(`${base}/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(12_000),
    });
    const payload = (await response.json()) as {
      error?: { message?: string };
      data?: { id?: string }[];
    };
    if (!response.ok) {
      throw new Error(payload.error?.message || `API respondeu ${response.status}`);
    }
    const fromApi = (payload.data || [])
      .map((item) => String(item.id || '').trim())
      .filter(isChatModelId)
      .sort((a, b) => a.localeCompare(b));
    if (!fromApi.length) {
      return {
        models: uniqueModels([current, ...FALLBACK_CHAT_MODELS]),
        error: 'A API não retornou modelos de chat utilizáveis.',
      };
    }
    return { models: uniqueModels([current, ...fromApi]), error: '' };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Falha ao listar modelos';
    return {
      models: uniqueModels([current, ...FALLBACK_CHAT_MODELS]),
      error: detail,
    };
  }
}

function uniqueModels(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const id = value.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

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
  options: { temperature?: number; timeoutMs?: number; maxTokens?: number } = {},
): Promise<string> {
  const base = getSetting('agent_base_url').replace(/\/$/, '');
  const body: Record<string, unknown> = {
    model: getSetting('agent_model'),
    temperature: options.temperature ?? Number(getSetting('agent_temperature') || '0.4'),
    messages,
  };
  if (options.maxTokens && options.maxTokens > 0) body.max_tokens = options.maxTokens;
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getSetting('agent_api_key')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
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
    'Modo: conversa livre. Não invente respostas de questionário nem diga que “não tem acesso” a questionários.',
    'Se a pessoa perguntar as perguntas do questionário, pedir para registrar kg/produto/entrega ou corrigir uma resposta, oriente com naturalidade que o acompanhamento diário cuida disso — não invente que o sistema não consegue.',
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
