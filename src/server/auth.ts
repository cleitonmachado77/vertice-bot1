import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { env } from './env.js';
import { getUserById, isAdm, toPublicUser, type PublicUser } from './users.js';
import type { Ctx } from './http.js';
import { json } from './http.js';

const COOKIE = 'vertice_session';

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function same(left: string, right: string): boolean {
  return timingSafeEqual(digest(left), digest(right));
}

/** Compat: login legado só com senha do painel (antes dos usuários). */
export function passwordOk(password: string): boolean {
  const expected = env('PANEL_PASSWORD', '');
  if (!expected || !password) return false;
  return same(password, expected);
}

function sessionSecret(): string {
  return env('PANEL_PASSWORD', '') || env('SESSION_SECRET', 'vertice');
}

function sign(value: string): string {
  return createHmac('sha256', sessionSecret()).update(value).digest('hex');
}

function parseCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  return (
    cookieHeader
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1) || null
  );
}

type SessionPayload = {
  userId: string;
  exp: number;
};

function encodeSession(payload: SessionPayload): string {
  const body = `v2.${payload.userId}.${payload.exp}`;
  return `${body}.${sign(body)}`;
}

function decodeSession(token: string): SessionPayload | null {
  const parts = token.split('.');
  if (parts[0] === 'v2' && parts.length === 4) {
    const [, userId, expRaw, signature] = parts;
    if (!userId || !expRaw || !signature) return null;
    const body = `v2.${userId}.${expRaw}`;
    const expected = sign(body);
    const left = Buffer.from(signature);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
    const exp = Number(expRaw);
    if (!Number.isFinite(exp) || exp <= Date.now()) return null;
    return { userId, exp };
  }

  // Sessão legada (só timestamp): trata como autenticada sem userId.
  if (parts.length === 2) {
    const [payload, signature] = parts;
    if (!payload || !signature) return null;
    const expected = sign(payload);
    const left = Buffer.from(signature);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
    const exp = Number(payload);
    if (!Number.isFinite(exp) || exp <= Date.now()) return null;
    return { userId: '', exp };
  }

  return null;
}

export function sessionCookie(userId: string, secure: boolean): string {
  const payload: SessionPayload = {
    userId: String(userId || ''),
    exp: Date.now() + 7 * 24 * 3600 * 1000,
  };
  const token = encodeSession(payload);
  const parts = [
    `${COOKIE}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${7 * 24 * 3600}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie(): string {
  return `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`;
}

export function hasSession(cookieHeader: string | undefined): boolean {
  return Boolean(decodeSession(parseCookie(cookieHeader) || ''));
}

export async function getSessionUser(cookieHeader: string | undefined): Promise<PublicUser | null> {
  const session = decodeSession(parseCookie(cookieHeader) || '');
  if (!session) return null;
  if (!session.userId) {
    // Sessão legada: expõe um ADM sintético até o próximo login.
    return {
      id: 'legacy',
      email: env('PANEL_ADMIN_EMAIL', 'admin@vertice.local'),
      name: env('PANEL_ADMIN_NAME', 'Administrador'),
      role: 'adm',
      companyOdooId: '',
      whatsappPhone: '',
      active: true,
      createdAt: '',
      updatedAt: '',
    };
  }
  const row = await getUserById(session.userId);
  if (!row || Number(row.active) !== 1) return null;
  return toPublicUser(row);
}

export function mePayload(user: PublicUser | null): {
  authenticated: boolean;
  user: PublicUser | null;
  isAdm: boolean;
} {
  return {
    authenticated: Boolean(user),
    user,
    isAdm: isAdm(user),
  };
}

export async function requireAuth(ctx: Ctx): Promise<PublicUser | null> {
  const user = await getSessionUser(ctx.req.headers.cookie);
  if (user) return user;
  json(ctx.res, 401, { error: 'Faça login' });
  return null;
}

export async function requireAdm(ctx: Ctx): Promise<PublicUser | null> {
  const user = await requireAuth(ctx);
  if (!user) return null;
  if (!isAdm(user)) {
    json(ctx.res, 403, { error: 'Apenas administradores' });
    return null;
  }
  return user;
}
