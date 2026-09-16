/**
 * Contracts: the station's job board.
 *
 * The galaxy already knows everything a mission system needs. A system has a
 * live condition (famine, blockade, gold rush), a trade profile naming what it
 * produces and what it lacks, a government, a danger rating and a faction that
 * now keeps a real opinion of the commander. Contracts are the layer that turns
 * those facts into something to *do*: they pick a neighbour that needs
 * something, price the trip, and hold the commander to a deadline.
 *
 * ## Why this module owns no rendering and no Three.js
 *
 * Same reason as the rest of `logic/`: the whole thing is arithmetic over
 * plain records, so it can be reasoned about and tested without a browser. The
 * station screen reads it, the HUD reads it, and neither writes it.
 *
 * ## The four kinds
 *
 *   delivery  - carry a commodity a neighbour is short of. The bread and
 *               butter of the board: it pays better than the same run would
 *               on the open market, and it tells the commander *where* to go,
 *               which is the part a new player has no way to work out.
 *   relief    - the same run, into a system in crisis. Pays far more and
 *               moves standing hard, because a famine is exactly when a
 *               delivery is worth something to somebody.
 *   courier   - documents. No cargo, no hold space, a tight deadline, and a
 *               reward that scales with distance rather than with tonnage.
 *               The contract for a commander with a fast ship and an empty
 *               hold.
 *   bounty    - clear pirates out of a system. The only contract that is not
 *               about going somewhere, and the only one that reads its
 *               progress from the world memory rather than from the cargo
 *               hold.
 *
 * ## Cargo is handed over
 *
 * A delivery requires the goods to be in the hold on arrival, and consumes
 * them. The alternative - pay for arriving with them and let the commander
 * keep them - would make the contract a bonus on top of an ordinary trade run
 * with nothing at stake. Handing them over is what makes it a job, and it is
 * why the reward is calibrated against the cargo's value rather than being a
 * flat fee.
 */
import * as R from './rng.js';
import * as F from './factions.js';
import * as E from './economy.js';
import * as P from './player.js';
import * as REP from './reputation.js';

/** How the board is priced. All four are in credits. */
export const MISSION = {
  /** Up to this many offers on a board at once. */
  boardSize: 3,
  /** How many contracts a commander may hold at once. */
  maxActive: 4,
  /** Raw world units within which a delivery target is considered reachable. */
  reach: 90,
  /** Days allowed, by type. A day passes on every dock and every jump. */
  days: { delivery: [7, 12], relief: [6, 10], courier: [4, 8], bounty: [6, 12] },
  /** Tonnage on offer, by type. */
  tons: { delivery: [6, 22], relief: [10, 30] },
  /** Bounty sizes. */
  bountyCount: [3, 6],
  /** Standing change on success and on failure. */
  standing: { success: 6, reliefSuccess: 14, fail: -9 },
  /** The fine on failure, as a fraction of the reward, and its cap. */
  failFineFraction: 0.35,
  failFineCap: 600,
};

/**
 * The name a commodity goes by on the board.
 *
 * Contracts read as work, not as a market order, so a couple of them want a
 * plainer word than the trade screen uses.
 */
function labelFor(comId) {
  const com = E.commodityById(comId);
  return com ? com.name : comId;
}

/**
 * Generate the board for one station.
 *
 * Deterministic from the seed, so a reload shows the same offers rather than
 * rerolling until a good one appears. `day` is the commander's day, which is
 * what the deadlines are measured against.
 */
