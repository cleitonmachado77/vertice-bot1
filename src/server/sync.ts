import { linkRemoteContact } from './local-contact.js';
import { mapContact, mapConversation, mapMessage } from './map.js';
import { nevoaList } from './nevoa.js';
import { enqueueInboundJob } from './inbound-jobs.js';
import {
  getContact,
  getConversation,
  insertContactIfMissing,
  upsertContact,
  upsertConversation,
} from './store.js';
import { attachLocalThread, saveSyncedMessage } from './thread.js';

export async function syncContactsAndConversations(): Promise<{ contacts: number; conversations: number }> {
  const contacts = await nevoaList('/contacts');
  for (const row of contacts) {
    const mapped = mapContact(row);
    if (!mapped.id) continue;
    const linked = await linkRemoteContact({
      remoteId: mapped.id,
      phone: mapped.phone,
      remoteName: mapped.name,
    });
    await upsertContact({ ...mapped, name: linked.name });
  }

  const conversations = await nevoaList('/conversations');
  for (const row of conversations) {
    const mapped = mapConversation(row);
    if (!mapped.id) continue;
    let contactName = mapped.contactName;
    if (mapped.contactId) {
      const linked = await linkRemoteContact({
        remoteId: mapped.contactId,
        phone: mapped.contactPhone,
        remoteName: mapped.contactName,
      });
      contactName = linked.name;
    }
    const changed = await upsertConversation({ ...mapped, contactName, raw: row });
    if (changed) await syncConversationMessages(mapped.id);
    if (mapped.contactId) {
      await attachLocalThread(mapped.id, mapped.contactId);
      await insertContactIfMissing({
        id: mapped.contactId,
        name: contactName || mapped.contactPhone || 'Sem nome',
        phone: mapped.contactPhone,
      });
    }
  }

  return { contacts: contacts.length, conversations: conversations.length };
}

export async function syncConversationMessages(conversationId: string): Promise<number> {
  const items = await nevoaList(`/conversations/${encodeURIComponent(conversationId)}/messages`);
  for (const row of items) {
    const mapped = mapMessage(row);
    if (!mapped.id) continue;
    // Só sincroniza o histórico. Responder fica a cargo do webhook —
    // chamar o agente aqui gerava resposta duplicada com textos diferentes.
    const saved = await saveSyncedMessage({
      ...mapped,
      conversationId,
      mediaUrl: mapped.mediaUrl,
      raw: row,
    });
    if (saved?.direction === 'INBOUND') {
      const conversation = await getConversation(conversationId);
      const contact = conversation?.contact_id
        ? await getContact(conversation.contact_id)
        : undefined;
      await enqueueInboundJob(
        {
          id: `sync:${saved.id}`,
          event: 'message.received',
          occurredAt: saved.createdAt,
          data: {
            conversation: {
              id: conversationId,
              status: conversation?.status || '',
              contact: contact
                ? { id: contact.id, name: contact.name, phone: contact.phone }
                : undefined,
            },
            contact: contact
              ? { id: contact.id, name: contact.name, phone: contact.phone }
              : undefined,
            message: row,
          },
        },
        `sync:${saved.id}`,
      );
    }
  }
  return items.length;
}
