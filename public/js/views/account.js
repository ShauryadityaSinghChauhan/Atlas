import { h, toast, armable } from '../dom.js';
import { api } from '../api.js';
import { session, navigate, openAuth } from '../state.js';
import { TITLES } from '/shared/engine.js';

export async function renderAccount(root) {
  document.title = 'Profile · PLAYERPRINT'; await session.ready;
  if (!session.user) {
    root.append(h('section', { class: 'notfound' }, h('div', {}, h('h1', 'Your profile'), h('p', 'Sign in to manage your player profile.'), h('button', { class: 'btn btn-hot', type: 'button', onclick: () => openAuth({ mode: 'login' }) }, 'Sign in')))); return;
  }
  const u = session.user;
  const history = await api.history().catch(() => ({ results: [] }));
  const badges = [];
  if (history.results.length >= 1) badges.push('First print');
  if (new Set(history.results.map((r) => r.titleKey)).size >= 5) badges.push('Explorer');
  if (history.results.length >= 5) badges.push('Regular cartographer');
  const name = h('input', { value: u.displayName || u.username, maxlength: 40, 'aria-label': 'Display name' });
  const published = h('input', { type: 'checkbox', checked: !!u.publicProfile, id: 'profile-published' });
  const avatar = h('img', { class: 'profile-avatar', src: u.avatarUrl || '', alt: '', hidden: !u.avatarUrl });
  const photoInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', 'aria-label': 'Profile photo' });
  let avatarUrl = u.avatarUrl || null;
  const profileLink = `/p/${encodeURIComponent(u.username)}`;
  const logout = async () => { await api.logout().catch(() => {}); session.set(null); toast('You are signed out.'); navigate('/', { replace: true }); };
  const crop = async (file) => {
    const bitmap = await createImageBitmap(file); const size = Math.min(bitmap.width, bitmap.height); const c = document.createElement('canvas'); c.width = c.height = 512; const x = (bitmap.width - size) / 2, y = (bitmap.height - size) / 2;
    c.getContext('2d').drawImage(bitmap, x, y, size, size, 0, 0, 512, 512); return new Promise((resolve) => c.toBlob((b) => resolve(b), 'image/jpeg', .9));
  };
  const downloadExport = async () => { try { const data = await api.exportAccount(); const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = 'playerprint-data.json'; a.click(); URL.revokeObjectURL(url); } catch (err) { toast(err.message); } };
  const removePhoto = async () => { try { const r = await api.updateProfile({ displayName: name.value, publicProfile: published.checked, removeAvatar: true }); avatarUrl = null; avatar.hidden = true; session.set(r.user); toast('Profile photo removed.'); } catch (err) { toast(err.message); } };
  const downloadCard = () => { const latest = history.results[0]; const c = document.createElement('canvas'); c.width = 1200; c.height = 630; const x = c.getContext('2d'); x.fillStyle = '#201f1a'; x.fillRect(0, 0, c.width, c.height); x.fillStyle = '#ff4f9a'; x.fillRect(0, 0, 24, c.height); x.fillStyle = '#f3ede0'; x.font = '700 42px sans-serif'; x.fillText('PLAYERPRINT', 80, 100); x.font = '700 78px sans-serif'; x.fillText(u.displayName || u.username, 80, 245); x.font = '32px sans-serif'; x.fillText(`@${u.username}`, 84, 300); x.font = 'italic 48px serif'; x.fillText(latest ? TITLES[latest.titleKey] : 'Uncharted', 84, 430); x.font = '26px sans-serif'; x.fillText('playerprint profile', 84, 520); const a = document.createElement('a'); a.download = 'playerprint-profile.png'; a.href = c.toDataURL('image/png'); a.click(); };
  root.append(h('section', { class: 'page' }, h('div', { class: 'wrap' },
    h('div', { class: 'page-head' }, avatar, h('span', { class: 'kicker' }, 'Your account'), h('h1', 'Profile'), h('p', `Signed in as @${u.username}${u.googleSub ? ' with Google' : ''}.`)),
    h('section', { class: 'panel' }, h('div', { class: 'panel-title' }, h('h3', 'Public player profile')), h('p', { style: { color: 'var(--ink-2)' } }, 'Publishing lets friends see your latest saved prints at your personal link.'),
      h('div', { class: 'profile-controls' }, h('label', {}, 'Display name', name), h('label', {}, 'Profile photo (centre-cropped square)', photoInput), h('label', { class: 'check' }, published, ' Publish profile'), h('button', { class: 'btn btn-hot', type: 'button', onclick: async () => { try { const r = await api.updateProfile({ displayName: name.value, publicProfile: published.checked, avatarUrl }); session.set(r.user); toast('Profile saved.'); } catch (err) { toast(err.message); } } }, 'Save changes'), h('button', { class: 'btn btn-sm', type: 'button', onclick: removePhoto }, 'Remove photo')),
      h('p', { class: 'kicker', style: { textTransform: 'none', letterSpacing: 0, marginBottom: 0 } }, 'Profile link: ', h('a', { href: profileLink, 'data-link': '' }, `${location.origin}${profileLink}`))),
    h('section', { class: 'panel', style: { marginTop: '18px' } }, h('div', { class: 'panel-title' }, h('h3', 'Player card'), h('button', { class: 'btn btn-sm', type: 'button', onclick: downloadCard }, 'Download PNG')), h('p', { style: { color: 'var(--ink-2)' } }, 'A shareable profile cover with your latest print.')),
    h('section', { class: 'panel', style: { marginTop: '18px' } }, h('div', { class: 'panel-title' }, h('h3', 'Badges')), badges.length ? h('div', { class: 'share-btns' }, badges.map((b) => h('span', { class: 'pill' }, b))) : h('p', { style: { color: 'var(--ink-2)' } }, 'Take your first quiz to earn a badge.')),
    h('section', { class: 'panel', style: { marginTop: '18px' } }, h('div', { class: 'panel-title' }, h('h3', 'Your circle'), h('a', { class: 'btn btn-sm', href: '/friends', 'data-link': '' }, 'Friend comparisons')),
      h('p', { style: { color: 'var(--ink-2)' } }, 'See compatibility and side-by-side results for players you have added.')),
    h('section', { class: 'panel', style: { marginTop: '18px' } }, h('div', { class: 'panel-title' }, h('h3', 'Your data')), h('p', { style: { color: 'var(--ink-2)' } }, 'Download a portable copy of your profile, runs, and friends.'), h('button', { class: 'btn btn-ghost', type: 'button', onclick: downloadExport }, 'Download my data')),
    h('section', { class: 'panel', style: { marginTop: '18px' } }, h('div', { class: 'panel-title' }, h('h3', 'Session')), h('p', { style: { color: 'var(--ink-2)' } }, 'Sign out from this browser. Your field log and public profile are not deleted.'), h('button', { class: 'btn btn-ghost', type: 'button', onclick: logout }, 'Log out')),
    h('section', { class: 'panel', style: { marginTop: '18px' } }, h('div', { class: 'panel-title' }, h('h3', 'Delete account')), h('p', { style: { color: 'var(--ink-2)' } }, 'Permanently removes your profile, results, and friend connections.'), armable(h('button', { class: 'btn btn-ghost', type: 'button' }, 'Delete account'), 'Really delete?', async () => { try { await api.deleteAccount(); session.set(null); toast('Account deleted.'); navigate('/', { replace: true }); } catch (err) { toast(err.message); } }))
  )));
  photoInput.addEventListener('change', async () => {
    const file = photoInput.files?.[0]; if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast('Choose an image smaller than 5 MB.'); return; }
    try {
      const cropped = await crop(file); const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Could not read this image')); reader.readAsDataURL(cropped); });
      const out = await api.uploadProfileImage(dataUrl);
      avatarUrl = out.avatarUrl; avatar.src = avatarUrl; avatar.hidden = false; session.set(out.user); toast('Photo uploaded and profile saved.');
    } catch (err) { toast(err.message); }
  });
}