export function generateBoard(system, galaxy, player, seed, day) {
  const rand = R.mulberry32(seed >>> 0);
  const offers = [];
  const used = new Set();

  // Neighbours within reach, richest first, so the board prefers a target the
  // commander can actually get to on one tank.
  const candidates = galaxy.systems
    .filter((s) => s.index !== system.index)
    .map((s) => ({ system: s, dist: distanceLy(galaxy, system, s) }))
    .filter((c) => c.dist <= MISSION.reach * lyPerUnit(galaxy) * 1.6)
    .sort((a, b) => a.dist - b.dist);

  // --- How many slots the cargo rows may use ---------------------------------
  // A cleanup job is the one row that needs no neighbour and the one row a full
  // board crowds out. Measured before this was reserved: **0 cleanup contracts
  // in 320 boards**. The delivery loop fills all three slots whenever a system
  // produces three things its neighbours want, which it did in 210 of those 320
  // - so one of the four contract types was dead content, and the defended
  // pocket it drives could never be seen at all.
  //
  // It is decided here, before the early return, because a lonely dangerous
  // system is still worth clearing even when nothing is in range to trade with.
  const bountyAvailable = F.dangerOf(system.gov, system.faction, system.condition) > 0.25;
  const cargoSlots = MISSION.boardSize - (bountyAvailable ? 1 : 0);

  if (!candidates.length && !bountyAvailable) return offers;

  // --- Delivery and relief ------------------------------------------------
  // What this system can supply, matched against what a neighbour needs. A
  // system that produces nothing has nothing to send.
  //
  // ## At most one emergency run per board
  //
  // The obvious version of this loop - offer every commodity somebody needs -
  // produced boards where *every* row said "emergency". The reason is not that
  // crises are common (they are about one system in five) but that a crisis is
  // the only thing that makes a system want a good it does not normally
  // consume. Measured at Lave: the needy pool for food was 12 calm systems and
  // 5 in crisis, but for livestock and medicine it was 0 calm and 4-6 in
  // crisis, because nothing but a famine wants livestock. Two of three rows
  // were therefore forced to be relief runs.
  //
  // So: prefer a calm destination when one exists, and allow at most one
  // emergency per board. A label that describes most of the board describes
  // nothing.
  const surplus = Object.keys((system.profile && system.profile.produces) || {});
  let reliefOffered = false;
  for (const comId of surplus) {
    if (offers.length >= cargoSlots) break;
    const needy = candidates.filter((c) => needs(c.system, comId) && !used.has(c.system.index));
    if (!needy.length) continue;

    const calm = needy.filter((c) => !isCrisis(c.system));
    const pool = (reliefOffered || !calm.length) ? needy : calm;
    const pick = pool[Math.floor(rand() * pool.length) % pool.length];

    const relief = isCrisis(pick.system);
    // The pool falls back to crisis destinations when there are no calm ones,
    // so the cap has to be applied after the pick rather than by filtering.
    if (relief && reliefOffered) continue;
    reliefOffered = reliefOffered || relief;

    used.add(pick.system.index);
    const [minTons, maxTons] = relief ? MISSION.tons.relief : MISSION.tons.delivery;
    const tons = Math.round(minTons + rand() * (maxTons - minTons));
    const days = pickDays(rand, relief ? 'relief' : 'delivery');

    offers.push(makeOffer({
      type: relief ? 'relief' : 'delivery',
      system: system,
      target: pick.system,
      commodity: comId,
      tons: tons,
      days: days,
      day: day,
      distance: pick.dist,
      rand: rand,
    }));
  }

  // --- Courier ------------------------------------------------------------
  if (offers.length < cargoSlots) {
    const free = candidates.filter((c) => !used.has(c.system.index));
    if (free.length) {
      // The furthest one, because a courier is paid for distance.
      const pick = free[free.length - 1];
      used.add(pick.system.index);
      offers.push(makeOffer({
        type: 'courier',
        system: system,
        target: pick.system,
        commodity: null,
        tons: 0,
        days: pickDays(rand, 'courier'),
        day: day,
        distance: pick.dist,
        rand: rand,
      }));
    }
  }

  // --- Bounty -------------------------------------------------------------
  // Only a lawful system bothers to post one, and only where there is something
  // to clear. The slot for it was held back above.
  if (bountyAvailable) {
    const [minCount, maxCount] = MISSION.bountyCount;
    const count = Math.round(minCount + rand() * (maxCount - minCount));
    offers.push(makeOffer({
      type: 'bounty',
      system: system,
      target: system,
      commodity: null,
      tons: count,
      days: pickDays(rand, 'bounty'),
      day: day,
      distance: 0,
      rand: rand,
    }));
  }

  return offers.slice(0, MISSION.boardSize);
}

/** Days allowed for a type, from the configured band. */
function pickDays(rand, type) {
  const [lo, hi] = MISSION.days[type];
  return Math.round(lo + rand() * (hi - lo));
}

/** Light years per raw world unit, read from the galaxy rather than assumed. */
function lyPerUnit(galaxy) {
  return galaxy.jumpReference ? 7 / galaxy.jumpReference : 0.194;
}

/** Straight-line distance between two systems, in light years. */
function distanceLy(galaxy, a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy) * lyPerUnit(galaxy);
}

/** Does this system want the commodity? Either it consumes it or it is short. */
function needs(system, comId) {
  if (system.profile && system.profile.lacking === comId) return true;
  const consumes = (system.profile && system.profile.consumes) || {};
  if (consumes[comId]) return true;
  const condition = F.condition(system.condition);
  return !!(condition && condition.demand && condition.demand[comId] > 0.5);
}

