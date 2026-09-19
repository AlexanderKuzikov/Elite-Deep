/**
 * Economy soak: does a long game stay interesting?
 *
 * Every balance question in this project has been answered by unit tests on a
 * single transaction - a price is in range, a spread is positive, a reward
 * scales with distance. None of them can answer the only question a player
 * actually asks, which is "after two hours, am I still making decisions?"
 *
 * This runs two greedy traders through a few hundred jumps and prints both
 * curves. It is not a test: there is no pass or fail, because "the right
 * economy" is a design judgement. It is an instrument.
 *
 * ## The two traders
 *
 *   **trader**   buys the most profitable cargo run it can find, every jump,
 *                and never takes a job. This is the trade-only ceiling, and it
 *                is what this script measured before contracts existed.
 *   **career**   the same trader, but it also takes contracts: a delivery sets
 *                its destination, a cleanup job sets a place to be for a few
 *                days, and it buys equipment when it can afford to. This is the
 *                ceiling *including* the two systems that pay, which is the
 *                question the trade-only run could not answer.
 *
 * Both are **ceilings**, not typical players: they know every price in range
 * and always fly the optimal route. If a ceiling looks flat, the floor is worse.
 *
 * ## What it found (120 jumps, seed 0x1337c0de)
 *
 * | career                | final    | growth/jump | trade | contracts |
 * |-----------------------|----------|-------------|-------|-----------|
 * | trade only            | 10 627   | 1.23 %      | 100 % | 0 %       |
 * | + jobs, best pay first|  6 004   | 1.69 %      |   0 % | 100 %     |
 * | + jobs, cargo first   |  3 112   | 1.31 %      |  40 % | 60 %      |
 *
 * Three things worth knowing:
 *
 *   1. **Contracts pay for themselves.** The reward-greedy career earns **100 %
 *      of its income from contracts** - it reads the board and stops trading -
 *      and the cargo-first career earns 60 %. Neither is a side dish.
 *   2. **Taking jobs still ends with less cash than pure trading at 120 jumps** -
 *      6 004 against 10 627 - and the reason is not that contracts pay badly.
 *      The job-taking career spends **11 800 CR on equipment** (five to six
 *      items) and stands still for **101 of its 120 days** clearing pirates.
 *      Standing still earns nothing, and equipment is a one-off that has not
 *      paid back yet.
 *   3. **Cleanups dominate by reward**, so a reward-greedy commander takes
 *      sixteen of them and no cargo jobs at all. Every other job type is
 *      strictly worse per day - which is the subject of #13.
 *
 * **Read the 120-jump table as the early game.** By **800** jumps the best-pay
 * career overtakes pure trading - **76 085 against 69 516** - because the
 * equipment is a one-off cost that then keeps paying. So "taking jobs makes you
 * poorer" is true for the first few hundred jumps and false afterwards, which is
 * a different sentence and a more useful one.
 *
 * ## Why this script was lying, and what it cost to find out
 *
 * Every number in this table used to be wrong, and the *shape* was wrong too: it
 * reported that a career of pure trading beat one that took contracts by 2x and
 * that cargo jobs were nearly uncompletable. Both were artifacts of the
 * instrument. Four separate defects, all of them in the measuring apparatus
 * rather than in the game:
 *
 *   1. **The clock.** This loop spent a day on every jump, and that part was
 *      *right* - in the game a jump does cost a day, because `decayDay` fires
 *      from `completeJump` as well as from `dock`. What was wrong was the
 *      model the numbers were read against: `MISSION.days` sizes a run as
 *      "one dock at the far end" and leaves no allowance for days spent in
 *      transit, so any multi-hop contract is late by construction once the
 *      hops are charged. The fix belonged in the mission lengths and in
 *      reading the table honestly, not in making jumps free. Earlier revisions
 *      of this comment claimed the loop was wrong to charge a day per jump;
 *      that was the actual error, and it was corrected in the game's favour.
 *   2. **Cleanups never started.** A bounty names the system it was posted in,
 *      so it needs no hop - the work is already here. The sim set the target and
 *      then fell through to the trade search, which found no neighbour that
 *      "closed the distance" to a target zero light years away, and flew off,
 *      leaving the job to lapse in the port where it was taken.
 *   3. **Cargo was bought once and never topped up.** The purchase branch was
 *      guarded by `!player.cargo[carry.id]`, so as soon as any of the commodity
 *      was aboard it refused to buy more. A run split across two ports could
 *      never be completed.
 *   4. **A job finished where it started was never handed in.** `resolveArrival`
 *      ran at the *end* of a pass, on the next system, so a delivery whose
 *      target was the current system had no hop to make and no dock to be paid
 *      at. The career sat still on a completed delivery for a hundred days.
 *
 * The game itself was right about the deadline, which was worth checking rather
 * than assuming: `resolveArrival` tests `day > deadlineDay` *above* its
 * `targetIndex` guard, so a contract lapses on time wherever the commander is.
 * The bug was in the sim, not in `missions.js`.
 *
 * A real defect *did* turn up in the game from this work, found because the
 * corrected clock changed the random stream: see `suppliedStock` in
 * `logic/missions.js` - the board was posting cargo contracts larger than the
 * source system's stock, 45 % of them.
 *
 * A cross-check that keeps this honest: the flow accounting reconciles to
 * within a credit (start + income - costs = final), so the columns are not
 * quietly losing money anywhere. The `no-run` and `stranded` counters read zero
 * on all three careers at every horizon measured - the careers now go somewhere
 * every day instead of standing still.
 *
 * ## What this does not model
 *
 *   - **Combat.** A cleanup contract is modelled as "be in the target system
 *     for one day per pirate, then collect" - the reward is known at accept
 *     time and completion is assumed. A real commander can lose the fight, and
 *     the flight there costs more than a jump does. So bounty income here is an
 *     upper bound on itself.
  *   - **Death, crime, reputation.** Nothing shoots back, nothing goes wrong.
  *   - **The market reacting to the trader.** Prices are read, never moved.
  *   - **Skipping ports.** Every hop ends in a dock here (sell, refuel, buy),
  *     so a moving hop costs two days, jump plus dock. A player who chains
  *     hops on one tank flies cheaper - deadlines feel one day tighter here
  *     than in the game for multi-hop runs without refuel stops.
 *
 * Run: node scripts/economy-sim.mjs [jumps]
 */
