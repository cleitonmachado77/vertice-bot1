import { randomUUID } from 'node:crypto';
import { many, one, run } from './db.js';

/** Tabelas do Vértice Agro no mesmo Postgres do Vértice Elo, por empresa do Odoo. */

let ready: Promise<void> | null = null;

export function ensureAgroSchema(): Promise<void> {
  if (!ready) {
    ready = createAgroTables().catch((error) => {
      ready = null;
      throw error;
    });
  }
  return ready;
}

async function createAgroTables(): Promise<void> {
  await run(`
    CREATE TABLE IF NOT EXISTS agro_producers (
      id TEXT PRIMARY KEY,
      company_odoo_id TEXT NOT NULL DEFAULT '1',
      name TEXT NOT NULL,
      total_area DOUBLE PRECISION,
      city TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      partner_id TEXT NOT NULL DEFAULT '',
      contact_id TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (total_area IS NULL OR total_area >= 0)
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS agro_properties (
      id TEXT PRIMARY KEY,
      company_odoo_id TEXT NOT NULL DEFAULT '1',
      name TEXT NOT NULL,
      producer_name TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS agro_plots (
      id TEXT PRIMARY KEY,
      property_id TEXT NOT NULL REFERENCES agro_properties(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      name TEXT NOT NULL,
      area DOUBLE PRECISION,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (area IS NULL OR area >= 0)
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS agro_plantings (
      id TEXT PRIMARY KEY,
      company_odoo_id TEXT NOT NULL DEFAULT '1',
      property_id TEXT NOT NULL REFERENCES agro_properties(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      plot_id TEXT REFERENCES agro_plots(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      product_id TEXT NOT NULL DEFAULT '',
      product_name TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT '',
      area_planned DOUBLE PRECISION NOT NULL,
      planted_on DATE NOT NULL,
      forecast_on DATE,
      forecast_qty DOUBLE PRECISION,
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'planejado',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (area_planned >= 0),
      CHECK (forecast_qty IS NULL OR forecast_qty >= 0),
      CHECK (status IN ('planejado', 'em_colheita', 'colhido')),
      CHECK (forecast_on IS NULL OR forecast_on >= planted_on)
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS agro_harvests (
      id TEXT PRIMARY KEY,
      planting_id TEXT NOT NULL REFERENCES agro_plantings(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      harvested_on DATE NOT NULL,
      quantity DOUBLE PRECISION NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (quantity > 0)
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS agro_deliveries (
      id TEXT PRIMARY KEY,
      planting_id TEXT NOT NULL REFERENCES agro_plantings(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      partner_id TEXT NOT NULL DEFAULT '',
      partner_name TEXT NOT NULL,
      delivered_on DATE NOT NULL,
      quantity DOUBLE PRECISION NOT NULL,
      unit_price DOUBLE PRECISION,
      total_value DOUBLE PRECISION,
      document TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (quantity > 0),
      CHECK (unit_price IS NULL OR unit_price >= 0),
      CHECK (total_value IS NULL OR total_value >= 0)
    )
  `);
  await run(`DROP INDEX IF EXISTS ux_agro_producers_company_name`);
  await run(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_agro_producers_company_name_active
     ON agro_producers(company_odoo_id, lower(name)) WHERE active = 1`,
  );
  await run(`DROP INDEX IF EXISTS ux_agro_properties_company_name`);
  await run(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_agro_properties_company_name_active
     ON agro_properties(company_odoo_id, lower(name)) WHERE active = 1`,
  );
  await run(`DROP INDEX IF EXISTS ux_agro_plots_property_name`);
  await run(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_agro_plots_property_name_active
     ON agro_plots(property_id, lower(name)) WHERE active = 1`,
  );
  await run(`
    CREATE TABLE IF NOT EXISTS agro_costs (
      id TEXT PRIMARY KEY,
      company_odoo_id TEXT NOT NULL DEFAULT '1',
      plot_id TEXT NOT NULL REFERENCES agro_plots(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      cost_on DATE NOT NULL,
      name TEXT NOT NULL,
      quantity DOUBLE PRECISION NOT NULL,
      unit_price DOUBLE PRECISION,
      notes TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (quantity > 0),
      CHECK (unit_price IS NULL OR unit_price >= 0)
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_agro_costs_company ON agro_costs(company_odoo_id, cost_on DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_agro_costs_plot ON agro_costs(plot_id, cost_on DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_agro_producers_company ON agro_producers(company_odoo_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_agro_plantings_company ON agro_plantings(company_odoo_id, planted_on DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_agro_harvests_planting ON agro_harvests(planting_id, harvested_on DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_agro_deliveries_planting ON agro_deliveries(planting_id, delivered_on DESC)`);
  await run(`ALTER TABLE agro_properties ADD COLUMN IF NOT EXISTS odoo_location_id TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE agro_properties ADD COLUMN IF NOT EXISTS odoo_partner_id TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE agro_properties ADD COLUMN IF NOT EXISTS producer_partner_id TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE agro_properties ADD COLUMN IF NOT EXISTS producer_id TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE agro_plots ADD COLUMN IF NOT EXISTS odoo_location_id TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE agro_plots ADD COLUMN IF NOT EXISTS code TEXT NOT NULL DEFAULT ''`);
  await run(`UPDATE agro_plots SET code = name WHERE COALESCE(code, '') = '' AND COALESCE(name, '') <> ''`);
  await run(`DROP INDEX IF EXISTS ux_agro_plots_property_code_active`);
  await run(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_agro_plots_property_code_active
     ON agro_plots(property_id, lower(code)) WHERE active = 1 AND code <> ''`,
  );
  await run(`ALTER TABLE agro_harvests ADD COLUMN IF NOT EXISTS odoo_qty DOUBLE PRECISION NOT NULL DEFAULT 0`);
  await run(`ALTER TABLE agro_deliveries ADD COLUMN IF NOT EXISTS odoo_order_id TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE agro_deliveries ADD COLUMN IF NOT EXISTS odoo_order_ref TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE agro_deliveries ADD COLUMN IF NOT EXISTS sale_document_id TEXT NOT NULL DEFAULT ''`);
  await run(
    `UPDATE agro_deliveries
     SET odoo_order_ref = document
     WHERE COALESCE(odoo_order_ref, '') = ''
       AND COALESCE(sale_document_id, '') <> ''
       AND document ~ '^S[0-9]+$'`,
  );
  await run(`ALTER TABLE agro_plantings ADD COLUMN IF NOT EXISTS source_cycle_id TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE agro_plantings ADD COLUMN IF NOT EXISTS planted_qty DOUBLE PRECISION`);
  await run(`ALTER TABLE agro_harvests ADD COLUMN IF NOT EXISTS source_cycle_id TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE agro_deliveries ADD COLUMN IF NOT EXISTS source_cycle_id TEXT NOT NULL DEFAULT ''`);
  await run(`
    DO $$ BEGIN
      ALTER TABLE agro_plantings
        ADD CONSTRAINT agro_plantings_planted_qty_nonneg
        CHECK (planted_qty IS NULL OR planted_qty >= 0);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);
  await run(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_agro_plantings_cycle
     ON agro_plantings(source_cycle_id) WHERE source_cycle_id <> ''`,
  );
  await run(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_agro_harvests_cycle
     ON agro_harvests(source_cycle_id) WHERE source_cycle_id <> ''`,
  );
  await run(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_agro_deliveries_cycle
     ON agro_deliveries(source_cycle_id) WHERE source_cycle_id <> ''`,
  );
  await run(`
    CREATE TABLE IF NOT EXISTS agro_delivery_points (
      id TEXT PRIMARY KEY,
      company_odoo_id TEXT NOT NULL DEFAULT '1',
      name TEXT NOT NULL,
      partner_id TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await run(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_agro_delivery_points_company_name_active
     ON agro_delivery_points(company_odoo_id, lower(name)) WHERE active = 1`,
  );
  await run(
    `CREATE INDEX IF NOT EXISTS idx_agro_delivery_points_company
     ON agro_delivery_points(company_odoo_id, sort_order, name)`,
  );
  await run(`ALTER TABLE agro_plantings ADD COLUMN IF NOT EXISTS plants_count DOUBLE PRECISION`);
  await run(
    `ALTER TABLE agro_plantings DROP CONSTRAINT IF EXISTS agro_plantings_plants_count_check`,
  );
  await run(
    `ALTER TABLE agro_plantings
     ADD CONSTRAINT agro_plantings_plants_count_check
     CHECK (plants_count IS NULL OR plants_count >= 0)`,
  );
  await run(`ALTER TABLE agro_harvests ADD COLUMN IF NOT EXISTS area_harvested DOUBLE PRECISION`);
  await run(
    `ALTER TABLE agro_harvests DROP CONSTRAINT IF EXISTS agro_harvests_area_harvested_check`,
  );
  await run(
    `ALTER TABLE agro_harvests
     ADD CONSTRAINT agro_harvests_area_harvested_check
     CHECK (area_harvested IS NULL OR area_harvested >= 0)`,
  );
  await run(`
    CREATE TABLE IF NOT EXISTS agro_planting_estimates (
      id TEXT PRIMARY KEY,
      planting_id TEXT NOT NULL REFERENCES agro_plantings(id) ON UPDATE CASCADE ON DELETE CASCADE,
      harvest_index INTEGER NOT NULL,
      forecast_on DATE NOT NULL,
      estimated_qty DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (harvest_index >= 1),
      CHECK (estimated_qty >= 0),
      UNIQUE (planting_id, harvest_index)
    )
  `);
  await run(
    `CREATE INDEX IF NOT EXISTS idx_agro_planting_estimates_planting
     ON agro_planting_estimates(planting_id, harvest_index)`,
  );
  await run(
    `CREATE INDEX IF NOT EXISTS idx_agro_planting_estimates_date
     ON agro_planting_estimates(forecast_on)`,
  );
  await migrateProducersFromProperties();
  await migrateLegacyPlantingEstimates();
}

/** Plantios antigos com forecast_* viram 1 linha de estimativa. */
async function migrateLegacyPlantingEstimates(): Promise<void> {
  await run(`
    INSERT INTO agro_planting_estimates(
      id, planting_id, harvest_index, forecast_on, estimated_qty, created_at, updated_at
    )
    SELECT
      p.id || '-est-1',
      p.id,
      1,
      p.forecast_on,
      COALESCE(p.forecast_qty, 0),
      NOW(),
      NOW()
    FROM agro_plantings p
    WHERE p.forecast_on IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM agro_planting_estimates e WHERE e.planting_id = p.id
      )
  `);
}

/** Liga propriedades antigas a um cadastro de produtor (nome/fornecedor já gravados). */
async function migrateProducersFromProperties(): Promise<void> {
  const rows = await many<{
    id: string;
    company_odoo_id: string;
    producer_name: string;
    producer_partner_id: string;
  }>(
    `SELECT id, company_odoo_id, COALESCE(producer_name, '') AS producer_name,
            COALESCE(producer_partner_id, '') AS producer_partner_id
     FROM agro_properties
     WHERE active = 1 AND COALESCE(producer_id, '') = ''
       AND (COALESCE(producer_name, '') <> '' OR COALESCE(producer_partner_id, '') <> '')`,
  );
  for (const row of rows) {
    const name = String(row.producer_name || '').trim();
    const partnerId = String(row.producer_partner_id || '').trim();
    if (!name && !partnerId) continue;
    let producer = partnerId
      ? await one<{ id: string }>(
          `SELECT id FROM agro_producers
           WHERE company_odoo_id = $1 AND partner_id = $2 AND active = 1 LIMIT 1`,
          [row.company_odoo_id, partnerId],
        )
      : undefined;
    if (!producer && name) {
      producer = await one<{ id: string }>(
        `SELECT id FROM agro_producers
         WHERE company_odoo_id = $1 AND lower(name) = lower($2) AND active = 1 LIMIT 1`,
        [row.company_odoo_id, name],
      );
    }
    let producerId = producer?.id || '';
    if (!producerId) {
      producerId = randomUUID();
      const label = name || `Produtor ${partnerId.slice(0, 8)}`;
      await run(
        `INSERT INTO agro_producers(
           id, company_odoo_id, name, partner_id, active, created_at, updated_at
         ) VALUES($1, $2, $3, $4, 1, NOW(), NOW())
         ON CONFLICT (id) DO NOTHING`,
        [producerId, row.company_odoo_id, label, partnerId],
      );
    }
    await run(`UPDATE agro_properties SET producer_id = $2, updated_at = NOW() WHERE id = $1`, [
      row.id,
      producerId,
    ]);
  }
}
