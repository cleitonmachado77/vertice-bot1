import { randomUUID } from 'node:crypto';
import { many, one, run } from './db.js';
import { upsertPartner } from './forms-catalog.js';
import { createLocalContact, findContactByPhone } from './local-contact.js';
import { listDeliveryPoints, type AgroDeliveryPoint } from './agro-delivery-points.js';
import { clip, plotLabel } from './agro-resolve.js';
import { parseOptionalQuantity, parseQuantity } from './agro-rules.js';
import { ensureAgroSchema } from './agro-schema.js';

export type AgroSettingsPlot = { id: string; code: string; name: string; area: number | null; label: string };
export type AgroSettingsProperty = {
  id: string;
  name: string;
  producerId: string;
  plots: AgroSettingsPlot[];
};
export type AgroSettingsProducer = {
  id: string;
  name: string;
  totalArea: number | null;
  city: string;
  state: string;
  phone: string;
  partnerId: string;
  contactId: string;
  properties: AgroSettingsProperty[];
};
export type { AgroDeliveryPoint };

const UF = new Set([
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA',
  'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
]);

function nullableArea(value: unknown, label: string): number | null {
  if (value == null || String(value).trim() === '') return null;
  return parseQuantity(value, label);
}

function normalizePhone(value: unknown): string {
  return String(value ?? '').replace(/\D/g, '').slice(0, 20);
}

function normalizeState(value: unknown): string {
  const state = String(value ?? '').trim().toUpperCase();
  if (!state) return '';
  if (!UF.has(state)) throw new Error('Informe a UF com 2 letras (ex.: PR)');
  return state;
}

async function syncProducerLinks(
  companyId: string,
  name: string,
  phone: string,
  currentPartnerId: string,
  currentContactId: string,
): Promise<{ partnerId: string; contactId: string }> {
  let partnerId = currentPartnerId;
  const partner = await upsertPartner(name, 'vendor', companyId);
  if (partner?.id) {
    partnerId = partner.id;
    if (phone) {
      await run(`UPDATE forms_partners SET phone = $2, updated_at = NOW() WHERE id = $1`, [
        partnerId,
        phone,
      ]);
    }
  }

  let contactId = currentContactId;
  if (phone) {
    const existing = await findContactByPhone(phone);
    if (existing && Number(existing.hidden) !== 1) {
      contactId = existing.id;
      await run(`UPDATE contacts SET name = $2, updated_at = NOW() WHERE id = $1`, [
        contactId,
        name,
      ]);
    } else if (!contactId) {
      const created = await createLocalContact({ name, phone, email: '' });
      contactId = created.id;
    } else {
      await run(
        `UPDATE contacts SET name = $2, phone = $3, updated_at = NOW() WHERE id = $1`,
        [contactId, name, phone],
      );
    }
  }
  return { partnerId, contactId };
}

