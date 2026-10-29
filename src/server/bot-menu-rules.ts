import { KIND_LABELS, isFormKind, type FormKind } from './forms-fields.js';

// Menu numerado do WhatsApp: só guia até o formulário certo; a coleta segue no fluxo do questionário.

export type MenuAction = 'node' | 'register' | 'correct' | 'view' | 'human' | 'back';

export type MenuOption = {
  key: string;
  label: string;
  action: MenuAction;
  /** Nó de destino (action=node) ou questionário (register/correct/view). */
  target?: string;
  featured?: boolean;
};

export type MenuNode = {
  node: string;
  parent: string;
  title: string;
  options: MenuOption[];
};

export type MenuForm = {
  questionnaireId: string;
  kind: FormKind;
  name: string;
};

export type MenuCycleStatus = 'none' | 'open' | 'notified' | 'in_progress' | 'completed';

export type MenuCycle = {
  questionnaireId: string;
  status: MenuCycleStatus;
  answers: number;
  lastPromptedAt: string;
};

const KIND_ORDER: FormKind[] = ['purchase', 'product', 'production', 'sale'];

const KIND_ALIASES: Record<FormKind, string[]> = {
  purchase: ['compras', 'compra'],
  product: ['inventario', 'estoque'],
  production: ['fabricacao', 'prensagem'],
  sale: ['vendas', 'venda'],
};

const ACTION_ALIASES: Partial<Record<MenuAction, string[]>> = {
  human: ['atendente', 'humano', 'atendimento', 'pessoa'],
  back: ['voltar', 'volta'],
  register: ['registrar', 'responder', 'continuar', 'acrescentar', 'lancar'],
  correct: ['corrigir', 'correcao', 'editar'],
  view: ['ver', 'consultar', 'resumo'],
};

const YES_RE =
  /^(sim|s|pode|posso|vamos|bora|ok|okay|claro|quero|certo|isso|manda)( (sim|pode|posso|vamos|la|ja|claro|agora|responder))*$/;

export function foldMenuText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isMenuKeyword(inbound: string): boolean {
  return /^(menu|menu principal|abrir menu|ver menu|voltar ao menu|voltar pro menu|opcoes|ver opcoes|inicio)$/.test(
    foldMenuText(inbound),
  );
}

/** Nova sessão: nenhuma mensagem anterior do contato, ou a última é mais antiga que o intervalo. */
export function isNewMenuSession(previousInboundAt: string, nowMs: number, gapHours: number): boolean {
  if (!previousInboundAt) return true;
  const at = Date.parse(previousInboundAt);
  if (!Number.isFinite(at)) return true;
  return nowMs - at >= Math.max(0.25, gapHours) * 3_600_000;
}

/** Nome do padrão sem o prefixo “[Forms] Compras · ”. */
export function menuFormName(rawName: string, kind: FormKind): string {
  const withoutTag = String(rawName || '').replace(/^\[Forms\]\s*/i, '').trim();
  const prefix = `${KIND_LABELS[kind]} · `;
  const name = withoutTag.startsWith(prefix) ? withoutTag.slice(prefix.length).trim() : withoutTag;
  return name || KIND_LABELS[kind];
}

export function normalizeMenuForms(
  rows: Array<{ questionnaire_id: string; name: string; form_kind: string }>,
): MenuForm[] {
  return rows
    .filter((row) => isFormKind(String(row.form_kind || '')))
    .map((row) => {
      const kind = row.form_kind as FormKind;
      return { questionnaireId: row.questionnaire_id, kind, name: menuFormName(row.name, kind) };
    });
}

function cycleFor(cycles: MenuCycle[], questionnaireId: string): MenuCycle {
  return (
    cycles.find((item) => item.questionnaireId === questionnaireId) || {
      questionnaireId,
      status: 'none',
      answers: 0,
      lastPromptedAt: '',
    }
  );
}

function numbered(options: Omit<MenuOption, 'key'>[]): MenuOption[] {
  let index = 0;
  return options.map((option) => {
    if (option.action === 'back') return { ...option, key: '0' };
    index += 1;
    return { ...option, key: String(index) };
  });
}

function kindsOf(forms: MenuForm[]): FormKind[] {
  return KIND_ORDER.filter((kind) => forms.some((form) => form.kind === kind));
}

/** Menu principal: atalhos do dia (convite / em andamento) + tipos de formulário + atendente. */
export function buildMainMenu(input: {
  forms: MenuForm[];
  cycles: MenuCycle[];
  attendant: boolean;
  title: string;
}): MenuNode {
  const featured: Omit<MenuOption, 'key'>[] = [];
  for (const form of input.forms) {
    const cycle = cycleFor(input.cycles, form.questionnaireId);
    const kindLabel = KIND_LABELS[form.kind];
    if (cycle.status === 'in_progress') {
      featured.push({
        label: `Continuar ${kindLabel} de hoje (${form.name}) — em andamento`,
        action: 'register',
        target: form.questionnaireId,
        featured: true,
      });
    } else if (cycle.status === 'notified' && cycle.answers === 0) {
      featured.push({
        label: `Responder ${kindLabel} de hoje (${form.name})`,
        action: 'register',
        target: form.questionnaireId,
        featured: true,
      });
    }
  }
  const options: Omit<MenuOption, 'key'>[] = [
    ...featured.slice(0, 2),
    ...kindsOf(input.forms).map((kind) => ({
      label: KIND_LABELS[kind],
      action: 'node' as const,
      target: `kind:${kind}`,
    })),
  ];
  if (input.attendant) options.push({ label: 'Falar com um atendente', action: 'human' });
  return { node: 'main', parent: '', title: input.title, options: numbered(options) };
}