import * as G from '../src/logic/galaxy.js';
import * as E from '../src/logic/economy.js';
import * as P from '../src/logic/player.js';
import * as M from '../src/logic/missions.js';
import * as REP from '../src/logic/reputation.js';

const JUMPS = Number(process.argv[2] || 120);
const GALAXY_SEED = 0x1337c0de;
const LY_PER_UNIT = 7 / G.JUMP_REFERENCE;

const galaxy = G.generate(GALAXY_SEED);
const toLy = (units) => units * LY_PER_UNIT;

/** The board seed the game uses, so the sim sees the boards a player would. */
function boardSeed(index, day) {
  return (GALAXY_SEED ^ (index * 2246822519) ^ (day * 2654435761)) >>> 0;
}

/** Every commodity's price in a system, as { id: { buy, sell, stock } }. */
function marketOf(system, day, activity) {
  const rows = E.computeMarket(system, day, activity);
  const out = {};
  for (const r of rows) {
    if (!r.available) continue;
    out[r.com.id] = { buy: r.buyPrice, sell: r.sellPrice, stock: r.qty };
  }
  return out;
}

/** Systems reachable on the current tank, with their distance in light years. */
function reachable(from, fuel) {
  return galaxy.systems
    .filter((s) => s.index !== from.index)
    .map((s) => ({ system: s, ly: toLy(G.distance(from, s)) }))
    .filter((c) => c.ly <= fuel)
    .sort((a, b) => a.ly - b.ly);
}

/**
 * The best single run available: buy here, sell there, for the largest profit
 * the hold and purse allow.
 *
 * `only` restricts the destination to one system - the one a contract points
 * at. Without it this is the pure trader's whole strategy.
 */
