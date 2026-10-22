import {
  clearCookie,
  getSessionUser,
  mePayload,
  passwordOk,
  requireAdm,
  requireAuth,
  sessionCookie,
} from './auth.js';
import { getSetting, setSetting } from './db.js';
import { json, route, type Ctx } from './http.js';
import { NevoaError, nevoaRequest, sendWhatsappText } from './nevoa.js';
import { listAgentModels, previewReply } from './agent.js';
import { syncContactsAndConversations, syncConversationMessages } from './sync.js';
import {
  dashboardCounts,
  getConversation,
  listContacts,
  listConversations,
  listEvents,
  listMessages,
  setAwaitingHuman,
  setHumanHandoff,
  setHumanUnread,
} from './store.js';
import { hideConversation } from './conversation-visibility.js';
import {
  listApprovedTemplates,
  resolveFirstContactTemplate,
  sendFirstContactTemplate,
} from './first-contact.js';
import { getSessionGate, recordOutbound } from './thread.js';
import {
  authenticateUser,
  createUser,
  deleteUser,
  ensureBootstrapAdmin,
  getUserByEmail,
  listUsers,
  toPublicUser,
  updateUser,
  type UserRole,
} from './users.js';
import { DEFAULT_COMPANY_ODOO_ID, listCompanies, setActiveCompanyId } from './forms-companies.js';
import { env } from './env.js';

async function requireUser(ctx: Ctx): Promise<boolean> {
  return Boolean(await requireAuth(ctx));
}

