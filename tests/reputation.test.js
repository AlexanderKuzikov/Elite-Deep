/**
 * Reputation, the police record and the world's memory.
 *
 * This module had no test file of its own, and two of the bugs found in review
 * lived here: `decayWanted` was called from `main.js` with no system index at
 * all, so no bounty in the galaxy ever expired, and `payFine` looked up
 * `standing` by system index when it is keyed by faction, so paying a fine
 * cleared the record and left the patrol hostile.
 *
 * Both survived because the only test that touched this area invented a
 * `standing[0]` entry that no real player record contains. The lesson is worth
 * keeping in mind while reading this file: a fixture that does not look like
 * real data will happily agree with a bug.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import * as REP from '../src/logic/reputation.js';
import * as PLAYER from '../src/logic/player.js';

// --- Standing tiers --------------------------------------------------------

test('every standing value maps to exactly one tier', () => {
  // The ladder has to be total: `tierFor` walks it top-down and falls through
  // to the last entry, so a gap would silently report the harshest tier.
  const probes = [-100, -60, -59, -25, -24, -8, -7, 0, 7, 8, 24, 25, 59, 60, 100];
  for (const v of probes) {
    const tier = REP.tierFor(v);
    assert.ok(tier && typeof tier.label === 'string', 'no tier for ' + v);
  }
  assert.equal(REP.tierFor(100).label, 'Allied');
  assert.equal(REP.tierFor(-100).label, 'Hunted');
  assert.equal(REP.tierFor(0).label, 'Neutral');
});

test('there is exactly one standing ladder, and the record delegates to it', () => {
  // There used to be two independently written ladders: this module's tiers
  // and a `standingLabel` in `player.js`. They disagreed at exactly three
  // boundaries, because one treated a boundary value as belonging to the tier
  // above and the other to the tier below - so a commander at +8 was shown
  // "Neutral" while the market applied the "Liked" discount. The record now
  // delegates, and this pins that.
  for (let v = -100; v <= 100; v += 1) {
    assert.equal(PLAYER.standingLabel(v), REP.tierFor(v).label,
      'the record disagrees with the ladder at standing ' + v);
  }
  // And the boundaries that were actually wrong, named explicitly so a future
  // edit that reintroduces an independent ladder fails loudly here.
  assert.equal(PLAYER.standingLabel(-60), 'Hostile');
  assert.equal(PLAYER.standingLabel(-25), 'Disliked');
  assert.equal(PLAYER.standingLabel(8), 'Liked');
});

test('a trusted commander buys cheaper and a hunted one pays more', () => {
  assert.ok(REP.standingPriceFactor(60) < 1, 'Allied should be a discount');
  assert.equal(REP.standingPriceFactor(0), 1, 'Neutral should be exactly par');
  assert.ok(REP.standingPriceFactor(-60) > 1, 'Hunted should be a surcharge');
  // Bounded: this multiplies market prices, so an unbounded bonus is a
  // money printer in either direction.
  for (const v of [-100, -60, 0, 60, 100]) {
    const f = REP.standingPriceFactor(v);
    assert.ok(f > 0.8 && f < 1.2, 'price factor out of band at ' + v + ': ' + f);
  }
});

// --- Patrol hostility ------------------------------------------------------

test('a patrol turns hostile on standing or on a local bounty', () => {
  const p = PLAYER.create();
  const friendly = { index: 3, faction: 'FEDERATION' };
  assert.equal(REP.patrolHostile(p, friendly), false, 'neutral should be left alone');

  p.standing.FEDERATION = -70;
  assert.equal(REP.patrolHostile(p, friendly), true, 'Hunted should be engaged');

  // Wanted in this system, even with a clean relationship.
  const q = PLAYER.create();
  q.wanted[3] = 4;
  assert.equal(REP.patrolHostile(q, friendly), true, 'a local bounty should be enough');

  // ...but a bounty elsewhere is not this system's business.
  const r = PLAYER.create();
  r.wanted[7] = 4;
  assert.equal(REP.patrolHostile(r, friendly), false, 'a bounty in another system is not local');
});

// --- The police record -----------------------------------------------------

test('decayWanted demands a system index rather than doing nothing', () => {
  // The original bug in one line: `main.js` called this with no index, the
  // lookup was `wanted[undefined]`, and every bounty in the galaxy became
  // permanent. Silently returning null looked like a design decision.
  const p = PLAYER.create();
  p.wanted[3] = 5;
  assert.throws(() => REP.decayWanted(p), TypeError);
  assert.throws(() => REP.decayWanted(p, null), TypeError);
  assert.equal(p.wanted[3], 5, 'a rejected call must not have changed anything');
});

test('decayWanted wears a bounty down and clears it at zero', () => {
  const p = PLAYER.create();
  p.wanted[3] = 2;

  assert.deepEqual(REP.decayWanted(p, 3), { cleared: false, remaining: 1 });
  assert.equal(p.wanted[3], 1);

  assert.deepEqual(REP.decayWanted(p, 3), { cleared: true, remaining: 0 });
  assert.equal(p.wanted[3], undefined, 'a cleared record should be removed, not left at zero');

  // And decaying a system with no record is a no-op, not an error.
  assert.equal(REP.decayWanted(p, 3), null);
});

test('decayAllWanted is what the day tick wants', () => {
  // A day passes everywhere at once, so docking should not leave a bounty on
  // the far side of the galaxy untouched.
  const p = PLAYER.create();
  p.wanted[0] = 1;   // will clear
  p.wanted[3] = 4;   // will not
  p.wanted[9] = 1;   // will clear

  const result = REP.decayAllWanted(p);

  assert.deepEqual(result.cleared.sort((a, b) => a - b), [0, 9]);
  assert.deepEqual(result.remaining, [3]);
  assert.equal(p.wanted[3], 3);
  assert.equal(p.wanted[0], undefined);
  assert.equal(p.wanted[9], undefined);
});

test('decayAllWanted reports indices as numbers, not object keys', () => {
  // Object.keys hands back strings. A caller comparing against
  // `session.index` would be defeated by '3' !== 3, which is the same class
  // of key-space mistake that made the original bug invisible.
  const p = PLAYER.create();
  p.wanted[3] = 1;
  const result = REP.decayAllWanted(p);
  assert.equal(typeof result.cleared[0], 'number');
  assert.equal(result.cleared[0], 3);
});

test('decayAllWanted survives a commander with no record at all', () => {
  const p = PLAYER.create();
  assert.deepEqual(REP.decayAllWanted(p), { cleared: [], remaining: [] });
  assert.deepEqual(REP.decayAllWanted({}), { cleared: [], remaining: [] });
});

test('a spree decays in finite time rather than never', () => {
  // The property the bug broke, stated as an invariant: keep your nose clean
  // and the record goes away. A weight-6 bounty at one point per day is six
  // days, which is the intended shape - outlastable, not instant.
  const p = PLAYER.create();
  REP.markWanted(p, 3, 6);
  let days = 0;
  while (p.wanted[3] !== undefined && days < 100) {
    REP.decayAllWanted(p);
    days += 1;
  }
  assert.equal(p.wanted[3], undefined, 'the record never cleared');
  assert.equal(days, 6, 'a weight-6 bounty should take 6 days, took ' + days);
});

test('markWanted accumulates and defaults to a sane weight', () => {
  const p = PLAYER.create();
  assert.equal(REP.markWanted(p, 3), 3, 'the default weight should be 3');
  assert.equal(REP.markWanted(p, 3, 4), 7, 'repeats should accumulate');
});

// --- Fines -----------------------------------------------------------------

test('a fine scales with how badly they want you, and is bounded at zero', () => {
  const p = PLAYER.create();
  assert.equal(REP.fineFor(p, 3), 0, 'no record means no fine');
  REP.markWanted(p, 3, 1);
  const light = REP.fineFor(p, 3);
  REP.markWanted(p, 3, 20);
  const heavy = REP.fineFor(p, 3);
  assert.ok(heavy > light, 'a bigger bounty should cost more');
  assert.ok(light > 0 && heavy > 0);
});

test('a fine is refused when it cannot be afforded, and costs nothing', () => {
  const p = PLAYER.create();
  p.cash = 1;
  REP.markWanted(p, 3, 20);
  const res = REP.payFine(p, { index: 3, faction: 'FEDERATION' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'funds');
  assert.equal(p.cash, 1, 'a refused fine must not take money');
  assert.equal(p.wanted[3], 20, 'a refused fine must not clear the record');
});

// --- The world's memory ----------------------------------------------------

test('createMemory starts empty and rememberEvent accumulates', () => {
  const m = REP.createMemory();
  assert.equal(m.piratesCleared, 0);
  assert.equal(m.visits, 0);

  REP.rememberEvent(m, 'piratesCleared');
  assert.equal(m.piratesCleared, 1, 'the default amount should be 1');
  REP.rememberEvent(m, 'piratesCleared', 3);
  assert.equal(m.piratesCleared, 4);
});

test('a cleared system gets safer and a murdered patrol makes it worse', () => {
  const m = REP.createMemory();

  REP.rememberEvent(m, 'piratesCleared', 10);
  const safer = REP.memoryDangerDelta(m);
  assert.ok(safer < 0, 'clearing pirates should lower danger');

  REP.rememberEvent(m, 'patrolsKilled', 10);
  const worse = REP.memoryDangerDelta(m);
  assert.ok(worse > safer, 'killing the police should undo the improvement');
});

test('memory deltas stay bounded however long you play', () => {
  // These feed the traffic and price layers. An unbounded delta would let a
  // long session empty the lanes or mint money.
  const m = REP.createMemory();
  REP.rememberEvent(m, 'piratesCleared', 10000);
  REP.rememberEvent(m, 'patrolsKilled', 10000);
  REP.rememberEvent(m, 'tradersLost', 10000);
  REP.rememberEvent(m, 'contrabandSeized', 10000);
  REP.rememberEvent(m, 'famineRelieved', 10000);

  assert.ok(Math.abs(REP.memoryDangerDelta(m)) <= 0.25);
  assert.ok(REP.memoryTrafficDelta(m) <= 0.4 && REP.memoryTrafficDelta(m) >= -0.3);
  for (const com of ['food', 'medicine', 'computers']) {
    const d = REP.memoryPriceDelta(m, com);
    assert.ok(d >= -0.22 && d <= 0.15, 'price delta out of band for ' + com + ': ' + d);
  }
});

test('memory moves traffic in the direction the fiction implies', () => {
  const cleared = REP.createMemory();
  REP.rememberEvent(cleared, 'piratesCleared', 10);
  assert.ok(REP.memoryTrafficDelta(cleared) > 0, 'a safe system should attract shipping');

  const raided = REP.createMemory();
  REP.rememberEvent(raided, 'tradersLost', 10);
  assert.ok(REP.memoryTrafficDelta(raided) < 0, 'a raided lane should lose traffic');
});

test('supplying a famine makes food cheaper, not dearer', () => {
  const m = REP.createMemory();
  REP.rememberEvent(m, 'famineRelieved', 4);
  assert.ok(REP.memoryPriceDelta(m, 'food') < 0, 'relief should push the price down');
  assert.equal(REP.memoryPriceDelta(m, 'gemstones'), 0, 'an unrelated good should be untouched');
});

test('a rumour is always produced, even from an empty memory', () => {
  // The station bar shows this line on arrival; returning undefined would
  // leave a gap in the message log rather than a neutral sentence.
  const empty = REP.createMemory();
  const line = REP.rumourFor({ name: 'Lave' }, empty, (lines) => lines[0]);
  assert.equal(typeof line, 'string');
  assert.ok(line.length > 0);

  const busy = REP.createMemory();
  REP.rememberEvent(busy, 'piratesCleared', 6);
  REP.rememberEvent(busy, 'visits', 6);
  const picked = REP.rumourFor({ name: 'Lave' }, busy, (lines) => lines.join('|'));
  assert.ok(picked.includes('quiet'), 'a cleared system should say so: ' + picked);
});

test('the default rumour picker works without one being supplied', () => {
  const line = REP.rumourFor({ name: 'Lave' }, REP.createMemory());
  assert.equal(typeof line, 'string');
  assert.ok(line.length > 0);
});

test('conditionHeadline falls back rather than returning undefined', () => {
  assert.equal(REP.conditionHeadline({}, null), 'Nothing unusual to report.');
  assert.equal(REP.conditionHeadline({}, { note: 'Famine grips the world.' }), 'Famine grips the world.');
});

// --- The default-export mirror ---------------------------------------------

test('the default export mirrors every named export a caller might want', () => {
  for (const name of ['tierFor', 'standingPriceFactor', 'patrolHostile',
    'decayWanted', 'decayAllWanted', 'markWanted', 'fineFor', 'payFine',
    'createMemory', 'rememberEvent', 'memoryDangerDelta', 'memoryTrafficDelta',
    'memoryPriceDelta', 'rumourFor', 'conditionHeadline']) {
    assert.equal(typeof REP.default[name], 'function', 'missing from default: ' + name);
  }
});

// --- The world's memory, attached to the commander -------------------------

test('memoryFor creates a system memory on first use and then returns the same one', () => {
  // The whole point of the event layer: a system has to remember across
  // visits. It used to be created fresh in `enterSystem` on every arrival, so
  // nothing could ever accumulate.
  const p = PLAYER.create();
  const first = REP.memoryFor(p, 3);
  assert.equal(first.visits, 0, 'a new memory should start empty');

  first.visits = 5;
  const again = REP.memoryFor(p, 3);
  assert.strictEqual(again, first, 'a second lookup returned a different object');
  assert.equal(again.visits, 5, 'the accumulated state was lost');
});

test('memoryFor keeps systems apart', () => {
  const p = PLAYER.create();
  REP.memoryFor(p, 3).visits = 2;
  REP.memoryFor(p, 7).visits = 9;
  assert.equal(REP.memoryFor(p, 3).visits, 2);
  assert.equal(REP.memoryFor(p, 7).visits, 9);
});

test('memoryFor tolerates a missing player rather than throwing', () => {
  // Called from the market path, which can run before a commander exists in a
  // test fixture.
  assert.doesNotThrow(() => REP.memoryFor(null, 0));
  assert.equal(REP.memoryFor(null, 0).visits, 0);
});

test('remember records into the system it is told about', () => {
  const p = PLAYER.create();
  REP.remember(p, 4, 'piratesCleared');
  REP.remember(p, 4, 'piratesCleared', 3);
  REP.remember(p, 5, 'tradersLost');

  assert.equal(REP.memoryFor(p, 4).piratesCleared, 4);
  assert.equal(REP.memoryFor(p, 5).piratesCleared, 0, 'the event leaked into another system');
  assert.equal(REP.memoryFor(p, 5).tradersLost, 1);
});

test('what a system remembers survives a save and a load', () => {
  // The memory is only meaningful if it outlives the session. It lives on the
  // player record precisely so the existing save carries it.
  const p = PLAYER.create();
  REP.remember(p, 3, 'piratesCleared', 6);
  REP.remember(p, 3, 'famineRelieved', 4);
  REP.remember(p, 9, 'patrolsKilled', 2);

  const restored = PLAYER.deserialize(PLAYER.serialize(p));

  assert.equal(REP.memoryFor(restored, 3).piratesCleared, 6);
  assert.equal(REP.memoryFor(restored, 3).famineRelieved, 4);
  assert.equal(REP.memoryFor(restored, 9).patrolsKilled, 2);
});

test('rememberedSystems lists only systems with something to say', () => {
  const p = PLAYER.create();
  REP.memoryFor(p, 1);                      // touched but empty
  REP.remember(p, 3, 'piratesCleared', 2);
  REP.remember(p, 7, 'famineRelieved', 1);
  REP.memoryFor(p, 9).visits = 4;

  const known = REP.rememberedSystems(p);
  const indices = known.map((e) => e.index).sort((a, b) => a - b);

  assert.deepEqual(indices, [3, 7, 9], 'an empty memory should not be listed');
  // Most visited first, so the status screen can show "where they know you".
  assert.equal(known[0].index, 9);
});

test('rememberedSystems reports indices as numbers', () => {
  const p = PLAYER.create();
  REP.remember(p, 3, 'piratesCleared');
  assert.equal(typeof REP.rememberedSystems(p)[0].index, 'number');
});

test('a cleared system is measurably safer and busier than an untouched one', () => {
  // The property the whole event layer exists for. If this fails, clearing
  // pirates is a bounty and nothing more.
  const cleared = PLAYER.create();
  REP.remember(cleared, 3, 'piratesCleared', 20);
  const m = REP.memoryFor(cleared, 3);

  assert.ok(REP.memoryDangerDelta(m) < 0, 'clearing the lanes did not lower danger');
  assert.ok(REP.memoryTrafficDelta(m) > 0, 'clearing the lanes did not attract shipping');
});

test('a system whose patrols were killed gets worse, not better', () => {
  const p = PLAYER.create();
  REP.remember(p, 3, 'patrolsKilled', 10);
  const m = REP.memoryFor(p, 3);
  assert.ok(REP.memoryDangerDelta(m) > 0, 'killing the police made the system safer');
});

test('supplying a famine leaves the price of food down afterwards', () => {
  const p = PLAYER.create();
  REP.remember(p, 3, 'famineRelieved', 5);
  const m = REP.memoryFor(p, 3);
  assert.ok(REP.memoryPriceDelta(m, 'food') < 0);
  assert.equal(REP.memoryPriceDelta(m, 'platinum'), 0, 'an unrelated good moved');
});

test('a fresh career starts with no memory of anywhere', () => {
  const p = PLAYER.create();
  assert.deepEqual(p.systemMemory, {});
  assert.deepEqual(REP.rememberedSystems(p), []);
});

// --- The rumour picker -----------------------------------------------------

test('the rumour picker returns one of the lines it is given', () => {
  // The picker that shipped returned a character code, so the arrival rumour
  // printed as a number (`76`) instead of a sentence. It looked like a
  // plausible hash at a glance, which is why it survived.
  const lines = ['alpha', 'beta', 'gamma', 'delta'];
  for (let seed = 0; seed < 200; seed += 1) {
    const picked = REP.rumourPicker(seed)(lines);
    assert.ok(lines.includes(picked), 'seed ' + seed + ' produced ' + JSON.stringify(picked));
  }
});

test('the rumour picker is deterministic and spreads across the lines', () => {
  const lines = ['alpha', 'beta', 'gamma', 'delta'];
  const seen = new Set();
  for (let seed = 0; seed < 200; seed += 1) {
    const a = REP.rumourPicker(seed)(lines);
    const b = REP.rumourPicker(seed)(lines);
    assert.equal(a, b, 'the same seed gave two answers');
    seen.add(a);
  }
  assert.equal(seen.size, lines.length, 'the picker never reaches some lines: ' + [...seen].join(','));
});

test('the rumour picker tolerates an empty or missing list', () => {
  assert.equal(REP.rumourPicker(1)([]), undefined);
  assert.equal(REP.rumourPicker(1)(null), undefined);
});

test('a rumour is a sentence, never a number', () => {
  // The bug stated as an invariant, so a regression cannot hide behind the
  // fact that a number is truthy and prints.
  const p = PLAYER.create();
  REP.remember(p, 3, 'piratesCleared', 6);
  const memory = REP.memoryFor(p, 3);
  const line = REP.rumourFor({ name: 'Lave' }, memory, REP.rumourPicker(42));
  assert.equal(typeof line, 'string');
  assert.ok(line.length > 10, 'the rumour is too short to be a sentence: ' + JSON.stringify(line));
});
