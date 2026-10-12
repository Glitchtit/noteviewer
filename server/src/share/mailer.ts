import nodemailer from 'nodemailer';

export interface MailMessage {
  to: string[];
  replyTo?: string;
  subject: string;
  text: string;
  attachment: { filename: string; content: Buffer };
}

export interface Mailer {
  configured: boolean;
  from?: string;
  send(msg: MailMessage): Promise<void>;
}

/**
 * SMTP mailer from SMTP_* / MAIL_FROM env; `configured: false` when SMTP_HOST is unset.
 * Cloudflare Email Service: SMTP_HOST=smtp.mx.cloudflare.net, SMTP_PORT=465,
 * SMTP_USER=api_token, SMTP_PASS=<API token with Email Sending: Edit>.
 */
export function createMailer(env: NodeJS.ProcessEnv = process.env): Mailer {
  const host = env['SMTP_HOST'];
  if (!host) {
    return {
      configured: false,
      send: () => Promise.reject(new Error('SMTP is not configured')),
    };
  }
  const user = env['SMTP_USER'];
  const from = env['MAIL_FROM'] || user;
  const port = Number(env['SMTP_PORT'] || 587);
  const transport = nodemailer.createTransport({
    host,
    port,
    // 465 is implicit TLS (the only mode Cloudflare Email Service offers); 587 upgrades via STARTTLS
    secure: env['SMTP_SECURE'] ? env['SMTP_SECURE'] === 'true' : port === 465,
    auth: user ? { user, pass: env['SMTP_PASS'] ?? '' } : undefined,
  });
  return {
    configured: true,
    from,
    async send(msg) {
      await transport.sendMail({
        from,
        to: msg.to,
        replyTo: msg.replyTo,
        subject: msg.subject,
        text: msg.text,
        attachments: [{ ...msg.attachment, contentType: 'application/pdf' }],
      });
    },
  };
}
