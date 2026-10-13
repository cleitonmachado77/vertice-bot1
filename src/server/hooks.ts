import { getSetting } from './db.js';
import { env } from './env.js';
import { headerValue, verifyNevoaSignature } from './hmac.js';
import { json, route } from './http.js';
import { enqueueInboundJob } from './inbound-jobs.js';

export function registerHookRoutes(): void {
  route('POST', '/api/webhooks/nevoa', async (ctx) => {
    const valid = verifyNevoaSignature(
      ctx.rawBody,
      getSetting('nevoa_webhook_secret') || env('NEVOA_WEBHOOK_SECRET'),
      headerValue(ctx.req.headers, 'x-nevoa-signature'),
      headerValue(ctx.req.headers, 'x-nevoa-timestamp'),
    );
    if (!valid) {
      json(ctx.res, 401, { error: 'Assinatura inválida' });
      return;
    }

    const queued = await enqueueInboundJob(
      ctx.body,
      headerValue(ctx.req.headers, 'x-nevoa-delivery-id'),
    );
    json(ctx.res, 200, { ok: true, queued: !queued.duplicate, duplicate: queued.duplicate });
  });
}
