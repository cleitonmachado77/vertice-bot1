export function asList(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.items)) return record.items as Record<string, unknown>[];
  if (Array.isArray(record.data)) return record.data as Record<string, unknown>[];
  return [];
}

export function messageText(message: unknown): string {
  if (!message) return '';
  if (typeof message === 'string') return message;
  if (typeof message !== 'object') return '';
  const row = message as Record<string, unknown>;
  if (typeof row.text === 'string') return row.text;
  if (typeof row.body === 'string') return row.body;
  if (row.body && typeof row.body === 'object') {
    const body = row.body as Record<string, unknown>;
    if (typeof body.text === 'string') return body.text;
    if (typeof body.caption === 'string') return body.caption;
  }
  if (typeof row.preview === 'string') return row.preview;
  if (typeof row.caption === 'string') return row.caption;
  return '';
}

export function tagNames(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((tag) => {
      if (typeof tag === 'string') return tag;
      if (tag && typeof tag === 'object' && 'name' in tag) return String(tag.name);
      return '';
    })
    .filter(Boolean);
}

export function mapContact(row: Record<string, unknown>) {
  const phone = String(row.primaryPhoneE164 || row.phone || row.wa_id || '');
  return {
    id: String(row.id || ''),
    name: String(row.name || phone || 'Sem nome'),
    phone,
    email: String(row.email || ''),
    tags: tagNames(row.tags),
    blocked: Boolean(row.whatsappDeliveryBlockedAt),
    raw: row,
  };
}

export function mapConversation(row: Record<string, unknown>) {
  const contact = (row.contact || {}) as Record<string, unknown>;
  const last = (row.last_message || row.lastMessage || {}) as Record<string, unknown>;
  const channel = (row.channel || {}) as Record<string, unknown>;
  const origin = (row.origin || {}) as Record<string, unknown>;
  return {
    id: String(row.conversation_id || row.id || ''),
    status: String(row.status || ''),
    preview: String(last.preview || messageText(last) || ''),
    lastMessageAt: String(last.at || row.updatedAt || ''),
    contactId: contact.id ? String(contact.id) : '',
    contactName: String(contact.name || ''),
    contactPhone: String(contact.phone || contact.primaryPhoneE164 || contact.wa_id || ''),
    channelId: String(channel.integrationId || origin.integration_id || ''),
    raw: row,
  };
}

export function mapMessage(row: Record<string, unknown>) {
  return {
    id: String(row.id || ''),
    direction: String(row.direction || 'INBOUND').toUpperCase(),
    type: String(row.type || 'text'),
    text: messageText(row),
    createdAt: String(row.timestamp || row.createdAt || row.sentAt || row.at || new Date().toISOString()),
    raw: row,
  };
}

export function inboundContent(message: unknown): { kind: string; text: string; mediaUrl: string; prompt: string } {
  const row = message && typeof message === 'object' ? (message as Record<string, unknown>) : {};
  const body = row.body && typeof row.body === 'object' ? (row.body as Record<string, unknown>) : {};
  const kind = classifyKind(String(row.type || 'text'));
  const text = messageText(message);
  const mediaUrl = String(row.mediaUrl || row.url || body.url || body.link || body.mediaUrl || '');
  return { kind, text, mediaUrl, prompt: describeInbound(kind, text) };
}

function classifyKind(type: string): string {
  const value = type.toLowerCase();
  if (value.includes('audio') || value.includes('voice') || value === 'ptt') return 'audio';
  if (value.includes('image') || value.includes('sticker')) return 'image';
  if (value.includes('video')) return 'video';
  if (value.includes('document') || value.includes('file')) return 'document';
  if (value.includes('text')) return 'text';
  return value || 'text';
}

function describeInbound(kind: string, text: string): string {
  if (kind === 'text') return text;
  const label =
    { audio: 'áudio', image: 'imagem', video: 'vídeo', document: 'documento' }[kind] || kind;
  return text
    ? `O contato enviou um ${label} com a legenda: ${text}`
    : `O contato enviou um ${label}.`;
}

export function unwrapEnvelope(input: unknown): Record<string, unknown> {
  let current = input;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!current || typeof current !== 'object') break;
    const record = current as Record<string, unknown>;
    if (typeof record.event === 'string') return record;
    if ('body' in record) {
      current = record.body;
      continue;
    }
    break;
  }
  return (current && typeof current === 'object' ? current : {}) as Record<string, unknown>;
}
