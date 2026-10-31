/* Refactored from the supplied HTML MVP. All operational state lives on the server. */
'use strict';
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n => `KES ${Number(n || 0).toLocaleString('en-KE')}`;
const time = n => n ? new Date(n).toLocaleTimeString('en-KE', {timeZone:'Africa/Nairobi',hour:'2-digit',minute:'2-digit'}) : '—';
const date = n => new Date(n).toLocaleDateString('en-KE', {timeZone:'Africa/Nairobi',day:'numeric',month:'short',year:'numeric'});
const day = n => new Date(n).toLocaleDateString('en-CA', {timeZone:'Africa/Nairobi'});
const pathBay = location.pathname.match(/^\/bay\/(\d+)\/?$/);
const bayValue = pathBay?.[1] || new URLSearchParams(location.search).get('bay');
const currentBay = /^\d+$/.test(bayValue || '') ? Number(bayValue) : null;
let state = {products:[],bays:[],orders:[],payments:[],sessions:[],role:null};
let cart = {}, category = 'All', barFilter = 'new', activeView = 'bay', dialogRefresh = null, refreshPromise = null, refreshAgain = false, eventSource;
let orderKey = crypto.randomUUID(), toastTimer, requestBusy = false;

async function api(action, data) {
  const response = await fetch(`/api/${action}`, data === undefined ? {cache:'no-store'} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'Request failed. Please retry.');
  return result;
}
function toast(message) {
  $('toast').textContent = message; $('toast').style.display = 'block';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').style.display = 'none', 6000);
}
function modal(html, refresh = null) {
  dialogRefresh = refresh;
  $('modalContent').innerHTML = html;
  if (!$('modal').open) $('modal').showModal();
}
function closeModal() { $('modal').close(); dialogRefresh = null; }
function errorInForm(error) {
  const el = $('formError');
  if (el) { el.textContent = error.message; el.scrollIntoView({block:'nearest'}); }
  else toast(error.message);
}
const errorField = '<p id="formError" class="error" role="alert"></p>';
function field(label, content) { return `<div class="field"><label>${label}${content}</label></div>`; }
function button(label, action, data = '', style = '') { return `<button class="btn ${style}" data-action="${action}" data-id="${esc(data)}">${label}</button>`; }
function getBay(id = currentBay) { return state.bays.find(b => b.id === id); }
function sessionOrders(session) { return state.orders.filter(o => o.session === session); }
function due(session) { return sessionOrders(session).filter(o => o.status !== 'cancelled').reduce((s,o) => s+o.total,0) - (state.payments || []).filter(p => p.session === session).reduce((s,p) => s+p.amount,0); }
function can(view) { return view === 'bay' || state.role === 'admin' || state.role === view; }

