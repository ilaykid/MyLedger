import type { FastifyInstance } from 'fastify';

/** Install before CORS so preflight responses obey the Host boundary too. */
export function registerHttpSecurity(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    if (req.hostname !== '127.0.0.1' && req.hostname !== 'localhost') {
      return reply.code(421).send({ error: 'invalid host' });
    }
    // Check every write, including encoded paths the router decodes later.
    // A hostile browser cannot supply this header without a CORS preflight.
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS'
      && req.headers['x-myledger'] !== '1') {
      return reply.code(403).send({ error: 'forbidden' });
    }
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    reply
      .header('Cache-Control', 'no-store')
      .header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
      .header('X-Frame-Options', 'DENY')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('Cross-Origin-Resource-Policy', 'same-origin')
      .header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    return payload;
  });
}
