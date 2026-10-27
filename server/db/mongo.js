// MongoDB repository. Documents use public string ids at the application edge,
// keeping the rest of the app independent from MongoDB's ObjectId type.
import { MongoClient, ObjectId } from 'mongodb';

const userView = (u) => u && ({ id: u._id.toString(), username: u.username, created_at: u.created_at, pass_hash: u.pass_hash,
  display_name: u.display_name || u.username, avatar_url: u.avatar_url || null, public_profile: !!u.public_profile, google_sub: u.google_sub || null });
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
  const friends = db.collection('friends');
  const resets = db.collection('password_resets');
  await Promise.all([
    users.createIndex({ username: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } }),
    users.createIndex({ google_sub: 1 }, { unique: true, sparse: true }),
    sessions.createIndex({ token_hash: 1 }, { unique: true }),
    sessions.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
    results.createIndex({ public_id: 1 }, { unique: true }),
    results.createIndex({ user_id: 1, created_at: -1 }),
    results.createIndex({ title_key: 1 }),
    friends.createIndex({ owner_id: 1, friend_id: 1 }, { unique: true }),
    resets.createIndex({ token_hash: 1 }, { unique: true }), resets.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
  ]);

  return {
    kind: 'mongo',
    file: `${uri.replace(/:\/\/[^@]+@/, '://***@')}/${dbName}`,
    migrate: async () => [],
    transaction: async (fn) => fn(),
    async createUser(username, passHash, email = null) {
      const row = { username, pass_hash: passHash, email: email || null, display_name: username, public_profile: false, created_at: Date.now() };
      const out = await users.insertOne(row);
      return { id: out.insertedId.toString(), username };
    },
    async findUserByName(username) { return userView(await users.findOne({ username }, { collation: { locale: 'en', strength: 2 } })); },
    async findUserByEmail(email) { return userView(await users.findOne({ email: String(email).toLowerCase() })); },
    async findUserById(id) {
      if (!ObjectId.isValid(id)) return null;
      return userView(await users.findOne({ _id: new ObjectId(id) }));
    },
    async findOrCreateGoogleUser({ sub, email, name, picture }) {
      let user = await users.findOne({ google_sub: sub });
      if (user) { await users.updateOne({ _id: user._id }, { $set: { email: email || user.email || null, avatar_url: picture || user.avatar_url || null } }); return userView({ ...user, email: email || user.email, avatar_url: picture || user.avatar_url }); }
      const base = (name || email?.split('@')[0] || 'player').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 24) || 'player';
      let username = base.length < 3 ? `player${base}`.slice(0, 24) : base;
      for (let n = 0; n < 50; n++) {
        try {
          const row = { username, google_sub: sub, email: email || null, display_name: name || username, avatar_url: picture || null, public_profile: false, created_at: Date.now() };
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
    async updateProfile(id, patch) { await users.updateOne({ _id: new ObjectId(id) }, { $set: patch }); return userView(await users.findOne({ _id: new ObjectId(id) })); },
    async publicProfile(username) {
      const user = await users.findOne({ username, public_profile: true }, { collation: { locale: 'en', strength: 2 } });
      if (!user) return null;
      return { user: userView(user), results: (await results.find({ user_id: user._id.toString() }).sort({ created_at: -1 }).limit(12).toArray()).map(resultView) };
    },
    async addFriend(ownerId, username) {
      const friend = await users.findOne({ username, public_profile: true }, { collation: { locale: 'en', strength: 2 } });
      if (!friend || friend._id.toString() === ownerId) return null;
      await friends.updateOne({ owner_id: ownerId, friend_id: friend._id.toString() }, { $setOnInsert: { created_at: Date.now() } }, { upsert: true }); return userView(friend);
    },
    async listFriends(ownerId) { const rows = await friends.find({ owner_id: ownerId }).toArray(); const ids = rows.map((r) => new ObjectId(r.friend_id)); return (await users.find({ _id: { $in: ids }, public_profile: true }).toArray()).map(userView); },
    removeFriend: (ownerId, friendId) => friends.deleteOne({ owner_id: ownerId, friend_id: friendId }),
    createPasswordReset: (tokenHash, userId, expiresAt) => resets.insertOne({ token_hash: tokenHash, user_id: userId, expires_at: expiresAt }),
    async consumePasswordReset(tokenHash, passHash) { const token = await resets.findOneAndDelete({ token_hash: tokenHash, expires_at: { $gt: Date.now() } }); if (!token) return false; await users.updateOne({ _id: new ObjectId(token.user_id) }, { $set: { pass_hash: passHash } }); return true; },
    async deleteUser(userId) { await Promise.all([sessions.deleteMany({ user_id: userId }), results.deleteMany({ user_id: userId }), friends.deleteMany({ $or: [{ owner_id: userId }, { friend_id: userId }] }), resets.deleteMany({ user_id: userId })]); return (await users.deleteOne({ _id: new ObjectId(userId) })).deletedCount > 0; },
    async stats(bins, filters = {}) {
      const query = {}; if (filters.title) query.title_key = filters.title; if (filters.source === 'real') query.is_seed = false; if (filters.source === 'seed') query.is_seed = true;
      const rows = await results.find(query, { projection: { title_key: 1, is_seed: 1, x: 1, y: 1 } }).toArray();
      const titles = {}, cells = new Map(); let seeded = 0;
      for (const r of rows) { titles[r.title_key] = (titles[r.title_key] || 0) + 1; if (r.is_seed) seeded++;
        const bx = Math.min(bins - 1, Math.floor(((r.x + 1) / 2) * bins)); const by = Math.min(bins - 1, Math.floor(((1 - r.y) / 2) * bins));
        const k = `${bx},${by}`; cells.set(k, (cells.get(k) || 0) + 1); }
      return { total: rows.length, seeded, titles, grid: [...cells].map(([k, n]) => [...k.split(',').map(Number), n]) };
    },
    async adminStats() { return { users: await users.countDocuments(), googleUsers: await users.countDocuments({ google_sub: { $exists: true } }), publicProfiles: await users.countDocuments({ public_profile: true }), results: await results.countDocuments(), friends: await friends.countDocuments() }; },
    close: () => client.close(),
  };
}
