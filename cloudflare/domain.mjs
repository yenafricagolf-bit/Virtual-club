// Business rules shared by every Pages Function invocation. No mutable process state.
export class Problem extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function requireThat(test, message, status = 400) {
  if (!test) throw new Problem(message, status);
}
export function integer(value, low = 1, high = 100000000) {
  requireThat(Number.isSafeInteger(value) && value >= low && value <= high, 'Invalid whole-number amount or quantity.');
  return value;
}
export function text(value, limit = 500) {
  requireThat(typeof value === 'string' && value.length <= limit, 'Invalid text field.');
  return value.trim();
}
export const roles = ['bar', 'reception', 'admin'];
export const ordersFor = (s, sid) => s.orders.filter(o => o.session === sid);
export const due = (s, sid) => ordersFor(s, sid).filter(o => o.status !== 'cancelled').reduce((sum, o) => sum + o.total, 0)
  - s.payments.filter(p => p.session === sid).reduce((sum, p) => sum + p.amount, 0);
export function getBay(s, id) {
  integer(id, 1, 1000);
  const bay = s.bays.find(b => b.id === id);
  requireThat(bay, 'Bay not found.', 404);
  return bay;
}
export function snapshot(s, role, bid, version) {
  const result = { products: s.products.filter(p => p.active || role === 'admin'), role, version, updates: 'poll', poll_interval: 5000 };
  if (role) {
    result.bays = role === 'bar' ? s.bays.map(({ name, phone, ...b }) => b) : s.bays;
    result.orders = s.orders;
    if (role !== 'bar') Object.assign(result, { payments: s.payments, sessions: s.sessions });
    if (role === 'admin') result.audit = s.audit;
  } else if (bid !== null) {
    const b = getBay(s, bid);
    result.bays = [{ id: b.id, active: b.active, session: b.session }];
    result.orders = b.active ? ordersFor(s, b.session) : [];
    result.payments = b.active ? s.payments.filter(p => p.session === b.session).map(p => ({ amount: p.amount, session: p.session })) : [];
  } else Object.assign(result, { bays: [], orders: [], payments: [] });
  return result;
}
export function mutate(s, action, d, role, now = Date.now()) {
  requireThat(d && typeof d === 'object' && !Array.isArray(d), 'JSON object required.');
  let result;
  if (action === 'orders') {
    const b = getBay(s, d.bay);
    requireThat(b.active, 'This bay is not currently checked in.', 409);
    requireThat(d.session === b.session, 'This bay session changed. Reload before ordering.', 409);
    const key = text(d.key || '', 100);
    requireThat(key.length >= 12, 'An order request key is required.');
    const previous = ordersFor(s, b.session).find(o => o.key === key);
    if (previous) return { result: { id: previous.id }, changed: false };
    requireThat(Array.isArray(d.items) && d.items.length > 0 && d.items.length <= 100, 'Add at least one item (maximum 100 lines).');
    const items = d.items.map(line => {
      requireThat(line && typeof line === 'object' && !Array.isArray(line), 'Invalid order item.');
      const p = s.products.find(p => p.id === line.product);
      requireThat(p && p.active && p.available, 'An item is unavailable.', 409);
      const o = p.options.find(o => o.id === line.option);
      requireThat(o, 'Select a valid product option.');
      return { product: p.id, option: o.id, name: p.name, serving: o.label, qty: integer(line.qty, 1, 99), price: o.price };
    });
    const id = 'VC' + String(s.seq++).padStart(3, '0');
    s.orders.push({ id, bay: b.id, session: b.session, key, items, total: items.reduce((sum, i) => sum + i.qty * i.price, 0), note: text(d.note || ''), mixers: text(d.mixers || '', 200), source: role ? role.toUpperCase() : 'CUSTOMER', status: 'new', created: now, accepted: null, served: null });
    result = { id };
  } else {
    requireThat(role, 'Staff sign-in required.', 401);
    if (action === 'status') {
      requireThat(['bar', 'admin'].includes(role), 'Only Bar staff can fulfil orders.', 403);
      const o = s.orders.find(o => o.id === d.id);
      requireThat(o, 'Order not found.', 404);
      requireThat(({ new: ['preparing', 'cancelled'], preparing: ['served', 'cancelled'] }[o.status] || []).includes(d.status), 'Invalid order transition.', 409);
      if (d.status === 'cancelled') {
        const reason = text(d.reason || '', 200);
        requireThat(reason, 'A cancellation reason is required.');
        requireThat(due(s, o.session) >= o.total, 'This order has been paid. Refund processing is required before cancellation.', 409);
        Object.assign(o, { reason, cancelled: now });
      } else o[d.status === 'preparing' ? 'accepted' : 'served'] = now;
      o.status = d.status;
      result = { id: o.id };
    } else if (['open', 'close', 'payment'].includes(action)) {
      requireThat(['reception', 'admin'].includes(role), 'Reception permission required.', 403);
      const b = getBay(s, d.bay);
      if (action === 'open') {
        requireThat(!b.active, 'Bay is already open.', 409);
        const name = text(d.name || '', 100);
        requireThat(name, 'Customer name is required.');
        Object.assign(b, { active: true, session: crypto.randomUUID(), name, phone: text(d.phone || '', 40), guests: integer(d.guests, 1, 50), opened: now });
        s.sessions.push({ ...b, closed: null });
      } else {
        requireThat(b.active && d.session === b.session, 'Bay session changed.', 409);
        requireThat(!ordersFor(s, b.session).some(o => ['new', 'preparing'].includes(o.status)), 'Serve or cancel all active orders before settlement or closing.', 409);
        if (action === 'payment') {
          requireThat(Array.isArray(d.payments) && d.payments.length > 0 && d.payments.length <= 10, 'Provide payment details.');
          const total = due(s, b.session);
          requireThat(total > 0, 'There is no outstanding balance.', 409);
          const payments = d.payments.map(p => {
            requireThat(p && typeof p === 'object' && !Array.isArray(p), 'Invalid payment.');
            requireThat(['M-Pesa', 'Card', 'Cash'].includes(p.method), 'Invalid payment method.');
            const reference = text(p.reference || '', 100);
            requireThat(p.method !== 'M-Pesa' || reference, 'M-Pesa reference is required.');
            return { method: p.method, reference, amount: integer(p.amount) };
          });
          requireThat(payments.reduce((sum, p) => sum + p.amount, 0) === total, 'Payments must equal the outstanding balance.');
          const receipt = 'RC' + String(s.payments.length + 1).padStart(5, '0');
          const billed = new Set(s.payments.filter(p => p.session === b.session).flatMap(p => p.order_ids || []));
          const order_ids = ordersFor(s, b.session).filter(o => o.status !== 'cancelled' && !billed.has(o.id)).map(o => o.id);
          s.payments.push(...payments.map(p => ({ ...p, bay: b.id, session: b.session, receipt, order_ids, time: now })));
          result = { id: receipt };
        } else {
          requireThat(due(s, b.session) === 0, 'Settle the unpaid balance before closing.', 409);
          s.sessions.find(x => x.session === b.session).closed = now;
          Object.assign(b, { active: false, session: null, name: '', phone: '', guests: 0, opened: null });
        }
      }
      result ||= { bay: b.id };
    } else if (action === 'product') {
      requireThat(['bar', 'admin'].includes(role), 'Menu permission required.', 403);
      let p = s.products.find(p => p.id === d.id);
      if (role === 'bar') {
        requireThat(p && typeof d.available === 'boolean', 'Invalid product.');
        requireThat(!d.available || p.options.length, 'Set a confirmed price before enabling a product.');
        p.available = d.available;
      } else {
        const name = text(d.name || '', 120), cat = text(d.cat || '', 60);
        requireThat(name && cat, 'Name and category are required.');
        requireThat(Array.isArray(d.options) && d.options.length <= 5, 'Invalid product options.');
        const options = d.options.map(o => {
          requireThat(o && typeof o === 'object' && !Array.isArray(o), 'Invalid product option.');
          const label = text(o.label || '', 30);
          requireThat(label, 'Option label is required.');
          return { id: o.id ? text(o.id, 100) : crypto.randomUUID(), label, price: integer(o.price) };
        });
        requireThat(new Set(options.map(o => o.id)).size === options.length, 'Duplicate option identifiers.');
        requireThat(typeof d.available === 'boolean' && typeof d.active === 'boolean', 'Invalid availability.');
        requireThat(!d.available || options.length, 'Set a confirmed price before enabling a product.');
        const values = { name, cat, options, active: d.active, available: d.available, flag: text(d.flag || '', 200) };
        if (p) Object.assign(p, values);
        else { p = { id: crypto.randomUUID(), ...values }; s.products.push(p); }
      }
      result = { id: p.id };
    } else throw new Problem('Unknown action.', 404);
  }
  s.audit.push({ at: now, actor: role || 'customer', action, subject: result.id || result.bay });
  return { result, changed: true };
}
