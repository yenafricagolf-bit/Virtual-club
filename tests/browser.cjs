/* Optional UI smoke suite. Requires Playwright and Chromium; uses an isolated database. */
const { chromium } = require(process.env.VC_PLAYWRIGHT || 'playwright');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname,'..');
const runtime = fs.mkdtempSync(path.join(os.tmpdir(),'yengolf-ui-'));
const env = {...process.env, VC_DATA_DIR:runtime};
const port = process.env.VC_TEST_PORT || '8081';
const external = !!process.env.VC_TEST_BASE_URL;
const url = process.env.VC_TEST_BASE_URL || `http://127.0.0.1:${port}`;
const screenshots = process.env.VC_SCREENSHOTS || path.join(runtime,'screenshots');
fs.mkdirSync(screenshots,{recursive:true});
if(!external) execFileSync('python3',['server.py','--init-staff'],{cwd:root,env,stdio:'ignore'});
const credentials = JSON.parse(fs.readFileSync(process.env.VC_TEST_PASSWORD_FILE || path.join(runtime,'initial-passwords.json'),'utf8'));
const server = external ? null : spawn('python3',['server.py','--port',port],{cwd:root,env,stdio:['ignore','pipe','pipe']});
let browser;
const errors=[];
async function visible(locator) { await locator.waitFor({state:'visible',timeout:15000}); }
async function openStation(page,station,role=station) {
  await page.goto(url+'/'+station);
  await visible(page.locator('#loginForm'));
  await page.locator('#loginForm select').selectOption(role);
  await page.locator('#loginForm input[type=password]').fill(credentials[role]);
  await page.getByRole('button',{name:'SIGN IN',exact:true}).click();
  await page.locator('#modal').waitFor({state:'hidden'});
  await visible(page.locator(`#${station}.active`));
}
async function run() {
  for(let i=0;i<50;i++) {
    try {if((await fetch(url+'/api/health')).ok) break;} catch {}
    await new Promise(r=>setTimeout(r,100));
  }
  browser=await chromium.launch({executablePath:process.env.VC_CHROMIUM || '/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const reception=await browser.newPage({viewport:{width:1440,height:1000}});
  const bar=await browser.newPage({viewport:{width:1024,height:900}});
  const customer=await browser.newPage({viewport:{width:390,height:844},isMobile:true,deviceScaleFactor:1});
  for(const p of [reception,bar,customer]) p.on('pageerror',e=>errors.push(e.message));
  await customer.goto(url+'/bay/1');
  await customer.evaluate(()=>document.fonts.ready);
  assert.equal(await customer.evaluate(()=>document.fonts.check('16px "Cormorant Garamond"')),true,'Bundled font loads under the content security policy');
  await visible(customer.getByText('This bay is not currently checked in.',{exact:true}));
  await openStation(reception,'reception');
  await openStation(bar,'bar');
  const bay1=reception.locator('#bayGrid article').first();
  await bay1.getByRole('button',{name:'CHECK IN / OPEN BAY',exact:true}).click();
  await reception.locator('#checkInForm input[name=name]').fill('Browser Test Guest');
  await reception.locator('#checkInForm input[name=guests]').fill('4');
  await reception.getByRole('button',{name:'OPEN BAY 1',exact:true}).click();
  await visible(customer.locator('#menuArea'));
  await customer.locator('#search').fill('Jameson');
  assert.equal(await customer.locator('#menu .menu-card').count(),1,'One grouped product card');
  await customer.locator('#menu').getByRole('button',{name:'SELECT'}).click();
  await customer.locator('#productForm input[value=jameson-black-tot]').check();
  await customer.getByRole('button',{name:'Increase quantity'}).click();
  await customer.getByRole('button',{name:'ADD TO ORDER',exact:true}).click();
  await customer.getByRole('button',{name:'VIEW CART'}).click();
  await customer.locator('#cartForm textarea').fill('Cold please <b>not HTML</b>');
  await customer.getByRole('button',{name:'SEND ORDER TO BAR',exact:true}).click();
  await visible(bar.locator('#barOrders .order-card'));
  assert.match(await bar.locator('#barOrders').textContent(),/2 × Jameson/);
  assert.equal(await bar.locator('#barOrders b').count(),0,'Customer note escaped');
  await bar.getByRole('button',{name:'ACCEPT ORDER',exact:true}).click();
  await visible(customer.locator('#modalContent').getByText('PREPARING',{exact:true}));
  await bar.locator('#barFilters').getByRole('button',{name:'PREPARING',exact:true}).click();
  await bar.getByRole('button',{name:'MARK AS SERVED',exact:true}).click();
  await visible(customer.locator('#modalContent').getByText('SERVED',{exact:true}));
  await customer.locator('#closeModal').click();
  await customer.locator('#search').fill('');
  await customer.screenshot({path:path.join(screenshots,'bay-mobile.png'),fullPage:false,animations:'disabled'});
  assert.equal(await customer.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'No mobile overflow');
  await reception.reload();
  await visible(reception.locator('#reception.active'));
  assert.equal(await reception.locator('nav .active').count(),1);
  await reception.screenshot({path:path.join(screenshots,'reception-desktop.png'),fullPage:true,animations:'disabled'});
  await bar.locator('#barFilters').getByRole('button',{name:'SERVED',exact:true}).click();
  await bar.screenshot({path:path.join(screenshots,'bar-tablet.png'),fullPage:true,animations:'disabled'});
  await reception.locator('#bayGrid article').first().getByRole('button',{name:'VIEW TAB',exact:true}).click();
  await reception.getByRole('button',{name:'SETTLE TAB',exact:true}).click();
  await reception.locator('#paymentForm select').selectOption('M-Pesa');
  await reception.locator('#paymentForm input[name=amount0]').fill('350');
  await reception.locator('#paymentForm input[name=reference0]').fill('TEST-REFERENCE');
  await reception.getByRole('button',{name:'+ SPLIT PAYMENT',exact:true}).click();
  await reception.locator('#paymentForm select[name=method1]').selectOption('Cash');
  await reception.locator('#paymentForm input[name=amount1]').fill('350');
  await reception.getByRole('button',{name:'CONFIRM KES 700 PAYMENT',exact:true}).click();
  await visible(reception.getByText('TOTAL RECEIVED',{exact:true}));
  await reception.emulateMedia({media:'print'});
  await reception.pdf({path:path.join(screenshots,'receipt.pdf'),format:'A5'});
  await reception.emulateMedia({media:'screen'});
  await reception.getByRole('button',{name:'BACK TO BAY',exact:true}).click();
  await reception.getByRole('button',{name:'CLOSE BAY',exact:true}).click();
  await visible(customer.getByText('This bay is not currently checked in.',{exact:true}));
  // A fresh bay session must start with an empty tab.
  await reception.locator('#bayGrid article').first().getByRole('button',{name:'CHECK IN / OPEN BAY',exact:true}).click();
  await reception.locator('#checkInForm input[name=name]').fill('Next Guest');
  await reception.getByRole('button',{name:'OPEN BAY 1',exact:true}).click();
  await visible(customer.locator('#menuArea'));
  assert.equal(await customer.locator('#heroTabTotal').textContent(),'KES 0');
  await customer.getByRole('button',{name:'VIEW MY TAB',exact:true}).click();
  await visible(customer.getByText('No orders yet. Your next round is just a tap away.'));
  await customer.locator('#closeModal').click();
  // Reception manual orders enter the same live Bar queue.
  await reception.locator('#bayGrid article').first().getByRole('button',{name:'+ ORDER',exact:true}).click();
  await reception.locator('#manualForm input[data-option=tonic]').fill('1');
  await reception.getByRole('button',{name:'ADD TO BAY TAB',exact:true}).click();
  await bar.locator('#barFilters button').first().click();
  await visible(bar.locator('#barOrders').getByText('RECEPTION',{exact:true}));
  await bar.getByRole('button',{name:'CANCEL / PROBLEM',exact:true}).click();
  await bar.locator('#cancelForm select').selectOption('Item unavailable');
  await bar.getByRole('button',{name:'CANCEL ORDER',exact:true}).click();
  await customer.getByRole('button',{name:'VIEW MY TAB',exact:true}).click();
  await visible(customer.getByText('CANCELLED',{exact:true}));
  await customer.locator('#closeModal').click();
  // Staff availability is reflected immediately on the customer menu.
  await bar.locator('.menu-availability summary').click();
  await bar.locator('#availability .card').filter({has:bar.getByRole('heading',{name:'Heineken',exact:true})}).getByRole('button').click();
  await customer.locator('#search').fill('Heineken');
  await visible(customer.getByText('Currently unavailable',{exact:true}));
  assert.equal(await customer.locator('#menu button').isDisabled(),true);
  const admin=await browser.newPage();
  admin.on('pageerror',e=>errors.push(e.message));
  await openStation(admin,'reception','admin');
  await admin.getByRole('button',{name:'MENU SETTINGS',exact:true}).click();
  await admin.getByRole('button',{name:'+ ADD PRODUCT',exact:true}).click();
  await admin.locator('#adminForm input[name=name]').fill('Test drink');
  await admin.locator('#adminForm input[name=cat]').fill('Soft Drinks');
  await admin.locator('#adminForm textarea[name=options]').fill('Glass: 250');
  await admin.locator('#adminForm input[name=available]').check();
  await admin.getByRole('button',{name:'SAVE PRODUCT',exact:true}).click();
  await visible(admin.getByRole('heading',{name:'Test drink',exact:true}));
  await customer.locator('#search').fill('Test drink');
  await visible(customer.locator('#menu').getByRole('heading',{name:'Test drink',exact:true}));
  await admin.locator('#closeModal').click();
  await admin.getByRole('button',{name:'VIEW DAILY REPORT',exact:true}).click();
  await visible(admin.getByRole('heading',{name:'Today at the club.',exact:true}));
  if(external) {
    await admin.locator('#closeModal').click();
    // A local HTTP test has no production host. Stub only the confirmed origin;
    // server-side QR permissions/origin validation are covered by the D1 suite.
    await admin.route('**/api/qr-info',route=>route.fulfill({json:{origin:'https://browser-qr-validation.example',bays:Object.fromEntries(Array.from({length:6},(_,i)=>[i+1,`https://browser-qr-validation.example/bay/${i+1}`]))}}));
    await admin.getByRole('button',{name:'BAY QR CODES',exact:true}).click();
    const download=admin.waitForEvent('download');
    await admin.getByRole('button',{name:'DOWNLOAD PRINTABLE QR SHEET',exact:true}).click();
    await (await download).saveAs(path.join(screenshots,'bay-qr-browser.pdf'));
    assert.equal(fs.readFileSync(path.join(screenshots,'bay-qr-browser.pdf')).subarray(0,5).toString(),'%PDF-');
    await admin.locator('#closeModal').click();
    await admin.getByRole('button',{name:'MENU SETTINGS',exact:true}).click();
    const backup=admin.waitForEvent('download');
    await admin.getByRole('button',{name:'DOWNLOAD DATA BACKUP',exact:true}).click();
    await (await backup).saveAs(path.join(screenshots,'backup-test.json'));
    const exported=JSON.parse(fs.readFileSync(path.join(screenshots,'backup-test.json'),'utf8'));
    assert.equal(exported.state.bays[0].name,'Next Guest');
    assert.equal('auth' in exported,false);
  }
  assert.deepEqual(errors,[],'No browser JavaScript errors');
  console.log('PASS: separate customer/Bar/Reception/Admin sessions, grouped options, quantities, escaped notes, live fulfilment, split settlement, receipt PDF, closing, fresh-session isolation, manual orders, cancellation, availability, menu administration, reports and mobile layout.');
  console.log('Artifacts: '+screenshots);
}
run().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(browser) await browser.close();
  server?.kill('SIGTERM');
});
