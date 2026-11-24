import { listAgroCatalog } from './agro-catalog.js';
import { many } from './db.js';
import { foldText } from './questionnaire-rules.js';
import { plotLabel } from './agro-resolve.js';

const PAGE = 12;

export type AgroCatalogKind = 'products' | 'producers' | 'plots';

export function isAgroCatalogKind(value: string): value is AgroCatalogKind {
  return value === 'products' || value === 'producers' || value === 'plots';
}

export async function formatAgroCatalogList(
  companyId: string,
  kind: AgroCatalogKind,
  page = 0,
): Promise<string> {
  const offset = Math.max(0, page) * PAGE;
  if (kind === 'products') {
    const catalog = await listAgroCatalog(companyId);
    const items = (catalog.products || [])
      .map((item) => {
        const sigla = String(item.sigla || '').trim();
        const name = String(item.name || '').trim();
        return sigla ? `${sigla} — ${name}` : name;
      })
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, 'pt-BR'));
    return pageList('Produtos (sigla)', items, offset);
  }
  if (kind === 'producers') {
    const catalog = await listAgroCatalog(companyId);
    const items = (catalog.producers || [])
      .map((item) => String(item.name || '').trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, 'pt-BR'));
    return pageList('Fornecedores (produtores)', items, offset);
  }
  const rows = await many<{ code: string; name: string; property_name: string }>(
    `SELECT COALESCE(pl.code, '') AS code, pl.name, pr.name AS property_name
     FROM agro_plots pl
     JOIN agro_properties pr ON pr.id = pl.property_id
     WHERE pr.company_odoo_id = $1 AND pl.active = 1 AND pr.active = 1
     ORDER BY lower(COALESCE(NULLIF(pl.code, ''), pl.name)), lower(pl.name)`,
    [companyId],
  );
  const items = rows.map((row) => {
    const label = plotLabel(row.code, row.name);
    return `${label} · ${row.property_name}`;
  });
  return pageList('Áreas (talhões)', items, offset);
}

function pageList(title: string, items: string[], offset: number): string {
  if (!items.length) return `${title}: nenhum cadastro encontrado.`;
  const slice = items.slice(offset, offset + PAGE);
  const lines = slice.map((item, index) => `${offset + index + 1}. ${item}`);
  const more =
    offset + PAGE < items.length
      ? `\n… e mais ${items.length - offset - PAGE}. Peça “listar ${title.toLowerCase()}” de novo ou abra o menu.`
      : '';
  return [`${title} (${items.length}):`, ...lines].join('\n') + more;
}

/** Pedido em texto livre durante o formulário Agro. */
export function matchAgroCatalogAsk(inbound: string): AgroCatalogKind | null {
  const text = foldText(inbound);
  if (!text || text.length < 4) return null;
  const wantsList =
    /(lista|listar|opcoes|quais|mostra|mostrar|cadastrad|disponiveis)/.test(text) ||
    /\blistar\b/.test(text);
  if (!wantsList) return null;
  if (/(produto|produtos|sigla|cultura)/.test(text)) return 'products';
  if (/(fornecedor|fornecedores|produtor|produtores)/.test(text)) return 'producers';
  if (/(area|areas|talhao|talhoes|lote)/.test(text)) return 'plots';
  return null;
}

export function agroLineExample(kind: string): string {
  if (kind === 'agro_plantio') {
    return 'Exemplo de uma linha completa: INH; 6; 5000\n(produto; área/talhão; quantidade plantada)';
  }
  if (kind === 'agro_colheita') {
    return 'Exemplo de uma linha completa: INH; 6; 200\n(produto; área; quantidade colhida)';
  }
  if (kind === 'agro_entrega') {
    return 'Exemplo de uma linha completa: INH; 100; Sacolão\n(produto; quantidade; local de entrega)';
  }
  if (kind === 'agro_custo') {
    return 'Exemplo de uma linha completa: adubo; 150; 6\n(nome do custo; quantidade/valor; área)';
  }
  return '';
}
