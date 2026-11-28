/**
 * Renomeia os padrões RSU de fardos e cria “Entrega de Fardos” (produção direta).
 *
 *   Produção de Fardos       → Converter BAGS para Fardos
 *   Entrega de Fardos (sale) → Venda de Fardos
 *   + Entrega de Fardos (production, sem bags)
 *
 *   npx tsx scripts/migrate-fardo-menus.ts
 */
import { closeDatabase, initDatabase, many, one, run, setSetting } from '../src/server/db.js';
import { loadEnv } from '../src/server/env.js';
import { FARDO_PRODUCTION_PRESET_ID } from '../src/server/fardo-counts.js';
import { FARDO_ENTREGA_PRESET_ID } from '../src/server/fardo-entrega.js';
import { FARDO_DELIVERY_PRESET_ID } from '../src/server/fardo-sale.js';
import { syncFormsBotQuestionnaire } from '../src/server/forms-bot.js';
import { RSU_FARDO_MENU_NAMES } from '../src/server/rsu-fardo-menu.js';
import {
  createFormPreset,
  getFormPresetById,
  updateFormPreset,
  type FormPresetInput,
} from '../src/server/forms-presets.js';

loadEnv();
await initDatabase();

try {
  await run(
    `UPDATE forms_presets
     SET name = $1, updated_at = NOW()
     WHERE lower(name) = lower('Produção de Fardos')`,
    [RSU_FARDO_MENU_NAMES.converter],
  );
  console.log(`Renomeados: Produção de Fardos → ${RSU_FARDO_MENU_NAMES.converter}`);

  await run(
    `UPDATE forms_presets
     SET name = $1, updated_at = NOW()
     WHERE kind = 'sale' AND lower(name) = lower('Entrega de Fardos')`,
    [RSU_FARDO_MENU_NAMES.venda],
  );
  console.log(`Renomeados: Entrega de Fardos (sale) → ${RSU_FARDO_MENU_NAMES.venda}`);

  await run(
    `UPDATE forms_presets
     SET name = $2, updated_at = NOW()
     WHERE id = $1 AND name <> $2`,
    [FARDO_DELIVERY_PRESET_ID, RSU_FARDO_MENU_NAMES.venda],
  );
  await run(
    `UPDATE forms_presets
     SET name = $2, updated_at = NOW()
     WHERE id = $1 AND name <> $2`,
    [FARDO_PRODUCTION_PRESET_ID, RSU_FARDO_MENU_NAMES.converter],
  );

  const source = await getFormPresetById(FARDO_PRODUCTION_PRESET_ID);
  if (!source) throw new Error(`Padrão fonte ${FARDO_PRODUCTION_PRESET_ID} não encontrado`);

  let canonical = await getFormPresetById(FARDO_ENTREGA_PRESET_ID);
  if (!canonical) {
    await run(
      `INSERT INTO forms_presets
        (id, company_odoo_id, kind, name, title, status, header_json, lines_json, visible_json,
         bot_enabled, bot_frequency, bot_weekday, bot_send_time, bot_template_id, bot_contact_id,
         bot_also_contact_ids, sort_order, bot_rules_json)
       VALUES ($1, $2, 'production', $3, '', 'draft', $4, '[]', $5,
               $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        FARDO_ENTREGA_PRESET_ID,
        source.company_odoo_id,
        'Entrega de Fardos',
        JSON.stringify({ input_product: 'Fardo', input_qty: '', input_uom: 'Unidade' }),
        JSON.stringify({
          title: true,
          status: false,
          header: ['input_product', 'input_qty', 'input_uom'],
          lines: [],
        }),
        source.bot_enabled ? 1 : 0,
        source.bot_frequency || 'weekdays',
        source.bot_weekday || 1,
        source.bot_send_time || '17:00',
        source.bot_template_id || '',
        source.bot_contact_id || '',
        JSON.stringify(source.bot_also_contact_ids || []),
        source.sort_order ?? 0,
        JSON.stringify(source.bot_rules || {}),
      ],
    );
    canonical = await getFormPresetById(FARDO_ENTREGA_PRESET_ID);
    console.log(`Criado padrão canônico Entrega de Fardos (${FARDO_ENTREGA_PRESET_ID})`);
  } else if (canonical.name !== 'Entrega de Fardos') {
    await run(`UPDATE forms_presets SET name = $2, updated_at = NOW() WHERE id = $1`, [
      FARDO_ENTREGA_PRESET_ID,
      'Entrega de Fardos',
    ]);
    canonical = await getFormPresetById(FARDO_ENTREGA_PRESET_ID);
  }
  if (!canonical) throw new Error('Padrão Entrega de Fardos canônico não criado');

  const companies = await many<{
    company_odoo_id: string;
    bot_contact_id: string;
    bot_also_contact_ids: string;
    bot_send_time: string;
    bot_frequency: string;
    bot_enabled: number;
    bot_weekday: number;
    bot_template_id: string;
  }>(
    `SELECT DISTINCT ON (company_odoo_id)
       company_odoo_id, bot_contact_id, bot_also_contact_ids, bot_send_time, bot_frequency,
       bot_enabled, bot_weekday, bot_template_id
     FROM forms_presets
     WHERE kind = 'production'
       AND (
         id = $1
         OR lower(name) = lower('Converter BAGS para Fardos')
       )
     ORDER BY company_odoo_id, CASE WHEN id = $1 THEN 0 ELSE 1 END`,
    [FARDO_PRODUCTION_PRESET_ID],
  );

  for (const company of companies) {
    if (company.company_odoo_id === canonical.company_odoo_id) {
      console.log(`Empresa ${company.company_odoo_id}: padrão canônico Entrega de Fardos`);
      continue;
    }
    const already = await one<{ id: string }>(
      `SELECT id FROM forms_presets
       WHERE company_odoo_id = $1 AND kind = 'production' AND lower(name) = lower('Entrega de Fardos')
       LIMIT 1`,
      [company.company_odoo_id],
    );
    let also: string[] = [];
    try {
      also = JSON.parse(company.bot_also_contact_ids || '[]') as string[];
    } catch {
      also = [];
    }
    const contactOk = company.bot_contact_id
      ? Boolean(
          await one<{ id: string }>(
            `SELECT id FROM contacts WHERE id = $1 AND COALESCE(hidden, 0) = 0 LIMIT 1`,
            [company.bot_contact_id],
          ),
        )
      : false;
    const payload: FormPresetInput = {
      kind: 'production',
      name: 'Entrega de Fardos',
      title: canonical.title,
      status: canonical.status,
      header: { input_product: 'Fardo', input_qty: '', input_uom: 'Unidade' },
      lines: [],
      visible: {
        title: true,
        status: false,
        header: ['input_product', 'input_qty', 'input_uom'],
        lines: [],
      },
      bot_enabled: Boolean(company.bot_enabled && contactOk),
      bot_frequency: (company.bot_frequency as FormPresetInput['bot_frequency']) || 'weekdays',
      bot_weekday: company.bot_weekday || 1,
      bot_send_time: company.bot_send_time || '17:00',
      bot_template_id: company.bot_template_id || '',
      bot_contact_id: contactOk ? company.bot_contact_id : '',
      bot_also_contact_ids: contactOk ? also : [],
      bot_rules: { ...canonical.bot_rules },
    };

    await setSetting('odoo_active_company_id', company.company_odoo_id);
    try {
      if (already?.id) {
        const saved = await updateFormPreset(already.id, payload);
        console.log(`Atualizado Entrega: empresa ${company.company_odoo_id} (${saved.id})`);
      } else {
        const saved = await createFormPreset(payload);
        console.log(`Criado Entrega: empresa ${company.company_odoo_id} (${saved.id})`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Empresa ${company.company_odoo_id}: bot falhou (${message}) — salvando sem bot`);
      payload.bot_enabled = false;
      payload.bot_contact_id = '';
      payload.bot_also_contact_ids = [];
      const fallback = await one<{ id: string }>(
        `SELECT id FROM forms_presets
         WHERE company_odoo_id = $1 AND kind = 'production' AND lower(name) = lower('Entrega de Fardos')
         LIMIT 1`,
        [company.company_odoo_id],
      );
      if (fallback?.id) {
        const saved = await updateFormPreset(fallback.id, payload);
        console.log(`Atualizado Entrega (sem bot): empresa ${company.company_odoo_id} (${saved.id})`);
      } else {
        const saved = await createFormPreset(payload);
        console.log(`Criado Entrega (sem bot): empresa ${company.company_odoo_id} (${saved.id})`);
      }
    }
  }

  const toSync = await many<{ id: string }>(
    `SELECT id FROM forms_presets
     WHERE id IN ($1, $2, $3)
        OR lower(name) IN (
          lower('Entrega de Fardos'),
          lower('Converter BAGS para Fardos'),
          lower('Venda de Fardos')
        )`,
    [FARDO_PRODUCTION_PRESET_ID, FARDO_DELIVERY_PRESET_ID, FARDO_ENTREGA_PRESET_ID],
  );
  for (const row of toSync) {
    const preset = await getFormPresetById(row.id);
    if (!preset) continue;
    try {
      await syncFormsBotQuestionnaire(preset);
    } catch (error) {
      console.warn(
        `Sync ${preset.name} (${preset.id}):`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  const rows = await many<{ company_odoo_id: string; kind: string; name: string; id: string }>(
    `SELECT company_odoo_id, kind, name, id FROM forms_presets
     WHERE lower(name) LIKE '%fardo%' OR lower(name) LIKE '%bags%'
     ORDER BY company_odoo_id, kind, name`,
  );
  console.log('\n=== Padrões bag/fardo ===');
  for (const row of rows) {
    console.log(`  ${row.company_odoo_id} | ${row.kind} | ${row.name} | ${row.id}`);
  }
} finally {
  await closeDatabase();
}