function body(ctx: Ctx): Record<string, unknown> {
  return ctx.body && typeof ctx.body === 'object' ? (ctx.body as Record<string, unknown>) : {};
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function mask(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

async function guard<T>(ctx: Ctx, action: () => Promise<T>): Promise<void> {
  try {
    json(ctx.res, 200, await action());
  } catch (error) {
    if (error instanceof NevoaError) {
      json(ctx.res, error.status, { error: error.message, details: error.payload });
      return;
    }
    const message = error instanceof Error ? error.message : 'Erro interno';
    json(ctx.res, 500, { error: message });
  }
}

export function registerPanelRoutes(): void {
  route('POST', '/api/login', async (ctx) => {
    const input = body(ctx);
    const email = text(input.email).trim();
    const password = text(input.password);
    const secure = ctx.req.headers['x-forwarded-proto'] === 'https';

    await ensureBootstrapAdmin();

    let user = email ? await authenticateUser(email, password) : null;

    // Compat: senha única do painel (sem e-mail) entra como ADM bootstrap.
    if (!user && !email && passwordOk(password)) {
      const adminEmail = text(env('PANEL_ADMIN_EMAIL', 'admin@vertice.local')).toLowerCase();
      const existing = await getUserByEmail(adminEmail);
      user = existing ? toPublicUser(existing) : null;
    }

    if (!user) {
      json(ctx.res, 401, { error: 'E-mail ou senha incorretos' });
      return;
    }

    // ADM entra sempre com Reciclarenda (visão consolidada no dashboard).
    if (user.role === 'adm') {
      try {
        await setActiveCompanyId(DEFAULT_COMPANY_ODOO_ID);
      } catch {
        await setSetting('odoo_active_company_id', DEFAULT_COMPANY_ODOO_ID);
      }
    }

    ctx.res.setHeader('set-cookie', sessionCookie(user.id, secure));
    json(ctx.res, 200, { ok: true, ...mePayload(user) });
  });

  route('POST', '/api/logout', async (ctx) => {
    ctx.res.setHeader('set-cookie', clearCookie());
    json(ctx.res, 200, { ok: true });
  });

  route('GET', '/api/me', async (ctx) => {
    const user = await getSessionUser(ctx.req.headers.cookie);
    json(ctx.res, 200, mePayload(user));
  });

  route('PUT', '/api/me', async (ctx) => {
    const user = await requireAuth(ctx);
    if (!user) return;
    if (user.id === 'legacy') {
      json(ctx.res, 400, { error: 'Faça login com um usuário para salvar o WhatsApp' });
      return;
    }
    try {
      const input = body(ctx);
      const patch: Parameters<typeof updateUser>[1] = {};
      if (typeof input.whatsappPhone === 'string' || typeof input.phone === 'string') {
        patch.whatsappPhone = text(input.whatsappPhone || input.phone);
      }
      if (typeof input.name === 'string' && input.name.trim()) patch.name = input.name;
      if (!Object.keys(patch).length) {
        json(ctx.res, 400, { error: 'Nada para atualizar' });
        return;
      }
      const updated = await updateUser(user.id, patch);
      json(ctx.res, 200, { ok: true, ...mePayload(updated) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao atualizar perfil';
      json(ctx.res, 400, { error: message });
    }
  });

  route('GET', '/api/users', async (ctx) => {
    if (!(await requireAdm(ctx))) return;
    const [items, companies] = await Promise.all([listUsers(), listCompanies()]);
    json(ctx.res, 200, { items, companies });
  });

  route('POST', '/api/users', async (ctx) => {
    if (!(await requireAdm(ctx))) return;
    try {
      const input = body(ctx);
      const role = (text(input.role, 'user') === 'adm' ? 'adm' : 'user') as UserRole;
      const user = await createUser({
        email: text(input.email),
        name: text(input.name),
        password: text(input.password),
        role,
        companyOdooId: text(input.companyOdooId || input.companyId),
        whatsappPhone: text(input.whatsappPhone || input.phone),
      });
      json(ctx.res, 200, { item: user });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao criar usuário';
      json(ctx.res, 400, { error: message });
    }
  });

  route('PUT', '/api/users/:id', async (ctx) => {
    if (!(await requireAdm(ctx))) return;
    try {
      const input = body(ctx);
      const patch: Parameters<typeof updateUser>[1] = {};
      if (typeof input.email === 'string') patch.email = input.email;
      if (typeof input.name === 'string') patch.name = input.name;
      if (typeof input.password === 'string' && input.password) patch.password = input.password;
      if (typeof input.role === 'string') patch.role = input.role === 'adm' ? 'adm' : 'user';
      if (typeof input.companyOdooId === 'string' || typeof input.companyId === 'string') {
        patch.companyOdooId = text(input.companyOdooId || input.companyId);
      }
      if (typeof input.whatsappPhone === 'string' || typeof input.phone === 'string') {
        patch.whatsappPhone = text(input.whatsappPhone || input.phone);
      }
      if (typeof input.active === 'boolean') patch.active = input.active;
      const user = await updateUser(ctx.params.id, patch);
      json(ctx.res, 200, { item: user });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao atualizar usuário';
      json(ctx.res, 400, { error: message });
    }
  });

  route('DELETE', '/api/users/:id', async (ctx) => {
    const actor = await requireAdm(ctx);
    if (!actor) return;
    try {
      await deleteUser(ctx.params.id, actor.id);
      json(ctx.res, 200, { ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao remover usuário';
      json(ctx.res, 400, { error: message });
    }
  });

  route('GET', '/api/overview', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    json(ctx.res, 200, {
      counts: await dashboardCounts(),
      agent: {
        name: getSetting('agent_name'),
        active: getSetting('agent_active') === '1',
        autoReply: getSetting('agent_auto_reply') === '1',
        model: getSetting('agent_model'),
      },
      channelId: getSetting('nevoa_channel_id'),
      conversations: (await listConversations()).slice(0, 6),
    });
  });

  route('GET', '/api/agent', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    const models = await listAgentModels();
    json(ctx.res, 200, { ...agentPayload(true), models: models.models, modelsError: models.error });
  });

  route('PUT', '/api/agent', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    const input = body(ctx);
    await setSetting('agent_name', text(input.name, getSetting('agent_name')));
    await setSetting('agent_prompt', text(input.prompt, getSetting('agent_prompt')));
    await setSetting('agent_model', text(input.model, getSetting('agent_model')));
    await setSetting('agent_base_url', text(input.baseUrl, getSetting('agent_base_url')));
    const apiKey = text(input.apiKey);
    if (apiKey && !apiKey.includes('••••')) await setSetting('agent_api_key', apiKey);
    await setSetting('agent_temperature', String(clamp(Number(input.temperature ?? 0.4), 0, 2)));
    const active = input.active !== false;
    await setSetting('agent_active', active ? '1' : '0');
    const autoReply = typeof input.autoReply === 'boolean' ? input.autoReply : active;
    await setSetting('agent_auto_reply', autoReply ? '1' : '0');
    await setSetting('agent_fallback', text(input.fallback));
    await setSetting('agent_history', String(clamp(Number(input.history ?? 16), 1, 30)));
    const models = await listAgentModels();
    json(ctx.res, 200, { ...agentPayload(true), models: models.models, modelsError: models.error });
  });

  route('POST', '/api/agent/preview', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    const sample = text(body(ctx).text).trim();
    if (!sample) {
      json(ctx.res, 400, { error: 'Escreva uma mensagem de teste' });
      return;
    }
    json(ctx.res, 200, await previewReply(sample));
  });

  route('GET', '/api/contacts', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    json(ctx.res, 200, { items: await listContacts(ctx.query.get('q') || '') });
  });

  route('POST', '/api/sync', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    await guard(ctx, () => syncContactsAndConversations());
  });

  route('GET', '/api/conversations', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    json(ctx.res, 200, { items: await listConversations() });
  });

  route('DELETE', '/api/conversations/:id', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    const conversation = await getConversation(ctx.params.id);
    if (!conversation) {
      json(ctx.res, 404, { error: 'Conversa não encontrada' });
      return;
    }
    await hideConversation(ctx.params.id);
    json(ctx.res, 200, { ok: true });
  });

  route('GET', '/api/conversations/:id/messages', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    const pack = async () => {
      const conversation = await getConversation(ctx.params.id);
      if (!conversation) return { items: [], conversation: null, session: null, templates: [], defaultTemplateId: '' };
      // Abrir a conversa limpa alerta de nova mensagem em modo humano.
      if (conversation.contact_id && Number(conversation.human_unread) === 1) {
        await setHumanUnread(conversation.contact_id, false);
        conversation.human_unread = 0;
      }
      const session = await getSessionGate(conversation.contact_id, conversation.contact_phone);
      const templates = session.requiresTemplate ? await listApprovedTemplates().catch(() => []) : [];
      return {
        items: await listMessages(ctx.params.id),
        conversation,
        session,
        templates,
        defaultTemplateId: resolveFirstContactTemplate(templates)?.id || '',
      };
    };
    if (ctx.query.get('refresh') === '1') {
      await guard(ctx, async () => {
        await syncConversationMessages(ctx.params.id);
        return pack();
      });
      return;
    }
    json(ctx.res, 200, await pack());
  });

  route('POST', '/api/conversations/:id/send', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    const conversation = await getConversation(ctx.params.id);
    const message = text(body(ctx).text).trim();
    if (!conversation) {
      json(ctx.res, 404, { error: 'Conversa não encontrada' });
      return;
    }
    if (!message) {
      json(ctx.res, 400, { error: 'Mensagem vazia' });
      return;
    }
    const gate = await getSessionGate(conversation.contact_id, conversation.contact_phone);
    if (gate.requiresTemplate) {
      json(ctx.res, 409, { error: gate.message || 'Envie um template Meta antes de mensagens livres.' });
      return;
    }
    await guard(ctx, async () => {
      const sent = await sendWhatsappText({
        phone: conversation.contact_phone,
        text: message,
        channelIntegrationId: conversation.channel_id || getSetting('nevoa_channel_id'),
      });
      await recordOutbound({
        conversationId: conversation.id,
        text: message,
        origin: 'manual',
        raw: sent,
      });
      // Humano respondeu: tira o alerta da Inbox, mantém o modo Humano.
      if (conversation.contact_id) await setAwaitingHuman(conversation.contact_id, false);
      return { ok: true };
    });
  });

  route('POST', '/api/conversations/:id/template', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    const conversation = await getConversation(ctx.params.id);
    if (!conversation?.contact_id) {
      json(ctx.res, 404, { error: 'Conversa não encontrada' });
      return;
    }
    try {
      const result = await sendFirstContactTemplate({
        contactId: conversation.contact_id,
        templateId: text(body(ctx).templateId),
      });
      json(ctx.res, 200, {
        ok: true,
        conversationId: result.conversationId,
        preview: result.preview,
      });
    } catch (error) {
      if (error instanceof NevoaError) {
        json(ctx.res, error.status, { error: error.message, details: error.payload });
        return;
      }
      const message = error instanceof Error ? error.message : 'Falha ao enviar template';
      json(ctx.res, 400, { error: message });
    }
  });

  route('PUT', '/api/conversations/:id/handoff', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    const conversation = await getConversation(ctx.params.id);
    if (!conversation?.contact_id) {
      json(ctx.res, 404, { error: 'Conversa não encontrada' });
      return;
    }
    const human = body(ctx).human === true;
    await setHumanHandoff(conversation.contact_id, human);
    json(ctx.res, 200, { human });
  });

  route('GET', '/api/integrations', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    json(ctx.res, 200, integrationPayload(false));
  });

  route('GET', '/api/integrations/secrets', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    json(ctx.res, 200, integrationPayload(true));
  });

  route('PUT', '/api/integrations', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    const input = body(ctx);
    await assignSecret('nevoa_token', text(input.nevoaToken));
    await assignSecret('nevoa_webhook_secret', text(input.webhookSecret));
    if (text(input.nevoaBaseUrl)) await setSetting('nevoa_base_url', text(input.nevoaBaseUrl));
    if (text(input.channelId)) await setSetting('nevoa_channel_id', text(input.channelId));
    await setSetting('public_base_url', text(input.publicBaseUrl));
    json(ctx.res, 200, integrationPayload(false));
  });

  route('POST', '/api/integrations/test', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    await guard(ctx, async () => {
      const payload = await nevoaRequest('GET', '/channels');
      return { ok: true, channels: payload };
    });
  });

  route('GET', '/api/events', async (ctx) => {
    if (!(await requireUser(ctx))) return;
    json(ctx.res, 200, {
      items: (await listEvents()).map((event) => ({
        ...event,
        payload: JSON.parse(event.payload_json) as unknown,
        result: JSON.parse(event.result_json) as unknown,
      })),
    });
  });
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