/** Is this system in a state that makes a delivery urgent? */
function isCrisis(system) {
  return system.condition === 'FAMINE' || system.condition === 'PLAGUE'
    || system.condition === 'BLOCKADE';
}

/**
 * Price one contract and package it.
 *
 * The reward is built from three terms so it stays meaningful across the whole
 * map: what the cargo is worth, how far it has to go, and how dangerous the
 * destination is. A flat fee would make a two-light-year hop and a twenty-light-
 * year haul pay the same, and the whole point of a board is that the commander
 * can tell the difference at a glance.
 */
function makeOffer(spec) {
  const com = spec.commodity ? E.commodityById(spec.commodity) : null;
  const base = com ? com.base : 0;
  const danger = F.dangerOf(spec.target.gov, spec.target.faction, spec.target.condition);

  let reward;
  if (spec.type === 'courier') {
    reward = 60 + spec.distance * 26;
  } else if (spec.type === 'bounty') {
    reward = spec.tons * 110 * (1 + danger);
  } else {
    // Cargo value, distance, and a risk premium. The cargo term is small on
    // purpose: the reward should be for the trip, not for the goods, or a
    // commander would simply buy the cheapest thing on the list every time.
    reward = 40 + base * spec.tons * 0.6 + spec.distance * 14;
    reward *= 1 + danger * 0.5;
    if (spec.type === 'relief') reward *= 2.2;
  }
  reward = Math.round(reward);

  const deadline = spec.day + spec.days;

  return {
    id: spec.type + ':' + spec.system.index + ':' + spec.target.index + ':' + deadline + ':' + spec.tons,
    type: spec.type,
    commodity: spec.commodity,
    commodityName: com ? com.name : null,
    tons: spec.tons,
    fromIndex: spec.system.index,
    fromName: spec.system.name,
    targetIndex: spec.target.index,
    targetName: spec.target.name,
    distance: Math.round(spec.distance * 10) / 10,
    reward: reward,
    deadlineDay: deadline,
    days: spec.days,
    standingFaction: spec.target.faction,
  };
}

/** A one-line description, used by the station screen and the message log. */
export function describe(offer) {
  if (offer.type === 'courier') {
    return 'Carry documents to ' + offer.targetName + ' (' + offer.distance + ' ly)';
  }
  if (offer.type === 'bounty') {
    return 'Clear ' + offer.tons + ' pirates from ' + offer.targetName;
  }
  const what = offer.tons + ' t of ' + offer.commodityName;
  if (offer.type === 'relief') {
    return 'Emergency: ' + what + ' to ' + offer.targetName;
  }
  return 'Deliver ' + what + ' to ' + offer.targetName;
}

/** Accept an offer, turning it into a live contract. */
export function accept(player, offer, day) {
  if (!player.contracts) player.contracts = [];
  if (player.contracts.length >= MISSION.maxActive) return { ok: false, reason: 'full' };
  if (player.contracts.some((c) => c.id === offer.id)) return { ok: false, reason: 'duplicate' };

  const contract = Object.assign({}, offer, {
    acceptedDay: day,
    // For a bounty, progress is measured from how many pirates the system had
    // already lost when the contract was taken. Without a baseline the
    // commander could accept a job in a system they had already cleared and be
    // paid for work they had done before being hired.
    baseline: offer.type === 'bounty'
      ? REP.memoryFor(player, offer.targetIndex).piratesCleared
      : 0,
  });
  player.contracts.push(contract);
  return { ok: true, contract: contract };
}

/**
 * Everything that should happen when the commander docks somewhere.
 *
 * Returns a list of outcomes rather than mutating quietly, so the caller can
 * report each one and decide about sound and standing. Cargo is consumed here
 * because the alternative - returning a description of what to remove and
 * hoping the caller does it - is how a delivery gets paid for twice.
 */
export function resolveArrival(player, systemIndex, day) {
  if (!player.contracts || !player.contracts.length) return [];
  const outcomes = [];

  for (let i = player.contracts.length - 1; i >= 0; i -= 1) {
    const c = player.contracts[i];

    // Overdue first: a contract that ran out of time cannot also be completed.
    if (day > c.deadlineDay) {
      player.contracts.splice(i, 1);
      outcomes.push(failOutcome(player, c, 'overdue'));
      continue;
    }

    if (c.targetIndex !== systemIndex) continue;
    if (c.type === 'bounty') continue;   // handled by `checkBounties`

    if (c.type === 'courier') {
      player.contracts.splice(i, 1);
      outcomes.push(successOutcome(player, c, 'documents delivered'));
      continue;
    }

    // Delivery and relief: the goods have to actually be aboard.
    const held = (player.cargo && player.cargo[c.commodity]) || 0;
    if (held < c.tons) continue;      // still short; the contract stays open
    P.removeCargo(player, c.commodity, c.tons);
    player.contracts.splice(i, 1);
    outcomes.push(successOutcome(player, c, c.tons + ' t handed over'));
  }

  return outcomes;
}

