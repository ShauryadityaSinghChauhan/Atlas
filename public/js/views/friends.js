import { h, toast } from '../dom.js';
import { api } from '../api.js';
import { session, openAuth } from '../state.js';
import { ARCH_ORDER, TITLES } from '/shared/engine.js';

export async function renderFriends(root) {
  document.title = 'Friend comparisons · PLAYERPRINT'; await session.ready;
  if (!session.user) { root.append(h('section', { class: 'notfound' }, h('div', {}, h('h1', 'Your circle'), h('p', 'Sign in to compare with friends.'), h('button', { class: 'btn btn-hot', onclick: () => openAuth({ mode: 'login' }) }, 'Sign in')))); return; }
  const [mine, data] = await Promise.all([api.history(), api.friends()]); const me = mine.results[0];
  const list = h('div', { class: 'runs' });
  for (const friend of data.friends) {
    try { const p = await api.player(friend.username); const latest = p.results[0]; if (!latest || !me) continue;
      const diff = ARCH_ORDER.reduce((n, k) => n + Math.abs(me.scores[k] - latest.scores[k]), 0) / ARCH_ORDER.length; const score = Math.round(100 * (1 - Math.min(1, diff * 1.6)));
      list.append(h('article', { class: 'run' }, h('div', {}, h('div', { class: 't' }, h('a', { href: `/p/${friend.username}`, 'data-link': '' }, friend.displayName || friend.username)), h('div', { class: 'd' }, `${TITLES[latest.titleKey]} · ${score}% play-style match`)), h('a', { class: 'btn btn-sm', href: `/r/${me.code}?vs=${latest.code}`, 'data-link': '' }, 'Compare')));
    } catch { /* a friend may have made their profile private */ }
  }
  root.append(h('section', { class: 'page' }, h('div', { class: 'wrap' }, h('div', { class: 'page-head' }, h('span', { class: 'kicker' }, 'Social atlas'), h('h1', 'Friend comparisons'), h('p', 'Compare your latest print with the latest public print from each player in your circle.')), h('section', { class: 'panel' }, list.childElementCount ? list : h('div', { class: 'empty' }, h('h3', 'Your circle is quiet'), h('p', 'Visit a public player profile and choose Add friend.'))))));
}
