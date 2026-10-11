import { run } from './db.js';

const samePerson = `
  SELECT id FROM conversations
  WHERE id = $1
     OR (contact_id <> '' AND contact_id = (SELECT contact_id FROM conversations WHERE id = $1))
     OR (contact_phone <> '' AND contact_phone = (SELECT contact_phone FROM conversations WHERE id = $1))
`;

export async function hideConversation(id: string): Promise<void> {
  await run(`UPDATE conversations SET hidden = 1 WHERE id IN (${samePerson})`, [id]);
}

export async function unhideConversation(id: string): Promise<void> {
  await run(`UPDATE conversations SET hidden = 0 WHERE id IN (${samePerson})`, [id]);
}
