/**
 * Contracts: the station's job board.
 *
 * The board is generated from facts the galaxy already knows - what a system
 * produces, what its neighbours need, which of them are in crisis - so most of
 * what is worth testing here is that the *derivation* is right: that a
 * delivery really does point at a system that wants the goods, that a relief
 * run really does target somewhere in trouble, and that the money is
 * proportionate to the work.
 *
 * The rest is the contract lifecycle, which has one property that matters more
 * than any other: a contract must be impossible to complete twice, and
 * impossible to complete without doing the work.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import * as M from '../src/logic/missions.js';
import * as G from '../src/logic/galaxy.js';
import * as P from '../src/logic/player.js';
import * as E from '../src/logic/economy.js';
import * as F from '../src/logic/factions.js';
import * as REP from '../src/logic/reputation.js';

const galaxy = G.generate(1984);

/** The first system that can actually offer something. */
function aSystemWithABoard() {
  for (const s of galaxy.systems) {
    const board = M.generateBoard(s, galaxy, P.create(), 12345, 0);
    if (board.length) return { system: s, board: board };
  }
  throw new Error('no system produced a board');
}

// --- Generating the board --------------------------------------------------

test('a board is generated deterministically from its seed', () => {
  // Rerolling until a good contract appears would make the board a slot
  // machine. A reload has to show the same offers.
  const { system } = aSystemWithABoard();
  const a = M.generateBoard(system, galaxy, P.create(), 777, 0);
  const b = M.generateBoard(system, galaxy, P.create(), 777, 0);
  assert.deepEqual(a, b, 'the same seed produced a different board');
});

test('a different seed produces a different board', () => {
  // Otherwise every station in the galaxy would offer the same job.
  const { system } = aSystemWithABoard();
  const a = M.generateBoard(system, galaxy, P.create(), 1, 0);
  const b = M.generateBoard(system, galaxy, P.create(), 2, 0);
  assert.notDeepEqual(a, b);
});

test('a board never exceeds its configured size', () => {
  for (const s of galaxy.systems) {
    const board = M.generateBoard(s, galaxy, P.create(), 99, 0);
    assert.ok(board.length <= M.MISSION.boardSize,
      s.name + ' offered ' + board.length + ' contracts');
  }
});

test('every offer has a stable id, a deadline in the future and a positive reward', () => {
  const day = 40;
  for (const s of galaxy.systems) {
    for (const offer of M.generateBoard(s, galaxy, P.create(), 4242, day)) {
      assert.ok(offer.id && typeof offer.id === 'string', 'no id');
      assert.ok(offer.deadlineDay > day, 'deadline is not in the future: ' + offer.deadlineDay);
      assert.ok(offer.reward > 0, 'reward is not positive: ' + offer.reward);
      assert.ok(offer.days > 0, 'no days allowed');
      assert.ok(offer.targetIndex !== offer.fromIndex || offer.type === 'bounty',
        'a non-bounty contract targets its own system');
    }
  }
});

test('ids are unique within a board', () => {
  // The id is what the accept and abandon actions key on; a duplicate would
  // make one of the two impossible to abandon.
  for (const s of galaxy.systems) {
    const board = M.generateBoard(s, galaxy, P.create(), 5150, 0);
    const ids = board.map((o) => o.id);
    assert.equal(new Set(ids).size, ids.length, s.name + ' produced duplicate ids');
  }
});

// --- The board reflects the galaxy -----------------------------------------

test('a delivery carries something the offering system actually produces', () => {
  // The contract has to be buyable where it is offered, or it is a trap.
  let checked = 0;
  for (const s of galaxy.systems) {
    for (const offer of M.generateBoard(s, galaxy, P.create(), 8080, 0)) {
      if (offer.type !== 'delivery' && offer.type !== 'relief') continue;
      const produces = (s.profile && s.profile.produces) || {};
      assert.ok(produces[offer.commodity],
        s.name + ' offers ' + offer.commodity + ' which it does not produce');
      checked += 1;
    }
  }
  assert.ok(checked > 5, 'only ' + checked + ' deliveries across the whole galaxy to check');
});

test('a delivery points at a system that wants the goods', () => {
  // And it has to be worth carrying to the far end, or the reward is paying
  // for a journey nobody would make.
  let checked = 0;
  for (const s of galaxy.systems) {
    for (const offer of M.generateBoard(s, galaxy, P.create(), 9090, 0)) {
      if (offer.type !== 'delivery' && offer.type !== 'relief') continue;
      const target = galaxy.systems[offer.targetIndex];
      const consumes = (target.profile && target.profile.consumes) || {};
      const lacking = target.profile && target.profile.lacking === offer.commodity;
      const condition = F.condition(target.condition);
      const demanded = condition && condition.demand && condition.demand[offer.commodity] > 0.5;
      assert.ok(consumes[offer.commodity] || lacking || demanded,
        target.name + ' does not want ' + offer.commodity);
      checked += 1;
    }
  }
  assert.ok(checked > 5, 'only ' + checked + ' deliveries to check');
});

test('a relief run targets a system that is actually in trouble', () => {
  let reliefs = 0;
  for (const s of galaxy.systems) {
    for (const offer of M.generateBoard(s, galaxy, P.create(), 31337, 0)) {
      if (offer.type !== 'relief') continue;
      const target = galaxy.systems[offer.targetIndex];
      assert.ok(['FAMINE', 'PLAGUE', 'BLOCKADE'].includes(target.condition),
        target.name + ' is ' + target.condition + ' and was called an emergency');
      reliefs += 1;
    }
  }
  assert.ok(reliefs > 0, 'the galaxy produced no relief runs at all, so this proved nothing');
});

