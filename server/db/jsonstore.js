// Fallback repository for Node versions without `node:sqlite` (< 22.5).
// Same interface as sqlite.js; keeps everything in memory and persists
// atomically (write temp file + rename) on a short debounce.
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './migrations.js';

export async function openJsonStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'playerprint.json');
  let s = { users: [], sessions: {}, results: [], friends: [], nextUserId: 1, migrations: [] };
  if (fs.existsSync(file)) s = { ...s, ...JSON.parse(fs.readFileSync(file, 'utf8')) };

  let timer = null;
  const flush = () => {
    timer = null;
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, file);
  };
  const save = () => { if (!timer) timer = setTimeout(flush, 150); };
  process.on('exit', () => { if (timer) flush(); });

  function migrate() {
    // Schema is implicit in JSON; record ids so `npm run migrate` reports consistently.
    const done = new Set(s.migrations);
    const applied = MIGRATIONS.filter((m) => !done.has(m.id));
    for (const m of applied) s.migrations.push(m.id);
    if (applied.length) save();
    return applied;
  }
  migrate();

  const byName = (u) => s.users.find((x) => x.username.toLowerCase() === String(u).toLowerCase());

  return {
    kind: 'json',
    file,
    migrate,
    transaction: (fn) => fn(),
    createUser(username, passHash) {
      if (byName(username)) { const e = new Error('UNIQUE constraint failed: users.username'); e.code = 'ERR_SQLITE_ERROR'; throw e; }
      const u = { id: s.nextUserId++, username, pass_hash: passHash, display_name: username, public_profile: false, created_at: Date.now() };
      s.users.push(u); save();
      return { id: u.id, username };
    },
    findUserByName: (u) => byName(u) || null,
    findUserById(id) {
      const u = s.users.find((x) => x.id === id);
      return u ? { id: u.id, username: u.username, created_at: u.created_at } : null;
    },
    findOrCreateGoogleUser({ sub, email, name }) {
      let u = s.users.find((x) => x.google_sub === sub);
      if (u) return { id: u.id, username: u.username, created_at: u.created_at };
      const raw = (name || email?.split('@')[0] || 'player').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 24) || 'player';
      const base = raw.length < 3 ? `player${raw}`.slice(0, 24) : raw;
      for (let n = 0; n < 50; n++) {
        const username = n ? `${base.slice(0, 20)}_${n + 1}` : base;
        if (!byName(username)) { u = { id: s.nextUserId++, username, google_sub: sub, email: email || null, created_at: Date.now() }; s.users.push(u); save(); return { id: u.id, username: u.username, created_at: u.created_at }; }
      }
      throw new Error('Could not choose a username for this Google account');
    },
    createSession(h, userId, exp) { s.sessions[h] = { user_id: userId, expires_at: exp, created_at: Date.now() }; save(); },
    findSession: (h) => s.sessions[h] || null,
    deleteSession(h) { delete s.sessions[h]; save(); },
    purgeSessions() {
      let n = 0; const now = Date.now();
      for (const [k, v] of Object.entries(s.sessions)) if (v.expires_at < now) { delete s.sessions[k]; n++; }
      if (n) save();
      return n;
    },
    insertResult(r) {
      s.results.push({ ...r, userId: r.userId ?? null, createdAt: r.createdAt ?? Date.now(), label: r.label ?? null });
      save(); return r;
    },
    findRecentDuplicate(code, userId, since) {
      const r = s.results.find((x) => x.code === code && x.userId === (userId ?? null) && x.createdAt > since);
      return r ? r.publicId : null;
    },
    getResult: (pid) => s.results.find((r) => r.publicId === pid) || null,
    claimResult(pid, code, userId, since) {
      const r = s.results.find((x) => x.publicId === pid && x.code === code && x.userId === null && !x.isSeed && x.createdAt > since);
      if (!r) return false;
      r.userId = userId; save(); return true;
    },
    listResultsByUser: (userId, limit = 100) =>
      s.results.filter((r) => r.userId === userId).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit),
    deleteResult(pid, userId) {
      const i = s.results.findIndex((r) => r.publicId === pid && r.userId === userId);
      if (i < 0) return false;
      s.results.splice(i, 1); save(); return true;
    },
    labelResult(pid, userId, label) {
      const r = s.results.find((x) => x.publicId === pid && x.userId === userId);
      if (!r) return false;
      r.label = label; save(); return true;
    },
    updateProfile(id, patch) { const u = s.users.find((x) => x.id === id); if (!u) return null; Object.assign(u, patch); save(); return u; },
    publicProfile(username) { const u = s.users.find((x) => x.username.toLowerCase() === String(username).toLowerCase() && x.public_profile); return u ? { user: u, results: s.results.filter((r) => r.userId === u.id).sort((a, b) => b.createdAt - a.createdAt).slice(0, 12) } : null; },
    addFriend(ownerId, username) { const u = s.users.find((x) => x.username.toLowerCase() === String(username).toLowerCase() && x.public_profile); if (!u || u.id === ownerId) return null; if (!s.friends.some((f) => f.owner_id === ownerId && f.friend_id === u.id)) s.friends.push({ owner_id: ownerId, friend_id: u.id, created_at: Date.now() }); save(); return u; },
    listFriends: (ownerId) => s.friends.filter((f) => f.owner_id === ownerId).map((f) => s.users.find((u) => u.id === f.friend_id)).filter((u) => u?.public_profile),
    removeFriend(ownerId, friendId) { const i = s.friends.findIndex((f) => f.owner_id === ownerId && f.friend_id === Number(friendId)); if (i < 0) return false; s.friends.splice(i, 1); save(); return true; },
    deleteUser(userId) { const i = s.users.findIndex((u) => u.id === userId); if (i < 0) return false; s.users.splice(i, 1); s.results = s.results.filter((r) => r.userId !== userId); s.friends = s.friends.filter((f) => f.owner_id !== userId && f.friend_id !== userId); for (const [key, value] of Object.entries(s.sessions)) if (value.user_id === userId) delete s.sessions[key]; save(); return true; },
    stats(bins, filters = {}) {
      const titles = {}, cells = new Map();
      let seeded = 0;
      const rows = s.results.filter((r) => (!filters.title || r.titleKey === filters.title) && (!filters.source || (filters.source === 'real' ? !r.isSeed : r.isSeed)));
      for (const r of rows) {
        titles[r.titleKey] = (titles[r.titleKey] || 0) + 1;
        if (r.isSeed) seeded++;
        const bx = Math.min(bins - 1, Math.floor(((r.x + 1) / 2) * bins));
        const by = Math.min(bins - 1, Math.floor(((1 - r.y) / 2) * bins));
        const k = `${bx},${by}`;
        cells.set(k, (cells.get(k) || 0) + 1);
      }
      const grid = [...cells].map(([k, n]) => [...k.split(',').map(Number), n]);
      return { total: rows.length, seeded, titles, grid };
    },
    adminStats() { return { users: s.users.length, googleUsers: s.users.filter((u) => u.google_sub).length, publicProfiles: s.users.filter((u) => u.public_profile).length, results: s.results.length, friends: s.friends.length }; },
    close: () => { if (timer) { clearTimeout(timer); flush(); } },
  };
}
