/**
 * Contrato dos menus RSU de bag/fardo no WhatsApp e nos seeds.
 * Novas entidades devem clonar estes IDs (Recicla Brasil) para manter o mesmo formato.
 *
 * Ordem no submenu Vértice RSU (por kind):
 *   purchase → product → production → sale
 *
 * Produção traz dois padrões (com bags e sem bags), na ordem abaixo.
 */
export const RSU_BAG_SEPARATION_PRESET_ID = '34673f79-a413-4832-940e-7f6427c9e070';
export const RSU_FARDO_CONVERTER_PRESET_ID = 'be8a792d-97e5-4d71-a54d-c3e51e667ed5';
export const RSU_FARDO_ENTREGA_PRESET_ID = 'a7e2be06-b04f-4c9d-85ee-a8d27630f460';
export const RSU_FARDO_VENDA_PRESET_ID = 'ff297445-83fb-4dc2-89f8-3b30976a5d95';
export const RSU_RECEBIMENTO_PRESET_ID = '368672c7-ea66-46d5-ba6f-123753f4683a';

export const RSU_FARDO_MENU_NAMES = {
  converter: 'Converter BAGS para Fardos',
  entrega: 'Entrega de Fardos',
  venda: 'Venda de Fardos',
  separacao: 'Separação de Bags',
  recebimento: 'Recebimento de Materiais',
} as const;

/**
 * Fontes canônicas para seed de entidades RSU.
 * Manter esta ordem: Separação → Converter → Entrega → Venda → Recebimento.
 * (A ordem no menu do Bot ainda segue KIND_ORDER; esta lista é só o pacote a clonar.)
 */
export const RSU_SOURCE_PRESET_IDS = [
  RSU_BAG_SEPARATION_PRESET_ID,
  RSU_FARDO_CONVERTER_PRESET_ID,
  RSU_FARDO_ENTREGA_PRESET_ID,
  RSU_FARDO_VENDA_PRESET_ID,
  RSU_RECEBIMENTO_PRESET_ID,
] as const;

const NAME_BY_SOURCE_ID: Record<string, string> = {
  [RSU_BAG_SEPARATION_PRESET_ID]: RSU_FARDO_MENU_NAMES.separacao,
  [RSU_FARDO_CONVERTER_PRESET_ID]: RSU_FARDO_MENU_NAMES.converter,
  [RSU_FARDO_ENTREGA_PRESET_ID]: RSU_FARDO_MENU_NAMES.entrega,
  [RSU_FARDO_VENDA_PRESET_ID]: RSU_FARDO_MENU_NAMES.venda,
  [RSU_RECEBIMENTO_PRESET_ID]: RSU_FARDO_MENU_NAMES.recebimento,
};

/** Nome canônico do padrão no menu — seeds devem usar isto ao clonar. */
export function canonicalRsuPresetName(sourceId: string, fallback = ''): string {
  return NAME_BY_SOURCE_ID[String(sourceId || '')] || String(fallback || '').trim();
}

/** Prévia do menu numerado (admin) — espelha o pacote RSU bag/fardo. */
export function rsuFardoMenuPreviewLines(options: { attendant?: boolean } = {}): string[] {
  const lines = [
    `1) ${RSU_FARDO_MENU_NAMES.separacao}`,
    `2) ${RSU_FARDO_MENU_NAMES.converter}`,
    `3) ${RSU_FARDO_MENU_NAMES.entrega}`,
    `4) ${RSU_FARDO_MENU_NAMES.venda}`,
  ];
  if (options.attendant) lines.push('5) Falar com um atendente');
  return lines;
}
