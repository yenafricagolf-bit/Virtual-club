# YENGolf Virtual Club

Bay ordering, Bar fulfilment and Reception tab management, refactored from the supplied HTML/CSS/JavaScript prototype. The original archive is preserved separately in the onboarding workspace. No existing Git commits were present at the start.

## Recommended free-pilot hosting

Use **Cloudflare Pages + Pages Functions (Workers) + D1**. The existing interface is preserved, while the backend runs in Cloudflare rather than requiring a paid Python server. See [CLOUDFLARE_DEPLOYMENT.md](CLOUDFLARE_DEPLOYMENT.md) for account setup, deployment, QR sheets and current pilot limits.

```sh
npm ci
npm run dev:init
npm run build
npm run dev
```

Cloudflare local development uses port 8788. Run `npm test` for the Workers/D1 regression suite. The screens automatically refresh every five seconds on this backend. Staff credentials are private in `.runtime/cloudflare-local-passwords.json`.

The Cloudflare adapter has been validated locally; a real Cloudflare account and deployment credentials are required to publish it. No live website address or final QR destination has been invented.

## Python alternative: run locally

Requires Python 3.12+ with SQLite. Pinned Python dependencies provide printable QR/PDF generation; Node is only needed for optional browser tests.

```sh
cd /workspace/Virtual-club
python3 -m venv .venv
. .venv/bin/activate
python3 -m pip install -r requirements.txt
python3 server.py --init-staff
python3 server.py
```

`--init-staff` creates unique development passwords once, in `.runtime/initial-passwords.json`, and salted scrypt hashes in `.runtime/staff.json`. Both are ignored by Git and created with owner-only access. Retrieve passwords privately from that file; never commit them. Login roles are `bar`, `reception`, and `admin`. Admin can use either station. The application does not ship default passwords or show staff passwords on customer pages.

Routes:

| Route | Purpose |
| --- | --- |
| `/bay/1` … `/bay/6` | Customer bay determined by URL |
| `/?bay=1` | Alternative QR-compatible bay route |
| `/bar` | Bar staff sign-in and order queue |
| `/reception` | Reception sign-in and bay dashboard |
| `/admin` | Administrator sign-in; use Menu Settings at Reception |
| `/api/health` | Health check |

Reception includes **BAY QR CODES** to download a printable six-bay QR sheet after a public HTTPS origin is configured. See [CLOUDFLARE_DEPLOYMENT.md](CLOUDFLARE_DEPLOYMENT.md) for free-pilot hosting, or [DEPLOYMENT.md](DEPLOYMENT.md) for the separate Render alternative.

Root `/` asks customers to scan their bay QR. All six bays start available; Reception must open one before it can receive orders. Six bays preserve the existing prototype; bay count is initialized in `Club` for a new database.

## What was retained and improved

The original three-station flow, menu, quantities, customer notes, manual ordering, running tabs and settlement have been retained. Styling reuses the supplied palette and Cormorant Garamond; the font is bundled from the official Google Fonts repository under its included OFL license. The original logo is retained as `static/vc_logo-original.png`; `static/vc_logo.svg` embeds that exact artwork and applies a white-to-alpha filter, preserving its proportions and colored pixels without redrawing it; it is, used at low opacity in the hero. There is no white navigation logo box or animated flag.

The former browser-local state is replaced by one shared server and SQLite database. Each visit has a distinct session; closing and reopening a bay cannot expose the previous visit's tab. Server-sent events notify every connected browser of changes, followed by a scoped state fetch. A 30-second refresh also recovers missed events. Cart contents remain temporary browser memory and are cleared when the bay session changes.

Server rules validate prices, quantities, availability, session identifiers, state transitions and permissions. Readable order numbers are generated under a transactional lock. Request keys prevent duplicate customer/manual orders when the same request is retried. New and preparing orders must be served or cancelled before settlement or closure. Served items remain on the tab. Cancelled orders and audit events are retained. Payment recording is atomic and supports M-Pesa references, cash, card and split settlement. Receipts contain only the orders settled by that receipt and support browser printing/PDF.

Bar can change availability. Admin can add products, change names/categories/prices, edit confirmation notes, and deactivate products through Menu Settings. Existing order line prices are immutable snapshots. The unpriced Glenlivet Founder's 1L is visible but disabled. Hendricks Tot remains KES 5,000 and is flagged for confirmation in the staff menu. No missing price was invented.

Reports distinguish money received from order value. They include daily payments, order counts, average order value, payments by bay/method, category order value, top products and hourly order counts. Reporting dates use Africa/Nairobi.

## Files and data