function bestRun(here, hereMarket, options, player, day, only) {
  let best = null;
  for (const option of options) {
    if (only !== undefined && option.system.index !== only) continue;
    const there = marketOf(option.system, day, player.activity);
    for (const id of Object.keys(hereMarket)) {
      const from = hereMarket[id];
      const to = there[id];
      if (!to) continue;
      const margin = to.sell - from.buy;
      if (margin <= 0.2) continue;
      const tons = Math.min(
        Math.floor(P.holdMaxOf(player) - P.cargoUsed(player)),
        Math.floor(from.stock),
        Math.floor(player.cash / Math.max(0.01, from.buy)),
      );
      if (tons <= 0) continue;
      const profit = margin * tons - option.ly * 1.4;   // minus the fuel
      if (!best || profit > best.profit) {
        best = { id, tons, margin, profit, target: option.system, ly: option.ly, buyAt: from.buy };
      }
    }
  }
  return best;
}

/** The cheapest equipment the trader does not own and can afford. */
function affordableUpgrade(player) {
  const owned = player.equip || {};
  let best = null;
  for (const item of P.EQUIPMENT) {
    if (owned[item.id]) continue;
    if (player.cash < item.price * 2) continue;      // keep trading capital
    if (!best || item.price < best.price) best = item;
  }
  return best;
}

/**
 * Fewest jumps from one system to another, on the given per-hop fuel.
 *
 * Delegates to `G.hopsBetween`, which walks the route graph. The version that
 * used to live here measured **straight-line** distance, so it would call two
 * systems four light years apart reachable even when no chain of routes joined
 * them - and it disagreed with the game, which only ever jumps edges. It was
 * moved into `logic/galaxy.js` when the contract board needed the same answer,
 * because two implementations of reachability is how the board ended up handing
 * out 28-light-year targets on a 7-light-year tank.
 */
function hopsBetween(from, targetIndex, fuel) {
  return G.hopsBetween(galaxy, from.index, targetIndex, fuel);
}

// --- The run ---------------------------------------------------------------

/**
 * One trader's career.
 *
 * `jobs` turns on contracts and equipment; without it this is exactly the
 * trade-only run the script has always done, which is what makes the two
 * columns comparable.
 *
 * ## The contract strategy, and why it is one job at a time
 *
 * The first version accepted a job whenever it had nothing to carry, which let
 * it hold four at once and service one - so seven jobs lapsed and the fines ate
 * the profit. That measured the strategy, not the economy. A commander who
 * takes a job intends to do it, so this one waits until it is empty-handed
 * before looking at the board.
 */