test('a bounty is only posted where there is something to clear', () => {
  for (const s of galaxy.systems) {
    for (const offer of M.generateBoard(s, galaxy, P.create(), 606, 0)) {
      if (offer.type !== 'bounty') continue;
      const danger = F.dangerOf(s.gov, s.faction, s.condition);
      assert.ok(danger > 0.25, s.name + ' posted a bounty at danger ' + danger);
      assert.ok(offer.tons >= M.MISSION.bountyCount[0], 'a bounty for too few pirates');
      assert.ok(offer.tons <= M.MISSION.bountyCount[1], 'a bounty for too many pirates');
    }
  }
});

test('every board describes each offer as a sentence', () => {
  // The board is read, not parsed. A missing description would render as
  // "undefined" in the table.
  for (const s of galaxy.systems) {
    for (const offer of M.generateBoard(s, galaxy, P.create(), 246, 0)) {
      const line = M.describe(offer);
      assert.equal(typeof line, 'string');
      assert.ok(line.length > 12, 'too short to be a sentence: ' + JSON.stringify(line));
      assert.ok(!line.includes('undefined'), 'the description leaked a missing field: ' + line);
      assert.ok(!line.includes('null'), 'the description leaked a missing field: ' + line);
    }
  }
});

test('a relief run pays more than the same delivery would', () => {
  // The whole reason to take a job into a famine instead of a stable world.
  // Compared on identical cargo and distance, because those move the price too.
  const offered = [];
  for (const s of galaxy.systems) {
    for (const offer of M.generateBoard(s, galaxy, P.create(), 13579, 0)) {
      if (offer.type === 'delivery' || offer.type === 'relief') offered.push(offer);
    }
  }
  const relief = offered.filter((o) => o.type === 'relief');
  const plain = offered.filter((o) => o.type === 'delivery');
  assert.ok(relief.length && plain.length, 'need both kinds to compare');

  // Normalise by cargo value and distance, which are the other two terms.
  const rate = (o) => {
    const com = E.commodityById(o.commodity);
    const base = (com ? com.base : 1) * o.tons;
    return o.reward / (base + o.distance * 14 + 1);
  };
  const reliefMean = relief.reduce((a, o) => a + rate(o), 0) / relief.length;
  const plainMean = plain.reduce((a, o) => a + rate(o), 0) / plain.length;
  assert.ok(reliefMean > plainMean,
    'relief pays no better than a routine delivery: ' + reliefMean.toFixed(2) + ' vs ' + plainMean.toFixed(2));
});

test('a longer haul pays more than a short one', () => {
  // Otherwise the board would be a list of identical numbers and the commander
  // would have no reason to read it.
  const byDistance = [];
  for (const s of galaxy.systems) {
    for (const offer of M.generateBoard(s, galaxy, P.create(), 4711, 0)) {
      if (offer.type !== 'courier') continue;
      byDistance.push(offer);
    }
  }
  if (byDistance.length < 2) return;   // nothing to compare at this seed
  byDistance.sort((a, b) => a.distance - b.distance);
  const short = byDistance[0];
  const long = byDistance[byDistance.length - 1];
  if (long.distance > short.distance * 1.5) {
    assert.ok(long.reward > short.reward, 'a longer courier run paid less');
  }
});

// --- Accepting -------------------------------------------------------------

test('accepting a contract puts it on the commander', () => {
  const { board } = aSystemWithABoard();
  const p = P.create();
  const res = M.accept(p, board[0], 0);
  assert.equal(res.ok, true);
  assert.equal(p.contracts.length, 1);
  assert.equal(p.contracts[0].id, board[0].id);
  assert.equal(p.contracts[0].acceptedDay, 0);
});

test('the same contract cannot be taken twice', () => {
  // It would be paid twice, and the second copy would be invisible on screen
  // because the ids match.
  const { board } = aSystemWithABoard();
  const p = P.create();
  assert.equal(M.accept(p, board[0], 0).ok, true);
  const again = M.accept(p, board[0], 0);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'duplicate');
  assert.equal(p.contracts.length, 1);
});

test('the number of active contracts is capped', () => {
  const p = P.create();
  const offers = [];
  for (let i = 0; i < M.MISSION.maxActive + 3; i += 1) {
    offers.push(Object.assign({}, M.generateBoard(galaxy.systems[0], galaxy, p, 1000 + i, 0)[0]
      || { id: 'x' + i, type: 'courier', reward: 10, days: 5, deadlineDay: 5, targetIndex: 1 },
      { id: 'offer-' + i }));
  }
  for (let i = 0; i < M.MISSION.maxActive; i += 1) {
    assert.equal(M.accept(p, offers[i], 0).ok, true, 'offer ' + i + ' was refused early');
  }
  const overflow = M.accept(p, offers[M.MISSION.maxActive], 0);
  assert.equal(overflow.ok, false);
  assert.equal(overflow.reason, 'full');
  assert.equal(p.contracts.length, M.MISSION.maxActive);
});

test('a bounty records how many pirates the system had already lost', () => {
  // Without a baseline, a commander could accept a job in a system they had
  // already cleared and be paid for work they did before being hired.
  const p = P.create();
  REP.remember(p, 5, 'piratesCleared', 9);
  const offer = {
    id: 'b1', type: 'bounty', targetIndex: 5, tons: 3, reward: 300,
    days: 6, deadlineDay: 6, fromIndex: 0, fromName: 'A', targetName: 'B',
    distance: 0, standingFaction: 'FEDERATION',
  };
  M.accept(p, offer, 0);
  assert.equal(p.contracts[0].baseline, 9, 'the baseline was not recorded');
});

