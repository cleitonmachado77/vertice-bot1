import { AGRO_BOT_KINDS, AGRO_BOT_LABELS, isAgroBotKind } from './agro-bot-fields.js';
import { KIND_LABELS, isFormKind } from './forms-fields.js';

// Menu numerado do WhatsApp: só guia até o formulário certo; a coleta segue no fluxo do questionário.

export type MenuAction = 'node' | 'register' | 'correct' | 'view' | 'human' | 'back' | 'catalog';

export type MenuOption = {
  key: string;
  label: string;
  action: MenuAction;
  /** Nó de destino (action=node) ou questionário (register/correct/view). */
  target?: string;
};

export type MenuNode = {
  node: string;
  parent: string;
  title: string;
  options: MenuOption[];
};

export type MenuForm = {
  questionnaireId: string;
  kind: string;
  name: string;
};

export function menuKindLabel(kind: string): string {
  if (isFormKind(kind)) return KIND_LABELS[kind];
  if (isAgroBotKind(kind)) return AGRO_BOT_LABELS[kind];
  return kind;
}

export function isMenuFormKind(kind: string): boolean {
  return isFormKind(kind) || isAgroBotKind(kind);
}

export type MenuCycleStatus = 'none' | 'open' | 'notified' | 'in_progress' | 'completed';

export type MenuCycle = {
  questionnaireId: string;
  status: MenuCycleStatus;
  answers: number;
  lastPromptedAt: string;
};

const KIND_ORDER = ['purchase', 'product', 'production', 'sale', ...AGRO_BOT_KINDS];

export function foldMenuText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type OpenQuestion = 'menu' | 'agenda' | 'form' | 'none';

/**
 * Uma pergunta aberta recebe a próxima mensagem.
 * Agenda e formulário vencem o menu salvo; sem pergunta, o menu aparece.
 */
export function classifyOpenQuestion(input: {
  menuOpen: boolean;
  agendaOpen: boolean;
  formOpen: boolean;
}): OpenQuestion {
  if (input.agendaOpen) return 'agenda';
  if (input.menuOpen) return 'menu';
  if (input.formOpen) return 'form';
  return 'none';
}

