// Seed data: a population of simulated players (so the atlas has a crowd on
// first boot) and a demo account with a few retakes (so judges can see the
// signed-in features without creating an account).
import crypto from 'node:crypto';
import { analyze, encodeAnswers, mulberry32 } from '../shared/engine.js';
import { simulateAnswers, answerWithTaste } from './simulate.js';
import { hashPassword } from './auth.js';

export const DEMO = { username: 'demo', password: 'playerprint' };

// A deliberately small, connected community for local demos. These accounts
// exercise public profiles, field-log history, badges and friend comparison.
export const DEMO_COMMUNITY = [
  {
    username: 'demo', displayName: 'Atlas', arc: [
      { t: { A: 0.2, B: 0.9, C: 1.4, G: -0.4, D: -0.5, W: 0.1 }, ago: 330, label: 'Animal Crossing era' },
      { t: { A: 0.1, B: 1.3, C: 0.9, G: 0.2, D: -0.4, W: 0.3 }, ago: 210, label: 'Joined a guild' },
      { t: { A: -0.2, B: 1.3, C: 0.2, G: 0.9, D: 0.1, W: 0.4 }, ago: 95, label: 'Lethal Company summer' },
      { t: { A: -0.5, B: 1.1, C: -0.3, G: 1.4, D: 0.3, W: 0.5 }, ago: 12, label: 'Current main' },
    ],
  },
  {
    username: 'luna', displayName: 'Luna Vale', arc: [
      { t: { A: 2.8 }, ago: 420, label: 'Ranked season' },
      { t: { B: 2.8 }, ago: 320, label: 'Co-op campaign' },
      { t: { C: 2.8 }, ago: 230, label: '100% completion run' },
      { t: { G: 2.8 }, ago: 120, label: 'Chaos weekend' },
      { t: { W: 2.8 }, ago: 18, label: 'Open-world reset' },
    ],
  },
  {
    username: 'pixel', displayName: 'Pixel Forge', arc: [
      { t: { A: 1.8, D: 0.9, C: 0.8 }, ago: 150, label: 'Tactics league' },
      { t: { A: 1.4, D: 0.7, C: 1.1 }, ago: 9, label: 'Perfect route' },
    ],
  },
  {
    username: 'arjun', displayName: 'Arjun Plays', arc: [
      { t: { B: 1.6, G: 1.3, W: 0.5 }, ago: 75, label: 'Party game night' },
      { t: { B: 1.1, G: 1.7, W: 0.8 }, ago: 6, label: 'New crew' },
    ],
  },
  {
    username: 'nova', displayName: 'Nova Drift', arc: [
      { t: { W: 1.9, D: 1.1, G: 0.6 }, ago: 55, label: 'Space exploration arc' },
      { t: { W: 1.5, D: 1.4, G: 0.9 }, ago: 3, label: 'No map, no problem' },
    ],
  },
];

const DEMO_FRIENDSHIPS = {
  demo: ['luna', 'pixel', 'arjun'],
  luna: ['demo', 'nova'],
  pixel: ['demo', 'arjun'],
  arjun: ['demo'],
  nova: ['luna'],
};

const rowFor = (answers, extra) => {
  const r = analyze(answers, { bootstrap: 0 });
  return {
    publicId: crypto.randomBytes(6).toString('base64url'),
    code: encodeAnswers(answers), version: r.version, titleKey: r.titleKey, primary: r.primary,
    x: +r.point.x.toFixed(5), y: +r.point.y.toFixed(5),
    scores: Object.fromEntries(Object.entries(r.scores).map(([k, v]) => [k, +v.toFixed(4)])),
    ...extra,
  };
};

export async function seed(store, { players = 640, log = console.log } = {}) {
  const rnd = mulberry32(20260930);
  const now = Date.now();
  const DAY = 86400_000;

  let added = 0;
  for (let i = 0; i < players; i++) {
    await store.insertResult(rowFor(simulateAnswers(rnd), { userId: null, isSeed: true, createdAt: now - Math.floor(rnd() * 120) * DAY }));
    added++;
  }

  let createdProfiles = 0;
  for (let index = 0; index < DEMO_COMMUNITY.length; index++) {
    const profile = DEMO_COMMUNITY[index];
    let user = await store.findUserByName(profile.username);
    const created = !user;
    if (created) {
      user = await store.createUser(profile.username, await hashPassword(DEMO.password));
      createdProfiles++;
    }
    // The seeded accounts are intentionally shareable so their profile and
    // comparison URLs work immediately. No avatar URL is faked: Cloudinary
    // remains the source of uploaded profile photos.
    await store.updateProfile(user.id, { display_name: profile.displayName, public_profile: true, avatar_url: null });
    if (!created) continue;

    const profileRnd = mulberry32(7 + index * 101);
    for (const step of profile.arc) {
      await store.insertResult(rowFor(answerWithTaste(profileRnd, step.t, 2.8), {
        userId: user.id, isSeed: true, createdAt: now - step.ago * DAY, label: step.label,
      }));
    }
  }

  for (const [owner, friends] of Object.entries(DEMO_FRIENDSHIPS)) {
    const user = await store.findUserByName(owner);
    if (!user) continue;
    for (const friend of friends) await store.addFriend(user.id, friend);
  }
  log(`[seed] demo community → ${createdProfiles} account(s) created; sign in as "${DEMO.username}" / "${DEMO.password}"`);
  log(`[seed] added ${added} simulated players`);
}

export async function seedIfEmpty(store, opts) {
  if ((await store.stats(1)).total > 0) return false;
  await seed(store, opts);
  return true;
}
