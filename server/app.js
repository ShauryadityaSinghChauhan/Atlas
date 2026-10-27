// HTTP application: API routes, security headers, SPA shell with per-result
// Open Graph tags. Everything is plain `node:http`.
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from './config.js';
import { HttpError, createRouter, sendJson, readJson, clientIp, parseCookies, serializeCookie } from './http.js';
import { createSessionService, hashPassword, verifyPassword, burnHash, validateCredentials, GOOGLE_STATE_COOKIE } from './auth.js';
import { createRateLimiter } from './ratelimit.js';
import { createStatic } from './static.js';
import { analyze, decodeCode, CODE_RE, QUESTIONS } from '../shared/engine.js';
import { describeShort } from '../shared/content.js';

const STATS_BINS = 20;
const STATS_TTL = 15_000;
const newPublicId = () => crypto.randomBytes(6).toString('base64url');

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://res.cloudinary.com",
  "connect-src 'self' https://api.cloudinary.com",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

/** Summary for API responses — derived fields only, never other users' data. */
function toPublicResult(row) {
  return {
    publicId: row.publicId, code: row.code, titleKey: row.titleKey, primary: row.primary,
    x: row.x, y: row.y, scores: row.scores, label: row.label || null, createdAt: row.createdAt,
  };
}
function toUser(row) {
  return { id: row.id, username: row.username, displayName: row.display_name || row.username,
    avatarUrl: row.avatar_url || null, publicProfile: !!row.public_profile, googleSub: row.google_sub || null, createdAt: row.created_at };
}

