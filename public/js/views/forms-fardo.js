/** Fluxos de fardo na Prensagem (site + padrões do Bot). */

export function foldName(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ç/g, 'c')
    .trim();
}

/** `converter_bags` | `entrega_direta` | '' */
export function fardoFlowOf(presetOrHeader) {
  const flow = String(presetOrHeader?.fardo_flow || presetOrHeader?.header?.fardo_flow || '').trim();
  if (flow === 'converter_bags' || flow === 'entrega_direta') return flow;
  const name = foldName(presetOrHeader?.name || '');
  if (!name.includes('fardo')) return '';
  if (name.includes('entrega')) return 'entrega_direta';
  if (name.includes('converter') || name.includes('producao') || (name.includes('bag') && name.includes('convert'))) {
    return 'converter_bags';
  }
  const input = foldName(presetOrHeader?.header?.input_product || presetOrHeader?.input_product || '');
  if (input === 'fardo') return 'entrega_direta';
  if (input === 'bag') return 'converter_bags';
  return '';
}

export function findFardoPresets(presets) {
  const list = Array.isArray(presets) ? presets : [];
  const comBags =
    list.find((item) => fardoFlowOf(item) === 'converter_bags') ||
    list.find((item) => foldName(item.name).includes('converter') && foldName(item.name).includes('fardo'));
  const semBags =
    list.find((item) => fardoFlowOf(item) === 'entrega_direta') ||
    list.find((item) => foldName(item.name).includes('entrega') && foldName(item.name).includes('fardo'));
  return { comBags, semBags };
}

export function fardoPresetTemplates() {
  return {
    converter_bags: {
      name: 'Converter BAGS para Fardos',
      title: '',
      status: 'draft',
      header: {
        input_product: 'Bag',
        input_qty: '',
        input_uom: 'Unidade',
        fardo_flow: 'converter_bags',
      },
      lines: [{ values: { product: 'Fardo', quantity: '', uom: 'Unidade' } }],
      visible: {
        title: true,
        status: false,
        header: ['production_date', 'input_product', 'input_qty', 'input_uom'],
        lines: ['product', 'quantity', 'uom'],
      },
    },
    entrega_direta: {
      name: 'Entrega de Fardos',
      title: '',
      status: 'draft',
      header: {
        input_product: 'Fardo',
        input_qty: '',
        input_uom: 'Unidade',
        fardo_flow: 'entrega_direta',
      },
      lines: [{ values: { product: 'Fardo', quantity: '', uom: 'Unidade' } }],
      visible: {
        title: true,
        status: false,
        header: ['production_date', 'input_qty', 'input_uom'],
        lines: ['quantity', 'uom'],
      },
    },
  };
}

export function applyFardoDraftDefaults(draft, flow) {
  if (!draft?.header) return draft;
  if (flow === 'converter_bags') {
    draft.header.fardo_flow = 'converter_bags';
    draft.header.input_product = draft.header.input_product || 'Bag';
    draft.header.input_uom = draft.header.input_uom || 'Unidade';
    if (!draft.lines?.length) {
      draft.lines = [{ id: '', values: { product: 'Fardo', quantity: '', uom: 'Unidade' } }];
    }
  }
  if (flow === 'entrega_direta') {
    draft.header.fardo_flow = 'entrega_direta';
    draft.header.input_product = 'Fardo';
    draft.header.input_uom = draft.header.input_uom || 'Unidade';
    if (!draft.lines?.length) {
      draft.lines = [{ id: '', values: { product: 'Fardo', quantity: '', uom: 'Unidade' } }];
    } else {
      draft.lines = draft.lines.map((line) => ({
        ...line,
        values: { product: 'Fardo', uom: 'Unidade', ...(line.values || {}) },
      }));
    }
  }
  return draft;
}

export function fardoFlowLabel(flow) {
  if (flow === 'converter_bags') return 'com bags';
  if (flow === 'entrega_direta') return 'sem bags';
  return '';
}

export function fardoEditorSubtitle(flow) {
  if (flow === 'converter_bags') {
    return 'Converte bags em fardos: informe tipo, quantos bags saíram e quantos fardos entraram. Ao salvar, o Odoo consome Bag e gera Fardo.';
  }
  if (flow === 'entrega_direta') {
    return 'Entidade sem bags: informe o tipo e quantos fardos foram produzidos. Ao salvar, os fardos entram no estoque sem consumir bags.';
  }
  return '';
}