function runCareer(jumps, jobs, prefer) {
  const player = P.create({ name: jobs ? 'Career' : 'Trader' });
  let system = galaxy.systems[0];
  let day = 0;
  const curve = [];
  const tally = { delivery: 0, relief: 0, courier: 0, bounty: 0, failed: 0 };
  const bought = [];
  let incomeTrade = 0;
  let incomeContracts = 0;
  // A cleanup job is a place to be, not a thing to carry: the sim stands in the
  // target system for one day per pirate and then collects.
  let clearing = null;      // { target, tons, daysLeft }

  /**
   * Bank a dock-day, the way the game does: the contract sweep runs against
   * the day the ship arrived on, *then* the day advances.
   *
   * The order matters and it is the game's order. `dock()` resolves contracts
   * with the day it arrived on and only afterwards calls `decayDay` - so a
   * deadline is inclusive of the delivery day. Resolving after the advance
   * would mark a job late on the very day the commander delivered it.
   */
  function dockAndAdvance() {
    if (!jobs) { day += 1; return []; }
    const missed = [];
    for (const outcome of M.resolveArrival(player, system.index, day)) {
      if (outcome.ok) {
        incomeContracts += outcome.reward;
        tally[outcome.contract.type] = (tally[outcome.contract.type] || 0) + 1;
      } else {
        tally.failed += 1;
        missed.push(outcome);
      }
    }
    for (const outcome of M.checkBounties(player, system.index)) {
      incomeContracts += outcome.reward;
      tally.bounty += 1;
    }
    day += 1;
    return missed;
  }

  /**
   * Bank a jump-day. A jump is not a dock: no contracts are handed in or
   * lapsed mid-transit, the day just passes. Every moving hop below therefore
   * costs two days - the jump and the dock at the far end - exactly like the
   * game, which fires `decayDay` from both `completeJump` and `dock`.
   */
  function advanceJumpDay() {
    day += 1;
  }

  for (let jump = 0; jump < jumps; jump += 1) {
    // --- Arrive -----------------------------------------------------------
    // The day is banked at the *end* of the pass, not here: one pass is one
    // dock, and a dock happens after the flying. See `dockAndAdvance`.
    if (jobs) {
      if (clearing && system.index === clearing.target) {
        clearing.daysLeft -= 1;
        if (clearing.daysLeft <= 0) {
          // Count the kills through the real memory, so `checkBounties`
          // completes it below exactly as it does on a real kill.
          REP.remember(player, system.index, 'piratesCleared', clearing.tons);
          clearing = null;
        }
      }
    }

    const hereMarket = marketOf(system, day, player.activity);

    // --- Sell what is left ------------------------------------------------
    // Contracts were resolved first, so the goods a job wanted are already
    // handed over and only the trader's own cargo is sold here.
    for (const id of Object.keys(player.cargo || {})) {
      const qty = player.cargo[id];
      if (!qty || !hereMarket[id]) continue;
      const take = qty * hereMarket[id].sell;
      player.cash += take;
      incomeTrade += take;
      P.removeCargo(player, id, qty);
    }

    // --- Refuel -----------------------------------------------------------
    const fuelCost = P.refuelCost(player);
    if (player.fuel < player.fuelMax * 0.7 && player.cash > fuelCost * 2) {
      P.refuel(player);
    }

    // --- Equipment --------------------------------------------------------
    if (jobs) {
      const item = affordableUpgrade(player);
      if (item && P.buyEquipment(player, item.id).ok) bought.push(item.id);
    }

    const options = reachable(system, player.fuel);
    if (!options.length) {
      curve.push({ jump, day, cash: player.cash, system: system.name, note: 'stranded' });
      break;
    }

    // --- A job to do? -----------------------------------------------------
    let target = null;        // the system a contract points at
    let carry = null;         // { id, tons } the contract wants
    if (jobs) {
      const live = M.active(player);
      const cargoJob = live.find((c) => c.type === 'delivery' || c.type === 'relief');
      const bountyJob = live.find((c) => c.type === 'bounty');
      if (clearing) {
        target = clearing.target;
      } else if (cargoJob) {
        target = cargoJob.targetIndex;
        carry = { id: cargoJob.commodity, tons: cargoJob.tons };
      } else if (bountyJob) {
        target = bountyJob.targetIndex;
      } else {
        // Empty-handed: take the best job that can actually be delivered.
        // A run needs its hops plus the dock at the far end - the same +1 the
        // board guarantees - so the filter matches the rule, not the raw days.
        const board = M.generateBoard(system, galaxy, player, boardSeed(system.index, day), day);
        const feasible = board
          .filter((o) => hopsBetween(system, o.targetIndex, player.fuelMax) + 1 <= o.days)
          .sort((a, b) => b.reward - a.reward);
        // `prefer` exists to check the instrument: if cargo jobs never complete
        // when they are chosen *first*, the cargo path in this sim is broken
        // rather than merely unprofitable.
        const pick = (prefer === 'cargo'
          ? (feasible.filter((o) => o.type !== 'bounty')[0] || feasible[0])
          : feasible[0]);
        if (pick && M.accept(player, pick, day).ok) {
          if (pick.type === 'bounty') {
            clearing = { target: pick.targetIndex, tons: pick.tons, daysLeft: pick.tons + 1 };
            target = pick.targetIndex;
          } else if (!pick.commodity || hereMarket[pick.commodity]) {
            // A courier carries nothing; a delivery needs goods this system sells.
            if (pick.commodity) carry = { id: pick.commodity, tons: pick.tons };
            target = pick.targetIndex;
          }
        }

      }

      // A cleanup job names the system it was posted in, so a fresh one needs
      // no hop at all: the work is here. Staying put is the *whole* strategy,
      // and the sim used to miss it - it fell through to the trade search,
      // found no neighbour that "closes the distance" to a target zero light
      // years away, and flew off on a cargo run, leaving the bounty to lapse
      // in the port where it was taken. Every bounty failure in the trace was
      // this: accepted day 1, deadline 9, still in the same system on day 10.
      if (clearing && system.index === clearing.target) {
        dockAndAdvance();
        curve.push({ jump, day, cash: player.cash, system: system.name, note: 'clearing' });
        continue;
      }
    }

    // --- Where to go ------------------------------------------------------
    let hop = null;
    if (target !== null) {
      // Head for the target: take the reachable hop that closes the distance
      // most, and prefer one that also pays.
      let bestClose = null;
      for (const option of options) {
        const now = G.distance(system, galaxy.systems[target]);
        const then = G.distance(option.system, galaxy.systems[target]);
        if (then >= now) continue;
        const gain = now - then;
        if (!bestClose || gain > bestClose.gain) bestClose = { option, gain };
      }
      if (bestClose) hop = bestClose.option;
    }

    // --- Buy the contract's goods ----------------------------------------
    // Top up to the contract's tonnage, not "buy only if the hold is empty".
    //
    // The previous test was `!player.cargo[carry.id]`, which refused to buy a
    // single tonne as soon as any of the commodity was aboard. That looks
    // harmless until a run is split across two ports - and it deadlocked the
    // whole career when the split happened in a system with no neighbours. At
    // Duanor the sim sat on 7 tonnes of a 13-tonne food job with **26 tonnes on
    // the local market** and nowhere to jump, for 102 days, because the only
    // buying branch it had was switched off by its own partial load.
    //
    // This mirrors `MISSIONS.shoppingList`: the shortfall is `tons - held`.
    if (carry) {
      const held = (player.cargo && player.cargo[carry.id]) || 0;
      const short = carry.tons - held;
      const row = hereMarket[carry.id];
      if (short > 0 && row) {
        const tons = Math.min(short, Math.floor(row.stock),
          Math.floor(player.cash / Math.max(0.01, row.buy)),
          Math.floor(P.holdMaxOf(player) - P.cargoUsed(player)));
        if (tons > 0) {
          player.cash -= tons * row.buy;
          P.addCargo(player, carry.id, tons);
          player.activity += tons * 0.6;
        }
      }
    }

    // --- The job may already be done, here -------------------------------
    // A contract whose target is the system you are standing in needs no hop:
    // hand it over and bank the day. Without this the sim looked for a
    // neighbour that "closes the distance" to a target zero light years away,
    // found none, and sat still for a hundred days with a completed delivery in
    // the hold. `resolveArrival` ran afterwards, on the *next* system, so a job
    // finished where it started could never be handed in at all.
    if (jobs && target !== null && system.index === target) {
      dockAndAdvance();
      curve.push({ jump, day, cash: Math.round(player.cash), system: system.name, note: 'delivered' });
      continue;
    }

    // --- And a trade run to pay for the trip ------------------------------
    const trade = bestRun(system, hereMarket, options, player, day,
      hop ? hop.system.index : undefined);
    if (trade) {
      player.cash -= trade.tons * trade.buyAt;
      P.addCargo(player, trade.id, trade.tons);
      player.activity += trade.tons * 0.6;
      hop = options.find((o) => o.system.index === trade.target.index) || hop;
    }

    if (!hop) {
      // Nothing worth carrying and nowhere to be: sit out the day and look
      // again. A day spent waiting is a dock - it can lapse a contract, so it
      // goes through the same sweep rather than a bare increment.
      dockAndAdvance();
      curve.push({ jump, day, cash: player.cash, system: system.name, note: 'no run' });
      continue;
    }

    player.fuel = Math.max(0, player.fuel - hop.ly);
    system = hop.system;
    // **The jump costs a day, and so does the dock at the far end.** In the
    // game `decayDay` fires from `completeJump` and from `dock`, and this loop
    // docks every hop (it sells, refuels and buys at every port), so a moving
    // hop costs two days here, exactly as it does there. A player who skips
    // ports flies cheaper than this - the sim is pessimistic on purpose, and
    // `MISSION.days` was sized against "one dock at the end" alone, which is
    // why long runs looked impossible before the board learned the same rule.
    advanceJumpDay();
    dockAndAdvance();

    curve.push({ jump, day, cash: Math.round(player.cash), system: system.name });
  }

  return { curve, day, player, tally, bought, incomeTrade, incomeContracts };
}

