import { h } from '../dom.js';
import { api } from '../api.js';
import { session } from '../state.js';

export async function renderAdmin(root) {
  document.title = 'Admin · PLAYERPRINT'; await session.ready;
  try {
    const s = await api.adminStats();
    const cells = [['Accounts', s.users], ['Google accounts', s.googleUsers], ['Public profiles', s.publicProfiles], ['Saved prints', s.results], ['Friend links', s.friends]];
    root.append(h('section', { class: 'page' }, h('div', { class: 'wrap' }, h('div', { class: 'page-head' }, h('span', { class: 'kicker' }, 'Restricted'), h('h1', 'Admin dashboard'), h('p', 'A compact health view of the PLAYERPRINT community.')), h('div', { class: 'stat-row' }, cells.map(([label, value]) => h('section', { class: 'stat panel' }, h('div', { class: 'v' }, Number(value).toLocaleString()), h('div', { class: 'l' }, label)))))));
  } catch (err) { root.append(h('section', { class: 'notfound' }, h('div', {}, h('h1', 'Restricted'), h('p', err.message)))); }
}