// --- Completing ------------------------------------------------------------

test('a courier contract completes on arrival', () => {
  const p = P.create();
  const cash = p.cash;
  M.accept(p, {
    id: 'c1', type: 'courier', targetIndex: 7, tons: 0, reward: 500,
    days: 5, deadlineDay: 5, fromIndex: 0, fromName: 'A', targetName: 'B',
    distance: 12, standingFaction: 'FEDERATION',
  }, 0);

  const outcomes = M.resolveArrival(p, 7, 1);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].ok, true);
  assert.equal(p.cash, cash + 500, 'the reward was not paid');
  assert.equal(p.contracts.length, 0, 'the contract is still open');
});

test('a delivery completes only when the goods are aboard, and consumes them', () => {
  const p = P.create();
  P.addCargo(p, 'food', 10);
  M.accept(p, {
    id: 'd1', type: 'delivery', commodity: 'food', commodityName: 'Food',
    targetIndex: 7, tons: 6, reward: 400, days: 8, deadlineDay: 8,
    fromIndex: 0, fromName: 'A', targetName: 'B', distance: 10,
    standingFaction: 'FEDERATION',
  }, 0);

  // Short of the required tonnage: nothing happens, the contract stays open.
  P.removeCargo(p, 'food', 6);        // 10 -> 4, two short of the six required
  assert.equal(p.cargo.food, 4);
  assert.equal(M.resolveArrival(p, 7, 1).length, 0, 'completed without the goods');
  assert.equal(p.contracts.length, 1, 'the contract closed without being done');
  assert.equal(p.cargo.food, 4, 'a failed attempt took the cargo anyway');

  P.addCargo(p, 'food', 2);           // 4 -> 6, exactly enough
  const outcomes = M.resolveArrival(p, 7, 1);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].ok, true);
  assert.equal(p.cargo.food, undefined, 'the goods were not handed over');
});

test('a delivery does not complete in the wrong system', () => {
  const p = P.create();
  P.addCargo(p, 'food', 10);
  M.accept(p, {
    id: 'd2', type: 'delivery', commodity: 'food', commodityName: 'Food',
    targetIndex: 7, tons: 4, reward: 400, days: 8, deadlineDay: 8,
    fromIndex: 0, fromName: 'A', targetName: 'B', distance: 10,
    standingFaction: 'FEDERATION',
  }, 0);

  assert.equal(M.resolveArrival(p, 3, 1).length, 0, 'completed in the wrong system');
  assert.equal(p.contracts.length, 1);
  assert.equal(p.cargo.food, 10, 'the cargo was taken anyway');
});

test('a contract cannot be completed twice', () => {
  // The property that matters most: the same job must not pay twice.
  const p = P.create();
  P.addCargo(p, 'food', 20);
  M.accept(p, {
    id: 'd3', type: 'delivery', commodity: 'food', commodityName: 'Food',
    targetIndex: 7, tons: 4, reward: 400, days: 8, deadlineDay: 8,
    fromIndex: 0, fromName: 'A', targetName: 'B', distance: 10,
    standingFaction: 'FEDERATION',
  }, 0);

  const first = M.resolveArrival(p, 7, 1);
  const cashAfter = p.cash;
  const second = M.resolveArrival(p, 7, 1);

  assert.equal(first.length, 1);
  assert.equal(second.length, 0, 'the same contract paid again');
  assert.equal(p.cash, cashAfter);
});

test('a relief run moves standing further than a routine delivery', () => {
  const faction = 'FEDERATION';
  function run(type) {
    const p = P.create();
    P.addCargo(p, 'food', 20);
    M.accept(p, {
      id: type, type: type, commodity: 'food', commodityName: 'Food',
      targetIndex: 7, tons: 5, reward: 400, days: 8, deadlineDay: 8,
      fromIndex: 0, fromName: 'A', targetName: 'B', distance: 10,
      standingFaction: faction,
    }, 0);
    M.resolveArrival(p, 7, 1);
    return p.standing[faction];
  }
  assert.ok(run('relief') > run('delivery'), 'a relief run is not worth more goodwill');
});

test('a bounty completes once enough pirates are down', () => {
  const p = P.create();
  REP.remember(p, 7, 'piratesCleared', 4);
  M.accept(p, {
    id: 'b2', type: 'bounty', targetIndex: 7, tons: 3, reward: 330,
    days: 6, deadlineDay: 6, fromIndex: 7, fromName: 'B', targetName: 'B',
    distance: 0, standingFaction: 'FEDERATION',
  }, 0);

  // Nothing new killed yet.
  assert.equal(M.resolveArrival(p, 7, 1).length, 0, 'paid for work not done');
  assert.equal(M.bountyProgress(p, 7)[0].cleared, 0);
  assert.equal(M.bountyProgress(p, 7)[0].done, false);

  REP.remember(p, 7, 'piratesCleared', 3);
  assert.equal(M.bountyProgress(p, 7)[0].done, true);
  const outcomes = M.checkBounties(p, 7);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].ok, true);
  assert.equal(p.contracts.length, 0, 'the completed bounty is still open');
});