export function createApp({ store, config }) {
  const sessions = createSessionService(store, config);
  const limiter = createRateLimiter({
    auth: { windowMs: 60_000, max: 12 },
    results: { windowMs: 60_000, max: 30 },
    write: { windowMs: 60_000, max: 60 },
  });
  const statics = createStatic([
    ['/shared/', path.join(ROOT, 'shared')],
    ['/', path.join(ROOT, 'public')],
  ]);
  let statsCache = null;

  const limit = (bucket, req) => {
    const wait = limiter.check(bucket, clientIp(req));
    if (wait) throw new HttpError(429, `Slow down — try again in ${wait}s`, 'rate_limited');
  };
  const requireUser = async (req) => {
    const u = await sessions.user(req);
    if (!u) throw new HttpError(401, 'Sign in required', 'unauthenticated');
    return u;
  };
  const requireAdmin = async (req) => {
    const u = await requireUser(req);
    if (!config.adminUsernames.has(String(u.username).toLowerCase())) throw new HttpError(403, 'Admin access required', 'forbidden');
    return u;
  };

  /* ------------------------------ API ------------------------------ */
  const api = createRouter();

  api.get('/api/health', () => ({ ok: true, store: store.kind, questions: QUESTIONS.length }));

  api.get('/api/me', async (req) => {
    const u = await sessions.user(req);
    return { user: u ? toUser(u) : null };
  });

  api.post('/api/auth/register', async (req, res) => {
    limit('auth', req);
    const body = await readJson(req); const { username, password } = validateCredentials(body);
    if (await store.findUserByName(username)) throw new HttpError(409, 'That username is taken', 'username_taken');
    let user;
    try { user = await store.createUser(username, await hashPassword(password)); } catch (e) {
      if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'That username is taken', 'username_taken');
      throw e;
    }
    await sessions.issue(res, user.id);
    return [201, { user: toUser(user) }];
  });

  api.post('/api/auth/login', async (req, res) => {
    limit('auth', req);
    const body = await readJson(req);
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const row = username ? await store.findUserByName(username) : null;
    if (!row) { await burnHash(password); throw new HttpError(401, 'Wrong username or password', 'bad_credentials'); }
    if (!row.pass_hash || !(await verifyPassword(password, row.pass_hash))) throw new HttpError(401, 'Wrong username or password', 'bad_credentials');
    await sessions.issue(res, row.id);
    return { user: toUser(row) };
  });

  // OAuth uses authorization-code flow. The short-lived state cookie binds the
  // callback to the browser that started it and prevents login CSRF.
  api.get('/api/auth/google', (req, res) => {
    if (!config.googleClientId || !config.googleClientSecret || !config.googleRedirectUri) {
      throw new HttpError(503, 'Google sign-in is not configured', 'google_not_configured');
    }
    const state = crypto.randomBytes(32).toString('base64url');
    res.setHeader('Set-Cookie', serializeCookie(GOOGLE_STATE_COOKIE, state, { maxAge: 600, secure: config.secureCookies }));
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: config.googleClientId, redirect_uri: config.googleRedirectUri,
      response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account' }).toString();
    res.writeHead(302, { Location: url.toString(), 'Cache-Control': 'no-store' }); res.end();
  });

  api.get('/api/auth/google/callback', async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const savedState = parseCookies(req.headers.cookie)[GOOGLE_STATE_COOKIE];
    if (!code || !state || !savedState || state.length !== savedState.length
      || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(savedState))) {
      throw new HttpError(400, 'Google sign-in could not be verified. Please try again.', 'bad_google_state');
    }
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: config.googleClientId, client_secret: config.googleClientSecret,
        redirect_uri: config.googleRedirectUri, grant_type: 'authorization_code' }) });
    if (!tokenResponse.ok) throw new HttpError(401, 'Google sign-in was declined', 'google_denied');
    const tokens = await tokenResponse.json();
    const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokens.id_token || '')}`);
    if (!verify.ok) throw new HttpError(401, 'Google identity could not be verified', 'bad_google_token');
    const profile = await verify.json();
    if (profile.aud !== config.googleClientId || profile.iss !== 'https://accounts.google.com' || profile.email_verified !== 'true' || !profile.sub) {
      throw new HttpError(401, 'Google identity could not be verified', 'bad_google_token');
    }
    const user = await store.findOrCreateGoogleUser({ sub: profile.sub, email: profile.email, name: profile.name, picture: profile.picture });
    await sessions.issue(res, user.id);
    const cookies = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', [cookies, serializeCookie(GOOGLE_STATE_COOKIE, '', { maxAge: 0, secure: config.secureCookies })].filter(Boolean));
    res.writeHead(302, { Location: '/me', 'Cache-Control': 'no-store' }); res.end();
  });

  api.post('/api/auth/logout', async (req, res) => { await sessions.revoke(req, res); return { ok: true }; });

  api.patch('/api/profile', async (req) => {
    limit('write', req); const u = await requireUser(req); const body = await readJson(req);
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 40) : u.display_name || u.username;
    const publicProfile = typeof body.publicProfile === 'boolean' ? body.publicProfile : !!u.public_profile;
    const avatarUrl = body.removeAvatar === true ? null : (typeof body.avatarUrl === 'string' && /^https:\/\/res\.cloudinary\.com\//.test(body.avatarUrl) ? body.avatarUrl.slice(0, 1000) : u.avatar_url || null);
    const updated = await store.updateProfile(u.id, { display_name: displayName || u.username, public_profile: publicProfile, avatar_url: avatarUrl });
    return { user: toUser(updated) };
  });
  api.post('/api/profile/upload-signature', async (req) => {
    limit('write', req); const u = await requireUser(req);
    if (!config.cloudinaryCloudName || !config.cloudinaryApiKey || !config.cloudinaryApiSecret) throw new HttpError(503, 'Profile image uploads are not configured', 'cloudinary_not_configured');
    const timestamp = Math.floor(Date.now() / 1000); const folder = 'playerprint/profiles'; const publicId = `user-${u.id}`; const overwrite = 'true';
    const toSign = `folder=${folder}&overwrite=${overwrite}&public_id=${publicId}&timestamp=${timestamp}${config.cloudinaryApiSecret}`;
    const signature = crypto.createHash('sha1').update(toSign).digest('hex');
    return { cloudName: config.cloudinaryCloudName, apiKey: config.cloudinaryApiKey, timestamp, folder, publicId, overwrite, signature };
  });
  // Relay the image through the signed-in server. This avoids browser/CORS
  // restrictions while still keeping Cloudinary credentials private.
  api.post('/api/profile/image', async (req) => {
    limit('write', req); const u = await requireUser(req);
    if (!config.cloudinaryCloudName || !config.cloudinaryApiKey || !config.cloudinaryApiSecret) throw new HttpError(503, 'Profile image uploads are not configured', 'cloudinary_not_configured');
    const { dataUrl } = await readJson(req, 3 * 1024 * 1024);
    const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
    if (!m) throw new HttpError(400, 'Choose a PNG, JPG, or WebP image', 'bad_image');
    const bytes = Buffer.from(m[2], 'base64');
    if (!bytes.length || bytes.length > 2 * 1024 * 1024) throw new HttpError(413, 'Choose an image smaller than 2 MB', 'image_too_large');
    const timestamp = Math.floor(Date.now() / 1000), folder = 'playerprint/profiles', publicId = `user-${u.id}`, overwrite = 'true';
    const signature = crypto.createHash('sha1').update(`folder=${folder}&overwrite=${overwrite}&public_id=${publicId}&timestamp=${timestamp}${config.cloudinaryApiSecret}`).digest('hex');
    const form = new FormData();
    form.set('file', new Blob([bytes], { type: m[1] }), `profile.${m[1].split('/')[1]}`);
    for (const [key, value] of Object.entries({ api_key: config.cloudinaryApiKey, timestamp: String(timestamp), folder, public_id: publicId, overwrite, signature })) form.set(key, value);
    let response; try { response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(config.cloudinaryCloudName)}/image/upload`, { method: 'POST', body: form }); } catch { throw new HttpError(502, 'Could not reach the image service', 'cloudinary_unavailable'); }
    const out = await response.json().catch(() => ({}));
    if (!response.ok || !out.secure_url) throw new HttpError(502, out.error?.message || 'Image upload failed', 'cloudinary_upload_failed');
    const updated = await store.updateProfile(u.id, { display_name: u.display_name || u.username, public_profile: !!u.public_profile, avatar_url: out.secure_url });
    return { avatarUrl: out.secure_url, user: toUser(updated) };
  });
  api.get('/api/account/export', async (req) => { const u = await requireUser(req); return { exportedAt: Date.now(), profile: toUser(u), results: (await store.listResultsByUser(u.id, 500)).map(toPublicResult), friends: (await store.listFriends(u.id)).map(toUser) }; });
  api.delete('/api/account', async (req, res) => { const u = await requireUser(req); if (!store.deleteUser || !(await store.deleteUser(u.id))) throw new HttpError(500, 'Could not delete account', 'delete_failed'); await sessions.revoke(req, res); return { ok: true }; });
  api.get('/api/players/:username', async (_req, _res, { username }) => {
    const profile = await store.publicProfile(username);
    if (!profile) throw new HttpError(404, 'This player has not published a profile', 'not_found');
    return { player: toUser(profile.user), results: profile.results.map(toPublicResult) };
  });
  api.get('/api/friends', async (req) => ({ friends: (await store.listFriends((await requireUser(req)).id)).map(toUser) }));
  api.post('/api/friends', async (req) => {
    limit('write', req); const u = await requireUser(req); const body = await readJson(req);
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const friend = username && await store.addFriend(u.id, username);
    if (!friend) throw new HttpError(404, 'That public player was not found', 'not_found');
    return { friend: toUser(friend) };
  });
  api.delete('/api/friends/:id', async (req, _res, { id }) => { const u = await requireUser(req); if (!(await store.removeFriend(u.id, id))) throw new HttpError(404, 'Friend not found', 'not_found'); return { ok: true }; });
  api.get('/api/admin/stats', async (req) => { await requireAdmin(req); return { ...(await store.adminStats()), generatedAt: Date.now() }; });

  // Submit a finished run. Anyone may submit (feeds the anonymous atlas);
  // signed-in users also get it attached to their history.
  api.post('/api/results', async (req) => {
    limit('results', req);
    const body = await readJson(req);
    const answers = decodeCode(body.code);
    if (!answers) throw new HttpError(400, 'Invalid result code', 'bad_code');
    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 40) || null : null;
    const user = await sessions.user(req);
    // Claim: a guest who finishes, then signs up and saves, adopts their own
    // anonymous row (proved by its unguessable publicId) instead of creating a
    // second one — so the population atlas never double-counts them.
    if (user && typeof body.claim === 'string' && body.claim.length <= 16
      && await store.claimResult(body.claim, body.code, user.id, Date.now() - 24 * 3600_000)) {
      statsCache = null;
      return { result: toPublicResult(await store.getResult(body.claim)), saved: true, claimed: true };
    }
    // Idempotency: the same code from the same owner within 10 minutes is one run
    // (refreshes, double clicks, …).
    const dup = await store.findRecentDuplicate(body.code, user?.id ?? null, Date.now() - 10 * 60_000);
    if (dup) return { result: toPublicResult(await store.getResult(dup)), saved: !!user, duplicate: true };
    const r = analyze(answers, { bootstrap: 0 });
    const row = await store.insertResult({
      publicId: newPublicId(), userId: user?.id ?? null, code: body.code, version: r.version,
      titleKey: r.titleKey, primary: r.primary, x: +r.point.x.toFixed(5), y: +r.point.y.toFixed(5),
      scores: Object.fromEntries(Object.entries(r.scores).map(([k, v]) => [k, +v.toFixed(4)])),
      isSeed: false, createdAt: Date.now(), label,
    });
    statsCache = null;
    return [201, { result: toPublicResult(row), saved: !!user }];
  });

  api.get('/api/results', async (req) => {
    const u = await requireUser(req);
    return { results: (await store.listResultsByUser(u.id, 200)).map(toPublicResult) };
  });

  api.patch('/api/results/:id', async (req, _res, { id }) => {
    limit('write', req);
    const u = await requireUser(req);
    const body = await readJson(req);
    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 40) : '';
    if (!(await store.labelResult(id, u.id, label || null))) throw new HttpError(404, 'Run not found', 'not_found');
    return { ok: true, label: label || null };
  });

  api.delete('/api/results/:id', async (req, _res, { id }) => {
    limit('write', req);
    const u = await requireUser(req);
    if (!(await store.deleteResult(id, u.id))) throw new HttpError(404, 'Run not found', 'not_found');
    statsCache = null;
    return { ok: true };
  });

  api.get('/api/stats', async (req) => {
    const query = new URL(req.url, 'http://localhost').searchParams;
    const title = /^[A-Z]{1,2}$/.test(query.get('title') || '') ? query.get('title') : null;
    const source = ['real', 'seed'].includes(query.get('source')) ? query.get('source') : null;
    const key = `${title || ''}:${source || ''}`;
    if (!statsCache || statsCache.at < Date.now() - STATS_TTL || statsCache.key !== key) {
      statsCache = { key, at: Date.now(), body: { bins: STATS_BINS, ...(await store.stats(STATS_BINS, { title, source })) } };
    }
    return statsCache.body;
  });

  /* --------------------------- SPA shell --------------------------- */
  const SPA_ROUTES = /^\/(quiz|me|profile|friends|atlas|about|admin|p\/[a-zA-Z0-9_.-]+|r\/[0-9a-z]+)?\/?$/;

  function renderShell(req, pathname) {
    const entry = statics.load(path.join(ROOT, 'public', 'index.html'));
    let html = entry.raw.toString('utf8');
    const base = config.publicUrl || `http://${req.headers.host || 'localhost'}`;
    let title = 'PLAYERPRINT — the gamer soul atlas';
    let desc = 'A 26-question field test that maps what kind of player you really are onto a six-pole atlas. No sign-up needed.';
    const m = /^\/r\/([0-9a-z]+)\/?$/.exec(pathname);
    if (m && CODE_RE.test(m[1])) {
      const answers = decodeCode(m[1]);
      if (answers) {
        const r = analyze(answers, { bootstrap: 0 });
        title = `${r.title} · PLAYERPRINT`;
        desc = describeShort(r);
      }
    }
    const meta = [
      `<meta name="description" content="${escapeHtml(desc)}">`,
      `<meta property="og:type" content="website">`,
      `<meta property="og:site_name" content="PLAYERPRINT">`,
      `<meta property="og:title" content="${escapeHtml(title)}">`,
      `<meta property="og:description" content="${escapeHtml(desc)}">`,
      `<meta property="og:url" content="${escapeHtml(base + pathname)}">`,
      `<meta name="twitter:card" content="summary">`,
    ].join('\n    ');
    return html.replace(/<title>.*?<\/title>/, `<title>${escapeHtml(title)}</title>`).replace('<!--META-->', meta);
  }

  /* ---------------------------- handler ---------------------------- */
  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (config.secureCookies || req.headers['x-forwarded-proto'] === 'https') {
      res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    }

    const url = new URL(req.url, 'http://x');
    const { pathname } = url;

    if (pathname.startsWith('/api/')) {
      try {
        // CSRF defence in depth: SameSite=Lax cookie + JSON-only bodies + same-origin check.
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          const origin = req.headers.origin;
          let originHost = null;
          try { originHost = origin ? new URL(origin).host : null; } catch { originHost = 'invalid'; }
          if (origin && originHost !== req.headers.host) throw new HttpError(403, 'Cross-origin request blocked', 'bad_origin');
        }
        const hit = api.match(req.method, pathname);
        if (!hit) throw new HttpError(404, 'Not found', 'not_found');
        if (hit.methodNotAllowed) throw new HttpError(405, 'Method not allowed', 'method_not_allowed');
        const out = await hit.handler(req, res, hit.params);
        if (res.writableEnded) return;
        if (Array.isArray(out)) sendJson(res, out[0], out[1]); else sendJson(res, 200, out);
      } catch (err) {
        if (err instanceof HttpError) sendJson(res, err.status, { error: err.message, code: err.code });
        else { console.error('[api]', err); sendJson(res, 500, { error: 'Something broke on our side', code: 'internal' }); }
      }
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    if (SPA_ROUTES.test(pathname)) { statics.html(req, res, renderShell(req, pathname)); return; }
    if (pathname !== '/index.html' && statics.serve(req, res, pathname)) return;

    statics.html(req, res, renderShell(req, pathname), 404);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  return { server, handle };
}