async function assignSecret(key: string, value: string): Promise<void> {
  if (value && !value.includes('••••')) await setSetting(key, value);
}

function agentPayload(maskKey: boolean) {
  const apiKey = getSetting('agent_api_key');
  return {
    name: getSetting('agent_name'),
    prompt: getSetting('agent_prompt'),
    model: getSetting('agent_model'),
    baseUrl: getSetting('agent_base_url'),
    apiKey: maskKey ? mask(apiKey) : apiKey,
    hasApiKey: Boolean(apiKey),
    temperature: Number(getSetting('agent_temperature') || '0.4'),
    active: getSetting('agent_active') === '1',
    autoReply: getSetting('agent_auto_reply') === '1',
    fallback: getSetting('agent_fallback'),
    history: Number(getSetting('agent_history') || '16'),
  };
}

function integrationPayload(reveal: boolean) {
  const token = getSetting('nevoa_token');
  const secret = getSetting('nevoa_webhook_secret');
  return {
    nevoaBaseUrl: getSetting('nevoa_base_url'),
    nevoaToken: reveal ? token : mask(token),
    webhookSecret: reveal ? secret : mask(secret),
    channelId: getSetting('nevoa_channel_id'),
    publicBaseUrl: getSetting('public_base_url'),
    webhookPath: '/api/webhooks/nevoa',
    configured: Boolean(token && secret),
  };
}
