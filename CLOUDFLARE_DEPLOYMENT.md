# Free-plan deployment: Cloudflare Pages + Functions + D1

The website runs on Pages. Its same-origin `/api/*` endpoints run as Pages Functions (the Workers runtime). D1 stores the club state, authentication sessions and login limits. This avoids a paid server or persistent disk. No domain purchase is required: Cloudflare assigns an HTTPS `pages.dev` address. Free plans have usage and CPU limits; verify Cloudflare's current terms and quotas for your account. This is a small-club pilot, not unlimited free hosting.

## Publish from this workspace

1. Create a free Cloudflare account and copy its Account ID. No domain transfer is needed.
2. Create a custom API token limited to your account with **Account / Cloudflare Pages / Edit** and **Account / D1 / Edit**. The deployment commands use the supplied account ID directly. Enter the token securely as `CLOUDFLARE_API_TOKEN` and the account ID as `CLOUDFLARE_ACCOUNT_ID` in this cloud environment's settings, then save the settings. Do not paste the token in chat, commit it, or put it in a URL. The deployment destination is `api.cloudflare.com`.
3. Run:

   ```sh
   npm ci
   npm run cf:setup
   npm run cf:deploy
   ```

`cf:setup` creates or reuses the named D1 database, saves its real ID to `wrangler.json`, creates a direct-upload Pages project, and uploads separately generated staff passwords as encrypted Pages secrets. It stores the initial passwords privately in `.runtime/cloudflare-production-passwords.json`, never in the public website. Project/database names can be changed with non-secret `CF_PAGES_PROJECT` and `CF_D1_NAME` environment variables before setup. Local development passwords are different from production passwords.

`cf:deploy` refuses to deploy while `wrangler.json` still has its obvious zero-filled database-ID placeholder. It applies the SQL migrations remotely and deploys the website and Functions to the production branch. It does not create a paid plan, register a domain or enable paid Workers features. Read the actual URL returned by Cloudflare; do not invent one from the proposed project name.

The initial D1 migration seeds six available bays and the supplied menu. Reapplying migrations does not replace existing live data. The local `.wrangler` database and Python `.runtime` database are never uploaded. If you already have real operational data in the old Python installation, arrange an explicit, verified data migration before switching live traffic; do not overwrite a populated D1 database with a seed or backup.

## Publish from your own computer without an API token

Install Node.js 22+ (LTS is recommended), download/unzip the latest project or clone its GitHub repository, and open a terminal inside the folder containing `package.json`.

```sh
npm ci
npx wrangler login
```

Wrangler opens your browser. Sign in to the Cloudflare account and approve its login request. This local interactive login is an alternative to storing an API token in this chat's environment settings.

Copy your Cloudflare Account ID and set it in the same terminal:

Windows PowerShell:

```powershell
$env:CLOUDFLARE_ACCOUNT_ID = "YOUR_ACCOUNT_ID"
```

macOS/Linux:

```sh
export CLOUDFLARE_ACCOUNT_ID="YOUR_ACCOUNT_ID"
```

Then:

```sh
npm run cf:setup
npm run cf:deploy
```

If Cloudflare reports that the proposed Pages project name is already taken, choose a unique `CF_PAGES_PROJECT` value in that terminal and rerun setup before deployment. If using a shared computer, protect the downloaded project folder and sign out of Wrangler when finished. The staff password files created by setup are private and excluded from Git; do not upload the entire working folder to a public file host.

## First live check and QR sheets

Open the actual production URL, confirm `/api/health` reports `{"ok":true,"backend":"cloudflare-d1"}`, and sign in at `/reception` using the production Reception password. Open a bay, order from its URL on another device, fulfil it at `/bar`, settle it at Reception, and close the bay. Verify a fresh visit starts with an empty tab. Check that the menu and history remain after a redeployment.

At Reception choose **BAY QR CODES**. Confirm the displayed HTTPS address is the permanent production address, then download the printable six-bay A4 PDF. QR/PDF generation runs in the Reception browser so it does not consume a free Worker's CPU allowance. Each code contains only `/bay/1` through `/bay/6` on that host. Test every printed code with a phone. No production codes are generated before an actual hosting address exists.

For a custom domain later, configure it through the Pages project and complete Cloudflare's DNS/HTTPS verification. Set `VC_PUBLIC_URL` to that exact verified HTTPS origin in the project's production variables and redeploy. Always use the same origin for the staff interface. Replace QR sheets printed for the previous address. Preview deployments are not permanent QR destinations.

## Local development

Requires Node.js 22+; the repository pins Wrangler, Miniflare, QR and PDF dependencies in `package-lock.json`.

```sh
npm ci
npm run dev:init
npm run build
npm run dev
```

Local Pages uses port 8788. `dev:init` creates private, unique development role passwords in `.runtime/cloudflare-local-passwords.json` and `.dev.vars` only if absent, then applies migrations to the local D1 database. It never requires Cloudflare authentication. `.dev.vars`, `.wrangler`, `.runtime` and `node_modules` are ignored by Git.

```sh
npm test
```

These tests execute the compiled Pages Functions in Miniflare with actual local D1 SQL, including concurrent orders/settlements, authentication, payments, cancellation, privacy, conditional refresh, QR destinations and exports. The existing Chromium suite also supports this backend using `VC_TEST_BASE_URL` and `VC_TEST_PASSWORD_FILE`; use a separate test D1 persistence directory so tests never modify live or development data.

## Updates, persistence and limits

Active screens refresh every five seconds and pause when hidden. Reopening a screen refreshes it immediately. The interface labels this `AUTO · 5s`, rather than claiming instantaneous push. Eight continuously visible screens open for ten hours produce about 57,600 polling requests, plus actions and logins; check those figures against your current Workers/D1 allowance before operational use. Static assets are served by Pages and excluded from Functions by `_routes.json`.

The D1 repository preserves the existing JSON aggregate using an atomic compare-and-swap version update. Competing requests reload, validate and retry; another station's changes cannot be silently overwritten. Each write atomically includes its audit record. Authentication and rate limits have their own indexed SQL tables. D1 survives redeployments; no local filesystem persistence is required.

For the pilot, aggregate history is capped at 1.5 MB to stay below D1's per-value limits. It is not appropriate for indefinite history or large reports. The application stops new writes with a clear storage message at that cap and does not delete history. Normalize/archive historical data before approaching it. Admin's **MENU SETTINGS → DOWNLOAD DATA BACKUP** exports the complete state without credentials or staff auth tokens. Protect downloaded backups: they contain guest and payment information. D1's own database export/restore tools should be included in operational backup procedures; restore has not been tested in a real Cloudflare account here.

Free-tier exhaustion or an account suspension can interrupt service; do not treat the pilot as an unlimited availability guarantee. Staff accounts remain per-role, payment recording remains manual, and refunds/live M-Pesa integration are not implemented. Static bay QR codes reject orders when closed but do not prove on-site presence while a bay is open.

## Existing Python/Render alternative

The original Python server, its tests, Dockerfile, and Render blueprint are retained as an alternative. `DEPLOYMENT.md` describes that paid-hosting path. The primary deployment path for the free pilot is this Cloudflare guide. Do not run the two backends as separate live systems: their databases do not synchronize.
