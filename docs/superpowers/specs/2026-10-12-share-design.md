# Share — email as PDF & public read-only links

**Date:** 2026-10-12
**Status:** Approved (user: "proceed all the way to implementation")

## Purpose

A **Share** button on the open note that lets the owner either

1. **email the note as a PDF attachment** (sent by the server), or
2. create a **read-only link** that works for people without Cloudflare Access.

## Decisions

| Topic | Decision |
|---|---|
| Email | Server renders the PDF and sends it via SMTP (`nodemailer`) through **Cloudflare Email Service** (`smtp.mx.cloudflare.net:465`, user `api_token`, password = API token with *Email Sending: Edit*). Form disabled when unconfigured. |
| Public link | Separate hostname (`share.wredlund.fi`) → **second listener** (`PUBLIC_PORT`, default 8081) that only serves shared notes. No Access app on that hostname; the private API does not exist on it. |
| Link semantics | Live (always the note's current content), revocable, optional expiry: never / 7 / 30 days. Follows in-app renames; dropped when the note is deleted in-app. |
| PDF rendering | Headless Chromium (`playwright-core`; Alpine `chromium-headless-shell` in the image) loads the private SPA's `/print?path=…` page on localhost, which builds the same `#print-root` document as the web *Export to PDF* (`buildPrintDocument`), and prints it with its `@page` rule. |
| Share store | `shares.json` in `DATA_PATH` (`/data`), **not** the vault (vault is git-synced to GitHub). Atomic writes. |

## Architecture

```
notes.wredlund.fi ─ Access ─▶ :8080 private app  (+ /api/shares, /api/pdf/*, /api/email, /print)
share.wredlund.fi ─ public ─▶ :8081 public app   (/s/:token shell, /assets/*, /api/public/:token[/embed/:target])
headless Chromium ──────────▶ http://127.0.0.1:8080/print?path=…  (PDF)
```

Both listeners share one `VaultIndex` and `ShareStore` in one process.

### Server units

- `share/store.ts` — `ShareStore`: `create(path, expiresInDays|null)`, `get(token)` (null when expired),
  `list(path)`, `revoke(token)`, `renamePath(from,to)`, `removePath(path)`. 128-bit base64url tokens.
- `share/pdf.ts` — `createPdfRenderer(baseUrl)` → `(notePath) => Promise<Buffer>`. Launches Chromium per call,
  waits for `window.__nvReady`, prints A4.
- `share/mailer.ts` — `createMailer(env)` → `{ configured, from, send(...) }`.
- `routes/share-routes.ts` (private) — `GET/POST /api/shares`, `DELETE /api/shares/:token`, `GET /api/pdf/*`,
  `GET /api/email/status`, `POST /api/email`.
- `routes/public-routes.ts` (both apps) — `GET /api/public/:token` → `{ title, content }`;
  `GET /api/public/:token/embed/:target` → file, only when the shared note contains `![[target]]`.
- `public-app.ts` — `buildPublicApp()`: public routes + static assets (`index: false`) + SPA shell only for `/s/*`;
  everything else 404. Responses carry `X-Robots-Tag: noindex` and `Referrer-Policy: no-referrer`.

### Web units

- `main.tsx` routes by pathname: `/s/:token` → `SharedView`, `/print` → `PrintView`, else `App`.
- `ShareDialog` — link list (copy / revoke) + create with expiry; email form (To, Subject, Message);
  Download PDF link. Saves pending edits before opening.
- `ReadingView` / `enhanceRendered` gain an `embedUrl` resolver; without `onOpenNote` links are inert.
- `exportPdf` is split into `buildPrintDocument()` + print, shared by `/print` (server PDFs) and the public page's Print button.

## Config (env)

`DATA_PATH` (`/data`), `PUBLIC_PORT` (`8081`, empty disables), `PUBLIC_SHARE_URL` (e.g. `https://share.wredlund.fi`),
`CHROMIUM_PATH`, `SMTP_HOST`, `SMTP_PORT` (587; implicit TLS by default on 465), `SMTP_SECURE` (override), `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`.

## Error handling

Invalid/expired/revoked token or deleted note → 404 page. PDF failure → 502. SMTP unconfigured → 503;
SMTP failure → 502 with message. Recipients validated (≤ 20, basic address check). Reply-To is set from
`Cf-Access-Authenticated-User-Email` when present.

## Testing

Vitest: store, private share routes (fake PDF renderer + fake mailer), public app isolation (private routes 404,
embed allow-list, expiry). Web: ShareDialog, SharedView. Playwright e2e: create link → open on public port;
real PDF bytes from `/api/pdf`.

## Out of scope

Renames done outside noteviewer (Obsidian desktop) do not move links. No PDF download on the public host
(viewers can print to PDF in the browser).
