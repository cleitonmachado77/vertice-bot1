import { KIND_LABELS, isFormKind, type FormKind } from './forms-fields.js';

// Menu numerado do WhatsApp: só guia até o formulário certo; a coleta segue no fluxo do questionário.

export type MenuAction = 'node' | 'register' | 'correct' | 'view' | 'human' | 'back';

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
}): boolean {
  if (!input.cycleId || input.superseded || input.awaiting === 1) return false;
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

/** Padrões na ordem das telas (Compras, Inventário, Fabricação, Vendas), sem mostrar o nome da tela. */
function formsInMenuOrder(forms: MenuForm[]): MenuForm[] {
  return KIND_ORDER.flatMap((kind) => forms.filter((form) => form.kind === kind));
}

/**
 * Menu principal: um item por padrão (nome que demos a ele) + atendente.
 * Sem rótulo de estado do dia: o usuário pode enviar informações quantas vezes quiser.
 */
export function buildMainMenu(input: {
  forms: MenuForm[];
  cycles: MenuCycle[];
  attendant: boolean;
  title: string;
}): MenuNode {
  const options: Omit<MenuOption, 'key'>[] = formsInMenuOrder(input.forms).map((form) => ({
    label: form.name,
    action: 'node' as const,
    target: `form:${form.questionnaireId}`,
  }));
  if (input.attendant) options.push({ label: 'Falar com um atendente', action: 'human' });
  return { node: 'main', parent: '', title: input.title, options: numbered(options) };
}

/** Só há uma ação útil (registrar): entra direto no formulário em vez de mostrar submenu de 1 item. */
export function singleRegisterOption(node: MenuNode): MenuOption | undefined {
  const actions = node.options.filter((option) => option.action !== 'back');
  return actions.length === 1 && actions[0].action === 'register' ? actions[0] : undefined;
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