test('a bounty pays the moment the last pirate dies, not on the next dock', () => {
  // It is the one contract that can be finished without going anywhere, so it
  // should not have to wait for a landing pad.
  const p = P.create();
  const cash = p.cash;
  M.accept(p, {
    id: 'b4', type: 'bounty', targetIndex: 7, tons: 2, reward: 250,
    days: 6, deadlineDay: 6, fromIndex: 7, fromName: 'B', targetName: 'B',
    distance: 0, standingFaction: 'FEDERATION',
  }, 0);
  assert.equal(M.checkBounties(p, 7).length, 0, 'paid before any kills');

  REP.remember(p, 7, 'piratesCleared', 2);
  const done = M.checkBounties(p, 7);
  assert.equal(done.length, 1);
  assert.equal(p.cash, cash + 250);
});

test('a bounty in another system is not completed by kills here', () => {
  const p = P.create();
  M.accept(p, {
    id: 'b5', type: 'bounty', targetIndex: 9, tons: 2, reward: 250,
    days: 6, deadlineDay: 6, fromIndex: 9, fromName: 'C', targetName: 'C',
    distance: 0, standingFaction: 'FEDERATION',
  }, 0);
  REP.remember(p, 3, 'piratesCleared', 5);
  assert.equal(M.checkBounties(p, 3).length, 0, 'a kill elsewhere paid a bounty');
  assert.equal(p.contracts.length, 1);
});

test('a bounty ignores pirates killed before the contract was taken', () => {
  // The baseline, stated as behaviour rather than as a field.
  const p = P.create();
  REP.remember(p, 7, 'piratesCleared', 20);
  M.accept(p, {
    id: 'b3', type: 'bounty', targetIndex: 7, tons: 3, reward: 330,
    days: 6, deadlineDay: 6, fromIndex: 7, fromName: 'B', targetName: 'B',
    distance: 0, standingFaction: 'FEDERATION',
  }, 0);
  assert.equal(M.bountyProgress(p, 7)[0].cleared, 0,
    'the contract counted kills from before it existed');
  assert.equal(M.checkBounties(p, 7).length, 0);
});

// --- Failing ---------------------------------------------------------------

test('an overdue contract fails, costs money and costs standing', () => {
  const p = P.create();
  p.cash = 10000;
  M.accept(p, {
    id: 'f1', type: 'courier', targetIndex: 7, tons: 0, reward: 500,
    days: 3, deadlineDay: 3, fromIndex: 0, fromName: 'A', targetName: 'B',
    distance: 12, standingFaction: 'FEDERATION',
  }, 0);

  const outcomes = M.resolveArrival(p, 0, 4);   // one day past the deadline
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].ok, false);
  assert.equal(outcomes[0].reason, 'overdue');
  assert.ok(outcomes[0].fine > 0, 'no fine was charged');
  assert.ok(p.cash < 10000, 'the purse was not touched');
  assert.ok(p.standing.FEDERATION < 0, 'standing was not reduced');
  assert.equal(p.contracts.length, 0, 'the contract is still open');
});

test('a fine cannot take the commander into debt', () => {
  // Being punished into negative credits is a dead end, not a consequence.
  const p = P.create();
  p.cash = 10;
  M.accept(p, {
    id: 'f2', type: 'courier', targetIndex: 7, tons: 0, reward: 5000,
    days: 3, deadlineDay: 3, fromIndex: 0, fromName: 'A', targetName: 'B',
    distance: 12, standingFaction: 'FEDERATION',
  }, 0);
  M.resolveArrival(p, 0, 9);
  assert.ok(p.cash >= 0, 'the purse went negative: ' + p.cash);
});

test('an overdue contract cannot also be completed', () => {
  // Order matters: a contract that ran out of time must not pay out because
  // the commander happened to arrive with the goods afterwards.
  const p = P.create();
  P.addCargo(p, 'food', 20);
  M.accept(p, {
    id: 'f3', type: 'delivery', commodity: 'food', commodityName: 'Food',
    targetIndex: 7, tons: 4, reward: 400, days: 2, deadlineDay: 2,
    fromIndex: 0, fromName: 'A', targetName: 'B', distance: 10,
    standingFaction: 'FEDERATION',
  }, 0);

  const outcomes = M.resolveArrival(p, 7, 5);   // late, but standing there
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].ok, false, 'a late contract paid out');
  assert.equal(p.cargo.food, 20, 'the cargo was taken by a failed contract');
});

test('abandoning costs the same as letting a contract lapse', () => {
  const p = P.create();
  p.cash = 10000;
  M.accept(p, {
    id: 'a1', type: 'courier', targetIndex: 7, tons: 0, reward: 500,
    days: 5, deadlineDay: 5, fromIndex: 0, fromName: 'A', targetName: 'B',
    distance: 12, standingFaction: 'FEDERATION',
  }, 0);

  const res = M.abandon(p, 'a1');
  assert.ok(res, 'abandon returned nothing');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'abandoned');
  assert.equal(p.contracts.length, 0);
  assert.ok(p.cash < 10000, 'abandoning was free');
});

test('abandoning an unknown contract is a no-op', () => {
  const p = P.create();
  assert.equal(M.abandon(p, 'nope'), null);
  assert.doesNotThrow(() => M.abandon({}, 'nope'));
});

// --- Listing and deadlines -------------------------------------------------