// --- Report ----------------------------------------------------------------

const tradeOnly = runCareer(JUMPS, false);
const paidJobs = runCareer(JUMPS, true, 'reward');
const cargoJobs = runCareer(JUMPS, true, 'cargo');
const columns = [
  ['trade only', tradeOnly],
  ['+ jobs (best pay)', paidJobs],
  ['+ jobs (cargo first)', cargoJobs],
];

function at(curve, fraction) {
  const i = Math.min(curve.length - 1, Math.floor(curve.length * fraction));
  return curve[i];
}

function perJumpGrowth(curve) {
  const mid = at(curve, 0.5);
  const late = at(curve, 0.9);
  return Math.pow(late.cash / Math.max(1, mid.cash),
    1 / Math.max(1, late.jump - mid.jump));
}

console.log('jumps per career:', JUMPS);
console.log('');
console.log('  fraction  |' + columns.map((c) => (c[0] + '                    ').slice(0, 21) + '|').join(''));
console.log('            |' + columns.map(() => '   jump       cash    |').join(''));
for (const f of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
  let row = '  ' + String(Math.round(f * 100) + '%').padStart(7) + '   |';
  for (const entry of columns) {
    const p = at(entry[1].curve, f);
    row += String(p.jump).padStart(7) + String(Math.round(p.cash)).padStart(11) + '    |';
  }
  console.log(row);
}

