/**
 * Promove a Associação de Florestopolis a res.company no Odoo,
 * sincroniza no Vertice e cadastra Bag/Fardo com os tipos da cooperativa.
 *
 * Uso: npx tsx scripts/setup-florestopolis-company.ts
 */
import {
  BAG_MATERIALS_FLORESTOPOLIS,
  FLORESTOPOLIS_COMPANY_SETTING,
  ensureBagMaterials,
  materialsForCompany,
} from '../src/server/bag-materials.js';
import { closeDatabase, getSetting, initDatabase, setSetting } from '../src/server/db.js';
import { loadEnv } from '../src/server/env.js';
import { syncCompaniesFromOdoo } from '../src/server/forms-companies.js';
import {
  odooAuthenticate,
  odooCreate,
  odooExecuteKw,
  odooSearchRead,
  odooWrite,
} from '../src/server/odoo-client.js';
import { ensureIncomingPickingTypeId } from '../src/server/odoo-resolve.js';

const PARTNER_ID = 548;
const COMPANY_NAME = 'Associação dos Trabalhadores Ambientais de Florestopolis';

function m2oId(value: unknown): number {
  if (Array.isArray(value) && typeof value[0] === 'number') return value[0];
  if (typeof value === 'number') return value;
  return 0;
}

function m2oName(value: unknown): string {
  if (Array.isArray(value) && value[1] != null) return String(value[1]);
  return '';
}

loadEnv();
await initDatabase();

try {
  const [partner] = await odooSearchRead<{
    id: number;
    name: string;
    vat: string | false;
    phone: string | false;
    email: string | false;
    country_id: unknown;
    city: string | false;
  }>('res.partner', [['id', '=', PARTNER_ID]], ['name', 'vat', 'phone', 'email', 'country_id', 'city'], {
    limit: 1,
  });
  if (!partner) throw new Error(`Parceiro ${PARTNER_ID} não encontrado no Odoo`);

  const existing = await odooSearchRead<{ id: number; name: string; partner_id: unknown }>(
    'res.company',
    [
      '|',
      '|',
      ['partner_id', '=', PARTNER_ID],
      ['name', 'ilike', 'florestopolis'],
      ['vat', '=', String(partner.vat || '').trim()],
    ],
    ['name', 'partner_id'],
    { limit: 5 },
  );

  let companyId = existing[0]?.id || Number(getSetting(FLORESTOPOLIS_COMPANY_SETTING) || 0);

  if (!companyId) {
    console.log('Criando res.company…');
    try {
      companyId = await odooCreate('res.company', {
        name: COMPANY_NAME,
        partner_id: PARTNER_ID,
        currency_id: 5, // BRL (mesmo da Recicla Brasil)
        country_id: m2oId(partner.country_id) || 31,
        phone: partner.phone || false,
        email: partner.email || false,
        vat: partner.vat || false,
      });
      console.log(`Empresa criada: id=${companyId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('\nNão foi possível criar a empresa via API:');
      console.error(message);
      console.error(`
Próximo passo (no Odoo, como Administrador):
1. Configurações → Empresas → Novo
2. Nome: ${COMPANY_NAME}
3. Vincule o contato id ${PARTNER_ID} (ASSOCIACAO DOS TRABALHADORES AMBIENTAIS DE FLORESTOPOLIS)
4. Moeda BRL / país Brasil / CNPJ ${partner.vat || ''}
5. Salve e rode de novo: npx tsx scripts/setup-florestopolis-company.ts

Ou liberar o usuário da API (cleiton.adriano@uel.br) no grupo Administrador e reexecutar.
`);
      process.exit(2);
    }
  } else {
    console.log(`Empresa já existia: id=${companyId} (${existing[0]?.name || 'setting'})`);
    await odooWrite('res.company', [companyId], {
      name: COMPANY_NAME,
      partner_id: PARTNER_ID,
      phone: partner.phone || false,
      vat: partner.vat || false,
      country_id: m2oId(partner.country_id) || 31,
    });
  }

  await setSetting(FLORESTOPOLIS_COMPANY_SETTING, String(companyId));

  // Libera a empresa no usuário autenticado e no login da API do Vertice (settings).
  const uid = await odooAuthenticate();
  const apiLogin = (await import('../src/server/db.js')).getSetting('odoo_login');
  const users = await odooSearchRead<{ id: number; login: string; company_ids: number[] }>(
    'res.users',
    ['|', ['id', '=', uid], ['login', '=', apiLogin]],
    ['login', 'company_ids'],
    { limit: 5 },
  );
  for (const user of users) {
    if (user.company_ids.includes(companyId)) continue;
    await odooWrite('res.users', [user.id], { company_ids: [[4, companyId]] });
    console.log(`Usuário ${user.login || user.id} liberado na empresa ${companyId}`);
  }

  console.log('Sincronizando empresas no Vertice…');
  const companies = await syncCompaniesFromOdoo({ repairWarehouses: true });
  const local = companies.find((row) => row.id === String(companyId));
  console.log(local ? `Local: ${local.id} — ${local.name}` : 'Aviso: empresa não apareceu no sync local');

  try {
    const pickingType = await ensureIncomingPickingTypeId(companyId);
    console.log(`Depósito/recebimento: picking_type=${pickingType || '(não criado)'}`);
  } catch (error) {
    console.warn('Warehouse:', error instanceof Error ? error.message : error);
  }

  // Produto avulso "PAPELÃO" (sem empresa) — material vira variante, não produto.
  const [papelao] = await odooSearchRead<{ id: number; name: string }>(
    'product.template',
    [['id', '=', 828], ['name', '=', 'PAPELÃO']],
    ['name'],
    { limit: 1 },
  );
  if (papelao) {
    try {
      await odooExecuteKw('product.template', 'unlink', [[papelao.id]]);
      console.log('Removido produto avulso PAPELÃO (id 828)');
    } catch {
      await odooWrite('product.template', [papelao.id], { active: false });
      console.log('Arquivado produto avulso PAPELÃO (id 828)');
    }
  }

  console.log(
    `Cadastrando Bag/Fardo com ${BAG_MATERIALS_FLORESTOPOLIS.length} tipos:`,
    BAG_MATERIALS_FLORESTOPOLIS.map((item) => item.code).join(', '),
  );
  // Garante que materialsForCompany já lê o setting gravado.
  if (materialsForCompany(companyId) !== BAG_MATERIALS_FLORESTOPOLIS) {
    throw new Error('Setting da Florestopolis não entrou em materialsForCompany');
  }
  await ensureBagMaterials(companyId);

  const templates = await odooSearchRead<{
    id: number;
    name: string;
    product_variant_count: number;
    company_id: unknown;
  }>(
    'product.template',
    [['company_id', '=', companyId], ['name', 'in', ['Bag', 'Fardo']]],
    ['name', 'product_variant_count', 'company_id'],
    { limit: 10, order: 'name asc' },
  );
  console.log('\n=== Resultado ===');
  console.log(`Empresa id=${companyId} | ${COMPANY_NAME}`);
  for (const row of templates) {
    console.log(`  ${row.name}: template=${row.id} variantes=${row.product_variant_count}`);
  }

  const variants = await odooSearchRead<{ id: number; display_name: string; default_code: string | false }>(
    'product.product',
    [['company_id', '=', companyId], ['product_tmpl_id.name', 'in', ['Bag', 'Fardo']]],
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