test('active contracts are listed by soonest deadline', () => {
  // The order a pilot wants: the one about to lapse first.
  const p = P.create();
  const base = {
    type: 'courier', tons: 0, reward: 10, fromIndex: 0, fromName: 'A',
    targetName: 'B', distance: 5, standingFaction: 'FEDERATION',
  };
  M.accept(p, Object.assign({}, base, { id: 'x', targetIndex: 1, days: 9, deadlineDay: 9 }), 0);
  M.accept(p, Object.assign({}, base, { id: 'y', targetIndex: 2, days: 3, deadlineDay: 3 }), 0);
  M.accept(p, Object.assign({}, base, { id: 'z', targetIndex: 3, days: 6, deadlineDay: 6 }), 0);

  assert.deepEqual(M.active(p).map((c) => c.id), ['y', 'z', 'x']);
});

test('daysLeft counts down and goes negative once overdue', () => {
  const c = { deadlineDay: 10 };
  assert.equal(M.daysLeft(c, 4), 6);
  assert.equal(M.daysLeft(c, 10), 0);
  assert.equal(M.daysLeft(c, 13), -3);
});

test('active tolerates a commander with no contracts at all', () => {
  assert.deepEqual(M.active(P.create()), []);
  assert.deepEqual(M.active({}), []);
  assert.deepEqual(M.active(null), []);
});

test('resolving arrivals is safe with nothing to resolve', () => {
  assert.deepEqual(M.resolveArrival(P.create(), 0, 0), []);
  assert.deepEqual(M.resolveArrival({}, 0, 0), []);
});

// --- Persistence -----------------------------------------------------------

test('contracts survive a save and a load', () => {
  // A deadline is measured in game days, so a contract has to outlive the
  // session that took it on.
  const p = P.create();
  M.accept(p, {
    id: 'p1', type: 'delivery', commodity: 'food', commodityName: 'Food',
    targetIndex: 7, tons: 6, reward: 400, days: 8, deadlineDay: 8,
    fromIndex: 0, fromName: 'A', targetName: 'B', distance: 10,
    standingFaction: 'FEDERATION',
  }, 0);

  const restored = P.deserialize(P.serialize(p));
  assert.equal(restored.contracts.length, 1);
  assert.equal(restored.contracts[0].id, 'p1');
  assert.equal(restored.contracts[0].deadlineDay, 8);
  assert.equal(restored.contracts[0].commodity, 'food');
});

test('a bounty baseline survives a save and a load', () => {
  // Lose it and the contract either completes instantly or never can.
  const p = P.create();
  REP.remember(p, 7, 'piratesCleared', 5);
  M.accept(p, {
    id: 'p2', type: 'bounty', targetIndex: 7, tons: 2, reward: 200,
    days: 6, deadlineDay: 6, fromIndex: 7, fromName: 'B', targetName: 'B',
    distance: 0, standingFaction: 'FEDERATION',
  }, 0);

  const restored = P.deserialize(P.serialize(p));
  assert.equal(restored.contracts[0].baseline, 5);
});

test('an old save without contracts still loads', () => {
  const p = P.create();
  const raw = JSON.parse(P.serialize(p));
  delete raw.contracts;
  const restored = P.deserialize(raw);
  assert.deepEqual(restored.contracts, []);
});

test('a fresh career starts with no contracts', () => {
  assert.deepEqual(P.create().contracts, []);
});

// --- The default-export mirror ---------------------------------------------

test('the default export mirrors the named ones', () => {
  for (const name of ['generateBoard', 'describe', 'accept', 'resolveArrival',
    'bountyProgress', 'checkBounties', 'abandon', 'daysLeft', 'active']) {
    assert.equal(typeof M.default[name], 'function', 'missing from default: ' + name);
  }
});

test('relief runs are the exception on the board, not the rule', () => {
  // A crisis is roughly one system in five, but a system has several
  // neighbours within reach, so "prefer a crisis target" made almost every
  // contract an emergency. A label that describes most of the board describes
  // nothing, and the board stops being readable at a glance.
  let relief = 0;
  let plain = 0;
  for (const s of galaxy.systems) {
    for (const offer of M.generateBoard(s, galaxy, P.create(), 20250913, 0)) {
      if (offer.type === 'relief') relief += 1;
      else if (offer.type === 'delivery') plain += 1;
    }
  }
  assert.ok(plain > 0, 'no ordinary deliveries at all');
  assert.ok(relief < plain,
    'relief runs outnumber routine deliveries: ' + relief + ' vs ' + plain);
});

test('a board never shows more than one emergency', () => {
  // Measured at Lave: nothing but a famine wants livestock or medicine, so the
  // needy pool for those goods was *entirely* crisis systems. Offering every
  // commodity somebody needed therefore produced boards where every row said
  // "emergency" - and a label that describes most of the board describes
  // nothing.
  let worst = 0;
  let worstSystem = '';
  for (const s of galaxy.systems) {
    for (const seed of [1, 77, 2024, 99999]) {
      const board = M.generateBoard(s, galaxy, P.create(), seed, 0);
      const reliefs = board.filter((o) => o.type === 'relief').length;
      if (reliefs > worst) { worst = reliefs; worstSystem = s.name + ' (seed ' + seed + ')'; }
    }
  }
  assert.ok(worst <= 1, worstSystem + ' offered ' + worst + ' emergency runs at once');
});

// --- What a cleanup contract owes ------------------------------------------

/** A player holding one cleanup contract against a system. */
function withBounty(systemIndex, tons, cleared) {
  const player = P.create();
  player.contracts.push({
    id: 'bounty:' + systemIndex + ':' + systemIndex + ':99:' + tons,
    type: 'bounty',
    targetIndex: systemIndex,
    fromIndex: systemIndex,
    tons: tons,
    reward: 100,
    deadlineDay: 99,
    baseline: 0,
  });
  if (cleared) REP.remember(player, systemIndex, 'piratesCleared', cleared);
  return player;
}

