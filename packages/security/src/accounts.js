export const findUserById = (db, id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

export function findUserByUsername(db, username) {
  const u = String(username || '').trim();
  if (!u) return null;
  return db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(u);
}
