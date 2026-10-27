// Cross-view state: session user, navigation, cached population stats.
import { api } from './api.js';

const listeners = new Set();
export const session = {
  user: null,
  ready: null,
  set(user) { this.user = user; listeners.forEach((fn) => fn(user)); },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};
session.ready = api.me().then((r) => session.set(r.user)).catch(() => session.set(null));

export function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', path); else history.pushState(null, '', path);
  window.dispatchEvent(new Event('pp:navigate'));
}

let statsPromise = null, statsAt = 0, statsKey = '';
export function getStats(force = false, filters = {}) {
  const key = JSON.stringify(filters);
  if (force || key !== statsKey || !statsPromise || Date.now() - statsAt > 30_000) {
    statsAt = Date.now();
    statsKey = key; statsPromise = api.stats(filters).catch(() => null);
  }
  return statsPromise;
}

// Auth dialog is registered by auth.js to avoid a circular import.
let authOpener = null;
export const registerAuth = (fn) => { authOpener = fn; };
/** Opens sign-in; resolves with the user (or null if dismissed). */
export const openAuth = (opts) => authOpener(opts);

export const shareUrl = (code) => `${location.origin}/r/${code}`;