test('a commander with no contracts owes nothing', () => {
  // The traffic layer calls this on every arrival, so the empty case has to be
  // free and boring rather than a special case at the call site.
  assert.equal(M.bountyPressure(P.create(), 0), 0);
  assert.equal(M.bountyPressure(null, 0), 0);
});

test('a fresh cleanup contract owes its full count', () => {
  assert.equal(M.bountyPressure(withBounty(3, 5), 3), 5);
});

test('clearing pirates reduces what is owed', () => {
  const player = withBounty(3, 5, 2);
  assert.equal(M.bountyPressure(player, 3), 3, 'two cleared should leave three owed');
});

test('over-clearing never goes negative', () => {
  // Otherwise a commander who shot nine pirates before being hired would be
  // told the system owes them work.
  const player = withBounty(3, 5, 9);
  assert.equal(M.bountyPressure(player, 3), 0);
});

test('a contract against another system is not counted', () => {
  const player = withBounty(3, 5);
  assert.equal(M.bountyPressure(player, 4), 0);
  assert.equal(M.bountyPressure(player, 3), 5);
});

test('only cleanup contracts count', () => {
  // A delivery does not put hostiles in the sky, however much cargo it moves.
  const player = P.create();
  player.contracts.push({
    id: 'delivery:1:2:9:10', type: 'delivery', targetIndex: 3,
    fromIndex: 1, tons: 10, reward: 500, deadlineDay: 9, baseline: 0,
  });
  assert.equal(M.bountyPressure(player, 3), 0);
});

test('two cleanup contracts on one system add up', () => {
  const player = withBounty(3, 5);
  player.contracts.push({
    id: 'bounty:3:3:99:2', type: 'bounty', targetIndex: 3,
    fromIndex: 3, tons: 2, reward: 100, deadlineDay: 99, baseline: 0,
  });
  assert.equal(M.bountyPressure(player, 3), 7);
});

test('bountyPressure agrees with bountyProgress', () => {
  // Two functions reading the same baseline must never disagree about how much
  // work is left, or the pocket would be sized for a job already finished.
  for (const cleared of [0, 1, 3, 6]) {
    const player = withBounty(3, 6, cleared);
    const progress = M.bountyProgress(player, 3)[0];
    const owed = Math.max(0, progress.needed - progress.cleared);
    assert.equal(M.bountyPressure(player, 3), owed,
      'disagreement at cleared=' + cleared);
  }
});

test('an accepted contract reports the same as one built by hand', () => {
  // The fixture above mirrors `accept`; if `accept` ever changes what it
  // records, this catches the fixture drifting away from reality.
  const { system, board } = aSystemWithABoard();
  const offer = board.find((o) => o.type === 'bounty');
  if (!offer) return;               // this board had no cleanup job
  const player = P.create();
  M.accept(player, offer, 0);
  assert.equal(M.bountyPressure(player, offer.targetIndex), offer.tons);
});

test('a finished contract stops owing anything', () => {
  const player = withBounty(3, 3, 3);
  const done = M.checkBounties(player, 3);
  assert.equal(done.length, 1, 'the contract should have completed');
  assert.equal(M.bountyPressure(player, 3), 0,
    'a completed contract is still drawing hostiles into the system');
});

// --- The cleanup job must be reachable -------------------------------------

test('a dangerous lawful system always offers a cleanup job', () => {
  // Measured before this was fixed: **0 cleanup contracts in 320 boards**. The
  // delivery loop filled all three slots whenever a system produced three
  // things its neighbours wanted, so the one contract type that is not a cargo
  // run was dead content - and the defended pocket it drives could never be
  // seen at all.
  let checked = 0;
  for (const s of galaxy.systems) {
    if (F.dangerOf(s.gov, s.faction, s.condition) <= 0.25) continue;
    for (const seed of [1, 77, 2024, 99999]) {
      const board = M.generateBoard(s, galaxy, P.create(), seed, 0);
      const bounties = board.filter((o) => o.type === 'bounty').length;
      assert.equal(bounties, 1,
        s.name + ' (seed ' + seed + ') offered ' + bounties + ' cleanup jobs');
      checked += 1;
    }
  }
  assert.ok(checked > 100, 'the fixture only exercised ' + checked + ' boards');
});

test('a calm system is not offered a cleanup job', () => {
  // The other half of the rule: a system with nothing to clear should not
  // invent a job. Without this the reservation would just be "always one".
  for (const s of galaxy.systems) {
    if (F.dangerOf(s.gov, s.faction, s.condition) > 0.25) continue;
    const board = M.generateBoard(s, galaxy, P.create(), 12345, 0);
    assert.equal(board.filter((o) => o.type === 'bounty').length, 0,
      s.name + ' is calm but offered a cleanup job');
  }
});

test('reserving the cleanup slot did not overflow the board', () => {
  for (const s of galaxy.systems) {
    for (const seed of [3, 44, 555, 6666]) {
      const board = M.generateBoard(s, galaxy, P.create(), seed, 0);
      assert.ok(board.length <= M.MISSION.boardSize,
        s.name + ' offered ' + board.length + ' contracts');
    }
  }
});

