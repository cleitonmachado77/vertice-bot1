/**
 * Clona os padrões RSU da Recicla Brasil para a Florestopolis (empresa 22),
 * no contato Erica — ATAF, dias úteis às 17:00.
 *
 *   npx tsx scripts/seed-florestopolis-presets.ts
 */
import { closeDatabase, initDatabase, many, one, run, setSetting } from '../src/server/db.js';
import { loadEnv } from '../src/server/env.js';
import {
  createFormPreset,
  getFormPresetById,
  updateFormPreset,
  type FormPreset,
  type FormPresetInput,
} from '../src/server/forms-presets.js';
import { createLocalContact, findContactByPhone } from '../src/server/local-contact.js';
import { normalizeWhatsappPhone } from '../src/server/phone.js';

const COMPANY_ID = '22';
const SEND_TIME = '17:00';
const FREQUENCY = 'weekdays' as const;
const ERICA_NAME = 'Erica - ATAF - Florestopolis';
/** Celular BR: DDD 43 + 9º dígito + 9604-3977. */
const ERICA_PHONE_RAW = '43 99604-3977';

/** Padrões da Recicla Brasil (empresa 7) a espelhar. */
const SOURCE_PRESET_IDS = [
  '34673f79-a413-4832-940e-7f6427c9e070', // Separação de Bags
  'be8a792d-97e5-4d71-a54d-c3e51e667ed5', // Produção de Fardos
  'ff297445-83fb-4dc2-89f8-3b30976a5d95', // Entrega de Fardos
  '368672c7-ea66-46d5-ba6f-123753f4683a', // Recebimento de Materiais
] as const;

loadEnv();
await initDatabase();

try {
  const company = await one<{ id: string; name: string }>(
    `SELECT id, name FROM forms_companies WHERE id = $1`,
    [COMPANY_ID],
  );
  if (!company) {
    throw new Error(`Empresa ${COMPANY_ID} não encontrada. Rode antes scripts/setup-florestopolis-company.ts`);
  }

  const phone = `+${normalizeWhatsappPhone(ERICA_PHONE_RAW)}`;
  let ericaId = '';
  const existingPhone = await findContactByPhone(phone);
  if (existingPhone && Number(existingPhone.hidden) !== 1) {
    ericaId = existingPhone.id;
    await run(
      `UPDATE contacts SET name = $2, phone = $3, bot_enabled = 1, updated_at = $4 WHERE id = $1`,
      [ericaId, ERICA_NAME, phone, new Date().toISOString()],
    );
    console.log(`Contato existente atualizado: ${ERICA_NAME} (${phone})`);
  } else {
    const created = await createLocalContact({ name: ERICA_NAME, phone, email: '' });
    ericaId = created.id;
    console.log(`Contato criado: ${ERICA_NAME} (${phone}) id=${ericaId}`);
  }

  await setSetting('odoo_active_company_id', COMPANY_ID);

  for (const sourceId of SOURCE_PRESET_IDS) {
    const source = await getFormPresetById(sourceId);
    if (!source) {
      console.warn(`Fonte ${sourceId} não encontrada — pulando`);
      continue;
    }

    const payload: FormPresetInput = {
      kind: source.kind,
      name: source.name,
      title: source.title,
      status: source.status,
      header: { ...source.header },
      lines: source.lines.map((line) => ({ values: { ...line.values } })),
      visible: {
        title: source.visible.title,
        status: source.visible.status,
        header: [...source.visible.header],
        lines: [...source.visible.lines],
      },
      bot_enabled: true,
      bot_frequency: FREQUENCY,
      bot_weekday: 1,
      bot_send_time: SEND_TIME,
      bot_template_id: source.bot_template_id,
      bot_contact_id: ericaId,
      bot_also_contact_ids: [],
      bot_rules: { ...source.bot_rules },
    };

    const already = await one<{ id: string }>(
      `SELECT id FROM forms_presets
       WHERE company_odoo_id = $1 AND kind = $2 AND lower(name) = lower($3)
       LIMIT 1`,
      [COMPANY_ID, source.kind, source.name],
    );

    let saved: FormPreset;
    if (already?.id) {
      saved = await updateFormPreset(already.id, payload);
      console.log(`Atualizado: ${saved.kind} · ${saved.name} (${saved.id})`);
    } else {
      saved = await createFormPreset(payload);
      console.log(`Criado: ${saved.kind} · ${saved.name} (${saved.id})`);
    }
  }

  const stamp = new Date().toISOString();
  await run(
    `INSERT INTO contact_reminder_schedules(contact_id, send_time, days, updated_at)
     VALUES($1, $2, $3, $4)
     ON CONFLICT(contact_id) DO UPDATE SET
       send_time = excluded.send_time,
       days = excluded.days,
       updated_at = excluded.updated_at`,
    [ericaId, SEND_TIME, FREQUENCY, stamp],
  );
  console.log(`Agenda Erica: ${FREQUENCY} às ${SEND_TIME}`);

  const presets = await many<{ id: string; kind: string; name: string; bot_send_time: string; bot_frequency: string }>(
    `SELECT id, kind, name, bot_send_time, bot_frequency
     FROM forms_presets WHERE company_odoo_id = $1 ORDER BY kind, name`,
    [COMPANY_ID],
  );
  console.log('\n=== Padrões Florestopolis ===');
  for (const row of presets) {
    console.log(`  ${row.kind} | ${row.name} | ${row.bot_frequency} ${row.bot_send_time} | ${row.id}`);
  }

  const assignments = await many<{ questionnaire_id: string; name: string }>(
    `SELECT a.questionnaire_id, q.name
     FROM questionnaire_assignments a
     JOIN questionnaires q ON q.id = a.questionnaire_id
     WHERE a.contact_id = $1 AND q.active = 1 AND q.deleted_at = ''
     ORDER BY q.name`,
    [ericaId],
  );
  console.log('\n=== Questionários da Erica ===');
  for (const row of assignments) console.log(`  ${row.name} (${row.questionnaire_id})`);
} finally {
  await closeDatabase();
}
