import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Optional `.env` file (KEY=VALUE lines). Real environment variables win.
try {
  const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* no .env — defaults apply */ }

const env = process.env;
export const config = {
  port: Number(env.PORT) || 3000,
  host: env.HOST || '0.0.0.0',
  // Where the SQLite file (or JSON fallback) lives.
  dataDir: path.resolve(ROOT, env.DATA_DIR || 'data'),
  // 'mongo' | 'sqlite' | 'json' | 'auto'. Mongo is selected when MONGO_URI is set.
  store: env.STORE || (env.MONGO_URI || env.MONGODB_URI ? 'mongo' : 'auto'),
  // MONGODB_URI is accepted as the conventional alias used by Atlas tooling.
  mongoUri: env.MONGO_URI || env.MONGODB_URI || '',
  mongoDb: env.MONGO_DB || 'playerprint',
  // Set to 1 when served over HTTPS so the session cookie gets `Secure`.
  secureCookies: env.SECURE_COOKIES === '1',
  sessionDays: Number(env.SESSION_DAYS) || 30,
  // Seed simulated players + the demo account on first boot.
  seedOnBoot: env.SEED !== '0',
  seedPlayers: Number(env.SEED_PLAYERS) || 640,
  publicUrl: env.PUBLIC_URL || '',
  googleClientId: env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: env.GOOGLE_CLIENT_SECRET || '',
  googleRedirectUri: env.GOOGLE_REDIRECT_URI || '',
  // Comma-separated usernames allowed to view /admin (for example: ADMIN_USERNAMES=alice,bob).
  adminUsernames: new Set((env.ADMIN_USERNAMES || '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean)),
  cloudinaryCloudName: env.CLOUDINARY_CLOUD_NAME || '',
  cloudinaryApiKey: env.CLOUDINARY_API_KEY || '',
  cloudinaryApiSecret: env.CLOUDINARY_API_SECRET || '',
  resetBaseUrl: env.RESET_BASE_URL || env.PUBLIC_URL || '',
  resendApiKey: env.RESEND_API_KEY || '',
  emailFrom: env.EMAIL_FROM || '',
};