test('a lonely system still offers a cleanup job', () => {
  // A cleanup job needs no neighbour, so an empty neighbourhood must not take
  // it away. The early return used to fire before the bounty was considered.
  for (const s of galaxy.systems) {
    if (F.dangerOf(s.gov, s.faction, s.condition) <= 0.25) continue;
    const board = M.generateBoard(s, { systems: [s] }, P.create(), 5, 0);
    assert.equal(board.length, 1, 'expected exactly the cleanup job, got ' + board.length);
    assert.equal(board[0].type, 'bounty');
    assert.equal(board[0].targetIndex, s.index);
    return;
  }
  throw new Error('no eligible system in the galaxy');
});

test('boards offer more than one kind of work', () => {
  // The same defect seen from the player's side: 235 of 320 boards were nothing
  // but cargo runs. A board that is three of the same row is a board with one
  // decision in it.
  let boards = 0;
  let cargoOnly = 0;
  for (const s of galaxy.systems) {
    for (const seed of [1, 77, 2024, 99999]) {
      const board = M.generateBoard(s, galaxy, P.create(), seed, 0);
      boards += 1;
      if (board.length && board.every((o) => o.type === 'delivery' || o.type === 'relief')) {
        cargoOnly += 1;
      }
    }
  }
  const share = cargoOnly / boards;
  assert.ok(share < 0.5,
    'cargo-only boards are still the norm: ' + cargoOnly + ' of ' + boards
    + ' (' + (share * 100).toFixed(0) + '%)');
});

// --- Reachability ----------------------------------------------------------

/**
 * Every target on the board must be one the commander can actually get to.
 *
 * Measured before this test existed: the board picked targets within
 * `MISSION.reach * lyPerUnit * 1.6` = **28 light years**, on a tank of **7**.
 * An audit of all 64 boards at four seeds each found **131 of 192 offers (68 %)**
 * pointing at systems unreachable even on a full tank, and none reachable
 * directly - a job the commander cannot take is not a job, it is a fine with a
 * reward printed on it.
 *
 * No earlier test could see this. They all build a board from a stub galaxy
 * (`{ systems: [s] }`) or check one contract's own fields, and reachability is
 * not a property of a contract - it is a property of the contract *and the
 * route graph* and the tank. It needs all three, which is why it was invisible.
 */
test('every contract target is reachable on a full tank', () => {
  const unreachable = [];
  let offers = 0;

  for (const s of galaxy.systems) {
    const player = P.create();
    for (const seed of [1, 77, 2024, 99999]) {
      const board = M.generateBoard(s, galaxy, player, seed, 0);
      for (const offer of board) {
        offers += 1;
        // A bounty names its own system, so it is reachable by definition.
        if (offer.type === 'bounty') continue;
        const hops = G.hopsBetween(galaxy, s.index, offer.targetIndex, player.fuelMax);
        if (!Number.isFinite(hops)) {
          unreachable.push(s.name + ' -> ' + offer.targetName
            + ' (' + offer.type + ', ' + offer.distance + ' ly)');
        }
      }
    }
  }

  assert.ok(offers > 0, 'no offers generated to check');
  assert.equal(unreachable.length, 0,
    unreachable.length + ' of ' + offers + ' offers point at unreachable systems: '
    + unreachable.slice(0, 5).join('; '));
});

test('a contract never takes longer to fly than its own deadline allows', () => {
  // A jump costs no day, but docking does, and a delivery needs one dock at the
  // far end. So the number of jumps is the number of days the trip can cost at
  // best - a job needing more hops than days is already lost when it is posted.
  const impossible = [];
  let offers = 0;

  for (const s of galaxy.systems) {
    const player = P.create();
    for (const seed of [1, 77, 2024, 99999]) {
      const board = M.generateBoard(s, galaxy, player, seed, 0);
      for (const offer of board) {
        if (offer.type === 'bounty') continue;
        offers += 1;
        const hops = G.hopsBetween(galaxy, s.index, offer.targetIndex, player.fuelMax);
        if (Number.isFinite(hops) && hops > offer.days) {
          impossible.push(s.name + ' -> ' + offer.targetName
            + ': ' + hops + ' hops in ' + offer.days + ' days');
        }
      }
    }
  }

  assert.ok(offers > 0, 'no offers generated to check');
  assert.equal(impossible.length, 0,
    impossible.length + ' of ' + offers + ' offers cannot be flown in time: '
    + impossible.slice(0, 5).join('; '));
});

test('every offer carries the hop count the route graph agrees with', () => {
  // The board shows this number, so it has to be the number the jump itself
  // would use. `hopsBetween` is the one implementation - the generator filters
  // by it and the screen prints it - so this test exists to catch the day
  // somebody recomputes it from `distance` and the two quietly drift apart.
  const wrong = [];
  let offers = 0;

  for (const s of galaxy.systems) {
    const player = P.create();
    for (const seed of [1, 77, 2024, 99999]) {
      for (const offer of M.generateBoard(s, galaxy, player, seed, 0)) {
        offers += 1;
        const real = G.hopsBetween(galaxy, s.index, offer.targetIndex, player.fuelMax);
        if (offer.type === 'bounty') {
          // A bounty names its own system, and 0 is what the screen prints for
          // "you are already there".
          if (offer.hops !== 0) wrong.push('bounty with ' + offer.hops + ' hops');
          continue;
        }
        if (!Number.isFinite(real)) { wrong.push('unreachable target'); continue; }
        if (offer.hops !== real) {
          wrong.push(s.name + ' -> ' + offer.targetName + ': says ' + offer.hops
            + ', graph says ' + real);
        }
      }
    }
  }

  assert.ok(offers > 0, 'no offers generated to check');
  assert.equal(wrong.length, 0, wrong.length + ' offers disagree with the route graph: '
    + wrong.slice(0, 5).join('; '));
});

