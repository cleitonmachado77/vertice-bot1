/**
 * Limpeza do ciclo Forms Bot de 27/10/2026 (padrão “Ademir - Compras”, contato Cleiton):
 * “bom dia posso sim” virou fornecedor e “fornecedor 2” virou o produto “fornecedor”.
 *
 * - Respostas do ciclo: fornecedor → Associação de Lupionópolis (opção 2 da lista) e linhas sem “fornecedor”.
 * - P00025 é regenerado a partir dessas respostas pelo próprio Forms Bot (produto fixo e preço do padrão)
 *   e reenviado ao Odoo — o pedido ainda está em rascunho, então as linhas são reescritas.
 * - Parceiro “bom dia posso sim” e produto “fornecedor”: arquivados no Odoo e removidos do Vertice,
 *   só se o nome no Odoo bater e nenhum outro documento os usar.
 *
 * Uso:
 *   npx tsx scripts/cleanup-forms-2026-10-27.ts            # só mostra o plano (nada é alterado)
 *   npx tsx scripts/cleanup-forms-2026-10-27.ts --apply    # executa
 *   --vendor="Nome do fornecedor"                           # outro fornecedor para o P00025
 *   --so-pedido                                             # só P00025 e respostas (sem parceiro/produto)
 */
import { closeDatabase, initDatabase, many, run } from '../src/server/db.js';
import { loadEnv } from '../src/server/env.js';
import { materializeFormsFromCycle } from '../src/server/forms-bot.js';
import { planBotLines } from '../src/server/forms-bot-lines.js';
import { resolveCatalogValue } from '../src/server/forms-bot-match.js';
import { deleteEntityPartner } from '../src/server/forms-entities.js';
import { getFormPresetById } from '../src/server/forms-presets.js';
import { deleteFormDocument, getFormDocument } from '../src/server/forms.js';
import { odooSearchRead } from '../src/server/odoo-client.js';
import { archivePartnerInOdoo, cancelFormInOdoo, isFormOrderEditable } from '../src/server/odoo-sync.js';

const PO_DOC_ID = '4487a7fc-5c32-4f27-8a24-41e8a71c503d';
const PRODUCT_DOC_ID = 'f9478be6-a620-4b97-848e-4f2ba73af5d6';
const CYCLE_ID = '779d82b9-a1a7-453e-866c-d978c14ad60c';
const PRESET_ID = '89a019d5-0f2b-46ee-9e23-963a18e3320f';
const BAD_PARTNER = 'bom dia posso sim';
const BAD_PRODUCT = 'fornecedor';
const DEFAULT_VENDOR = 'Associação do Desenvolvimento Comunitário de Lupionópolis';

const apply = process.argv.includes('--apply');
const onlyOrder = process.argv.includes('--so-pedido');
const vendorArg = process.argv.find((arg) => arg.startsWith('--vendor='))?.slice('--vendor='.length);

const same = (a: unknown, b: string) => String(a || '').trim().toLowerCase() === b.toLowerCase();
const plan: string[] = [];
const blocked: string[] = [];

loadEnv();
// initDatabase carrega as credenciais do Odoo (settings), mas também roda migrações: só no --apply.
if (apply) await initDatabase();

