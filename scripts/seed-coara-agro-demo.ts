/**
 * Dados fake de plantio/estimativa na Coara (empresa 2) para demonstrar o gráfico.
 *
 *   npx tsx scripts/seed-coara-agro-demo.ts
 */
import { randomUUID } from 'node:crypto';
import { loadEnv } from '../src/server/env.js';
import { closeDatabase, initDatabase, many, one, run } from '../src/server/db.js';
import { ensureAgroSchema } from '../src/server/agro-schema.js';
import { deriveHarvestEstimates } from '../src/server/agro-rules.js';

const COMPANY_ID = '2';
const DEMO_NOTE = 'Demo fake · gráfico estimativa';

type DemoCrop = {
  sigla: string;
  name: string;
  uom: string;
  cycleDays: number;
  yieldPerHa: number;
  harvestCount: number;
  harvestIntervalDays: number;
  harvestCurve: 'Uniforme' | 'Decrescente' | 'Crescente' | 'Pico no meio';
  curveIntensity: number;
  areaHa: number;
  plantsCount: number;
  plantedOn: string;
};

const CROPS: DemoCrop[] = [
  {
    sigla: 'ALF',
    name: 'Alface (demo)',
    uom: 'kg',
    cycleDays: 45,
    yieldPerHa: 16500,
    harvestCount: 1,
    harvestIntervalDays: 0,
    harvestCurve: 'Uniforme',
    curveIntensity: 0,
    areaHa: 0.12,
    plantsCount: 4800,
    plantedOn: '2026-10-15',
  },
  {
    sigla: 'ALM',
    name: 'Almeirão (demo)',
    uom: 'kg',
    cycleDays: 45,
    yieldPerHa: 12300,
    harvestCount: 4,
    harvestIntervalDays: 25,
    harvestCurve: 'Decrescente',
    curveIntensity: 1,
    areaHa: 0.08,
    plantsCount: 3200,
    plantedOn: '2026-09-20',
  },
  {
    sigla: 'PEP',
    name: 'Pepino (demo)',
    uom: 'kg',
    cycleDays: 45,
    yieldPerHa: 16800,
    harvestCount: 7,
    harvestIntervalDays: 7,
    harvestCurve: 'Pico no meio',
    curveIntensity: 1,
    areaHa: 0.05,
    plantsCount: 900,
    plantedOn: '2026-10-01',
  },
  {
    sigla: 'TOM',
    name: 'Tomate (demo)',
    uom: 'kg',
    cycleDays: 110,
    yieldPerHa: 52650,
    harvestCount: 4,
    harvestIntervalDays: 20,
    harvestCurve: 'Pico no meio',
    curveIntensity: 1,
    areaHa: 0.2,
    plantsCount: 2500,
    plantedOn: '2026-08-10',
  },
];

loadEnv();
await initDatabase();

