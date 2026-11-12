import { run } from './db.js';

/** Tabelas do Vertice Agro no mesmo Postgres do Vertice WEB, por empresa do Odoo. */

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
  await run(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_agro_properties_company_name
     ON agro_properties(company_odoo_id, lower(name))`,
  );
  await run(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_agro_plots_property_name
     ON agro_plots(property_id, lower(name))`,
  );
  await run(`CREATE INDEX IF NOT EXISTS idx_agro_plantings_company ON agro_plantings(company_odoo_id, planted_on DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_agro_harvests_planting ON agro_harvests(planting_id, harvested_on DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_agro_deliveries_planting ON agro_deliveries(planting_id, delivered_on DESC)`);
  await run(`ALTER TABLE agro_properties ADD COLUMN IF NOT EXISTS odoo_location_id TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE agro_properties ADD COLUMN IF NOT EXISTS odoo_partner_id TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE agro_properties ADD COLUMN IF NOT EXISTS producer_partner_id TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE agro_plots ADD COLUMN IF NOT EXISTS odoo_location_id TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE agro_harvests ADD COLUMN IF NOT EXISTS odoo_qty DOUBLE PRECISION NOT NULL DEFAULT 0`);
  await run(`ALTER TABLE agro_deliveries ADD COLUMN IF NOT EXISTS odoo_order_id TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE agro_deliveries ADD COLUMN IF NOT EXISTS sale_document_id TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE agro_plantings ADD COLUMN IF NOT EXISTS source_cycle_id TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE agro_harvests ADD COLUMN IF NOT EXISTS source_cycle_id TEXT NOT NULL DEFAULT ''`);
  await run(`ALTER TABLE agro_deliveries ADD COLUMN IF NOT EXISTS source_cycle_id TEXT NOT NULL DEFAULT ''`);
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
}
