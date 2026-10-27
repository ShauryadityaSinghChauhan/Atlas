import { h, toast, armable } from '../dom.js';
import { api } from '../api.js';
import { session, openAuth, navigate } from '../state.js';
import { ARCH_ORDER, TITLES } from '/shared/engine.js';

function usernameFromInput(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw, location.origin);
    const match = /^\/p\/([a-zA-Z0-9_.-]+)\/?$/.exec(url.pathname);
    if (match) return decodeURIComponent(match[1]);
  } catch { /* use the username form below */ }
  const username = raw.replace(/^@/, '').replace(/^\/p\//, '');
  return /^[a-zA-Z0-9_.-]{3,24}$/.test(username) ? username : null;
}

export async function renderFriends(root) {
  document.title = 'Friend comparisons · PLAYERPRINT'; await session.ready;
  if (!session.user) { root.append(h('section', { class: 'notfound' }, h('div', {}, h('h1', 'Your circle'), h('p', 'Sign in to compare with friends.'), h('button', { class: 'btn btn-hot', onclick: () => openAuth({ mode: 'login' }) }, 'Sign in')))); return; }

  const [mine, data] = await Promise.all([api.history(), api.friends()]);
  const me = mine.results[0];
  const list = h('div', { class: 'runs' });
  for (const friend of data.friends) {
    let latest = null;
    try { latest = (await api.player(friend.username)).results[0] || null; } catch { /* profile was made private after it was added */ }
    const details = latest && me
      ? `${TITLES[latest.titleKey]} · ${Math.round(100 * (1 - Math.min(1, ARCH_ORDER.reduce((n, k) => n + Math.abs(me.scores[k] - latest.scores[k]), 0) / ARCH_ORDER.length * 1.6)))}% play-style match`
      : latest ? `${TITLES[latest.titleKey]} · take a quiz to compare` : 'This profile is no longer public';
    const actions = h('div', { class: 'acts' },
      latest && me ? h('a', { class: 'btn btn-sm', href: `/r/${me.code}?vs=${latest.code}`, 'data-link': '' }, 'Compare') : null,
      armable(h('button', { class: 'btn btn-sm', type: 'button' }, 'Remove'), 'Remove?', async () => {
        try { await api.removeFriend(friend.id); toast(`${friend.displayName || friend.username} removed from your circle.`); navigate('/friends', { replace: true }); } catch (err) { toast(err.message); }
      }),
    );
    list.append(h('article', { class: 'run' }, h('div', {}, h('div', { class: 't' }, h('a', { href: `/p/${friend.username}`, 'data-link': '' }, friend.displayName || friend.username)), h('div', { class: 'd' }, details)), actions));
  }

  const addInput = h('input', { placeholder: 'Public profile link or @username', 'aria-label': 'Public player profile link or username' });
  const addForm = h('form', { class: 'compare-form' }, addInput, h('button', { class: 'btn btn-sm btn-sun', type: 'submit' }, 'Add friend'));
  addForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = usernameFromInput(addInput.value);
    if (!username) { toast('Paste a public PLAYERPRINT profile link or a username.'); return; }
    try { const out = await api.addFriend(username); toast(`${out.friend.displayName || out.friend.username} added to your circle.`); navigate('/friends', { replace: true }); } catch (err) { toast(err.message); }
  });

  root.append(h('section', { class: 'page' }, h('div', { class: 'wrap' },
    h('div', { class: 'page-head' }, h('span', { class: 'kicker' }, 'Social atlas'), h('h1', 'Friend comparisons'), h('p', 'Add a public player profile, then compare your latest prints side by side.')),
    h('section', { class: 'panel' }, h('div', { class: 'panel-title' }, h('h3', 'Add to your circle')), h('p', { style: { color: 'var(--ink-2)' } }, 'Paste a player’s public `/p/username` link or type their username.'), addForm),
    h('section', { class: 'panel', style: { marginTop: '18px' } }, h('div', { class: 'panel-title' }, h('h3', 'Your circle'), h('span', { class: 'kicker' }, `${data.friends.length} friend${data.friends.length === 1 ? '' : 's'}`)),
      !me ? h('p', { style: { color: 'var(--ink-2)' } }, 'Take the field test to unlock side-by-side comparisons. You can still manage your friends here.') : null,
      list.childElementCount ? list : h('div', { class: 'empty' }, h('h3', 'Your circle is quiet'), h('p', 'Add a player with a public profile to get started.'))))));
}