try {
  // ---------- respostas do ciclo + P00025 ----------
  const po = await getFormDocument(PO_DOC_ID);
  const answers = await many<{ id: string; export_field: string; answer_text: string }>(
    `SELECT ans.id, qq.export_field, ans.answer_text
     FROM questionnaire_answers ans
     JOIN questionnaire_questions qq ON qq.id = ans.question_id
     WHERE ans.cycle_id = $1`,
    [CYCLE_ID],
  );
  const answerFixes: Array<{ id: string; text: string }> = [];
  let rebuildPo = false;

  if (!po) {
    blocked.push(`P00025 (${PO_DOC_ID}) não encontrado`);
  } else {
    console.log(`P00025: título “${po.title}”, fornecedor “${po.header.vendor}”, estado ${po.header.odoo_state || po.status}, Odoo ${po.header.odoo_id || '-'}`);
    for (const line of po.lines) console.log(`  linha atual: ${JSON.stringify(line.values)}`);

    const vendor = await resolveCatalogValue({
      kind: 'purchase',
      fieldKey: 'vendor',
      raw: vendorArg || DEFAULT_VENDOR,
      companyOdooId: po.company_odoo_id || '1',
    });
    for (const row of answers) {
      if (row.export_field === 'vendor' && same(row.answer_text, BAD_PARTNER)) {
        if (vendor.matched) answerFixes.push({ id: row.id, text: vendor.value });
        else blocked.push(`fornecedor “${vendorArg || DEFAULT_VENDOR}” não está no catálogo (use --vendor=)`);
      }
      if (row.export_field === '__lines__') {
        try {
          const lines = JSON.parse(row.answer_text) as Array<{ product?: string }>;
          const kept = lines.filter((line) => !same(line.product, BAD_PRODUCT));
          if (kept.length !== lines.length) answerFixes.push({ id: row.id, text: JSON.stringify(kept) });
        } catch {
          /* texto livre: deixa como está */
        }
      }
    }

    const hasBadData =
      same(po.header.vendor, BAD_PARTNER) || po.lines.some((line) => same(line.values.product, BAD_PRODUCT));
    if (!hasBadData && !answerFixes.length) {
      console.log('  → já corrigido, nada a fazer');
    } else if (!isFormOrderEditable(po)) {
      blocked.push(`P00025 não está mais em rascunho no Odoo (${po.header.odoo_state}) — corrija manualmente`);
    } else if (!blocked.length) {
      rebuildPo = true;
      for (const fix of answerFixes) plan.push(`resposta do ciclo 27/10 (${fix.id}) → ${fix.text}`);
      const preset = await getFormPresetById(PRESET_ID);
      const fixedById = new Map(answerFixes.map((fix) => [fix.id, fix.text]));
      const answerText = (field: string) => {
        const row = answers.find((item) => item.export_field === field);
        return row ? fixedById.get(row.id) ?? row.answer_text : '';
      };
      const preview = planBotLines({
        kind: 'purchase',
        presetLines: preset?.lines || [],
        visibleLineKeys: preset?.visible.lines || [],
        linesAnswer: answerText('__lines__'),
        moreAnswer: answerText('__lines_more__'),
      });
      plan.push(`P00025: regenerar pelo Forms Bot e reenviar ao Odoo ${po.header.odoo_id || ''}`.trim());
      for (const line of [...preview.primary, ...preview.extra]) plan.push(`  linha prevista: ${JSON.stringify(line)}`);
    }
  }

  // ---------- parceiro “bom dia posso sim” ----------
  const partners = await many<{ id: string; odoo_id: string; company_odoo_id: string }>(
    `SELECT id, odoo_id, company_odoo_id FROM forms_partners WHERE LOWER(TRIM(name)) = $1`,
    [BAD_PARTNER],
  );
  const otherPartnerRefs = await many<{ id: string; title: string }>(
    `SELECT id, title FROM forms_documents
     WHERE id <> $1 AND (header_json ILIKE $2 OR header_json ILIKE $3)`,
    [PO_DOC_ID, `%"vendor":"${BAD_PARTNER}"%`, `%"customer":"${BAD_PARTNER}"%`],
  );
  const partnerOdooIds = [...new Set(partners.map((row) => row.odoo_id).filter(Boolean))];
  const cleanPartner =
    !onlyOrder && partners.length > 0 && !otherPartnerRefs.length && (rebuildPo || !same(po?.header.vendor, BAD_PARTNER));
  if (otherPartnerRefs.length) {
    blocked.push(`parceiro “${BAD_PARTNER}” ainda usado em: ${otherPartnerRefs.map((row) => row.title).join(', ')}`);
  } else if (cleanPartner) {
    plan.push(`parceiro “${BAD_PARTNER}”: arquivar no Odoo ${partnerOdooIds.join(', ') || '-'} e remover ${partners.length} registro(s) local(is)`);
  }

  // ---------- produto “fornecedor” ----------
  const product = await getFormDocument(PRODUCT_DOC_ID);
  const otherProductRefs = await many<{ document_id: string }>(
    `SELECT DISTINCT document_id FROM forms_document_lines
     WHERE document_id <> $1 AND LOWER(line_json) LIKE $2`,
    [PO_DOC_ID, `%"product":"${BAD_PRODUCT}"%`],
  );
  let cleanProduct = false;
  if (product && (product.kind !== 'product' || !same(product.header.name, BAD_PRODUCT))) {
    blocked.push(`documento ${PRODUCT_DOC_ID} não é o produto “${BAD_PRODUCT}” — não mexo`);
  } else if (otherProductRefs.length) {
    blocked.push(`produto “${BAD_PRODUCT}” ainda usado em ${otherProductRefs.length} documento(s)`);
  } else if (product && !onlyOrder) {
    cleanProduct = true;
    plan.push(`produto “${BAD_PRODUCT}”: arquivar no Odoo (template ${product.header.odoo_id || '-'}) e remover do Vertice`);
  }

  console.log('\nPlano:');
  for (const item of plan) console.log(`  - ${item}`);
  if (!plan.length) console.log('  (nada a fazer)');
  if (blocked.length) {
    console.log('\nNão será feito:');
    for (const item of blocked) console.log(`  ! ${item}`);
  }

  if (!apply) {
    console.log('\nNada foi alterado. Rode com --apply para executar.');
  } else {
    if (rebuildPo) {
      const stamp = new Date().toISOString();
      for (const fix of answerFixes) {
        await run(`UPDATE questionnaire_answers SET answer_text = $2, updated_at = $3 WHERE id = $1`, [
          fix.id,
          fix.text,
          stamp,
        ]);
      }
      const rebuilt = await materializeFormsFromCycle(CYCLE_ID);
      if (!rebuilt || rebuilt.id !== PO_DOC_ID) throw new Error('Forms Bot não regenerou o P00025 — verifique o ciclo');
      const pushed = await waitOdooPush(PO_DOC_ID);
      console.log(`✔ P00025 regenerado: “${pushed.title}”, Odoo ${pushed.header.odoo_id}, estado ${pushed.header.odoo_state}`);
      for (const line of pushed.lines) console.log(`    ${JSON.stringify(line.values)}`);
      if (pushed.header.odoo_sync_error) throw new Error(`Falha no envio ao Odoo: ${pushed.header.odoo_sync_error}`);
    }

    if (cleanPartner) {
      for (const odooId of partnerOdooIds) {
        const [remote] = await odooSearchRead<{ name: string }>('res.partner', [['id', '=', Number(odooId)]], ['name'], { limit: 1 });
        if (remote && !same(remote.name, BAD_PARTNER)) {
          console.log(`! parceiro Odoo ${odooId} se chama “${remote.name}” — não arquivado`);
          continue;
        }
        await archivePartnerInOdoo(odooId);
        console.log(`✔ parceiro Odoo ${odooId} arquivado`);
      }
      for (const row of partners) await deleteEntityPartner(row.id);
      console.log(`✔ ${partners.length} parceiro(s) “${BAD_PARTNER}” removido(s) do Vertice`);
    }

    if (cleanProduct && product) {
      const odooId = Number(product.header.odoo_id || 0);
      const [remote] = odooId
        ? await odooSearchRead<{ name: string }>('product.template', [['id', '=', odooId]], ['name'], { limit: 1 })
        : [];
      if (remote && !same(remote.name, BAD_PRODUCT)) {
        console.log(`! produto Odoo ${odooId} se chama “${remote.name}” — não arquivado nem removido`);
      } else {
        await cancelFormInOdoo(product);
        await deleteFormDocument(PRODUCT_DOC_ID);
        console.log(`✔ produto “${BAD_PRODUCT}” arquivado no Odoo e removido do Vertice`);
      }
    }
  }
} finally {
  await closeDatabase();
}

/** materializeFormsFromCycle agenda o push (setImmediate): espera ele concluir antes de seguir. */
async function waitOdooPush(id: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const doc = await getFormDocument(id);
    if (doc && (!doc.header.odoo_sync_pending || doc.header.odoo_sync_error)) return doc;
  }
  throw new Error('Envio ao Odoo não concluiu em 60s — confira o P00025 no painel');
}
