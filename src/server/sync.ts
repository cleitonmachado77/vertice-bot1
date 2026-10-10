import { mapContact, mapConversation, mapMessage } from './map.js';
import { nevoaList } from './nevoa.js';
import { insertContactIfMissing, upsertContact, upsertConversation } from './store.js';
import { attachLocalThread, saveSyncedMessage } from './thread.js';

export async function syncContactsAndConversations(): Promise<{ contacts: number; conversations: number }> {
  const contacts = await nevoaList('/contacts');
  for (const row of contacts) {
    const mapped = mapContact(row);
    if (!mapped.id) continue;
    await upsertContact(mapped);
  }

  const conversations = await nevoaList('/conversations');
  for (const row of conversations) {
    const mapped = mapConversation(row);
    if (!mapped.id) continue;
    await upsertConversation({ ...mapped, raw: row });
    if (mapped.contactId) {
      await attachLocalThread(mapped.id, mapped.contactId);
      await insertContactIfMissing({
        id: mapped.contactId,
        name: mapped.contactName || mapped.contactPhone || 'Sem nome',
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
    await saveSyncedMessage({ ...mapped, conversationId, raw: row });
  }
  return items.length;
}
