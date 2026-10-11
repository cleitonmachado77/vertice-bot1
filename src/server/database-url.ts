import { env } from './env.js';

const DIRECT_HOST = /^db\.([a-z0-9]+)\.supabase\.co$/;

export function databaseConnectionString(raw: string): string {
  const url = new URL(raw);
  const match = url.hostname.match(DIRECT_HOST);
  if (!match) return raw;
  const ref = match[1];
  url.hostname = env('SUPABASE_POOLER_HOST', 'aws-1-us-west-2.pooler.supabase.com');
  url.port = '5432';
  if (!url.username.includes('.')) url.username = `postgres.${ref}`;
  return url.toString();
}
