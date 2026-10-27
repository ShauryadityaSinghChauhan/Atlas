// Vercel serverless entry point. Reuse the initialized Mongo connection and
// application handler while an instance stays warm.
import { config } from '../server/config.js';
import { openStore } from '../server/db/index.js';
import { createApp } from '../server/app.js';
import { seedIfEmpty } from '../server/seed.js';

let appPromise;
async function app() {
  if (!appPromise) appPromise = (async () => {
    // Serverless filesystems are ephemeral: a Vercel deploy must use MongoDB.
    if (config.store !== 'mongo' || !config.mongoUri) {
      throw new Error('Vercel deployment requires STORE=mongo and MONGODB_URI (or MONGO_URI).');
    }
    const store = await openStore(config);
    if (config.seedOnBoot) await seedIfEmpty(store, { players: config.seedPlayers });
    return createApp({ store, config });
  })().catch((err) => { appPromise = null; throw err; });
  return appPromise;
}

export default async function handler(req, res) {
  const { handle } = await app();
  return handle(req, res);
}
