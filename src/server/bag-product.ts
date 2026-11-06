import { BAG_MATERIALS, type BagMaterial } from './bag-materials.js';
import { odooCreate, odooExecuteKw, odooSearchRead, odooWrite } from './odoo-client.js';

const BAG_PRODUCT_NAME = 'Bag';
const FARDO_PRODUCT_NAME = 'Fardo';
const BAG_ATTRIBUTE_NAME = 'Tipo de Bag';

export type BagVariantRef = { templateId: number; variantId: number };

const variantsByCompany = new Map<number, Map<string, BagVariantRef>>();
const fardoVariantsByCompany = new Map<number, Map<string, BagVariantRef>>();
let ensuring: Promise<void> | null = null;

/** Um produto Bag e um produto Fardo, cada um com um tipo (variante) por sigla. */
export function ensureBagMaterials(companyId: number): Promise<void> {
  if (ensuring) return ensuring;
  ensuring = writeBagProduct(companyId).finally(() => {
    ensuring = null;
  });
  return ensuring;
}

export function bagVariantRef(companyId: number, code: string): BagVariantRef | undefined {
  return variantsByCompany.get(companyId)?.get(variantCode(code));
}

export function fardoVariantRef(companyId: number, code: string): BagVariantRef | undefined {
  return fardoVariantsByCompany.get(companyId)?.get(variantCode(code));
}

function variantCode(code: string): string {
  return String(code || '').trim().toUpperCase();
}

async function writeBagProduct(companyId: number): Promise<void> {
  if (!companyId) throw new Error('Empresa do Odoo obrigatória para cadastrar o Bag');
  const uomId = await findUnitId();
  if (!uomId) throw new Error('Cadastre a unidade de medida Unidade no Odoo antes dos bags');
  await removeStandaloneTypes(companyId);
  const attributeId = await ensureBagAttribute();
  const valueByCode = await ensureBagValues(attributeId);
  const valueIds = [...valueByCode.values()];
  const bagId = await ensureNamedTemplate(companyId, BAG_PRODUCT_NAME, uomId, attributeId, valueIds);
  const fardoId = await ensureNamedTemplate(companyId, FARDO_PRODUCT_NAME, uomId, attributeId, valueIds);
  await assignVariantCodes(bagId, valueByCode, variantsByCompany, companyId);
  await assignVariantCodes(fardoId, valueByCode, fardoVariantsByCompany, companyId);
}

async function removeStandaloneTypes(companyId: number): Promise<void> {
  const rows = await odooExecuteKw<Array<{ id: number; name: string }>>('product.template', 'search_read', [
    [
      ['company_id', '=', companyId],
      ['default_code', 'in', BAG_MATERIALS.map((item) => item.code)],
      ['name', '!=', BAG_PRODUCT_NAME],
    ],
    ['name'],
  ], { context: { active_test: false }, limit: 50 });
  const ids = rows.map((row) => row.id);
  if (!ids.length) return;
  try {
    await odooExecuteKw('product.template', 'unlink', [ids]);
  } catch {
    for (const id of ids) {
      await odooWrite('product.template', [id], { active: false, default_code: false });
    }
  }
}

async function findUnitId(): Promise<number> {
  const rows = await odooSearchRead<{ id: number; relative_uom_id: unknown }>(
    'uom.uom',
    [['name', '=', 'Unidade']],
    ['relative_uom_id'],
    { limit: 5 },
  );
  const own = rows.find((row) => !row.relative_uom_id);
  return own?.id || rows[0]?.id || 0;
}

function typeLabel(material: BagMaterial): string {
  return material.name === material.code ? material.code : `${material.code} ${material.name}`;
}

async function ensureBagAttribute(): Promise<number> {
  const [found] = await odooSearchRead<{ id: number }>('product.attribute', [['name', '=', BAG_ATTRIBUTE_NAME]], ['id'], {
    limit: 1,
  });
  if (found?.id) return found.id;
  return odooCreate('product.attribute', {
    name: BAG_ATTRIBUTE_NAME,
    create_variant: 'always',
    display_type: 'select',
  });
}

