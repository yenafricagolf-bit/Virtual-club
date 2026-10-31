import { mutate, Problem } from './domain.mjs';

export async function readClub(db) {
  const row = await db.prepare('SELECT payload, version FROM club WHERE id = 1').first();
  if (!row) throw new Problem('Database setup is incomplete. Apply the D1 migrations.', 503);
  return { state: JSON.parse(row.payload), version: row.version };
}

// Each update atomically compares the persisted version. A competing write reloads and
// revalidates the operation; Workers never overwrite another station's order/payment.
export async function updateClub(db, action, data, role) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const { state, version } = await readClub(db);
    const { result, changed } = mutate(state, action, data, role);
    if (!changed) return result;
    const payload = JSON.stringify(state);
    if (new TextEncoder().encode(payload).length > 1500000) {
      throw new Problem('The pilot history is reaching its storage limit. Export/archive history before adding more records.', 507);
    }
    const update = await db.prepare('UPDATE club SET payload = ?, version = version + 1 WHERE id = 1 AND version = ?')
      .bind(payload, version).run();
    if (update.meta.changes === 1) return result;
    await new Promise(resolve => setTimeout(resolve, 10 + Math.random() * 40));
  }
  throw new Problem('Another station is updating this tab. Please retry.', 409);
}