test('the shopping list covers every cargo contract in hand', () => {
  // This is the promise the board and the market now make to the commander:
  // "buy what this list says and you can complete what you are carrying".
  // Measured before it existed: 145 of 145 cargo offers named a commodity that
  // was not in the hold, and neither screen said so.
  const broken = [];
  let checked = 0;

  for (const s of galaxy.systems) {
    const player = P.create();
    // Take everything on offer, so the list has to merge as well as count.
    for (const offer of M.generateBoard(s, galaxy, player, 4242, 0)) {
      if (M.accept(player, offer, 0).ok) checked += 1;
    }
    if (!checked) continue;

    const list = M.shoppingList(player);
    for (const c of player.contracts) {
      if (!c.commodity) continue;
      const entry = list.find((e) => e.commodity === c.commodity);
      if (!entry) { broken.push('no row for ' + c.commodity); continue; }
      // The row must be for the *sum* of the contracts wanting it, not for one
      // of them: a list that says 5 t twice has the commander buy 10.
      const want = player.contracts
        .filter((x) => x.commodity === c.commodity)
        .reduce((n, x) => n + x.tons, 0);
      if (entry.tons !== want) {
        broken.push(c.commodity + ': list says ' + entry.tons + ', contracts want ' + want);
      }
      const held = (player.cargo && player.cargo[c.commodity]) || 0;
      if (entry.short !== Math.max(0, want - held)) {
        broken.push(c.commodity + ': short says ' + entry.short);
      }
    }
    break;                       // one board is enough; the loop is the search
  }

  assert.ok(checked > 0, 'no contracts were accepted to check');
  assert.equal(broken.length, 0, broken.join('; '));
});

test('the shopping list empties as the cargo is loaded', () => {
  // The half of the mechanic the board was silently relying on. If the list
  // did not clear, the market would keep telling the commander to buy goods
  // already in the hold, which is how a working mechanic gets read as a bug.
  const { system } = aSystemWithABoard();
  const player = P.create();
  const offer = M.generateBoard(system, galaxy, player, 4242, 0)
    .find((o) => o.commodity);
  assert.ok(offer, 'no cargo offer to check');
  M.accept(player, offer, 0);

  const before = M.shoppingList(player).find((e) => e.commodity === offer.commodity);
  assert.ok(before, 'nothing was listed after accepting');
  assert.equal(before.short, offer.tons, 'the shortfall is not the full tonnage');

  P.addCargo(player, offer.commodity, offer.tons);
  const after = M.shoppingList(player).find((e) => e.commodity === offer.commodity);
  assert.ok(after, 'the row vanished entirely instead of going quiet');
  assert.equal(after.short, 0, 'the list still asks for goods already aboard');
});

test('the stake counts the cargo the fine does not', () => {
  // The fine alone understates the deal badly: 35 % of the reward, capped at
  // 600, which on a 900 CR relief run is 315 - less than the goods cost. The
  // stake is what makes the deadline a real deadline, so it has to include the
  // cargo, priced locally.
  const { system } = aSystemWithABoard();
  const player = P.create();
  const offer = M.generateBoard(system, galaxy, player, 4242, 0)
    .find((o) => o.commodity);
  assert.ok(offer, 'no cargo offer to check');
  M.accept(player, offer, 0);
  const contract = player.contracts[0];

  const market = [{ id: offer.commodity, buyPrice: 10 }];
  const fine = Math.min(M.MISSION.failFineCap,
    Math.round(contract.reward * M.MISSION.failFineFraction));
  const expected = fine + 10 * offer.tons;
  assert.equal(M.stakeOf(player, contract, market), expected,
    'the stake is not the fine plus the cargo');

  // Only what is still missing counts: goods already aboard are not at risk,
  // because they were going to be spent anyway.
  P.addCargo(player, offer.commodity, offer.tons);
  assert.equal(M.stakeOf(player, contract, market), fine + 10 * offer.tons,
    'a contract short of it is staked differently to one fully loaded');

  // A courier carries nothing, so there is nothing to add.
  assert.equal(M.stakeOf(player, { reward: 400 }, market), 140,
    'a cargo-less contract is staked at more than its fine');
});

test('no cargo contract asks for more than the ship can hold', () => {
  // Measured before the clamp: 11 of 145 cargo offers demanded more than the
  // base hold of 20 t, and the board did not say so - the commander found out
  // after buying the goods, at the moment they could not load them. A job that
  // does not fit the ship is not a job.
  const oversized = [];
  let cargo = 0;

  for (const s of galaxy.systems) {
    for (const withExtended of [false, true]) {
      const player = P.create();
      if (withExtended) P.applyEquip(player, 'cargoExt');
      const hold = P.holdMaxOf(player);
      for (const seed of [1, 77, 2024, 99999]) {
        const board = M.generateBoard(s, galaxy, player, seed, 0);
        for (const offer of board) {
          if (offer.type !== 'delivery' && offer.type !== 'relief') continue;
          cargo += 1;
          if (offer.tons > hold) {
            oversized.push(offer.type + ' ' + offer.tons + ' t into ' + hold + ' t ('
              + s.name + ' -> ' + offer.targetName + ')');
          }
        }
      }
    }
  }

  assert.ok(cargo > 0, 'no cargo offers generated to check');
  assert.equal(oversized.length, 0,
    oversized.length + ' of ' + cargo + ' cargo offers do not fit: '
    + oversized.slice(0, 5).join('; '));
});