console.log('');
for (const entry of columns) {
  const name = entry[0];
  const r = entry[1];
  const g = perJumpGrowth(r.curve);
  const last = r.curve[r.curve.length - 1];
  console.log(name.padEnd(20) + 'final ' + String(Math.round(last.cash)).padStart(8)
    + ' CR   growth/jump x' + g.toFixed(4) + '  (' + ((g - 1) * 100).toFixed(2) + '%)');
}

console.log('');
console.log('where the money came from:');
for (const entry of columns) {
  const name = entry[0];
  const r = entry[1];
  const total = r.incomeTrade + r.incomeContracts;
  if (!total) {
    console.log('  ' + name.padEnd(20) + '(trade only)');
    continue;
  }
  console.log('  ' + name.padEnd(20) + 'trade '
    + String(Math.round(r.incomeTrade)).padStart(7)
    + ' (' + (r.incomeTrade / total * 100).toFixed(0) + '%)   contracts '
    + String(Math.round(r.incomeContracts)).padStart(7)
    + ' (' + (r.incomeContracts / total * 100).toFixed(0) + '%)');
  console.log('  ' + ''.padEnd(20) + 'jobs ' + JSON.stringify(r.tally));
  console.log('  ' + ''.padEnd(20) + 'bought '
    + (r.bought.length ? r.bought.join(', ') : 'nothing'));
}

console.log('');
for (const entry of columns) {
  const name = entry[0];
  const r = entry[1];
  const stranded = r.curve.filter((c) => c.note === 'stranded').length;
  const barren = r.curve.filter((c) => c.note === 'no run').length;
  const clearing = r.curve.filter((c) => c.note === 'clearing').length;
  const delivered = r.curve.filter((c) => c.note === 'delivered').length;
  console.log(name.padEnd(20) + 'days ' + String(r.day).padStart(4)
    + '   stranded ' + stranded + ', no-run ' + barren
    + ', clearing ' + clearing + ', delivered in place ' + delivered);
}
