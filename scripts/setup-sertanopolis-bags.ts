/**
 * Bag/Fardo da Sertanópolis (empresa 9): cria variantes, apaga produtos avulsos
 * e grava o setting da cooperativa.
 *
 *   ODOO_LOGIN=... ODOO_API_KEY=... npx tsx scripts/setup-sertanopolis-bags.ts
 */
import {
  BAG_MATERIALS_SERTANOPOLIS,
  SERTANOPOLIS_COMPANY_SETTING,
  ensureBagMaterials,
  materialsForCompany,
} from '../src/server/bag-materials.js';
import { closeDatabase, getSetting, initDatabase, setSetting } from '../src/server/db.js';
import { loadEnv } from '../src/server/env.js';
import { syncCompaniesFromOdoo } from '../src/server/forms-companies.js';
import { odooAuthenticate, odooExecuteKw, odooSearchRead, odooWrite } from '../src/server/odoo-client.js';
import { ensureIncomingPickingTypeId } from '../src/server/odoo-resolve.js';

const COMPANY_ID = 9;

loadEnv();
await initDatabase();

try {
  await setSetting(SERTANOPOLIS_COMPANY_SETTING, String(COMPANY_ID));

  const [company] = await odooSearchRead<{ id: number; name: string }>(
    'res.company',
    [['id', '=', COMPANY_ID]],
    ['name'],
    { limit: 1 },
  );
  if (!company) throw new Error(`Empresa Odoo ${COMPANY_ID} não encontrada`);
  console.log(`Empresa: ${company.id} — ${company.name}`);

  await syncCompaniesFromOdoo({ repairWarehouses: true });

  const uid = await odooAuthenticate();
  const apiLogin = getSetting('odoo_login');
  const users = await odooSearchRead<{ id: number; login: string; company_ids: number[] }>(
    'res.users',
    ['|', ['id', '=', uid], ['login', '=', apiLogin]],
    ['login', 'company_ids'],
    { limit: 5 },
  );
  for (const user of users) {
    if (user.company_ids.includes(COMPANY_ID)) continue;
    await odooWrite('res.users', [user.id], { company_ids: [[4, COMPANY_ID]] });
    console.log(`Usuário ${user.login || user.id} liberado na empresa ${COMPANY_ID}`);
  }

  try {
    const pickingType = await ensureIncomingPickingTypeId(COMPANY_ID);
    console.log(`Depósito/recebimento: picking_type=${pickingType || '(não criado)'}`);
  } catch (error) {
    console.warn('Warehouse:', error instanceof Error ? error.message : error);
  }

  if (materialsForCompany(COMPANY_ID) !== BAG_MATERIALS_SERTANOPOLIS) {
    throw new Error('materialsForCompany não retornou a lista da Sertanópolis');
  }

  console.log(
    `Cadastrando Bag/Fardo com ${BAG_MATERIALS_SERTANOPOLIS.length} tipos:`,
    BAG_MATERIALS_SERTANOPOLIS.map((item) => item.code).join(', '),
  );
  await ensureBagMaterials(COMPANY_ID);

  // Remove produtos avulsos (material como produto) — mantém só Bag e Fardo
  const extras = await odooSearchRead<{ id: number; name: string }>(
    'product.template',
    [['company_id', '=', COMPANY_ID], ['name', 'not in', ['Bag', 'Fardo']]],
    ['name'],
    { limit: 100 },
  );
  if (extras.length) {
    const ids = extras.map((row) => row.id);
    console.log(`Removendo ${ids.length} produtos avulsos:`, extras.map((r) => r.name).join(', '));
    try {
      await odooExecuteKw('product.template', 'unlink', [ids]);
      console.log('unlink OK');
    } catch (error) {
      console.warn('unlink falhou, arquivando…', error instanceof Error ? error.message : error);
      for (const id of ids) await odooWrite('product.template', [id], { active: false });
    }
  }

  const templates = await odooSearchRead<{
    id: number;
    name: string;
    product_variant_count: number;
  }>(
    'product.template',
    [['company_id', '=', COMPANY_ID], ['name', 'in', ['Bag', 'Fardo']]],
    ['name', 'product_variant_count'],
    { limit: 10, order: 'name asc' },
  );
  console.log('\n=== Resultado ===');
  for (const row of templates) {
    console.log(`  ${row.name}: template=${row.id} variantes=${row.product_variant_count}`);
  }

  const variants = await odooSearchRead<{ id: number; display_name: string; default_code: string | false }>(
    'product.product',
    [['company_id', '=', COMPANY_ID], ['product_tmpl_id.name', 'in', ['Bag', 'Fardo']]],
    ['display_name', 'default_code'],
    { limit: 80, order: 'default_code asc' },
  );
  console.log(`Variantes: ${variants.length}`);
  for (const row of variants) {
    console.log(`  ${row.default_code || '-'} | ${row.display_name}`);
  }
} finally {
  await closeDatabase();
}
