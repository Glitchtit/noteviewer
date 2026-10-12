import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Share, ShareWithUrl } from '@noteviewer/shared';
import path from 'node:path';
import { badNotePath, relParam } from './params.js';

const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

function pdfFilename(notePath: string): string {
  return `${path.posix.basename(notePath, '.md')}.pdf`;
}

/** `attachment` disposition that survives non-ASCII names (ÅÄÖ) via RFC 5987. */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Private (Access-protected) routes that manage shares and send PDFs. */
export async function shareRoutes(app: FastifyInstance): Promise<void> {
  const withUrl = (s: Share): ShareWithUrl => ({ ...s, url: `${app.publicBaseUrl}/s/${s.token}` });

  async function renderPdf(rel: string, reply: FastifyReply): Promise<Buffer | undefined> {
    if (!app.index.getMeta(rel)) {
      void reply.code(404).send({ error: 'note not found' });
      return undefined;
    }
    if (!app.pdf) {
      void reply.code(503).send({ error: 'PDF rendering is not available' });
      return undefined;
    }
    try {
      return await app.pdf(rel);
    } catch (err) {
      app.log.error({ err, path: rel }, 'pdf render failed');
      void reply.code(502).send({ error: 'PDF rendering failed' });
      return undefined;
    }
  }

  app.get<{ Querystring: { path?: string } }>('/api/shares', async (req, reply) => {
    const rel = req.query.path ?? '';
    if (badNotePath(rel)) return reply.code(400).send({ error: 'bad path' });
    return app.shares.list(rel).map(withUrl);
  });

  app.post<{ Body: { path: string; expiresInDays?: number | null } }>(
    '/api/shares',
    {
      schema: {
        body: {
          type: 'object',
          required: ['path'],
          properties: {
            path: { type: 'string' },
            expiresInDays: { type: ['integer', 'null'], minimum: 1, maximum: 3650 },
          },
        },
      },
    },
    async (req, reply) => {
      const rel = req.body.path;
      if (badNotePath(rel)) return reply.code(400).send({ error: 'bad path' });
      if (!app.index.getMeta(rel)) return reply.code(404).send({ error: 'note not found' });
      const share = await app.shares.create(rel, req.body.expiresInDays ?? null);
      return reply.code(201).send(withUrl(share));
    },
  );

  app.delete<{ Params: { token: string } }>('/api/shares/:token', async (req, reply) => {
    if (!(await app.shares.revoke(req.params.token))) return reply.code(404).send({ error: 'no such share' });
    return { revoked: true };
  });

  app.get('/api/pdf/*', async (req, reply) => {
    const rel = relParam(req.params);
    if (badNotePath(rel)) return reply.code(404).send({ error: 'note not found' });
    const pdf = await renderPdf(rel, reply);
    if (!pdf) return reply;
    return reply
      .type('application/pdf')
      .header('content-disposition', contentDisposition(pdfFilename(rel)))
      .send(pdf);
  });

  app.get('/api/email/status', async () => ({
    configured: app.mailer.configured,
    from: app.mailer.from ?? null,
  }));

  app.post<{ Body: { path: string; to: string[]; subject: string; message?: string } }>(
    '/api/email',
    {
      schema: {
        body: {
          type: 'object',
          required: ['path', 'to', 'subject'],
          properties: {
            path: { type: 'string' },
            to: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', maxLength: 254 } },
            subject: { type: 'string', minLength: 1, maxLength: 300 },
            message: { type: 'string', maxLength: 20_000 },
          },
        },
      },
    },
    async (req, reply) => {
      const { path: rel, subject, message } = req.body;
      const to = req.body.to.map((t) => t.trim()).filter(Boolean);
      if (badNotePath(rel)) return reply.code(400).send({ error: 'bad path' });
      const invalid = to.filter((t) => !EMAIL.test(t));
      if (to.length === 0 || invalid.length) {
        return reply.code(400).send({ error: `invalid recipient: ${invalid.join(', ') || '(none)'}` });
      }
      if (!app.mailer.configured) return reply.code(503).send({ error: 'SMTP is not configured' });
      const pdf = await renderPdf(rel, reply);
      if (!pdf) return reply;
      // Cloudflare Access injects the signed-in user's address; use it so replies reach the sender
      const sender = req.headers['cf-access-authenticated-user-email'];
      const replyTo = typeof sender === 'string' && EMAIL.test(sender) ? sender : undefined;
      try {
        await app.mailer.send({
          to,
          replyTo,
          subject,
          text: message ?? '',
          attachment: { filename: pdfFilename(rel), content: pdf },
        });
      } catch (err) {
        app.log.error({ err, path: rel }, 'email send failed');
        return reply.code(502).send({ error: `Sending failed: ${(err as Error).message}` });
      }
      app.log.info({ path: rel, to, by: replyTo }, 'note emailed as pdf');
      return { sent: true };
    },
  );
}
