import { getSetting } from './db.js';
import { headerValue, verifyNevoaSignature } from './hmac.js';
import { json, route } from './http.js';
import { NevoaError, sendWhatsappText } from './nevoa.js';
import { handleInbound } from './pipeline.js';

export function registerHookRoutes(): void {
  route('POST', '/api/webhooks/nevoa', async (ctx) => {
    const valid = verifyNevoaSignature(
      ctx.rawBody,
      getSetting('nevoa_webhook_secret'),
      headerValue(ctx.req.headers, 'x-nevoa-signature'),
      headerValue(ctx.req.headers, 'x-nevoa-timestamp'),
    );
    if (!valid) {
      json(ctx.res, 401, { error: 'Assinatura inválida' });
      return;
    }

    const decision = await handleInbound(ctx.body, headerValue(ctx.req.headers, 'x-nevoa-delivery-id'));
    if (decision.action === 'reply' && decision.nevoa) {
      try {
        await sendWhatsappText(decision.nevoa.body);
      } catch (error) {
        const message = error instanceof NevoaError ? error.message : 'Falha ao enviar';
        json(ctx.res, 200, { ...decision, sendError: message });
        return;
      }
    }
    json(ctx.res, 200, decision);
  });
}