export async function listAgroSettings(
  companyId: string,
): Promise<{ producers: AgroSettingsProducer[]; deliveryPoints: AgroDeliveryPoint[] }> {
  await ensureAgroSchema();
  const deliveryPoints = await listDeliveryPoints(companyId);
  const producers = await many<{
    id: string;
    name: string;
    total_area: number | null;
    city: string;
    state: string;
    phone: string;
    partner_id: string;
    contact_id: string;
  }>(
    `SELECT id, name, total_area, city, state, phone,
            COALESCE(partner_id, '') AS partner_id,
            COALESCE(contact_id, '') AS contact_id
     FROM agro_producers
     WHERE company_odoo_id = $1 AND active = 1
     ORDER BY name ASC`,
    [companyId],
  );
  const producerIds = producers.map((item) => item.id);
  const properties = producerIds.length
    ? await many<{ id: string; name: string; producer_id: string }>(
        `SELECT id, name, COALESCE(producer_id, '') AS producer_id
         FROM agro_properties
         WHERE company_odoo_id = $1 AND active = 1
           AND producer_id = ANY($2::text[])
         ORDER BY name ASC`,
        [companyId, producerIds],
      )
    : [];
  const propertyIds = properties.map((item) => item.id);
  const plots = propertyIds.length
    ? await many<{ id: string; property_id: string; code: string; name: string; area: number | null }>(
        `SELECT id, property_id, COALESCE(code, '') AS code, name, area FROM agro_plots
         WHERE active = 1 AND property_id = ANY($1::text[])
         ORDER BY CASE WHEN COALESCE(code, '') = '' THEN 1 ELSE 0 END, lower(code), lower(name)`,
        [propertyIds],
      )
    : [];

  return {
    deliveryPoints,
    producers: producers.map((producer) => ({
      id: producer.id,
      name: producer.name,
      totalArea: producer.total_area == null ? null : Number(producer.total_area),
      city: producer.city || '',
      state: producer.state || '',
      phone: producer.phone || '',
      partnerId: producer.partner_id || '',
      contactId: producer.contact_id || '',
      properties: properties
        .filter((property) => property.producer_id === producer.id)
        .map((property) => ({
          id: property.id,
          name: property.name,
          producerId: producer.id,
          plots: plots
            .filter((plot) => plot.property_id === property.id)
            .map((plot) => ({
              id: plot.id,
              code: plot.code || '',
              name: plot.name,
              area: plot.area == null ? null : Number(plot.area),
              label: plotLabel(plot.code, plot.name),
            })),
        })),
    })),
  };
}

export async function saveAgroProducer(
  companyId: string,
  input: Record<string, unknown>,
  id = '',
): Promise<AgroSettingsProducer> {
  await ensureAgroSchema();
  const name = clip(input.name, 150);
  if (!name) throw new Error('Informe o nome do produtor');
  const totalArea = nullableArea(input.totalArea, 'Área total');
  const city = clip(input.city, 120);
  const state = normalizeState(input.state);
  const phone = normalizePhone(input.phone);
  const current = id
    ? await one<{ id: string; partner_id: string; contact_id: string }>(
        `SELECT id, COALESCE(partner_id, '') AS partner_id, COALESCE(contact_id, '') AS contact_id
         FROM agro_producers WHERE id = $1 AND company_odoo_id = $2 AND active = 1`,
        [id, companyId],
      )
    : undefined;
  if (id && !current) throw new Error('Produtor não encontrado');

  const clash = await one<{ id: string }>(
    `SELECT id FROM agro_producers
     WHERE company_odoo_id = $1 AND lower(name) = lower($2) AND active = 1
       AND id <> $3`,
    [companyId, name, current?.id || ''],
  );
  if (clash) throw new Error('Já existe um produtor com este nome');

  const links = await syncProducerLinks(
    companyId,
    name,
    phone,
    current?.partner_id || '',
    current?.contact_id || '',
  );
  const producerId = current?.id || randomUUID();
  if (!current) {
    await run(
      `INSERT INTO agro_producers(
         id, company_odoo_id, name, total_area, city, state, phone, partner_id, contact_id,
         active, created_at, updated_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,NOW(),NOW())`,
      [producerId, companyId, name, totalArea, city, state, phone, links.partnerId, links.contactId],
    );
  } else {
    await run(
      `UPDATE agro_producers SET
         name = $1, total_area = $2, city = $3, state = $4, phone = $5,
         partner_id = $6, contact_id = $7, updated_at = NOW()
       WHERE id = $8 AND company_odoo_id = $9`,
      [
        name, totalArea, city, state, phone, links.partnerId, links.contactId, producerId, companyId,
      ],
    );
    await run(
      `UPDATE agro_properties
       SET producer_name = $2, producer_partner_id = $3, updated_at = NOW()
       WHERE producer_id = $1 AND company_odoo_id = $4`,
      [producerId, name, links.partnerId, companyId],
    );
  }

  const settings = await listAgroSettings(companyId);
  const saved = settings.producers.find((item) => item.id === producerId);
  if (!saved) throw new Error('Não foi possível salvar o produtor');
  return saved;
}

