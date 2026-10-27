// MongoDB repository. Documents use public string ids at the application edge,
// keeping the rest of the app independent from MongoDB's ObjectId type.
import { MongoClient, ObjectId } from 'mongodb';

const userView = (u) => u && ({ id: u._id.toString(), username: u.username, created_at: u.created_at, pass_hash: u.pass_hash });
const resultView = (r) => r && ({
  publicId: r.public_id, userId: r.user_id ?? null, code: r.code, version: r.version,
  titleKey: r.title_key, primary: r.primary_id, x: r.x, y: r.y, scores: r.scores,
  isSeed: !!r.is_seed, label: r.label ?? null, createdAt: r.created_at,
});

export async function openMongoStore({ uri, dbName = 'playerprint' }) {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  const users = db.collection('users');
  const sessions = db.collection('sessions');
  const results = db.collection('results');
  await Promise.all([
    users.createIndex({ username: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } }),
    users.createIndex({ google_sub: 1 }, { unique: true, sparse: true }),
    sessions.createIndex({ token_hash: 1 }, { unique: true }),
    sessions.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
    results.createIndex({ public_id: 1 }, { unique: true }),
    results.createIndex({ user_id: 1, created_at: -1 }),
    results.createIndex({ title_key: 1 }),
  ]);

  return {
    kind: 'mongo',
    file: `${uri.replace(/:\/\/[^@]+@/, '://***@')}/${dbName}`,
    migrate: async () => [],
    transaction: async (fn) => fn(),
    async createUser(username, passHash) {
      const row = { username, pass_hash: passHash, created_at: Date.now() };
      const out = await users.insertOne(row);
      return { id: out.insertedId.toString(), username };
    },
    async findUserByName(username) { return userView(await users.findOne({ username }, { collation: { locale: 'en', strength: 2 } })); },
    async findUserById(id) {
      if (!ObjectId.isValid(id)) return null;
      return userView(await users.findOne({ _id: new ObjectId(id) }));
    },
    async findOrCreateGoogleUser({ sub, email, name }) {
      let user = await users.findOne({ google_sub: sub });
      if (user) return userView(user);
      const base = (name || email?.split('@')[0] || 'player').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 24) || 'player';
      let username = base.length < 3 ? `player${base}`.slice(0, 24) : base;
      for (let n = 0; n < 50; n++) {
        try {
          const row = { username, google_sub: sub, email: email || null, created_at: Date.now() };
          const out = await users.insertOne(row);
          return userView({ ...row, _id: out.insertedId });
        } catch (err) {
          if (err?.code === 11000 && String(err.message).includes('google_sub')) {
            user = await users.findOne({ google_sub: sub });
            if (user) return userView(user);
          } else if (err?.code === 11000) username = `${base.slice(0, Math.max(1, 21 - String(n + 2).length))}_${n + 2}`;
          else throw err;
        }
      }
      throw new Error('Could not choose a username for this Google account');
    },
    createSession: (tokenHash, userId, expiresAt) => sessions.insertOne({ token_hash: tokenHash, user_id: userId, created_at: Date.now(), expires_at: expiresAt }),
    async findSession(tokenHash) { return sessions.findOne({ token_hash: tokenHash }); },
    deleteSession: (tokenHash) => sessions.deleteOne({ token_hash: tokenHash }),
    async purgeSessions() { return (await sessions.deleteMany({ expires_at: { $lt: Date.now() } })).deletedCount; },
    async insertResult(r) {
      await results.insertOne({ public_id: r.publicId, user_id: r.userId ?? null, code: r.code, version: r.version,
        title_key: r.titleKey, primary_id: r.primary, x: r.x, y: r.y, scores: r.scores,
        is_seed: !!r.isSeed, created_at: r.createdAt ?? Date.now(), label: r.label ?? null });
      return r;
    },
    async findRecentDuplicate(code, userId, since) { return (await results.findOne({ code, user_id: userId ?? null, created_at: { $gt: since } }))?.public_id || null; },
    async getResult(publicId) { return resultView(await results.findOne({ public_id: publicId })); },
    async claimResult(publicId, code, userId, since) { return (await results.updateOne({ public_id: publicId, code, user_id: null, is_seed: false, created_at: { $gt: since } }, { $set: { user_id: userId } })).modifiedCount > 0; },
    async listResultsByUser(userId, limit = 100) { return (await results.find({ user_id: userId }).sort({ created_at: -1 }).limit(limit).toArray()).map(resultView); },
    async deleteResult(publicId, userId) { return (await results.deleteOne({ public_id: publicId, user_id: userId })).deletedCount > 0; },
    async labelResult(publicId, userId, label) { return (await results.updateOne({ public_id: publicId, user_id: userId }, { $set: { label } })).modifiedCount > 0; },
    async stats(bins) {
      const rows = await results.find({}, { projection: { title_key: 1, is_seed: 1, x: 1, y: 1 } }).toArray();
      const titles = {}, cells = new Map(); let seeded = 0;
      for (const r of rows) { titles[r.title_key] = (titles[r.title_key] || 0) + 1; if (r.is_seed) seeded++;
        const bx = Math.min(bins - 1, Math.floor(((r.x + 1) / 2) * bins)); const by = Math.min(bins - 1, Math.floor(((1 - r.y) / 2) * bins));
        const k = `${bx},${by}`; cells.set(k, (cells.get(k) || 0) + 1); }
      return { total: rows.length, seeded, titles, grid: [...cells].map(([k, n]) => [...k.split(',').map(Number), n]) };
    },
    close: () => client.close(),
  };
}