/**
 * Complete any bounty whose count is met.
 *
 * Called the moment a pirate dies, so the reward lands while the wreck is
 * still expanding, and again on docking as a safety net. A bounty is the one
 * contract that can be finished without going anywhere, so it should not have
 * to wait for a landing pad.
 */
export function checkBounties(player, systemIndex) {
  const done = [];
  if (!player || !player.contracts) return done;
  for (let i = player.contracts.length - 1; i >= 0; i -= 1) {
    const c = player.contracts[i];
    if (c.type !== 'bounty' || c.targetIndex !== systemIndex) continue;
    const cleared = REP.memoryFor(player, systemIndex).piratesCleared - c.baseline;
    if (cleared < c.tons) continue;
    player.contracts.splice(i, 1);
    done.push(successOutcome(player, c, 'cleared ' + cleared + ' of ' + c.tons));
  }
  return done;
}

/** Progress on the bounties open in this system, for the status screen. */
export function bountyProgress(player, systemIndex) {
  const out = [];
  if (!player.contracts) return out;
  for (const c of player.contracts) {
    if (c.type !== 'bounty' || c.targetIndex !== systemIndex) continue;
    const cleared = REP.memoryFor(player, systemIndex).piratesCleared - c.baseline;
    out.push({ contract: c, cleared: cleared, needed: c.tons, done: cleared >= c.tons });
  }
  return out;
}

/**
 * How many pirates an open cleanup contract still owes in a system.
 *
 * A cleanup contract names *the system it was posted in* - there is nowhere to
 * travel to - so on its own it is a promise to loiter in the right place until
 * the right ships happen to die. This number is what lets the world hold up its
 * end: the traffic layer sizes a defended pocket to it, so taking the job
 * changes the sky you launch into, and clearing it visibly shrinks the pocket.
 *
 * Counted against the same baseline `checkBounties` uses, so the two can never
 * disagree about how much work is left.
 */
export function bountyPressure(player, systemIndex) {
  if (!player || !player.contracts) return 0;
  let owed = 0;
  for (const c of player.contracts) {
    if (c.type !== 'bounty' || c.targetIndex !== systemIndex) continue;
    const cleared = REP.memoryFor(player, systemIndex).piratesCleared - c.baseline;
    owed += Math.max(0, c.tons - cleared);
  }
  return owed;
}

function successOutcome(player, contract, note) {
  player.cash += contract.reward;
  if (contract.standingFaction) {
    P.adjustStanding(player, contract.standingFaction,
      contract.type === 'relief' ? MISSION.standing.reliefSuccess : MISSION.standing.success);
  }
  return { ok: true, contract: contract, reward: contract.reward, note: note };
}

function failOutcome(player, contract, reason) {
  const fine = Math.min(MISSION.failFineCap, Math.round(contract.reward * MISSION.failFineFraction));
  const paid = Math.min(fine, Math.max(0, Math.floor(player.cash)));
  player.cash -= paid;
  if (contract.standingFaction) {
    P.adjustStanding(player, contract.standingFaction, MISSION.standing.fail);
  }
  return { ok: false, contract: contract, reason: reason, fine: paid };
}

/** Give up on a contract. The same cost as letting it lapse. */
export function abandon(player, contractId) {
  if (!player.contracts) return null;
  const i = player.contracts.findIndex((c) => c.id === contractId);
  if (i < 0) return null;
  const c = player.contracts.splice(i, 1)[0];
  return failOutcome(player, c, 'abandoned');
}

/** How many days are left, or a negative number once it is overdue. */
export function daysLeft(contract, day) {
  return contract.deadlineDay - day;
}

/** Active contracts, soonest deadline first - the order a pilot wants them. */
export function active(player) {
  return ((player && player.contracts) || []).slice()
    .sort((a, b) => a.deadlineDay - b.deadlineDay);
}

export default {
  MISSION, generateBoard, describe, accept, resolveArrival, checkBounties,
  bountyProgress, bountyPressure, abandon, daysLeft, active,
};
