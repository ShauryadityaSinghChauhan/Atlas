// Thin JSON API client.
async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status; err.code = data?.code;
    throw err;
  }
  return data;
}

export const api = {
  me: () => call('GET', '/api/me'),
  login: (username, password) => call('POST', '/api/auth/login', { username, password }),
  register: (username, password) => call('POST', '/api/auth/register', { username, password }),
  logout: () => call('POST', '/api/auth/logout', {}),
  submit: (code, extra = {}) => call('POST', '/api/results', { code, ...extra }),
  history: () => call('GET', '/api/results'),
  label: (id, label) => call('PATCH', `/api/results/${encodeURIComponent(id)}`, { label }),
  remove: (id) => call('DELETE', `/api/results/${encodeURIComponent(id)}`),
  stats: (filters = {}) => { const q = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)); return call('GET', `/api/stats${q.size ? `?${q}` : ''}`); },
  updateProfile: (body) => call('PATCH', '/api/profile', body),
  profileUploadSignature: () => call('POST', '/api/profile/upload-signature', {}),
  uploadProfileImage: (dataUrl) => call('POST', '/api/profile/image', { dataUrl }),
  exportAccount: () => call('GET', '/api/account/export'),
  deleteAccount: () => call('DELETE', '/api/account'),
  player: (username) => call('GET', `/api/players/${encodeURIComponent(username)}`),
  friends: () => call('GET', '/api/friends'),
  addFriend: (username) => call('POST', '/api/friends', { username }),
  removeFriend: (id) => call('DELETE', `/api/friends/${encodeURIComponent(id)}`),
  adminStats: () => call('GET', '/api/admin/stats'),
};