function refresh() {
  refreshAgain = true;
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    do { refreshAgain = false; await loadState(); } while (refreshAgain);
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}
async function loadState() {
  try {
    const previous = getBay()?.session;
    state = await api('state' + (currentBay ? `?bay=${currentBay}` : ''));
    if (previous && previous !== getBay()?.session) {
      cart = {}; orderKey = crypto.randomUUID(); closeModal(); toast('This bay session has changed. Your cart was cleared.');
    }
    renderAll();
    if (dialogRefresh && $('modal').open) dialogRefresh();
    if (!can(activeView)) login(activeView);
    $('connection').textContent = eventSource?.readyState === 1 ? 'LIVE · NAIROBI' : 'CONNECTED · NAIROBI';
  } catch (error) { $('connection').textContent = 'OFFLINE · RETRYING'; toast(error.message); }
}
function renderAll() {
  $('logout').hidden = !state.role;
  renderBay(); renderBar(); renderReception();
}
function renderBay() {
  const b = getBay(), open = !!b?.active;
  $('bayTitle').textContent = currentBay ? `Bay ${currentBay}.` : 'your bay.';
  $('heroTabTotal').textContent = money(open ? due(b.session) : 0);
  $('bayClosed').hidden = open;
  $('menuArea').hidden = !open;
  $('closedTitle').textContent = currentBay ? 'This bay is not currently checked in.' : 'Scan your bay’s QR code to begin.';
  $('closedCopy').textContent = currentBay ? 'Please speak to Reception for assistance.' : 'Your bay is assigned automatically. Reception can help you get checked in.';
  $('viewMenu').disabled = !open; $('viewTab').disabled = !open;
  renderMenu(); renderCartSummary();
}
function renderMenu() {
  const products = state.products.filter(p => p.active);
  const cats = ['All', ...new Set(products.map(p => p.cat))];
  $('categories').innerHTML = cats.map(c => `<button data-action="category" data-id="${esc(c)}" class="${c === category ? 'active' : ''}" aria-pressed="${c === category}">${esc(c.toUpperCase())}</button>`).join('');
  const search = $('search').value.trim().toLowerCase();
  const filtered = products.filter(p => (category === 'All' || category === p.cat) && (p.name + ' ' + p.cat).toLowerCase().includes(search));
  $('menu').innerHTML = filtered.length ? filtered.map(p => {
    const available = p.available && p.options.length;
    const price = p.options.length ? money(Math.min(...p.options.map(o => o.price))) : 'Price to be confirmed';
    return `<article class="card menu-card ${available ? '' : 'unavailable'}"><span class="eyebrow">${esc(p.cat)}</span><h3>${esc(p.name)}</h3>${!available ? '<p class="availability-note">Currently unavailable</p>' : `<p class="availability-note">${p.options.map(o => esc(o.label)).join(' / ')}</p>`}<div class="row"><span class="price">${p.options.length > 1 ? 'From ' : ''}${price}</span><button class="btn ghost" data-action="product" data-id="${esc(p.id)}" ${available ? '' : 'disabled'}>SELECT <span>+</span></button></div></article>`;
  }).join('') : '<div class="card empty"><h3>No drinks found.</h3><p>Try another search or category.</p></div>';
}
function productDialog(id) {
  const p = state.products.find(p => p.id === id);
  if (!getBay()?.active || !p?.available || !p.options.length) return toast('This item is not available.');
  modal(`<div class="eyebrow">${esc(p.cat)}</div><h2>${esc(p.name)}</h2><p>How would you like it?</p><form id="productForm" data-product="${esc(id)}"><div class="option-list">${p.options.map((o,i) => `<label><span><input type="radio" name="option" value="${esc(o.id)}" ${!i ? 'checked' : ''}> ${esc(o.label)}</span><strong class="price">${money(o.price)}</strong></label>`).join('')}</div><div class="quantity"><span>Quantity</span><button type="button" data-action="quantity" data-id="-1" aria-label="Decrease quantity">−</button><output id="productQty">1</output><button type="button" data-action="quantity" data-id="1" aria-label="Increase quantity">+</button></div>${errorField}<button class="btn full" type="submit">ADD TO ORDER</button></form>`);
}
function cartLines() {
  return Object.entries(cart).map(([key, qty]) => {
    const [pid, oid] = key.split(':'); const p = state.products.find(p => p.id === pid), o = p?.options.find(o => o.id === oid);
    return p && o ? {key, product:pid,option:oid,name:p.name,serving:o.label,price:o.price,qty,available:p.active && p.available} : {key,qty,name:'Item changed — please remove',price:0,available:false};
  });
}
function renderCartSummary() {
  const lines = cartLines(), count = lines.reduce((s,l) => s+l.qty,0);
  $('cartSummary').textContent = count ? `${count} item${count === 1 ? '' : 's'} · ${money(lines.reduce((s,l) => s+l.price*l.qty,0))}` : 'No items yet';
}
function cartDialog() {
  const lines = cartLines();
  if (!lines.length) return toast('Choose a drink to start your order.');
  modal(`<h2>Your order · Bay ${currentBay}</h2>${lines.map(l => `<div class="cart-item"><div>${l.qty} × ${esc(l.name)}<small>${esc(l.serving || '')}${l.available ? '' : ' · Currently unavailable'}</small>${button('Remove','removeCart',l.key,'textbtn')}</div><strong>${money(l.qty*l.price)}</strong></div>`).join('')}<div class="row sep-total"><strong>Order total</strong><span class="total">${money(lines.reduce((s,l) => s+l.price*l.qty,0))}</span></div><form id="cartForm">${field('Mixers / preferences (optional)', '<input name="mixers" maxlength="200" placeholder="e.g. tonic, served separately">')}<p class="hint">Add any chargeable mixers as menu items. Preferences do not add products.</p>${field('Anything we should know?', '<textarea name="note" maxlength="500" placeholder="e.g. no ice"></textarea>')}${errorField}<button class="btn full" type="submit" ${lines.some(l => !l.available) ? 'disabled' : ''}>SEND ORDER TO BAR</button><p class="hint">Added to your running bay tab. Settle at Reception.</p></form>`);
}
function orderHtml(o, operational = false) {
  const cancel = o.status === 'cancelled';
  return `<article class="${operational ? 'order-card' : 'card'} ${o.status}"><div class="row"><span class="pill">${esc(o.status.toUpperCase())}</span><span class="small muted">#${esc(o.id)}</span></div>${operational ? `<h2>BAY ${o.bay}</h2><span class="small muted">${esc(o.source)}</span>` : ''}<div class="order-time">Received ${time(o.created)}${o.accepted ? ` · Accepted ${time(o.accepted)}` : ''}${o.served ? ` · Served ${time(o.served)}` : ''}</div><div class="order-lines">${o.items.map(i => `<div>${i.qty} × ${esc(i.name)} <span class="muted">· ${esc(i.serving)}</span></div>`).join('')}</div>${o.mixers ? `<p class="small">Mixers / preferences: ${esc(o.mixers)}</p>` : ''}${o.note ? `<p class="small">Customer note: ${esc(o.note)}</p>` : ''}${cancel ? `<p class="small">Cancelled: ${esc(o.reason)}</p>` : ''}<div class="row"><strong class="price">${money(o.total)}</strong>${operational && o.status === 'new' ? button('ACCEPT ORDER','accept',o.id) : operational && o.status === 'preparing' ? button('MARK AS SERVED','serve',o.id) : ''}</div>${operational && ['new','preparing'].includes(o.status) ? button('CANCEL / PROBLEM','cancel',o.id,'ghost') : ''}</article>`;
}
function tabDialog() {
  const b = getBay(); if (!b?.active) return toast('This bay is not currently checked in.');
  const render = () => {
    const b = getBay();
    if (!b?.active) return closeModal();
    const orders = sessionOrders(b.session);
    modal(`<h2>Bay ${currentBay} · Your tab</h2><div class="row"><span>OUTSTANDING BALANCE</span><strong class="total">${money(due(b.session))}</strong></div><p class="hint">Settle at Reception when you’re done.</p><div class="history">${orders.length ? orders.map(o => orderHtml(o)).join('') : '<p>No orders yet. Your next round is just a tap away.</p>'}</div>`, render);
  }; render();
}
function renderBar() {
  if (!can('bar') || !state.role) { $('barOrders').innerHTML = ''; $('availability').innerHTML = ''; return; }
  const orders = state.orders.filter(o => barFilter === 'all' || o.status === barFilter).sort((a,b) => b.created-a.created);
  $('barFilters').innerHTML = ['new','preparing','served','all'].map(f => `<button class="${f === barFilter ? 'active' : ''}" data-action="filter" data-id="${f}" aria-pressed="${f === barFilter}">${f.toUpperCase()} ${f === 'new' ? `(${state.orders.filter(o => o.status === 'new').length})` : ''}</button>`).join('');
  $('barOrders').innerHTML = orders.length ? orders.map(o => orderHtml(o,true)).join('') : '<div class="card darkcard empty"><h3>All clear.</h3><p class="muted">New bay orders will appear here automatically.</p></div>';
  $('availability').innerHTML = state.products.filter(p => p.active).map(p => `<div class="card"><h3>${esc(p.name)}</h3>${p.flag ? `<p class="hint">${esc(p.flag)}</p>` : ''}<button class="btn ghost" data-action="availability" data-id="${esc(p.id)}" ${!p.options.length ? 'disabled' : ''}>${p.available ? 'MARK UNAVAILABLE' : 'MAKE AVAILABLE'}</button></div>`).join('');
}
function renderReception() {
  if (!can('reception') || !state.role) { $('bayGrid').innerHTML = ''; return; }
  $('occupancy').textContent = `${state.bays.filter(b => b.active).length} OF ${state.bays.length} BAYS ACTIVE`;
  $('salesTotal').textContent = money((state.payments || []).filter(p => day(p.time) === day(Date.now())).reduce((s,p) => s+p.amount,0));
  $('adminButton').hidden = state.role !== 'admin';
  $('bayGrid').innerHTML = state.bays.map(b => {
    const pending = sessionOrders(b.session).filter(o => ['new','preparing'].includes(o.status)).length;
    return `<article class="card"><div class="row"><h2>Bay ${b.id}</h2><span class="pill ${b.active ? 'activepill' : ''}">${b.active ? 'ACTIVE' : 'AVAILABLE'}</span></div>${b.active ? `<p class="guest-name">${esc(b.name)} · ${b.guests} guest${b.guests === 1 ? '' : 's'}</p><p class="muted">Opened ${time(b.opened)} · ${pending} outstanding order${pending === 1 ? '' : 's'}</p><div class="eyebrow">CURRENT BAR TAB</div><div class="total">${money(due(b.session))}</div><div class="row">${button('VIEW TAB','bayDetail',b.id)}${button('+ ORDER','manual',b.id,'ghost')}</div>` : `<p class="muted guest-name">A fresh round awaits.</p><div class="total">—</div>${button('CHECK IN / OPEN BAY','checkIn',b.id)}`}</article>`;
  }).join('');
}
function checkIn(id) {
  modal(`<h2>Welcome to Bay ${id}.</h2><p>Open a new visit and activate this bay’s QR ordering.</p><form id="checkInForm" data-bay="${id}">${field('Customer name','<input name="name" required maxlength="100" autocomplete="name">')}${field('Phone number (optional)','<input name="phone" type="tel" maxlength="40" autocomplete="tel">')}${field('Number of guests','<input name="guests" type="number" min="1" max="50" step="1" value="2" required>')}${errorField}<button class="btn full" type="submit">OPEN BAY ${id}</button></form>`);
}
function bayDetail(id) {
  const render = () => {
    const b = getBay(id); if (!b?.active) return closeModal();
    const orders = sessionOrders(b.session), pending = orders.some(o => ['new','preparing'].includes(o.status));
    modal(`<div class="row"><h2>Bay ${id}</h2><span class="pill">ACTIVE</span></div><p>${esc(b.name)} · ${b.guests} guests · Opened ${time(b.opened)}</p><div class="eyebrow">OUTSTANDING BALANCE</div><div class="total">${money(due(b.session))}</div>${pending ? '<p class="hint">Serve or cancel outstanding orders before settlement or closing.</p>' : ''}<div class="history">${orders.length ? orders.map(o => orderHtml(o)).join('') : '<p>No orders yet.</p>'}</div><div class="form-actions">${button('+ ADD BAR ORDER','manual',id,'ghost')}<button class="btn" data-action="settle" data-id="${id}" ${pending || due(b.session) <= 0 ? 'disabled' : ''}>SETTLE TAB</button><button class="btn ghost" data-action="closeBay" data-id="${id}" ${pending || due(b.session) !== 0 ? 'disabled' : ''}>CLOSE BAY</button></div><p class="hint">Customer QR: /bay/${id}</p>`, render);
  }; render();
}
function manualOrder(id) {
  const bays = state.bays.filter(b => b.active);
  if (!bays.length) return toast('No active bays. Reception must open a bay first.');
  modal(`<h2>New ${state.role === 'reception' ? 'Reception' : 'Bar'} order</h2><form id="manualForm">${field('Active bay',`<select name="bay">${bays.map(b => `<option value="${b.id}" ${b.id === Number(id) ? 'selected' : ''}>Bay ${b.id}</option>`).join('')}</select>`)}<label class="field">Find a drink<input id="manualSearch" type="search" placeholder="Search drinks…"></label><div class="manual-menu">${state.products.filter(p => p.active && p.available).map(p => p.options.map(o => `<label class="menu-item" data-search="${esc(p.name.toLowerCase())}"><span>${esc(p.name)} · ${esc(o.label)}<small class="muted"> · ${money(o.price)}</small></span><input aria-label="Quantity ${esc(p.name)} ${esc(o.label)}" type="number" data-product="${esc(p.id)}" data-option="${esc(o.id)}" min="0" max="99" step="1" value="0"></label>`).join('')).join('')}</div>${field('Mixers / preferences (optional)','<input name="mixers" maxlength="200">')}${field('Order note (optional)','<textarea name="note" maxlength="500"></textarea>')}${errorField}<button class="btn full" type="submit">ADD TO BAY TAB</button></form>`);
  $('manualForm').dataset.key = crypto.randomUUID();
}
function cancelDialog(id) {
  modal(`<h2>Problem with #${esc(id)}</h2><p>Cancellation preserves the order in history and removes it from the bill.</p><form id="cancelForm" data-order="${esc(id)}">${field('Reason','<select name="reason"><option>Item unavailable</option><option>Customer changed order</option><option>Duplicate order</option><option>Other</option></select>')}${field('Details','<textarea name="details" maxlength="150"></textarea>')}${errorField}<button class="btn full" type="submit">CANCEL ORDER</button></form>`);
}
function paymentLine(index, amount = '') {
  return `<div class="payment-line" data-payment>${field('Payment method',`<select name="method${index}"><option>M-Pesa</option><option>Card</option><option>Cash</option></select>`)}${field('Amount (KES)',`<input name="amount${index}" type="number" min="1" step="1" value="${amount}" required>`)}<div class="reference">${field('Reference (required for M-Pesa)',`<input name="reference${index}" maxlength="100">`)}</div></div>`;
}
function settle(id) {
  const b = getBay(id); if (!b?.active) return;
  modal(`<h2>Settle Bay ${id}</h2><div class="eyebrow">OUTSTANDING BALANCE</div><div class="total">${money(due(b.session))}</div><p class="hint">Record a payment already received. This does not charge a card or initiate M-Pesa.</p><form id="paymentForm" data-bay="${id}" data-session="${esc(b.session)}"><div id="paymentLines">${paymentLine(0,due(b.session))}</div><button class="btn ghost" type="button" data-action="split">+ SPLIT PAYMENT</button>${errorField}<button class="btn full" type="submit">CONFIRM ${money(due(b.session))} PAYMENT</button></form>`);
}
function receipt(id) {
  const payments = (state.payments || []).filter(p => p.receipt === id);
  if (!payments.length) return;
  const p = payments[0], session = state.sessions.find(s => s.session === p.session);
  const orders = sessionOrders(p.session).filter(o => o.status !== 'cancelled' && (p.order_ids || []).includes(o.id));
  modal(`<div class="eyebrow">PAYMENT RECEIVED · ${esc(id)}</div><h2>YENGolf Virtual Club</h2><p>Bay ${p.bay} · ${esc(session?.name || 'Guest')}<br>${date(p.time)} · ${time(p.time)} EAT</p><div class="sep"></div>${orders.map(o => `<div class="report-row"><span>#${esc(o.id)}<br>${o.items.map(i => `${i.qty} × ${esc(i.name)} · ${esc(i.serving)}`).join('<br>')}</span><strong>${money(o.total)}</strong></div>`).join('')}<div class="sep"></div><div class="row"><strong>TOTAL RECEIVED</strong><strong class="total">${money(payments.reduce((s,p) => s+p.amount,0))}</strong></div>${payments.map(p => `<p>${esc(p.method)} · ${money(p.amount)}${p.reference ? `<br>Reference: ${esc(p.reference)}` : ''}</p>`).join('')}<p class="hint">Manual payment record. Thank you for joining us.</p><div class="form-actions no-print">${button('PRINT RECEIPT','print')}${getBay(p.bay)?.session === p.session ? button('BACK TO BAY','bayDetail',p.bay,'ghost') : ''}</div>`);
}
function receipts() {
  const ids = [...new Set((state.payments || []).map(p => p.receipt))].reverse();
  modal(`<h2>Payments & receipts</h2>${ids.length ? ids.map(id => { const ps=state.payments.filter(p => p.receipt === id), p=ps[0]; return `<div class="admin-product"><div class="row"><span>${esc(id)} · Bay ${p.bay}<br><small>${date(p.time)} · ${time(p.time)}</small></span><strong>${money(ps.reduce((s,p) => s+p.amount,0))}</strong></div>${button('VIEW RECEIPT','receipt',id,'ghost')}</div>`; }).join('') : '<p>No payments recorded yet.</p>'}`);
}
function reports() {
  const today = day(Date.now()), payments = state.payments.filter(p => day(p.time) === today), orders = state.orders.filter(o => day(o.created) === today && o.status !== 'cancelled');
  const revenue = payments.reduce((s,p) => s+p.amount,0), total = orders.reduce((s,o) => s+o.total,0);
  const rows = obj => Object.entries(obj).map(([k,v]) => `<div class="report-row"><span>${esc(k)}</span><strong>${money(v)}</strong></div>`).join('') || '<p class="hint">No data yet.</p>';
  const bayRevenue={}, categories={}, productSales={}, hours={}, methods={};
  payments.forEach(p => { bayRevenue[`Bay ${p.bay}`]=(bayRevenue[`Bay ${p.bay}`]||0)+p.amount; methods[p.method]=(methods[p.method]||0)+p.amount; });
  orders.forEach(o => {
    const hour = new Date(o.created).toLocaleTimeString('en-GB',{timeZone:'Africa/Nairobi',hour:'2-digit'});
    hours[hour]=(hours[hour]||0)+1;
    o.items.forEach(i => { const cat=state.products.find(p => p.id===i.product)?.cat || 'Archived'; categories[cat]=(categories[cat]||0)+i.price*i.qty; productSales[i.name]=(productSales[i.name]||0)+i.qty; });
  });
  modal(`<h2>Today at the club.</h2><p class="hint">${date(Date.now())} · Africa/Nairobi</p><div class="report-grid"><div class="card"><span class="eyebrow">PAYMENTS RECEIVED</span><strong>${money(revenue)}</strong></div><div class="card"><span class="eyebrow">ORDERS</span><strong>${orders.length}</strong></div><div class="card"><span class="eyebrow">ORDER VALUE</span><strong>${money(total)}</strong></div><div class="card"><span class="eyebrow">AVERAGE ORDER</span><strong>${money(orders.length ? Math.round(total/orders.length) : 0)}</strong></div></div><h3>Payments by bay</h3>${rows(bayRevenue)}<h3>Payment methods</h3>${rows(methods)}<h3>Order value by category</h3>${rows(categories)}<h3>Top products · units</h3>${Object.entries(productSales).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([k,v])=>`<div class="report-row"><span>${esc(k)}</span><strong>${v}</strong></div>`).join('') || '<p class="hint">No sales yet.</p>'}<h3>Orders by hour</h3>${Object.entries(hours).sort().map(([k,v])=>`<div class="report-row"><span>${esc(k)}:00 EAT</span><strong>${v}</strong></div>`).join('') || '<p class="hint">No orders yet.</p>'}<p class="hint">Order value includes unpaid orders; payments received reflect recorded settlements. Cancelled orders are excluded. Category attribution uses the current menu.</p>`);
}
function admin() {
  if (state.role !== 'admin') return toast('Administrator sign-in required.');
  modal(`<h2>The club menu.</h2><p class="hint">Changes are saved in the shared database. Existing orders retain their original prices.</p>${button('+ ADD PRODUCT','editProduct','','gold')}${state.products.map(p => `<div class="admin-product"><h3>${esc(p.name)}</h3><p class="hint">${esc(p.cat)} · ${p.active ? 'Active' : 'Deactivated'} · ${p.available ? 'Available' : 'Unavailable'}</p>${p.flag ? `<p class="error">${esc(p.flag)}</p>` : ''}<p>${p.options.map(o => `${esc(o.label)} ${money(o.price)}`).join(' · ') || 'No confirmed price'}</p>${button('EDIT PRODUCT','editProduct',p.id,'ghost')}</div>`).join('')}`);
}
function editProduct(id) {
  const p = state.products.find(p => p.id === id) || {id:'',name:'',cat:'',options:[],active:true,available:false,flag:''};
  modal(`<h2>${p.id ? 'Edit' : 'Add'} product</h2><form id="adminForm" data-product="${esc(p.id)}">${field('Name','<input name="name" required maxlength="120" value="'+esc(p.name)+'">')}${field('Category','<input name="cat" required maxlength="60" list="categoryOptions" value="'+esc(p.cat)+'"><datalist id="categoryOptions">'+[...new Set(state.products.map(p=>p.cat))].map(c=>`<option value="${esc(c)}">`).join('')+'</datalist>')}<p class="hint">Serving options, one per line: Bottle: 5000 or Tot: 300. Leave blank if price is unknown.</p>${field('Serving options and prices',`<textarea name="options">${p.options.map(o => `${esc(o.label)}: ${o.price}`).join('\n')}</textarea>`)}${field('Price confirmation / admin note',`<input name="flag" maxlength="200" value="${esc(p.flag)}">`)}<label><input type="checkbox" name="available" ${p.available ? 'checked' : ''}> Available for ordering</label><br><label><input type="checkbox" name="active" ${p.active ? 'checked' : ''}> Active in the menu</label>${errorField}<button class="btn full" type="submit">SAVE PRODUCT</button></form>`);
}
function login(target, adminLogin = false) {
  closeModal();
  modal(`<h2>Staff sign-in.</h2><p class="hint login-note">${target === 'bar' ? 'Bar' : 'Reception'} controls are protected. Customers can order from their bay without an account.</p><form id="loginForm" data-target="${target}">${field('Station role',`<select name="role"><option value="${target}">${target === 'bar' ? 'Bar staff' : 'Reception'}</option><option value="admin" ${adminLogin ? 'selected' : ''}>Administrator</option></select>`)}${field('Password','<input name="password" type="password" autocomplete="current-password" required maxlength="512">')}${errorField}<button class="btn full" type="submit">SIGN IN</button></form>`);
}
function station(view) {
  if (view !== 'bay' && !can(view)) { login(view); return; }
  activeView = view;
  document.querySelectorAll('.navbtn').forEach(b => { b.classList.toggle('active', b.dataset.view===view); b.setAttribute('aria-current',b.dataset.view===view ? 'page' : 'false'); });
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active',v.id===view));
  renderAll();
}

async function act(action, id) {
  switch(action) {
    case 'category': category=id; renderMenu(); break;
    case 'product': productDialog(id); break;
    case 'quantity': $('productQty').value=Math.max(1,Math.min(99,Number($('productQty').value)+Number(id))); break;
    case 'removeCart': delete cart[id]; renderCartSummary(); if (Object.keys(cart).length) cartDialog(); else closeModal(); break;
    case 'filter': barFilter=id; renderBar(); break;
    case 'checkIn': checkIn(Number(id)); break;
    case 'bayDetail': bayDetail(Number(id)); break;
    case 'manual': manualOrder(Number(id)); break;
    case 'accept': case 'serve': await api('status',{id,status:action==='accept'?'preparing':'served'}); await refresh(); toast(action==='accept'?'Order accepted.':'Order marked as served.'); break;
    case 'cancel': cancelDialog(id); break;
    case 'settle': settle(Number(id)); break;
    case 'closeBay': { const b=getBay(Number(id)); await api('close',{bay:b.id,session:b.session}); closeModal(); await refresh(); toast(`Bay ${id} is available. QR ordering is now inactive.`); break; }
    case 'split': { const count=$('paymentLines').children.length; if(count<10) $('paymentLines').insertAdjacentHTML('beforeend',paymentLine(count)); break; }
    case 'receipt': receipt(id); break;
    case 'print': window.print(); break;
    case 'editProduct': editProduct(id); break;
    case 'availability': { const p=state.products.find(p=>p.id===id); await api('product',{id,available:!p.available}); await refresh(); toast('Availability updated.'); break; }
  }
}
document.addEventListener('click', async e => {
  const nav=e.target.closest('[data-view]'); if(nav) return station(nav.dataset.view);
  const b=e.target.closest('[data-action]'); if(!b || b.disabled) return;
  b.disabled=true;
  try { await act(b.dataset.action,b.dataset.id); } catch(error) { errorInForm(error); } finally { b.disabled=false; }
});
document.addEventListener('submit', async e => {
  e.preventDefault(); if (requestBusy) return;
  const form=e.target, d=new FormData(form), submit=form.querySelector('[type=submit]');
  if(!form.reportValidity()) return;
  requestBusy=true; if(submit) submit.disabled=true;
  try {
    switch(form.id) {
      case 'productForm': {
        const key=`${form.dataset.product}:${d.get('option')}`;
        cart[key]=Math.min(99,(cart[key]||0)+Number($('productQty').value)); closeModal(); renderCartSummary(); toast('Added to your order.'); break;
      }
      case 'cartForm': {
        const b=getBay();
        const result=await api('orders',{bay:currentBay,session:b?.session,key:orderKey,items:cartLines().map(l=>({product:l.product,option:l.option,qty:l.qty})),note:d.get('note'),mixers:d.get('mixers')});
        cart={}; orderKey=crypto.randomUUID(); closeModal(); await refresh(); toast(`#${result.id} sent to the bar. Keep your game going.`); tabDialog(); break;
      }
      case 'loginForm': await api('login',{role:d.get('role'),password:d.get('password')}); closeModal(); await refresh(); station(form.dataset.target); break;
      case 'checkInForm': await api('open',{bay:Number(form.dataset.bay),name:d.get('name'),phone:d.get('phone'),guests:Number(d.get('guests'))}); closeModal(); await refresh(); toast('Bay opened. QR ordering is active.'); break;
      case 'manualForm': {
        const b=getBay(Number(d.get('bay'))), items=[...form.querySelectorAll('[data-option]')].filter(i=>Number(i.value)>0).map(i=>({product:i.dataset.product,option:i.dataset.option,qty:Number(i.value)}));
        const result=await api('orders',{bay:b.id,session:b.session,key:form.dataset.key,items,note:d.get('note'),mixers:d.get('mixers')}); closeModal(); await refresh(); toast(`#${result.id} added to Bay ${b.id}.`); break;
      }
      case 'cancelForm': {
        const reason=d.get('reason')==='Other' ? d.get('details').trim() : `${d.get('reason')}${d.get('details') ? ': '+d.get('details') : ''}`;
        await api('status',{id:form.dataset.order,status:'cancelled',reason}); closeModal(); await refresh(); toast('Order cancelled. History preserved.'); break;
      }
      case 'paymentForm': {
        const payments=[...form.querySelectorAll('[data-payment]')].map((_,i)=>({method:d.get(`method${i}`),amount:Number(d.get(`amount${i}`)),reference:d.get(`reference${i}`)}));
        const result=await api('payment',{bay:Number(form.dataset.bay),session:form.dataset.session,payments}); closeModal(); await refresh(); receipt(result.id); break;
      }
      case 'adminForm': {
        const old=state.products.find(p=>p.id===form.dataset.product);
        const raw=d.get('options').trim();
        const options=raw ? raw.split('\n').filter(s=>s.trim()).map(line=>{
          const match=line.match(/^\s*([^:]+):\s*(\d+)\s*$/); if(!match) throw Error('Use one option per line, for example Tot: 300.');
          const label=match[1].trim(); return {id:old?.options.find(o=>o.label===label)?.id,label,price:Number(match[2])};
        }) : [];
        await api('product',{id:form.dataset.product,name:d.get('name'),cat:d.get('cat'),options,available:d.has('available'),active:d.has('active'),flag:d.get('flag')}); closeModal(); await refresh(); admin(); toast('Menu saved.'); break;
      }
    }
  } catch(error) { errorInForm(error); }
  finally { requestBusy=false; if(submit) submit.disabled=false; }
});
$('search').addEventListener('input',renderMenu);
document.addEventListener('input',e=>{ if(e.target.id==='manualSearch') document.querySelectorAll('[data-search]').forEach(el=>el.hidden=!el.dataset.search.includes(e.target.value.toLowerCase())); });
$('closeModal').onclick=closeModal;
$('modal').addEventListener('cancel',()=>{dialogRefresh=null;});
$('viewMenu').onclick=()=>$('menuArea').scrollIntoView({behavior:'smooth'});
$('viewTab').onclick=tabDialog;
$('viewCart').onclick=cartDialog;
$('manualBar').onclick=()=>manualOrder();
$('reportsButton').onclick=reports;
$('receiptsButton').onclick=receipts;
$('adminButton').onclick=admin;
$('qrButton').onclick=async()=>{
  try {
    const info=await api('qr-info');
    modal(`<h2>Bay QR codes.</h2><p>Print one code for each bay. Reception must open the bay before customers can order.</p><p class="hint">Website: ${esc(info.origin)}</p>${Object.entries(info.bays).map(([bay,url])=>`<div class="report-row"><strong>Bay ${esc(bay)}</strong><span>${esc(url)}</span></div>`).join('')}<div class="form-actions"><a class="btn" href="/api/qr-codes.pdf">DOWNLOAD PRINTABLE QR SHEET</a></div><p class="hint">Print at 100% scale, cut along the borders and place each code at its matching bay. If the website address changes, replace the printed codes.</p>`);
  } catch(error) { toast(error.message); }
};
$('logout').onclick=async()=>{try{await api('logout',{}); closeModal(); activeView='bay'; await refresh(); station('bay');}catch(error){toast(error.message);}};
async function boot() {
  await refresh();
  if(location.pathname==='/bar') station('bar');
  if(['/reception','/admin'].includes(location.pathname)) { if(location.pathname==='/admin' && state.role!=='admin') login('reception',true); else station('reception'); }
  eventSource=new EventSource('/api/events');
  eventSource.onmessage=()=>refresh();
  eventSource.onopen=()=>{$('connection').textContent='LIVE · NAIROBI';};
  eventSource.onerror=()=>{$('connection').textContent='RECONNECTING…';};
  setInterval(refresh,30000);
}
boot();