async function ensureBagValues(attributeId: number): Promise<Map<string, number>> {
  const labels = BAG_MATERIALS.map(typeLabel);
  const existing = await odooSearchRead<{ id: number; name: string }>(
    'product.attribute.value',
    [['attribute_id', '=', attributeId], ['name', 'in', labels]],
    ['name'],
    { limit: 50 },
  );
  const byName = new Map(existing.map((row) => [row.name, row.id]));
  const byCode = new Map<string, number>();
  for (const material of BAG_MATERIALS) {
    const label = typeLabel(material);
    let id = byName.get(label) || 0;
    if (!id) id = await odooCreate('product.attribute.value', { name: label, attribute_id: attributeId });
    byCode.set(material.code, id);
  }
  return byCode;
}

async function ensureNamedTemplate(
  companyId: number,
  productName: string,
  uomId: number,
  attributeId: number,
  valueIds: number[],
): Promise<number> {
  const values = {
    name: productName,
    uom_id: uomId,
    type: 'consu',
    is_storable: true,
    company_id: companyId,
    active: true,
    default_code: false,
  };
  const [found] = await odooExecuteKw<Array<{ id: number }>>('product.template', 'search_read', [
    [['name', '=', productName], ['company_id', '=', companyId]],
    ['id'],
  ], { context: { active_test: false }, limit: 1 });
  const lineValues = { attribute_id: attributeId, value_ids: [[6, 0, valueIds]] };
  if (!found?.id) {
    return odooCreate('product.template', {
      ...values,
      attribute_line_ids: [[0, 0, lineValues]],
    });
  }
  await odooWrite('product.template', [found.id], values);
  const [line] = await odooSearchRead<{ id: number }>(
    'product.template.attribute.line',
    [['product_tmpl_id', '=', found.id], ['attribute_id', '=', attributeId]],
    ['id'],
    { limit: 1 },
  );
  await odooWrite('product.template', [found.id], {
    attribute_line_ids: line?.id ? [[1, line.id, { value_ids: lineValues.value_ids }]] : [[0, 0, lineValues]],
  });
  return found.id;
}

async function assignVariantCodes(
  templateId: number,
  valueByCode: Map<string, number>,
  target: Map<number, Map<string, BagVariantRef>>,
  companyId: number,
): Promise<void> {
  const variants = await odooSearchRead<{ id: number; product_template_attribute_value_ids: number[] }>(
    'product.product',
    [['product_tmpl_id', '=', templateId]],
    ['product_template_attribute_value_ids'],
    { limit: 50 },
  );
  const ptavIds = variants.flatMap((row) => row.product_template_attribute_value_ids || []);
  const ptavs = ptavIds.length
    ? await odooSearchRead<{ id: number; name: string; product_attribute_value_id: unknown }>(
        'product.template.attribute.value',
        [['id', 'in', ptavIds]],
        ['name', 'product_attribute_value_id'],
        { limit: 50 },
      )
    : [];
  const codeByValue = new Map<number, string>();
  for (const [code, valueId] of valueByCode) codeByValue.set(valueId, code);
  const codeByPtav = new Map<number, string>();
  for (const row of ptavs) {
    const valueId = Array.isArray(row.product_attribute_value_id) ? Number(row.product_attribute_value_id[0]) : 0;
    const code = codeByValue.get(valueId) || BAG_MATERIALS.find((item) => typeLabel(item) === row.name)?.code;
    if (code) codeByPtav.set(row.id, code);
  }
  const refs = new Map<string, BagVariantRef>();
  for (const variant of variants) {
    const code = (variant.product_template_attribute_value_ids || []).map((id) => codeByPtav.get(id)).find(Boolean);
    if (!code) continue;
    await odooWrite('product.product', [variant.id], { default_code: code });
    refs.set(code, { templateId, variantId: variant.id });
  }
  target.set(companyId, refs);
}
