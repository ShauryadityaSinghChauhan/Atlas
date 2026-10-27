import { h, toast } from '../dom.js';
import { api } from '../api.js';
import { navigate } from '../state.js';

export function renderReset(root, { query }) {
  const token = query.get('token') || ''; const password = h('input', { type: 'password', minlength: 8, autocomplete: 'new-password', required: true });
  root.append(h('section', { class: 'page' }, h('div', { class: 'wrap prose' }, h('div', { class: 'page-head' }, h('span', { class: 'kicker' }, 'Account recovery'), h('h1', 'Reset password'), h('p', 'Choose a new password for your PLAYERPRINT account.')), h('form', { class: 'panel', onsubmit: async (e) => { e.preventDefault(); try { await api.confirmPasswordReset(token, password.value); toast('Password reset. You can sign in now.'); navigate('/'); } catch (err) { toast(err.message); } } }, h('div', { class: 'field' }, h('label', {}, 'New password'), password), h('button', { class: 'btn btn-hot', type: 'submit', disabled: !token }, 'Reset password')))));
}
