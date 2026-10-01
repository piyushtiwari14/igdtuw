# Taarangana 2026 — Registration, Digital Pass & QR Entry Platform

Web platform for **IGDTUW** (Indira Gandhi Delhi Technical University for Women), Taarangana 2026 · 22–23 October 2026.
Built from *IGDTUW Taarangana 2026 Technical Development Specification v1.0*.

| Module | Where |
|---|---|
| Landing, registration (3-step, validated, uploads), digital entry pass, pass retrieval | `/`, `/register`, `/pass` |
| Volunteer QR scanner (mobile camera, Android/iOS) | `/scanner` |
| Admin: dashboard, participants (search/edit), entries, reports (CSV/XLSX), users, settings, audit log, diagnostics | `/admin` |
| REST API | `/api/v1/*` (`server/app.js`) |

## Run it

Requires **Node ≥ 22.5** (uses the built-in `node:sqlite`).

```bash
npm install
cp .env.example .env     # set SERVER_SECRET, BASE_URL
npm run seed             # first Super Admin (set BOOTSTRAP_ADMIN_PASSWORD or one is generated and printed)
npm run seed:demo        # optional demo admin / volunteer / support accounts
node --env-file=.env --no-warnings server/index.js    # or: npm start
npm test                 # 16 tests, incl. the mandatory concurrency test (spec §17.1)
```

Camera access needs **HTTPS** (or `localhost`). Run behind a TLS-terminating proxy and set `TRUST_PROXY=1`, `BASE_URL=https://…`, `NODE_ENV=production`.

## How the key rules are enforced

- **One entry per participant per day**: `entry_logs` has a partial `UNIQUE (event_id, registration_id, event_day) WHERE scan_status='ALLOWED'` index, and verification runs in a `BEGIN IMMEDIATE` transaction. The test suite fires 11 simultaneous scans of one QR: exactly one `ENTRY_ALLOWED`, ten `ALREADY_ENTERED`.
- **Day 2 needs no re-registration**: entry is evaluated per event day; the same Registration ID/QR works on both.
- **Event day** comes from the IST date (22 Oct → Day 1, 23 Oct → Day 2); any other date gives `NOT_ELIGIBLE`. Settings has a *testing-only* override. **Reset it to Automatic before the event.**
- **QR holds no PII**: only `…/verify?t=<opaque token>` (HMAC-derived, 256-bit). Only the SHA-256 of the token is stored; passes are re-issued by re-deriving the token from `SERVER_SECRET` (**changing it invalidates all issued passes**).
- **Server-side RBAC**: `SUPER_ADMIN`, `ADMIN`, `VOLUNTEER` (name + photo only), `SUPPORT` (diagnostics only, no PII).
- **Security**: bcrypt cost 12, httpOnly SameSite=Strict cookies + CSRF header, rate limits (login, registration, pass lookup, verify), CSP, magic-byte upload validation, private ID documents (never statically served; ID views audit-logged), CSV formula-injection neutralised, audit log for login/edit/export/limit/user changes.
- **Scanner states**: Entry allowed / Already entered (shows first-entry time) / Invalid QR / Not eligible / Network error (never auto-admits). Icon + text, not colour alone.

## Deviations from the spec (to confirm with IGDTUW)

| Spec | This build | Note |
|---|---|---|
| Next.js + NestJS + PostgreSQL + S3 + Redis | Node/Express, SQLite (WAL), private local `data/uploads`, in-memory rate limiter | Self-contained. Schema is plain SQL in `server/db.js`; porting to PostgreSQL/S3 is mechanical. One instance is ample for 11 scanners; use Redis-backed limits for multi-instance. |
| `roles` / `user_roles` tables | one `users.role` column | Four fixed roles. |
| "3,000 per day" | one configurable **total** limit (default 3000) | A registration covers both days. |
| Email/SMS/WhatsApp delivery | not implemented | Channel undecided (spec §24). Pass is retrievable via Registration ID + email/phone. |
| Official emblem, brand colours, consent text | placeholder emblem box, spec working palette, bracketed consent note | Put the approved logo at `public/assets/emblem.png`; it replaces the placeholder. Palette is in `public/css/app.css` `:root`. |
| Backups, TLS, monitoring, malware scan | not included | Infra tasks: back up `data/` (SQLite + `uploads/`) daily and before/after the event, and test a restore. `GET /healthz` for uptime checks. |
| PDF pass | Print / Save as PDF + QR PNG | Print stylesheet included. |

## Event-day checklist

1. Set `SERVER_SECRET`, `BASE_URL` (https), `NODE_ENV=production`; run `npm run seed`.
2. Create 10–11 `VOLUNTEER` accounts (Admin › Users); test camera permission on Android and iOS.
3. Admin › Settings: confirm the limit and **event-day override = Automatic**.
4. Back up `data/` before gates open and after the event.
