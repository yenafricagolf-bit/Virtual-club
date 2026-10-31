# Publish on Render

The repository includes a Render Blueprint (`render.yaml`) and a tested Docker image definition. Render supplies HTTPS; one persistent disk keeps the SQLite database across restarts and deployments. Use one application instance only. Review Render's current service and disk prices before creating paid resources.

## First deployment

1. Create or sign in to your account at https://render.com and connect GitHub. Authorize access to `yenafricagolf-bit/Virtual-club`.
2. Create a new **Blueprint** from that repository's `main` branch. Render reads `render.yaml`. Review the Starter web service, Frankfurt region, and 1 GB persistent disk before creating them. If the proposed service name is taken, choose another name in Render; do not guess its final URL.
3. Render generates separate random `VC_BAR_PASSWORD`, `VC_RECEPTION_PASSWORD`, and `VC_ADMIN_PASSWORD` environment values. Retrieve these privately in the service's Environment settings and share each role's password only with authorized staff. Do not paste them in chat. No development password file is deployed.
4. Wait for the service to become healthy. Copy the actual HTTPS URL displayed by Render. The application reads Render's `RENDER_EXTERNAL_URL` automatically for secure cookies, origin checks and QR destinations; no guessed hostname is in the code.
5. Verify the assigned URL's `/api/health`, then sign in at `/reception`. Open Bay 1, use `/bay/1` on another device, submit an order, fulfil it at `/bar`, settle it and close the bay. Restart the Render service and confirm the same menu/history remain. These live checks cannot be completed before a hosting account and service exist.

## Print the bay QR codes

At Reception, select **BAY QR CODES**, check that the displayed website is the permanent address you intend to print, then select **DOWNLOAD PRINTABLE QR SHEET**. The A4 PDF contains six labeled codes, one per bay. Print at 100% scale. Codes link to `/bay/1` through `/bay/6` and contain no customer names, credentials or session tokens. Test each printed code with a phone before putting it into use.

The generator refuses to produce codes without a configured public HTTPS origin. No production QR sheet is generated against an invented URL. For individual SVG codes after the URL is confirmed:

```sh
python3 qr_codes.py --url 'https://YOUR-CONFIRMED-HOST' --output .runtime/qr-codes
```

This writes an A4 PDF, six individual SVGs and a JSON list of destinations. Do not print the literal example above.

If you want to use `virtualclub.yengolf.com`, set up that domain before printing permanent codes. In Render, add the custom domain, apply the exact DNS records Render provides through the domain owner's DNS account, and wait for domain/TLS verification. Then set `VC_PUBLIC_URL` to the verified HTTPS origin and redeploy. Access the staff interface using that same origin. Replace any QR sheets previously printed for another hostname.

## Operational limits

Payments are manual records of funds received; there is no live M-Pesa/card gateway. The runtime is a single-process pilot behind Render's HTTPS proxy, with shared-role staff accounts. Do not enable multiple workers or replicas against its in-memory aggregate state. Staff sessions last eight hours. Back up the SQLite database using SQLite's backup API, protect access to guest data, and validate restores before relying on it for business records. Move to a production application server and normalized database before significant public traffic or horizontal scaling.

Deleting the Render disk deletes operational data. Do not use an ephemeral/free service for live tabs. Platform-level HTTPS does not confirm the business workflow: complete the live checks above after deployment. A static photo of a bay code can be used remotely while that bay is open; closed bays reject orders.

## Container verification

The container installs pinned dependencies, excludes `.runtime`, `.env`, `.git`, tests and credential files, and drops root privileges after preparing the persistent disk mount. It honors `PORT` and exposes a health check. In the managed development environment, build with the configured CA bundle:

```sh
docker build --secret id=proxy_ca,src=/etc/ssl/certs/ca-certificates.crt -t yengolf-virtual-club:validated .
```

Ordinary Render builds need no custom CA secret. TLS verification remains enabled. Local development can use `python3 -m pip install -r requirements.txt` followed by the existing setup commands in README.md.
