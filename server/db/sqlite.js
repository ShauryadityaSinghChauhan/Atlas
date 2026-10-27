// SQLite repository backed by Node's built-in `node:sqlite` (no native deps).
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './migrations.js';

const rowToResult = (r) => r && ({
  publicId: r.public_id, userId: r.user_id, code: r.code, version: r.version,
  titleKey: r.title_key, primary: r.primary_id, x: r.x, y: r.y,
  scores: JSON.parse(r.scores), isSeed: !!r.is_seed, label: r.label || null, createdAt: r.created_at,
});

// node:sqlite prints an "ExperimentalWarning" on first load; silence just that one.
async function importSqlite() {
  const emit = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    if (/SQLite/i.test(String(warning?.message ?? warning))) return;
    emit.call(process, warning, ...rest);
  };
  try { return await import('node:sqlite'); } finally { process.emitWarning = emit; }
}

export async function sqliteAvailable() {
  try { await importSqlite(); return true; } catch { return false; }
}

export async function openSqlite(dataDir) {
  const { DatabaseSync } = await importSqlite();
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'playerprint.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');

  const tx = (fn) => {
    db.exec('BEGIN');
    try { const v = fn(); db.exec('COMMIT'); return v; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  function migrate() {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at INTEGER)');
    const done = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id));
    const applied = [];
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      tx(() => {
        db.exec(m.sql);
        db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, Date.now());
      });
      applied.push(m);
    }
    return applied;
  }
  migrate();

  const q = {
    insUser: db.prepare('INSERT INTO users (username, pass_hash, created_at) VALUES (?, ?, ?)'),
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    userById: db.prepare('SELECT *, COALESCE(display_name, username) AS display_name FROM users WHERE id = ?'),
    userByGoogleSub: db.prepare('SELECT *, COALESCE(display_name, username) AS display_name FROM users WHERE google_sub = ?'),
    insGoogleUser: db.prepare('INSERT INTO users (username, google_sub, email, created_at) VALUES (?, ?, ?, ?)'),
    insSession: db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
    session: db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?'),
    delSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    purge: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
    insResult: db.prepare(`INSERT INTO results (public_id, user_id, code, version, title_key, primary_id, x, y, scores, is_seed, created_at, label)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    byUser: db.prepare('SELECT * FROM results WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'),
    byPublic: db.prepare('SELECT * FROM results WHERE public_id = ?'),
    delResult: db.prepare('DELETE FROM results WHERE public_id = ? AND user_id = ?'),
    label: db.prepare('UPDATE results SET label = ? WHERE public_id = ? AND user_id = ?'),
    count: db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(is_seed), 0) AS seeded FROM results'),
    titles: db.prepare('SELECT title_key AS k, COUNT(*) AS n FROM results GROUP BY title_key'),
    grid: db.prepare(`SELECT MIN(:bins - 1, CAST((x + 1) / 2 * :bins AS INTEGER)) AS bx,
                             MIN(:bins - 1, CAST((1 - y) / 2 * :bins AS INTEGER)) AS by,
                             COUNT(*) AS n
                      FROM results GROUP BY bx, by`),
    recentDup: db.prepare('SELECT public_id FROM results WHERE code = ? AND user_id IS ? AND created_at > ? LIMIT 1'),
    claim: db.prepare('UPDATE results SET user_id = ? WHERE public_id = ? AND code = ? AND user_id IS NULL AND is_seed = 0 AND created_at > ?'),
    profile: db.prepare('SELECT *, COALESCE(display_name, username) AS display_name FROM users WHERE username = ? AND public_profile = 1'),
    profileResults: db.prepare('SELECT * FROM results WHERE user_id = ? ORDER BY created_at DESC LIMIT 12'),
    updProfile: db.prepare('UPDATE users SET display_name = ?, public_profile = ? WHERE id = ?'),
    addFriend: db.prepare('INSERT OR IGNORE INTO friends (owner_id, friend_id, created_at) VALUES (?, ?, ?)'),
    friendRows: db.prepare('SELECT u.*, COALESCE(u.display_name, u.username) AS display_name FROM friends f JOIN users u ON u.id = f.friend_id WHERE f.owner_id = ? AND u.public_profile = 1'),
    delFriend: db.prepare('DELETE FROM friends WHERE owner_id = ? AND friend_id = ?'),
  };

  return {
    kind: 'sqlite',
    file,
    migrate,
    transaction: tx,
    createUser(username, passHash) {
      const info = q.insUser.run(username, passHash, Date.now());
      return { id: Number(info.lastInsertRowid), username };
    },
    findUserByName: (u) => q.userByName.get(u) || null,
    findUserById: (id) => q.userById.get(id) || null,
    findOrCreateGoogleUser({ sub, email, name }) {
      const current = q.userByGoogleSub.get(sub);
      if (current) return current;
      const raw = (name || email?.split('@')[0] || 'player').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 24) || 'player';
      const base = raw.length < 3 ? `player${raw}`.slice(0, 24) : raw;
      for (let n = 0; n < 50; n++) {
        const username = n ? `${base.slice(0, 20)}_${n + 1}` : base;
        try { const out = q.insGoogleUser.run(username, sub, email || null, Date.now()); return { id: Number(out.lastInsertRowid), username }; }
        catch (err) { if (!/UNIQUE/.test(err.message)) throw err; const existing = q.userByGoogleSub.get(sub); if (existing) return existing; }
      }
      throw new Error('Could not choose a username for this Google account');
    },
    createSession: (h, userId, exp) => q.insSession.run(h, userId, Date.now(), exp),
    findSession: (h) => q.session.get(h) || null,
    deleteSession: (h) => q.delSession.run(h),
    purgeSessions: () => q.purge.run(Date.now()).changes,
    insertResult(r) {
      q.insResult.run(r.publicId, r.userId ?? null, r.code, r.version, r.titleKey, r.primary, r.x, r.y,
        JSON.stringify(r.scores), r.isSeed ? 1 : 0, r.createdAt ?? Date.now(), r.label ?? null);
      return r;
    },
    findRecentDuplicate: (code, userId, since) => q.recentDup.get(code, userId ?? null, since)?.public_id || null,
    getResult: (pid) => rowToResult(q.byPublic.get(pid)),
    claimResult: (pid, code, userId, since) => q.claim.run(userId, pid, code, since).changes > 0,
    listResultsByUser: (userId, limit = 100) => q.byUser.all(userId, limit).map(rowToResult),
    deleteResult: (pid, userId) => q.delResult.run(pid, userId).changes > 0,
    labelResult: (pid, userId, label) => q.label.run(label, pid, userId).changes > 0,
    updateProfile(id, patch) { q.updProfile.run(patch.display_name, patch.public_profile ? 1 : 0, id); return q.userById.get(id); },
    publicProfile(username) { const u = q.profile.get(username); return u ? { user: u, results: q.profileResults.all(u.id).map(rowToResult) } : null; },
    addFriend(ownerId, username) { const u = q.profile.get(username); if (!u || u.id === ownerId) return null; q.addFriend.run(ownerId, u.id, Date.now()); return u; },
    listFriends: (ownerId) => q.friendRows.all(ownerId),
    removeFriend: (ownerId, friendId) => q.delFriend.run(ownerId, friendId).changes > 0,
    stats(bins, filters = {}) {
      const clauses = [], values = [];
      if (filters.title) { clauses.push('title_key = ?'); values.push(filters.title); }
      if (filters.source === 'real') clauses.push('is_seed = 0');
      if (filters.source === 'seed') clauses.push('is_seed = 1');
      const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
      const { n, seeded } = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(is_seed), 0) AS seeded FROM results${where}`).get(...values);
      const titles = Object.fromEntries(db.prepare(`SELECT title_key AS k, COUNT(*) AS n FROM results${where} GROUP BY title_key`).all(...values).map((r) => [r.k, r.n]));
      const grid = db.prepare(`SELECT MIN(? - 1, CAST((x + 1) / 2 * ? AS INTEGER)) AS bx, MIN(? - 1, CAST((1 - y) / 2 * ? AS INTEGER)) AS by, COUNT(*) AS n FROM results${where} GROUP BY bx, by`).all(bins, bins, bins, bins, ...values).map((r) => [r.bx, r.by, r.n]);
      return { total: n, seeded, titles, grid };
    },
    adminStats() { return { users: db.prepare('SELECT COUNT(*) n FROM users').get().n, googleUsers: db.prepare('SELECT COUNT(*) n FROM users WHERE google_sub IS NOT NULL').get().n, publicProfiles: db.prepare('SELECT COUNT(*) n FROM users WHERE public_profile = 1').get().n, results: q.count.get().n, friends: db.prepare('SELECT COUNT(*) n FROM friends').get().n }; },
    close: () => db.close(),
  };
}
