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
  try {
    const { handle } = await app();
    return handle(req, res);
  } catch (err) {
    // Do not let a missing production setting turn into Vercel's opaque
    // FUNCTION_INVOCATION_FAILED page. The detailed cause stays in function
    // logs, while callers get a safe, actionable response.
    console.error('[startup]', err);
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      error: 'The service is not ready. Check Vercel function logs and MongoDB production environment variables.',
      code: 'startup_failed',
    }));
  }
}