try {
  await ensureAgroSchema();

  let producer = await one<{ id: string; name: string }>(
    `SELECT id, name FROM agro_producers
     WHERE company_odoo_id = $1 AND active = 1
     ORDER BY name ASC LIMIT 1`,
    [COMPANY_ID],
  );
  if (!producer) {
    const id = randomUUID();
    await run(
      `INSERT INTO agro_producers(id, company_odoo_id, name, phone, active, created_at, updated_at)
       VALUES($1, $2, $3, $4, 1, NOW(), NOW())`,
      [id, COMPANY_ID, 'Wagner (demo)', '44999887766'],
    );
    producer = { id, name: 'Wagner (demo)' };
    console.log(`Produtor criado: ${producer.name}`);
  } else {
    await run(
      `UPDATE agro_producers
       SET phone = CASE WHEN COALESCE(phone, '') = '' THEN '44999887766' ELSE phone END,
           updated_at = NOW()
       WHERE id = $1`,
      [producer.id],
    );
  }

  let property = await one<{ id: string; name: string }>(
    `SELECT id, name FROM agro_properties
     WHERE company_odoo_id = $1 AND active = 1
     ORDER BY name ASC LIMIT 1`,
    [COMPANY_ID],
  );
  if (!property) {
    const id = randomUUID();
    await run(
      `INSERT INTO agro_properties(
         id, company_odoo_id, name, producer_name, producer_id, active, created_at, updated_at
       ) VALUES($1, $2, $3, $4, $5, 1, NOW(), NOW())`,
      [id, COMPANY_ID, 'Fazenda Wagner (demo)', producer.name, producer.id],
    );
    property = { id, name: 'Fazenda Wagner (demo)' };
    console.log(`Propriedade criada: ${property.name}`);
  } else {
    await run(
      `UPDATE agro_properties SET producer_id = $2, producer_name = $3, updated_at = NOW()
       WHERE id = $1 AND COALESCE(producer_id, '') = ''`,
      [property.id, producer.id, producer.name],
    );
  }

  let plot = await one<{ id: string; name: string; code: string; area: number | null }>(
    `SELECT id, name, code, area FROM agro_plots
     WHERE property_id = $1 AND active = 1
     ORDER BY name ASC LIMIT 1`,
    [property.id],
  );
  if (!plot) {
    const id = randomUUID();
    await run(
      `INSERT INTO agro_plots(id, property_id, name, code, area, active, created_at, updated_at)
       VALUES($1, $2, $3, $4, $5, 1, NOW(), NOW())`,
      [id, property.id, 'Talhão A1', 'A1', 1.5],
    );
    plot = { id, name: 'Talhão A1', code: 'A1', area: 1.5 };
    console.log(`Talhão criado: ${plot.code}`);
  }

  // Remove demos anteriores para poder rodar de novo.
  const old = await many<{ id: string }>(
    `SELECT id FROM agro_plantings
     WHERE company_odoo_id = $1 AND notes = $2`,
    [COMPANY_ID, DEMO_NOTE],
  );
  for (const row of old) {
    await run(`DELETE FROM agro_planting_estimates WHERE planting_id = $1`, [row.id]);
    await run(`DELETE FROM agro_harvests WHERE planting_id = $1`, [row.id]);
    await run(`DELETE FROM agro_deliveries WHERE planting_id = $1`, [row.id]);
    await run(`DELETE FROM agro_plantings WHERE id = $1`, [row.id]);
  }
  if (old.length) console.log(`Removidos ${old.length} plantios demo anteriores`);

  for (const crop of CROPS) {
    let product = await one<{ id: string; header_json: string }>(
      `SELECT id, header_json FROM forms_documents
       WHERE kind = 'product'
         AND COALESCE(NULLIF(company_odoo_id, ''), '1') = $1
         AND (
           lower(title) = lower($2)
           OR lower(header_json::jsonb ->> 'sigla') = lower($3)
         )
       ORDER BY updated_at DESC
       LIMIT 1`,
      [COMPANY_ID, crop.name, crop.sigla],
    );

    const header = {
      name: crop.name,
      sigla: crop.sigla,
      uom: crop.uom,
      cycle_days: String(crop.cycleDays),
      yield_per_ha: String(crop.yieldPerHa),
      harvest_count: String(crop.harvestCount),
      harvest_interval_days: String(crop.harvestIntervalDays),
      harvest_curve: crop.harvestCurve,
      curve_intensity: String(crop.curveIntensity),
      cycles_per_year: '2',
      track_inventory: 'True',
      company_odoo_id: COMPANY_ID,
    };

    if (!product) {
      const id = randomUUID();
      await run(
        `INSERT INTO forms_documents(id, kind, title, status, header_json, company_odoo_id, created_at, updated_at)
         VALUES($1, 'product', $2, 'draft', $3, $4, NOW(), NOW())`,
        [id, crop.name, JSON.stringify(header), COMPANY_ID],
      );
      product = { id, header_json: JSON.stringify(header) };
      console.log(`Produto criado: ${crop.sigla} · ${crop.name}`);
    } else {
      let prev: Record<string, string> = {};
      try {
        prev = JSON.parse(product.header_json || '{}') as Record<string, string>;
      } catch {
        prev = {};
      }
      const merged = { ...prev, ...header, odoo_id: prev.odoo_id || '' };
      await run(
        `UPDATE forms_documents
         SET title = $2, header_json = $3, updated_at = NOW()
         WHERE id = $1`,
        [product.id, crop.name, JSON.stringify(merged)],
      );
      console.log(`Produto atualizado: ${crop.sigla} · ${crop.name}`);
    }

    const estimates = deriveHarvestEstimates({
      plantedOn: crop.plantedOn,
      areaHa: crop.areaHa,
      cycleDays: crop.cycleDays,
      yieldPerHa: crop.yieldPerHa,
      harvestCount: crop.harvestCount,
      harvestIntervalDays: crop.harvestIntervalDays,
      harvestCurve: crop.harvestCurve,
      curveIntensity: crop.curveIntensity,
    });
    const forecastOn = estimates[0]?.forecastOn || null;
    const forecastQty =
      Math.round(estimates.reduce((sum, line) => sum + line.estimatedQty, 0) * 1000) / 1000;
    const plantingId = randomUUID();

    await run(
      `INSERT INTO agro_plantings(
         id, company_odoo_id, property_id, plot_id, product_id, product_name, unit,
         area_planned, plants_count, planted_on, forecast_on, forecast_qty, notes, status,
         created_at, updated_at
       ) VALUES(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'planejado',NOW(),NOW()
       )`,
      [
        plantingId,
        COMPANY_ID,
        property.id,
        plot.id,
        product.id,
        crop.name,
        crop.uom,
        crop.areaHa,
        crop.plantsCount,
        crop.plantedOn,
        forecastOn,
        forecastQty,
        DEMO_NOTE,
      ],
    );

    for (const line of estimates) {
      await run(
        `INSERT INTO agro_planting_estimates(
           id, planting_id, harvest_index, forecast_on, estimated_qty, created_at, updated_at
         ) VALUES($1,$2,$3,$4,$5,NOW(),NOW())`,
        [randomUUID(), plantingId, line.index, line.forecastOn, line.estimatedQty],
      );
    }

    console.log(
      `Plantio ${crop.sigla}: ${crop.plantedOn} → ${estimates.length} colheita(s) ` +
        `(1ª ${forecastOn}, total ${forecastQty} ${crop.uom})`,
    );
  }

  console.log('');
  console.log('Demo Coara pronta. No dashboard Agro:');
  console.log('  · Empresa: Coara (ou Todas/Reciclarenda consolidado)');
  console.log('  · Período sugerido: novembro/2026 ou dezembro/2026 (há colheitas previstas)');
  console.log('  · Aba Plantio: coluna "Colheita prevista"');
} finally {
  await closeDatabase();
}
