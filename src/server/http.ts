import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Ctx = {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  rawBody: string;
  req: IncomingMessage;
  res: ServerResponse;
};

type Handler = (ctx: Ctx) => Promise<void>;
type Route = { method: string; keys: string[]; regex: RegExp; handler: Handler };

const routes: Route[] = [];
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

export function route(method: string, pattern: string, handler: Handler): void {
  const keys: string[] = [];
  const regex = new RegExp(
    `^${pattern.replace(/:([A-Za-z0-9_]+)/g, (_, key: string) => {
      keys.push(key);
      return '([^/]+)';
    })}$`,
  );
  routes.push({ method, keys, regex, handler });
}

export function json(res: ServerResponse, status: number, data: unknown): void {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<{ raw: string; body: unknown }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({ raw: '', body: {} });
        return;
      }
      try {
        resolve({ raw, body: JSON.parse(raw) as unknown });
      } catch {
        reject(new Error('JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

export function listen(port: number): void {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const method = req.method || 'GET';
      if (method === 'GET' && !url.pathname.startsWith('/api/')) {
        await serveStatic(url.pathname, res);
        return;
      }
      const match = routes.find((item) => item.method === method && item.regex.test(url.pathname));
      if (!match) {
        json(res, 404, { error: 'Não encontrado' });
        return;
      }
      const found = url.pathname.match(match.regex);
      const params: Record<string, string> = {};
      match.keys.forEach((key, index) => {
        params[key] = decodeURIComponent(found?.[index + 1] || '');
      });
      const parsed = method === 'GET' ? { raw: '', body: {} } : await readBody(req);
      await match.handler({
        params,
        query: url.searchParams,
        body: parsed.body,
        rawBody: parsed.raw,
        req,
        res,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro interno';
      if (!res.headersSent) json(res, 500, { error: message });
    }
  });
  server.listen(port, '0.0.0.0');
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  if (/^\/forms\/p\/[^/]+\/?$/.test(pathname)) {
    const html = await readFile(path.join(publicDir, 'forms-public.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
    return;
  }
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(publicDir, requested));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      'content-type': types[path.extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  } catch {
    const html = await readFile(path.join(publicDir, 'index.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  }
}
