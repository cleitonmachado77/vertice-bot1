/**
 * Cadastra os padrões Agro da Coara (empresa 2) para o contato Wagner,
 * com menu agendado em dias úteis às 13:30.
 *
 *   npx tsx scripts/seed-coara-agro-presets.ts
 */
import { syncAgroBotQuestionnaire } from '../src/server/agro-bot.js';
import { closeDatabase, initDatabase, one, run } from '../src/server/db.js';
import { loadEnv } from '../src/server/env.js';
import { saveAgroPreset, listAgroPresets, type AgroPresetInput } from '../src/server/agro-presets.js';
import { ensureDefaultDeliveryPoints } from '../src/server/agro-delivery-points.js';

const COMPANY_ID = '2';
const WAGNER_CONTACT_ID = '0af220b9-ed99-455b-bd72-ea1078f8d462';
const SEND_TIME = '13:30';
const FREQUENCY = 'weekdays' as const;

const PRESETS: AgroPresetInput[] = [
  {
    kind: 'agro_plantio',
    name: 'Plantio Coara',
    bot_enabled: true,
    bot_contact_id: WAGNER_CONTACT_ID,
    bot_frequency: FREQUENCY,
    bot_send_time: SEND_TIME,
    bot_rules: { confirm_before_close: false },
    header: {
      propertyName: 'Fazenda Wagner',
      producerName: 'Wagner',
    },
    visible: ['propertyName', 'producerName', 'plantedOn', 'productName', 'forecastQty', 'plotName'],
  },
  {
    kind: 'agro_colheita',
    name: 'Colheita Coara',
    bot_enabled: true,
    bot_contact_id: WAGNER_CONTACT_ID,
    bot_frequency: FREQUENCY,
    bot_send_time: SEND_TIME,
    bot_rules: { confirm_before_close: false },
    header: {},
    visible: ['harvestedOn', 'productName', 'quantity', 'plotName'],
  },
  {
    kind: 'agro_entrega',
    name: 'Entrega Coara',
    bot_enabled: true,
    bot_contact_id: WAGNER_CONTACT_ID,
    bot_frequency: FREQUENCY,
    bot_send_time: SEND_TIME,
    bot_rules: { confirm_before_close: false },
    header: {},
    visible: ['deliveredOn', 'productName', 'quantity', 'partnerName'],
  },
  {
    kind: 'agro_custo',
    name: 'Custos Coara',
    bot_enabled: true,
    bot_contact_id: WAGNER_CONTACT_ID,
    bot_frequency: FREQUENCY,
    bot_send_time: SEND_TIME,
    bot_rules: { confirm_before_close: false },
    header: {},
    visible: ['costOn', 'name', 'quantity', 'plotName'],
  },
];

loadEnv();
await initDatabase();

try {
  const contact = await one<{ id: string; name: string; phone: string; bot_enabled: number }>(
    `SELECT id, name, phone, bot_enabled FROM contacts WHERE id = $1`,
    [WAGNER_CONTACT_ID],
  );
  if (!contact) throw new Error('Contato Wagner não encontrado');
  if (!contact.bot_enabled) {
    await run(`UPDATE contacts SET bot_enabled = 1 WHERE id = $1`, [WAGNER_CONTACT_ID]);
    console.log('Bot habilitado no contato Wagner');
  }

  await ensureDefaultDeliveryPoints(COMPANY_ID);

  for (const spec of PRESETS) {
    const kind = String(spec.kind || '');
    const existing = (await listAgroPresets(COMPANY_ID, kind)).find(
      (item) => item.name.toLowerCase() === String(spec.name || '').toLowerCase(),
    );
    const saved = await saveAgroPreset(COMPANY_ID, spec, existing?.id || '');
    const questionnaire = await syncAgroBotQuestionnaire(saved);
    console.log(
      `OK ${saved.kind} · ${saved.name} → ${questionnaire?.id || '(sem bot)'} · ${saved.bot_send_time} ${saved.bot_frequency}`,
    );
  }

  const stamp = new Date().toISOString();
  await run(
    `INSERT INTO contact_reminder_schedules(contact_id, send_time, days, updated_at)
     VALUES($1, $2, $3, $4)
     ON CONFLICT(contact_id) DO UPDATE SET
       send_time = excluded.send_time,
       days = excluded.days,
       updated_at = excluded.updated_at`,
    [WAGNER_CONTACT_ID, SEND_TIME, FREQUENCY, stamp],
  );
  console.log(`Agenda Wagner: ${FREQUENCY} às ${SEND_TIME}`);

  // Garante que a empresa ativa de quem opera o Agro Coara veja os padrões (informativo).
  const active = await one<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'odoo_active_company_id'`,
  );
  console.log(`Empresa ativa no Vertice agora: ${active?.value || '—'}`);
  console.log('Padrões gravados na empresa Coara (id=2).');
} finally {
  await closeDatabase();
}