/** Tipo com vários padrões → escolhe o padrão; com um só → vai direto às ações dele. */
export function buildKindMenu(kind: FormKind, forms: MenuForm[], cycles: MenuCycle[]): MenuNode {
  const ofKind = forms.filter((form) => form.kind === kind);
  if (ofKind.length === 1) return buildFormMenu(ofKind[0], cycles, 'main');
  return {
    node: `kind:${kind}`,
    parent: 'main',
    title: `${KIND_LABELS[kind]} — escolha o formulário:`,
    options: numbered([
      ...ofKind.map((form) => ({
        label: `${form.name}${statusSuffix(cycleFor(cycles, form.questionnaireId))}`,
        action: 'node' as const,
        target: `form:${form.questionnaireId}`,
      })),
      { label: 'Voltar', action: 'back' as const },
    ]),
  };
}

export function buildFormMenu(form: MenuForm, cycles: MenuCycle[], parent: string): MenuNode {
  const cycle = cycleFor(cycles, form.questionnaireId);
  const kindLabel = KIND_LABELS[form.kind];
  const options: Omit<MenuOption, 'key'>[] = [];
  if (cycle.status === 'completed') {
    options.push({ label: 'Acrescentar itens ao registro de hoje', action: 'register', target: form.questionnaireId });
    options.push({ label: 'Corrigir o registro de hoje', action: 'correct', target: form.questionnaireId });
  } else if (cycle.status === 'in_progress') {
    options.push({ label: 'Continuar o registro de hoje', action: 'register', target: form.questionnaireId });
  } else {
    options.push({ label: `Registrar ${kindLabel.toLowerCase()} de hoje`, action: 'register', target: form.questionnaireId });
  }
  if (cycle.answers > 0) {
    options.push({ label: 'Ver o que registrei hoje', action: 'view', target: form.questionnaireId });
  }
  options.push({ label: 'Voltar', action: 'back' });
  return {
    node: `form:${form.questionnaireId}`,
    parent,
    title: `${kindLabel} · ${form.name} — ${statusLine(cycle)}`,
    options: numbered(options),
  };
}

function statusLine(cycle: MenuCycle): string {
  if (cycle.status === 'completed') return 'registro de hoje concluído.';
  if (cycle.status === 'in_progress') return 'registro de hoje em andamento.';
  return 'ainda sem registro hoje.';
}

function statusSuffix(cycle: MenuCycle): string {
  if (cycle.status === 'completed') return ' (concluído hoje)';
  if (cycle.status === 'in_progress') return ' (em andamento)';
  return '';
}

export function formatMenu(node: MenuNode, options: { greeting?: string; hint?: string } = {}): string {
  const lines = node.options
    .filter((option) => option.action !== 'back')
    .map((option) => `${option.key}) ${option.label}`);
  const back = node.options.find((option) => option.action === 'back');
  if (back) lines.push(`0) ${back.label}`);
  const footer =
    node.node === 'main'
      ? 'Responda com o número da opção. Digite *menu* a qualquer momento para voltar aqui.'
      : 'Responda com o número da opção.';
  const header = [options.greeting, node.title].filter(Boolean).join(' ');
  return [...(options.hint ? [options.hint] : []), header, '', ...lines, '', footer].join('\n');
}

/** Opção escolhida por número, nome ou “sim” (aceita o atalho do dia no menu principal). */
export function matchMenuOption(inbound: string, node: MenuNode): MenuOption | undefined {
  const folded = foldMenuText(inbound);
  if (!folded) return undefined;

  const number = /^(?:opcao\s*|op\s*|n\s*)?(\d{1,2})$/.exec(folded)?.[1];
  if (number !== undefined) return node.options.find((option) => option.key === String(Number(number)));

  const words = ` ${folded} `;
  const hits = node.options.filter((option) => {
    const aliases = [foldMenuText(option.label), ...optionAliases(option)].filter(Boolean);
    return aliases.some((alias) => folded === alias || words.includes(` ${alias} `));
  });
  if (hits.length === 1) return hits[0];
  // “compras” no menu principal casa com o atalho do dia e com o tipo: o tipo vence.
  const nonFeatured = hits.filter((option) => !option.featured);
  if (nonFeatured.length === 1) return nonFeatured[0];

  if (node.node === 'main' && YES_RE.test(folded)) {
    return node.options.find((option) => option.featured);
  }
  return undefined;
}

function optionAliases(option: MenuOption): string[] {
  if (option.action === 'node' && option.target?.startsWith('kind:')) {
    const kind = option.target.slice('kind:'.length);
    return isFormKind(kind) ? KIND_ALIASES[kind] : [];
  }
  if (option.featured) return [];
  return ACTION_ALIASES[option.action] || [];
}

/** Texto curto que não é opção: reapresenta o menu em vez de mandar ao agente livre. */
export function isShortMenuReply(inbound: string): boolean {
  const folded = foldMenuText(inbound);
  return Boolean(folded) && folded.split(' ').length <= 3;
}

export function menuGreeting(contactName: string, minutes: number): string {
  const hello = minutes < 12 * 60 ? 'Bom dia' : minutes < 18 * 60 ? 'Boa tarde' : 'Boa noite';
  const first = String(contactName || '').trim().split(/\s+/)[0] || '';
  const usable = first && /[a-zA-ZÀ-ÿ]/.test(first) && !/\d/.test(first);
  return usable ? `${hello}, ${first}!` : `${hello}!`;
}
