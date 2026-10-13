import { linkRemoteContact } from './local-contact.js';
import { mapContact, mapConversation, mapMessage } from './map.js';
import { nevoaList } from './nevoa.js';
import { answerInbound } from './reply.js';
import { insertContactIfMissing, upsertContact, upsertConversation } from './store.js';
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
    const saved = await saveSyncedMessage({
      ...mapped,
      conversationId,
      mediaUrl: mapped.mediaUrl,
      raw: row,
    });
    if (saved?.direction === 'INBOUND') {
      await answerInbound({
        messageId: saved.id,
        conversationId,
        text: saved.text,
        createdAt: saved.createdAt,
        inboundType: saved.type,
        mediaUrl: saved.mediaUrl,
      });
    }
  }
  return items.length;
}
