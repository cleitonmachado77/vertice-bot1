import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_SKEW_SECONDS = 300;

export function verifyNevoaSignature(
  rawBody: string,
  secret: string,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined,
): boolean {
  if (!secret) return false;
  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > MAX_SKEW_SECONDS) {
    return false;
  }
  const expected =
    'sha256=' + createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  const left = Buffer.from(expected);
  const right = Buffer.from(signatureHeader || '');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string {
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(direct)) return direct[0] || '';
  return direct || '';
}