| Path | Responsibility |
| --- | --- |
| `server.py` | HTTP API, authentication, authorization, business rules, SQLite persistence, live event stream |
| `static/index.html` | Three responsive station views |
| `static/styles.css` | Shared YENGolf visual design, adapted from the MVP |
| `static/app.js` | Menu/cart and station interactions; server state synchronization |
| `data/menu.json` | Initial menu seed, grouped into products and options |
| `tests/test_workflow.py` | Isolated real HTTP/database regression tests |
| `tests/browser.cjs` | Optional multi-browser workflow and mobile smoke suite |
| `.runtime/club.sqlite3` | Runtime operational database; contains guest and payment information |

The database currently stores a single JSON aggregate transactionally in SQLite, plus a separate hashed authentication-session table. This keeps the MVP dependency-free and serializes concurrent writes safely within one server process. Back up the database using SQLite's backup API (not a live raw file copy), protect the data directory, and validate restore procedures before operational use. Do not delete `.runtime` to refresh dependencies: that would delete operational history.

`data/menu.json` seeds an empty database only. Change live menu data through Menu Settings, not by editing the seed and expecting it to overwrite the database.

## Validation

```sh
python3 -m unittest discover -s tests -v
node --check static/app.js
```

HTTP tests use fresh temporary databases and cover full ordering/settlement, permissions/privacy, cancellation/audit history, invalid input, active-order closure rules, duplicate and concurrent orders, price snapshots, availability, split payments, persisted state, logout, and event-stream updates.

Optional browser checks require Playwright and Chromium already installed:

```sh
VC_PLAYWRIGHT=/opt/codex/cua_node/lib/node_modules/playwright \
VC_CHROMIUM=/usr/bin/chromium \
VC_SCREENSHOTS=/tmp/yengolf-screenshots \
node tests/browser.cjs
```

The browser test starts its own server on port 8081 and uses unique temporary staff credentials and data. It checks three separate browser sessions, mobile overflow, grouped serving options, live status changes, settlement, receipt PDF, and bay reopening. It does not touch the development database. Override `VC_TEST_PORT` if that port is occupied.

## Python/Render alternative: configuration and deployment

This is a working single-server MVP and development environment. Public production deployment has not been performed or load-tested. Python's standard-library HTTP server is a development/pilot runner, not a hardened public application server. Before public launch, retain the API/business rules behind an appropriate production HTTP stack, configure TLS and access limits, and validate backups, monitoring, operational recovery, and the business's privacy/retention rules. Do not run multiple application processes against this aggregate database: their in-memory state would diverge. For multiple workers/locations, migrate the repository layer to normalized PostgreSQL tables with transaction locking and shared event distribution.

Configuration:

| Variable | Purpose |
| --- | --- |
| `VC_DATA_DIR` | Persistent private data directory; default `.runtime` beside `server.py` |
| `VC_PUBLIC_URL` | Exact external origin, e.g. `https://virtualclub.yengolf.com`; controls origin checks and Secure cookies |
| `VC_BAR_PASSWORD` | Optional runtime override for the Bar password |
| `VC_RECEPTION_PASSWORD` | Optional runtime override for the Reception password |
| `VC_ADMIN_PASSWORD` | Optional runtime override for the Admin password |

Supply production passwords securely at runtime; do not put them in JavaScript, source files, command-line arguments or images. Do not publish development-generated passwords as production credentials. Staff sessions expire after eight hours and use HttpOnly/SameSite cookies; `VC_PUBLIC_URL=https://…` enables Secure cookies. Credentials are per role in this MVP; individual staff accounts, password resets and user-attributed audit trails remain future work. Staff API actions are protected on the server, regardless of visible navigation buttons.

The static bay QR links are intentionally reusable and contain no customer information. Bay activation prevents ordering while closed, but a photograph of a QR can still be used remotely while the bay is active. Stronger on-site presence verification would require an additional mechanism agreed with the club.

Payments are manual records of money already received. There is no live M-Pesa/card charge, transaction verification, refund processing or fiscal receipt integration. Cancellation of served/paid orders is blocked; refunds need a separate audited workflow before launch if required. Receipt printing uses the browser; automatic printer integration has not been added.

The production domain is an example, not a confirmed destination. The QR generator uses `VC_PUBLIC_URL` or Render's assigned `RENDER_EXTERNAL_URL`; it refuses to guess an address. Print permanent sheets after confirming the final HTTPS URL. No public URL or production QR codes have been invented.

Future cloud tasks should use this existing isolated checkout; do not create Git worktrees unless explicitly requested. Live server processes must be restarted after a new environment is restored.