export async function deleteAgroProducer(companyId: string, id: string): Promise<void> {
  await ensureAgroSchema();
  const properties = await one<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM agro_properties
     WHERE producer_id = $1 AND company_odoo_id = $2 AND active = 1`,
    [id, companyId],
  );
  if ((properties?.total || 0) > 0) {
    throw new Error('Remova as propriedades deste produtor antes de excluí-lo');
  }
  const updated = await one<{ id: string }>(
    `UPDATE agro_producers SET active = 0, updated_at = NOW()
     WHERE id = $1 AND company_odoo_id = $2 AND active = 1
     RETURNING id`,
    [id, companyId],
  );
  if (!updated) throw new Error('Produtor não encontrado');
}

export async function saveAgroProperty(
  companyId: string,
  input: Record<string, unknown>,
  id = '',
): Promise<AgroSettingsProperty> {
  await ensureAgroSchema();
  const producerId = clip(input.producerId, 80);
  const name = clip(input.name, 150);
  if (!producerId) throw new Error('Informe o produtor da propriedade');
  if (!name) throw new Error('Informe o nome da propriedade');
  const producer = await one<{ id: string; name: string; partner_id: string }>(
    `SELECT id, name, COALESCE(partner_id, '') AS partner_id
     FROM agro_producers WHERE id = $1 AND company_odoo_id = $2 AND active = 1`,
    [producerId, companyId],
  );
  if (!producer) throw new Error('Produtor não encontrado');

  const current = id
    ? await one<{ id: string }>(
        `SELECT id FROM agro_properties WHERE id = $1 AND company_odoo_id = $2 AND active = 1`,
        [id, companyId],
      )
    : undefined;
  if (id && !current) throw new Error('Propriedade não encontrada');

  const clash = await one<{ id: string }>(
    `SELECT id FROM agro_properties
     WHERE company_odoo_id = $1 AND lower(name) = lower($2) AND active = 1 AND id <> $3`,
    [companyId, name, current?.id || ''],
  );
  if (clash) throw new Error('Já existe uma propriedade com este nome');

  const propertyId = current?.id || randomUUID();
  if (!current) {
    await run(
      `INSERT INTO agro_properties(
         id, company_odoo_id, name, producer_name, producer_partner_id, producer_id,
         active, created_at, updated_at
       ) VALUES($1,$2,$3,$4,$5,$6,1,NOW(),NOW())`,
      [propertyId, companyId, name, producer.name, producer.partner_id, producer.id],
    );
  } else {
    await run(
      `UPDATE agro_properties SET
         name = $1, producer_id = $2, producer_name = $3, producer_partner_id = $4, updated_at = NOW()
       WHERE id = $5 AND company_odoo_id = $6`,
      [name, producer.id, producer.name, producer.partner_id, propertyId, companyId],
    );
  }

  const settings = await listAgroSettings(companyId);
  for (const item of settings.producers) {
    const property = item.properties.find((entry) => entry.id === propertyId);
    if (property) return property;
  }
  throw new Error('Não foi possível salvar a propriedade');
}

export async function deleteAgroProperty(companyId: string, id: string): Promise<void> {
  await ensureAgroSchema();
  const used = await one<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM agro_plantings WHERE property_id = $1 AND company_odoo_id = $2`,
    [id, companyId],
  );
  if ((used?.total || 0) > 0) {
    throw new Error('Esta propriedade tem plantios. Remova os plantios antes de excluí-la');
  }
  const plots = await one<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM agro_plots WHERE property_id = $1 AND active = 1`,
    [id],
  );
  if ((plots?.total || 0) > 0) {
    throw new Error('Remova os talhões desta propriedade antes de excluí-la');
  }
  const updated = await one<{ id: string }>(
    `UPDATE agro_properties SET active = 0, updated_at = NOW()
     WHERE id = $1 AND company_odoo_id = $2 AND active = 1
     RETURNING id`,
    [id, companyId],
  );
  if (!updated) throw new Error('Propriedade não encontrada');
}

export async function saveAgroPlot(
  companyId: string,
  input: Record<string, unknown>,
  id = '',
): Promise<AgroSettingsPlot & { propertyId: string }> {
  await ensureAgroSchema();
  const propertyId = clip(input.propertyId, 80);
  let code = clip(input.code, 40);
  const name = clip(input.name, 150);
  if (!propertyId) throw new Error('Informe a propriedade do talhão');
  if (!name) throw new Error('Informe o nome do talhão (ex.: Hortaliças)');
  const property = await one<{ id: string }>(
    `SELECT id FROM agro_properties WHERE id = $1 AND company_odoo_id = $2 AND active = 1`,
    [propertyId, companyId],
  );
  if (!property) throw new Error('Propriedade não encontrada');

  const area = parseOptionalQuantity(input.area, 'Área do talhão');

  const current = id
    ? await one<{ id: string; property_id: string; code: string }>(
        `SELECT id, property_id, COALESCE(code, '') AS code FROM agro_plots WHERE id = $1 AND active = 1`,
        [id],
      )
    : undefined;
  if (id && (!current || current.property_id !== propertyId)) {
    throw new Error('Talhão não encontrado nesta propriedade');
  }
  // Edição sem o campo na tela antiga: mantém o código já gravado.
  if (!code && current?.code) code = clip(current.code, 40);
  if (!code) throw new Error('Informe o código do talhão (ex.: 1 ou A1)');

  const codeClash = await one<{ id: string }>(
    `SELECT id FROM agro_plots
     WHERE property_id = $1 AND lower(code) = lower($2) AND active = 1 AND id <> $3`,
    [propertyId, code, current?.id || ''],
  );
  if (codeClash) throw new Error('Já existe um talhão com este código nesta propriedade');

  const nameClash = await one<{ id: string }>(
    `SELECT id FROM agro_plots
     WHERE property_id = $1 AND lower(name) = lower($2) AND active = 1 AND id <> $3`,
    [propertyId, name, current?.id || ''],
  );
  if (nameClash) throw new Error('Já existe um talhão com este nome nesta propriedade');

  const plotId = current?.id || randomUUID();
  if (!current) {
    await run(
      `INSERT INTO agro_plots(id, property_id, code, name, area, active, created_at, updated_at)
       VALUES($1, $2, $3, $4, $5, 1, NOW(), NOW())`,
      [plotId, propertyId, code, name, area],
    );
  } else {
    await run(
      `UPDATE agro_plots SET code = $1, name = $2, area = $3, updated_at = NOW() WHERE id = $4`,
      [code, name, area, plotId],
    );
  }
  return {
    id: plotId,
    propertyId,
    code,
    name,
    area,
    label: plotLabel(code, name),
  };
}

export async function deleteAgroPlot(companyId: string, id: string): Promise<void> {
  await ensureAgroSchema();
  const plot = await one<{ id: string; property_id: string }>(
    `SELECT pl.id, pl.property_id
     FROM agro_plots pl
     JOIN agro_properties pr ON pr.id = pl.property_id
     WHERE pl.id = $1 AND pr.company_odoo_id = $2 AND pl.active = 1`,
    [id, companyId],
  );
  if (!plot) throw new Error('Talhão não encontrado');
  const used = await one<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM agro_plantings WHERE plot_id = $1 AND company_odoo_id = $2`,
    [id, companyId],
  );
  if ((used?.total || 0) > 0) {
    throw new Error('Este talhão tem plantios. Remova os plantios antes de excluí-lo');
  }
  await run(`UPDATE agro_plots SET active = 0, updated_at = NOW() WHERE id = $1`, [id]);
}
