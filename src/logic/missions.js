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
import * as G from './galaxy.js';

/** How the board is priced. All four are in credits. */
export const MISSION = {
  /** Up to this many offers on a board at once. */
  boardSize: 3,
  /** How many contracts a commander may hold at once. */
  maxActive: 4,
  /**
   * How far from home the board will look, **in jumps**.
   *
   * This replaced a straight-line radius of `reach * lyPerUnit * 1.6` = 28
   * light years, which is why the board used to hand out work nobody could
   * take. Measured on all 64 systems at four seeds: **541 of 768 offers (70 %)**
   * named a target unreachable even on a full tank, and not one was reachable
   * directly. The old radius was four times the tank and ignored the route
   * graph entirely, so it was measuring a distance the ship cannot fly.
   *
   * Six jumps is the ceiling because a deadline is measured in days and a day
   * is spent by a jump as well as by a dock: a run out and back costs two hops
   * of the budget, so six hops still leaves room for the return trip on the
   * longest deadlines.
   */
  maxHops: 6,
  /** Days allowed, by type. A day passes on every dock and every jump. */
  days: { delivery: [7, 12], relief: [6, 10], courier: [4, 8], bounty: [6, 12] },
  /**
   * Days a single hop is worth when a deadline has to be raised to fit.
   *
   * One, because a jump spends a day (`decayDay` fires from `completeJump`).
   * The `+ 1` at the call site is the dock at the far end, where the documents
   * are actually handed over - a courier that arrives with no day left to dock
   * has not delivered. So the shortest flyable route of N hops needs N + 1
   * days, and a deadline that only covers the hops is a job lost in transit.
   */
  daysPerHop: 1,
  /** Tonnage on offer, by type, as a floor and a share of the hold. */
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
  // commander can actually get to.
  //
  // "Within reach" used to mean **within 28 light years in a straight line**,
  // which is not a distance this ship can fly: it jumps route edges, and its
  // tank holds 7. Measured before the fix: 541 of 768 offers named a target
  // unreachable even on a full tank. The filter is now the same one the jump
  // itself uses - walk the route graph, count the hops, cap them - so a target
  // on the board is a target `canJump` can actually chain to.
  const tank = (player && player.fuelMax) || P.create().fuelMax;
  const candidates = galaxy.systems
    .filter((s) => s.index !== system.index)
    .map((s) => ({
      system: s,
      dist: distanceLy(galaxy, system, s),
      hops: G.hopsBetween(galaxy, system.index, s.index, tank),
    }))
    .filter((c) => Number.isFinite(c.hops) && c.hops <= MISSION.maxHops)
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
    // The band's ceiling is clamped to two things: the hold the commander has,
    // and the stock the posting system can actually supply.
    //
    // The hold clamp closed a measured defect - **11 of 145 cargo offers
    // demanded more than 20 tonnes** while the base hold carries 20, and the
    // board said nothing, so the commander found out after buying. A job that
    // does not fit the ship is not a job.
    //
    // The stock clamp closes the same defect one step earlier, and it is the
    // bigger of the two. A delivery is *bought* at the system that posts it, so
    // a board asking for more than that system holds is asking for goods that
    // do not exist. Measured before this: **1387 of 3080 cargo offers (45 %)**
    // named a tonnage above the local stock and 120 named a commodity the
    // system does not sell at all, the worst gap being 18 tonnes. The tonnage
    // band knew about `qBase` in no way whatsoever. The commander's loop was to
    // buy what there was, arrive short, and never be able to close.
    //
    // The band's floor is *not* raised to meet the stock: a poor system may
    // legitimately post a small job. Instead the whole band is shifted down
    // when the stock cannot carry its ceiling, so a thin market posts small
    // runs rather than impossible ones.
    const hold = (player && P.holdMaxOf(player)) || P.BASE_HOLD;
    const stock = suppliedStock(system, comId, day, player);
    const ceiling = Math.max(0, Math.min(maxTons, hold, stock));
    if (ceiling < 1) continue;      // this system cannot supply the job at all
    // Keep the floor below the ceiling, and let a scarce market pull it down.
    const floor = Math.min(minTons, ceiling);
    const top = Math.max(floor, ceiling);
    const tons = Math.max(1, Math.round(floor + rand() * (top - floor)));
    // The deadline is raised to fit the route, never lowered - the same rule
    // the courier already follows below. A six-hop run with six days arrives
    // on the last day with no day left to dock, so the floor is hops plus the
    // far-end dock. Without this the job is flyable only by luck of the draw.
    const drawn = pickDays(rand, relief ? 'relief' : 'delivery');
    const days = Math.max(drawn, Math.ceil(pick.hops * MISSION.daysPerHop) + 1);

    offers.push(makeOffer({
      type: relief ? 'relief' : 'delivery',
      system: system,
      target: pick.system,
      commodity: comId,
      tons: tons,
      days: days,
      day: day,
      distance: pick.dist,
      hops: pick.hops,
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
      // The deadline is raised to fit the route, never lowered.
      //
      // A courier is the one job that picks its target for *maximising*
      // distance, and the days band was drawn independently of how far that
      // turned out to be - so a six-hop run could be posted with five days and
      // be lost before it was accepted. Found at Rari: a courier to Ores, six
      // hops, five days. Raising the floor around the drawn value keeps the
      // randomness and keeps the job flyable; the alternative - redrawing until
      // it fits - would bias every courier on the board toward short runs.
      const drawn = pickDays(rand, 'courier');
      const days = Math.max(drawn, Math.ceil(pick.hops * MISSION.daysPerHop) + 1);
      offers.push(makeOffer({
        type: 'courier',
        system: system,
        target: pick.system,
        commodity: null,
        tons: 0,
        days: days,
        day: day,
        distance: pick.dist,
        hops: pick.hops,
        rand: rand,
      }));
    }
  }

  // --- Bounty -------------------------------------------------------------
  // A cleanup job is posted where there is something to clear. Note what this
  // does *not* check: lawfulness. An anarchy with danger over the bar posts
  // like anyone else, so "who pays for order where there is none" is an open
  // balance question (see the bounty-reward problem), not a settled rule.
  // The slot for it was held back above.
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
      hops: 0,
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

/**
 * How many tonnes of one commodity a system can actually sell right now.
 *
 * Returns 0 for a commodity the world does not trade at all. This reads the
 * *real* market rather than an approximation of it, because the whole point is
 * that the board and the market screen must agree: a board that clamps by one
 * rule and a market that stocks by another puts the commander back where this
 * defect started.
 *
 * `player` is only needed for the activity term, which is what makes prices and
 * stock drift with the commander's own trading. A missing player reads the
 * market at rest, which is the right answer for a board generated for nobody.
 */
function suppliedStock(system, comId, day, player) {
  const activity = (player && player.activity) || 0;
  for (const row of E.computeMarket(system, day, activity)) {
    if (row.com && row.com.id === comId) return row.available ? row.qty : 0;
  }
  return 0;
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
 * The identity of an offer, and of the contract it becomes.
 *
 * Two things key on this: the board marks an offer `taken` by matching ids, and
 * `accept` refuses an id it already holds. So it has to be unique per *job* -
 * and until the commodity was added it was not. Type, route, deadline and
 * tonnage were the whole story, so two different cargoes posted on the same
 * route for the same tonnage and landing on the same day shared an id, and the
 * duplicate guard refused the second as though it were the first.
 *
 * Courier and bounty carry no commodity (`null`), which leaves an empty final
 * slot rather than changing their ids.
 */
export function offerId(spec) {
  return spec.type + ':' + spec.system.index + ':' + spec.target.index + ':'
    + (spec.day + spec.days) + ':' + spec.tons + ':' + (spec.commodity || '');
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
    // The commodity is part of the identity, not decoration: see `offerId`.
    id: offerId(spec),
    type: spec.type,
    commodity: spec.commodity,
    commodityName: com ? com.name : null,
    tons: spec.tons,
    fromIndex: spec.system.index,
    fromName: spec.system.name,
    targetIndex: spec.target.index,
    targetName: spec.target.name,
    distance: Math.round(spec.distance * 10) / 10,
    // Jumps to the destination, on a full tank. Carried on the offer because
    // the distance alone cannot answer the only question the commander has at
    // the board - *can I get there, and in how many days* - and the generator
    // already knows: it is the number the target was filtered by.
    hops: Number.isFinite(spec.hops) ? spec.hops : null,
    reward: reward,
    deadlineDay: deadline,
    days: spec.days,
    standingFaction: spec.target.faction,
  };
}

/**
 * What the commander still has to go and buy, across all live contracts.
 *
 * **Why this exists.** A delivery contract never loads the goods - that is the
 * mechanic, not a bug: work is "carry *these* goods to *there*", and the goods
 * are bought on the open market like any other cargo. What was missing was the
 * telling. Measured before this: **145 of 145 cargo offers** named a commodity
 * the commander did not hold and the board did not say so anywhere. The first
 * thing a new commander learned about contracts was, at the destination, that
 * they had carried the wrong thing.
 *
 * So this is the missing half of the board: given the contracts in hand and the
 * cargo actually aboard, what is left to buy. Keyed by commodity, because two
 * contracts wanting food want the same three tonnes of it, and a shopping list
 * that asks for five tonnes in two lines gets five tonnes bought twice.
 *
 * Deliberately *not* a function of which station the commander is standing in.
 * A shortage is a fact about the ship; the market's ability to fill it is a
 * separate question the market screen already answers.
 */
export function shoppingList(player) {
  const need = new Map();
  for (const c of (player && player.contracts) || []) {
    if (!c.commodity) continue;
    need.set(c.commodity, (need.get(c.commodity) || 0) + c.tons);
  }

  const out = [];
  for (const [commodity, tons] of need) {
    const held = (player.cargo && player.cargo[commodity]) || 0;
    const com = E.commodityById(commodity);
    out.push({
      commodity: commodity,
      name: com ? com.name : commodity,
      tons: tons,
      held: held,
      short: Math.max(0, tons - held),
    });
  }
  // Things still to fetch first, then alphabetically, so the list does not
  // reshuffle under the cursor as the hold changes.
  out.sort((a, b) => (b.short > 0 ? 1 : 0) - (a.short > 0 ? 1 : 0)
    || a.name.localeCompare(b.name));
  return out;
}

/**
 * What a live contract would cost the commander if it ran out of time, in
 * credits, priced locally.
 *
 * `failOutcome` charges a fine of 35 % of the reward, capped at 600 - small
 * enough that failing a big run is cheaper than flying it, which makes
 * "abandon at the deadline" a real strategy and the deadline a suggestion. The
 * fine is only half the bill: the goods are already bought by then, and if the
 * contract was the reason they were bought they are dead stock in the hold.
 *
 * So the stake is the fine *and* the cargo it was carrying, the second term
 * valued at what this station asks for it right now - what the commander would
 * have to pay to buy that mistake back. A courier carries nothing and a bounty
 * is handed no goods, so both are fine-only, which is why this reads the
 * shopping list rather than the contract.
 *
 * Returns credits, rounded, for the status screen to print next to the reward.
 */
export function stakeOf(player, contract, market) {
  const fine = Math.min(MISSION.failFineCap,
    Math.round(contract.reward * MISSION.failFineFraction));
  if (!contract.commodity || !market) return fine;

  const entry = shoppingList(player).find((e) => e.commodity === contract.commodity);
  // `||` would be wrong here: a full hold gives `short === 0`, which is falsy,
  // so the fallback fired exactly when the answer was zero and valued the stake
  // as though the whole tonnage were still to be bought. Only a *missing* entry
  // (nothing to price) falls back to the contract's own tonnage.
  const tons = entry ? entry.short : contract.tons;
  const row = market.find((r) => r && r.id === contract.commodity);
  const unit = (row && row.buyPrice) || 0;
  return fine + Math.round(unit * tons);
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
  shoppingList, stakeOf, offerId,
};
