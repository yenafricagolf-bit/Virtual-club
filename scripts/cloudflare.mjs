import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const project = process.env.CF_PAGES_PROJECT || 'yengolf-virtual-club';
const dbName = process.env.CF_D1_NAME || 'yengolf-club';
const configFile = 'wrangler.json';
const placeholder = '00000000-0000-0000-0000-000000000000';
function run(args, capture = false) {
  const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args], {
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : ['ignore', 'inherit', 'inherit'],
    encoding: 'utf8', env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' }
  });
  if (result.error || result.status !== 0) throw new Error(`Cloudflare command failed: ${args.slice(0, 3).join(' ')}. Resolve the reported error before retrying.`);
  return result.stdout || '';
}
function readConfig() { return JSON.parse(readFileSync(configFile, 'utf8')); }
function passwords(file) {
  mkdirSync('.runtime', { recursive: true, mode: 0o700 });
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const values = Object.fromEntries(['bar', 'reception', 'admin'].map(role => [role, randomBytes(24).toString('base64url')]));
  writeFileSync(file, JSON.stringify(values, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return values;
}
function secrets(values) { return Object.fromEntries(Object.entries(values).map(([k, v]) => [`VC_${k.toUpperCase()}_PASSWORD`, v])); }

async function main() {
  const action = process.argv[2];
  if (action === 'init-local') {
    if (!existsSync('.dev.vars')) {
      const values = secrets(passwords('.runtime/cloudflare-local-passwords.json'));
      writeFileSync('.dev.vars', Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
    }
    run(['d1', 'migrations', 'apply', 'DB', '--local']);
    console.log('Local D1 initialized. Staff passwords are private in .runtime/cloudflare-local-passwords.json; do not commit or share them.');
    return;
  }
  if (!['setup', 'deploy'].includes(action)) throw new Error('Use init-local, setup or deploy.');
  if (!process.env.CLOUDFLARE_ACCOUNT_ID) throw new Error('Set CLOUDFLARE_ACCOUNT_ID, then run npx wrangler login on your computer or configure CLOUDFLARE_API_TOKEN securely in environment settings. Do not paste credentials in chat.');
  let config = readConfig();
  if (action === 'setup') {
    const databases = JSON.parse(run(['d1', 'list', '--json'], true));
    const existing = databases.find(d => d.name === dbName);
    if (existing) {
      const saved = config.d1_databases[0].database_id;
      if (saved !== placeholder && saved !== existing.uuid) throw new Error('Configured database differs from the existing named database. Resolve this explicitly before proceeding.');
      config.d1_databases[0].database_id = existing.uuid;
      config.d1_databases[0].database_name = dbName;
      writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
    } else {
      run(['d1', 'create', dbName, '--update-config=false']);
      const created = JSON.parse(run(['d1', 'list', '--json'], true)).find(d => d.name === dbName);
      if (!created?.uuid) throw new Error('The database was created but its ID could not be confirmed. Rerun setup after checking the Cloudflare account.');
      config.d1_databases[0].database_id = created.uuid;
      config.d1_databases[0].database_name = dbName;
      writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
    }
    const projects = JSON.parse(run(['pages', 'project', 'list', '--json'], true));
    if (!projects.some(p => (p.name || p.Name || p['Project Name']) === project)) run(['pages', 'project', 'create', project, '--production-branch', 'main']);
    const privateFile = '.runtime/cloudflare-production-secrets.json';
    if (!existsSync(privateFile)) {
      const values = secrets(passwords('.runtime/cloudflare-production-passwords.json'));
      writeFileSync(privateFile, JSON.stringify(values), { mode: 0o600, flag: 'wx' });
      run(['pages', 'secret', 'bulk', privateFile, '--project-name', project]);
      // Mark upload separately, so an interrupted command can be retried without rotating passwords.
      writeFileSync('.runtime/cloudflare-secrets-uploaded', project, { mode: 0o600 });
    } else if (!existsSync('.runtime/cloudflare-secrets-uploaded') || readFileSync('.runtime/cloudflare-secrets-uploaded', 'utf8') !== project) {
      run(['pages', 'secret', 'bulk', privateFile, '--project-name', project]);
      writeFileSync('.runtime/cloudflare-secrets-uploaded', project, { mode: 0o600 });
    }
    console.log('D1 and Pages project prepared. Private role passwords: .runtime/cloudflare-production-passwords.json. Run npm run cf:deploy next.');
  } else {
    if (!config.d1_databases[0]?.database_id || config.d1_databases[0].database_id === placeholder) throw new Error('Run npm run cf:setup first; a real D1 database ID is required.');
    run(['d1', 'migrations', 'apply', 'DB', '--remote']);
    run(['pages', 'deploy', 'static', '--project-name', project, '--branch', 'main']);
    console.log('Use the verified production URL shown by Cloudflare. Check /api/health and the full station workflow before printing QR codes.');
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
