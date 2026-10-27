import { h, fmtDate, toast } from '../dom.js';
import { api } from '../api.js';
import { session, navigate, openAuth } from '../state.js';
import { TITLES } from '/shared/engine.js';

export async function renderProfile(root, { params }) {
  const username = params[0];
  document.title = `${username} · PLAYERPRINT`;
  let profile;
  try { profile = await api.player(username); } catch (err) {
    root.append(h('section', { class: 'notfound' }, h('div', {}, h('h1', 'Private print'), h('p', err.message), h('a', { class: 'btn btn-hot', href: '/atlas', 'data-link': '' }, 'Explore the atlas')))); return;
  }
  await session.ready;
  const { player, results } = profile;
  const latest = results[0];
  const actions = h('div', { class: 'share-btns' });
  if (session.user && session.user.username !== player.username) actions.append(h('button', { class: 'btn btn-hot', type: 'button', onclick: async () => {
    try { await api.addFriend(player.username); toast(`${player.displayName} added to your circle.`); } catch (err) { toast(err.message); }
  } }, 'Add friend'));
  if (!session.user) actions.append(h('button', { class: 'btn btn-hot', type: 'button', onclick: () => openAuth({ mode: 'login' }) }, 'Sign in to compare'));
  if (session.user && latest) actions.append(h('a', { class: 'btn btn-ghost', href: `/r/${latest.code}?vs=${latest.code}`, 'data-link': '' }, 'Open latest print'));
  root.append(h('section', { class: 'page' }, h('div', { class: 'wrap' },
    h('div', { class: 'page-head profile-head' }, player.avatarUrl ? h('img', { class: 'profile-avatar', src: player.avatarUrl, alt: '' }) : null,
      h('span', { class: 'kicker' }, 'Public player profile'), h('h1', player.displayName), h('p', `@${player.username} · charting since ${fmtDate(player.createdAt)}`), actions),
    latest ? h('section', { class: 'panel' }, h('div', { class: 'panel-title' }, h('h3', 'Latest print'), h('span', { class: 'kicker' }, fmtDate(latest.createdAt))), h('p', { class: 'serif-i', style: { fontSize: '28px', margin: 0 } }, TITLES[latest.titleKey]), h('p', { style: { color: 'var(--ink-2)' } }, `${results.length} shared run${results.length === 1 ? '' : 's'} on this profile.`)) : h('div', { class: 'empty' }, h('h3', 'No saved prints yet')),
    h('section', { class: 'panel', style: { marginTop: '18px' } }, h('div', { class: 'panel-title' }, h('h3', 'Recent prints')), h('div', { class: 'runs' }, results.map((r) => h('a', { class: 'run', href: `/r/${r.code}`, 'data-link': '' }, h('div', {}, h('div', { class: 't' }, TITLES[r.titleKey]), h('div', { class: 'd' }, `${fmtDate(r.createdAt)}${r.label ? ` · ${r.label}` : ''}`))))))
  )));
}
