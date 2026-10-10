import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { env } from './env.js';

const COOKIE = 'vertice_session';

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function same(left: string, right: string): boolean {
  return timingSafeEqual(digest(left), digest(right));
}

export function passwordOk(password: string): boolean {
  const expected = env('PANEL_PASSWORD', '');
  if (!expected || !password) return false;
  return same(password, expected);
}

function sign(value: string): string {
  return createHmac('sha256', env('PANEL_PASSWORD', 'vertice')).update(value).digest('hex');
}

export function sessionCookie(secure: boolean): string {
  const payload = String(Date.now() + 7 * 24 * 3600 * 1000);
  const token = `${payload}.${sign(payload)}`;
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
  if (!cookieHeader) return false;
  const token = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (!token) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;
  const expected = sign(payload);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return false;
  return Number(payload) > Date.now();
}
