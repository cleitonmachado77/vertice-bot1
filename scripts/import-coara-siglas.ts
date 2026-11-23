/**
 * Preenche `header.sigla` dos produtos Forms a partir de
 * `src/server/seeds/coara-product-siglas.json` (abreviacoes Coara).
 *
 * Match por nome normalizado (sem acento / pontuação).
 * Produtos já com a mesma sigla são ignorados; sigla diferente é sobrescrita.
 *
 * Uso:
 *   npx tsx scripts/import-coara-siglas.ts           # dry-run
 *   npx tsx scripts/import-coara-siglas.ts --apply   # grava no banco
 */
import { closeDatabase, initDatabase, many, run } from '../src/server/db.js';
import { loadEnv } from '../src/server/env.js';
import { loadCoaraSiglaMap, productNameKey } from '../src/server/coara-siglas.js';

const apply = process.argv.includes('--apply');

loadEnv();
await initDatabase();

type ProductRow = {
  id: string;
  title: string;
  header_json: string;
  company_odoo_id: string;
};

function parseHeader(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw || '{}') as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      out[key] = value == null || value === false ? '' : String(value);
    }
    return out;
  } catch {
    return {};
  }
}

try {
  const map = loadCoaraSiglaMap();
  const products = await many<ProductRow>(
    `SELECT id, title, header_json, COALESCE(NULLIF(company_odoo_id, ''), '1') AS company_odoo_id
     FROM forms_documents
     WHERE kind = 'product'
     ORDER BY title ASC`,
  );

  let matched = 0;
  let updated = 0;
  let already = 0;
  let unmatched = 0;
  const usedKeys = new Set<string>();
  const changes: string[] = [];

  for (const row of products) {
    const header = parseHeader(row.header_json);
    const name = (header.name || row.title || '').trim();
    const key = productNameKey(name);
    const entry = map.get(key);
    if (!entry) {
      unmatched += 1;
      continue;
    }
    matched += 1;
    usedKeys.add(key);
    const current = String(header.sigla || '').trim().toUpperCase();
    if (current === entry.sigla) {
      already += 1;
      continue;
    }
    changes.push(
      `${name} [${row.company_odoo_id}] ${current || '(vazio)'} → ${entry.sigla}`,
    );
    if (apply) {
      const next = { ...header, sigla: entry.sigla, name: header.name || name };
      await run(
        `UPDATE forms_documents SET header_json = $2, updated_at = NOW() WHERE id = $1`,
        [row.id, JSON.stringify(next)],
      );
      updated += 1;
    }
  }

  const unused = [...map.values()].filter((entry) => !usedKeys.has(entry.key));

  console.log(apply ? '=== APPLY ===' : '=== DRY-RUN (passe --apply para gravar) ===');
  console.log(`Catálogo Coara: ${map.size} siglas`);
  console.log(`Produtos no Vertice: ${products.length}`);
  console.log(`Match por nome: ${matched}`);
  console.log(`Já corretos: ${already}`);
  console.log(`${apply ? 'Atualizados' : 'A atualizar'}: ${changes.length}`);
  console.log(`Sem match no Vertice: ${unmatched}`);
  console.log(`Siglas Coara sem produto: ${unused.length}`);

  if (changes.length) {
    console.log('\nAlterações:');
    for (const line of changes.slice(0, 80)) console.log(`  ${line}`);
    if (changes.length > 80) console.log(`  … +${changes.length - 80} mais`);
  }

  if (unused.length && unused.length <= 40) {
    console.log('\nCoara sem produto correspondente:');
    for (const entry of unused) console.log(`  ${entry.sigla}  ${entry.name}`);
  } else if (unused.length > 40) {
    console.log(`\nCoara sem produto: ${unused.length} (omitido; rode com menos ruído no dry-run)`);
  }
} finally {
  await closeDatabase();
}