/** Ciclo preso na conversa ainda espera a resposta de uma pergunta. */
export function formCollectionIsOpen(input: {
  cycleId: string;
  status: string;
  superseded: boolean;
  awaiting: number;
  pendingQuestionId: string;
  /** Data do ciclo (YYYY-MM-DD). Fora do dia de hoje não recebe resposta. */
  occurrenceDate?: string;
  today?: string;
}): boolean {
  if (!input.cycleId || input.superseded || input.awaiting === 1) return false;
  if (
    input.occurrenceDate &&
    input.today &&
    input.occurrenceDate < input.today &&
    input.awaiting !== 2
  ) {
    return false;
  }
  if (input.awaiting === 2) return true;
  if (input.status === 'completed' || input.status === 'failed') return false;
  if (input.status === 'in_progress') return true;
  return Boolean(input.pendingQuestionId) && ['open', 'notified', 'sending'].includes(input.status);
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

/** Prefixos antigos de tela (antes do rename Recebimento/Separação/…). */
const LEGACY_KIND_LABELS: Record<string, string[]> = {
  purchase: ['Recebimento', 'Compras'],
  product: ['Separação', 'Inventário', 'Inventario'],
  production: ['Prensagem', 'Fabricação', 'Fabricacao'],
  sale: ['Entrega', 'Vendas'],
};

/** Nome do padrão sem o prefixo “[Forms] Recebimento · ”. */
export function menuFormName(rawName: string, kind: string): string {
  const withoutTag = String(rawName || '')
    .replace(/^\[(Forms|Agro)\]\s*/i, '')
    .trim();
  const labels = LEGACY_KIND_LABELS[kind] || [menuKindLabel(kind)];
  for (const label of labels) {
    const prefix = `${label} · `;
    if (withoutTag.startsWith(prefix)) return withoutTag.slice(prefix.length).trim() || menuKindLabel(kind);
  }
  return withoutTag || menuKindLabel(kind);
}

export function normalizeMenuForms(
  rows: Array<{ questionnaire_id: string; name: string; form_kind: string }>,
): MenuForm[] {
  return rows
    .filter((row) => isMenuFormKind(String(row.form_kind || '')))
    .map((row) => {
      const kind = row.form_kind;
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

/** Padrões na ordem das telas (Recebimento, Separação, Prensagem, Entrega), sem mostrar o nome da tela. */
function formsInMenuOrder(forms: MenuForm[]): MenuForm[] {
  return KIND_ORDER.flatMap((kind) => forms.filter((form) => form.kind === kind));
}

function isRsuMenuKind(kind: string): boolean {
  return isFormKind(kind);
}

/**
 * Menu principal: separa Agro e RSU quando os dois existem; consultas Agro no fim.
 */
export function buildMainMenu(input: {
  forms: MenuForm[];
  cycles: MenuCycle[];
  attendant: boolean;
  title: string;
}): MenuNode {
  const agro = input.forms.filter((form) => isAgroBotKind(form.kind));
  const rsu = input.forms.filter((form) => isRsuMenuKind(form.kind));
  const options: Omit<MenuOption, 'key'>[] = [];

  if (agro.length && rsu.length) {
    options.push({ label: 'Vertice Agro', action: 'node', target: 'group:agro' });
    options.push({ label: 'Vertice RSU', action: 'node', target: 'group:rsu' });
  } else {
    for (const form of formsInMenuOrder(input.forms)) {
      options.push({
        label: form.name,
        action: 'node',
        target: `form:${form.questionnaireId}`,
      });
    }
  }

  if (agro.length) {
    options.push({ label: 'Listar produtos', action: 'catalog', target: 'products' });
    options.push({ label: 'Listar fornecedores', action: 'catalog', target: 'producers' });
    options.push({ label: 'Listar áreas (talhões)', action: 'catalog', target: 'plots' });
  }

  if (input.attendant) options.push({ label: 'Falar com um atendente', action: 'human' });
  return { node: 'main', parent: '', title: input.title, options: numbered(options) };
}

export function buildGroupMenu(
  group: 'agro' | 'rsu',
  forms: MenuForm[],
  cycles: MenuCycle[],
): MenuNode {
  const ofGroup =
    group === 'agro'
      ? forms.filter((form) => isAgroBotKind(form.kind))
      : forms.filter((form) => isRsuMenuKind(form.kind));
  return {
    node: `group:${group}`,
    parent: 'main',
    title: group === 'agro' ? 'Vértice Agro — escolha:' : 'Vértice RSU — escolha:',
    options: numbered([
      ...formsInMenuOrder(ofGroup).map((form) => ({
        label: form.name,
        action: 'node' as const,
        target: `form:${form.questionnaireId}`,
      })),
      { label: 'Voltar', action: 'back' as const },
    ]),
  };
}

/** Só há uma ação útil (registrar): entra direto no formulário em vez de mostrar submenu de 1 item. */
export function singleRegisterOption(node: MenuNode): MenuOption | undefined {
  const actions = node.options.filter((option) => option.action !== 'back');
  return actions.length === 1 && actions[0].action === 'register' ? actions[0] : undefined;
}

/** Tipo com vários padrões → escolhe o padrão; com um só → vai direto às ações dele. */
export function buildKindMenu(kind: string, forms: MenuForm[], cycles: MenuCycle[]): MenuNode {
  const ofKind = forms.filter((form) => form.kind === kind);
  if (ofKind.length === 1) return buildFormMenu(ofKind[0], cycles, 'main');
  return {
    node: `kind:${kind}`,
    parent: 'main',
    title: `${menuKindLabel(kind)} — escolha o formulário:`,
    options: numbered([
      ...ofKind.map((form) => ({
        label: form.name,
        action: 'node' as const,
        target: `form:${form.questionnaireId}`,
      })),
      { label: 'Voltar', action: 'back' as const },
    ]),
  };
}

export function buildFormMenu(form: MenuForm, cycles: MenuCycle[], parent: string): MenuNode {
  const cycle = cycleFor(cycles, form.questionnaireId);
  const kindLabel = menuKindLabel(form.kind);
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
    title: `${kindLabel} · ${form.name}`,
    options: numbered(options),
  };
}

export function formatMenu(node: MenuNode, options: { greeting?: string; hint?: string } = {}): string {
  const lines = node.options
    .filter((option) => option.action !== 'back')
    .map((option) => `${option.key}) ${option.label}`);
  const back = node.options.find((option) => option.action === 'back');
  if (back) lines.push(`0) ${back.label}`);
  const footer =
    node.node === 'main'
      ? 'Digite o número da opção. Digite *menu* a qualquer momento para voltar aqui.'
      : 'Digite o número da opção.';
  const header = [options.greeting, node.title].filter(Boolean).join(' ');
  return [...(options.hint ? [options.hint] : []), header, '', ...lines, '', footer].join('\n');
}

/** A mensagem inteira é o número da opção. Nome, “sim” e “opção 3” não escolhem. */
export function matchMenuOption(inbound: string, node: MenuNode): MenuOption | undefined {
  const folded = foldMenuText(inbound);
  if (!/^\d{1,2}$/.test(folded)) return undefined;
  return node.options.find((option) => option.key === String(Number(folded)));
}

export function menuGreeting(contactName: string, minutes: number): string {
  const hello = minutes < 12 * 60 ? 'Bom dia' : minutes < 18 * 60 ? 'Boa tarde' : 'Boa noite';
  const first = String(contactName || '').trim().split(/\s+/)[0] || '';
  const usable = first && /[a-zA-ZÀ-ÿ]/.test(first) && !/\d/.test(first);
  return usable ? `${hello}, ${first}!` : `${hello}!`;
}
