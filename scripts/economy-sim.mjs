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
 * | + jobs, best pay first|  4 573   | 0.32 %      |  35 % | 65 %      |
 * | + jobs, cargo first   |  3 312   | 1.31 %      |  76 % | 24 %      |
 *
 * Three things worth knowing:
 *
 *   1. **Contracts are a real share of income.** For a commander who takes them
 *      they are **65 % of income** - but see the next point, because the share
 *      is not the same thing as the outcome.
 *   2. **Taking jobs still ends with less cash than pure trading** - 4 573
 *      against 10 627. Two reasons, and neither is that contracts pay badly:
 *      the job-taking career spends **11 800 CR on equipment** (six items) and
 *      stands still for **76 of its 120 days** clearing pirates. Standing still
 *      earns nothing.
 *   3. **Cleanups dominate by reward**, so a reward-greedy commander takes
 *      fifteen of them and one relief run, and no cargo jobs at all. Every
 *      other job type is strictly worse per day.
 *
 * **Read the 120-jump table as the *early* game.** At **800** jumps the
 * best-pay career overtakes pure trading - 72 280 against 69 516 - because the
 * equipment is a one-off cost that then keeps paying, and by then both have
 * settled to a crawl (0.20 % against 0.19 % per jump, which is what a mature
 * economy looks like). Note that the *final* figure is not where the difference
 * shows: at 120 jumps the gap is 2.3x and at 800 there is none. So "taking jobs
 * makes you poorer" is true for the first few hundred jumps and false
 * afterwards, which is a different sentence and a more useful one.
 *
 * ## The cargo-first column is broken, and it is the *clock* that broke it
 *
 * The cargo-first column exists to check the instrument rather than to model a
 * player: if cargo jobs never complete when chosen *first*, the cargo path in
 * this sim is broken rather than unprofitable. At 120 jumps it shows **8
 * deliveries and 6 relief runs completed against 8 failures** - and at 800
 * jumps, **62 completed against 61 failures**, with contract income *negative*
 * (-18 975 CR by the flow accounting). That is not "contracts pay badly". It is
 * this sim refusing to let them be delivered.
 *
 * The cause is the day model, not the economy. **This loop spends a day on
 * every jump**, while `MISSION.days` is set for the game's model where a day is
 * a *dock* and a jump costs no time at all (`decayDay` fires on `dock`).
 * Deadlines sized for "six docks" therefore expire after six *jumps*, and a
 * multi-hop run is late before it arrives.
 *
 * A second defect compounds it: a cleanup job parks the ship for `tons + 1`
 * days, but `resolveArrival` only checks `day > deadlineDay` once the commander
 * is back in the target system. So a six-tonne delivery can go overdue while
 * the ship sits in someone else's port, and only finds out later.
 *
 * Neither is a balance finding, and the reward formula is not implicated: on
 * live boards **only 55 of 3 680 offers** are too tight for a round trip, so in
 * the game the window is generous. Fix the clock here and the deadline check
 * there before reading the cargo column as an economic verdict.
 *
 * The cargo-first column's own numbers should be treated as **fiction until
 * then** - it is measuring "can this loop finish a job", not "is a job worth
 * taking".
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

  for (let jump = 0; jump < jumps; jump += 1) {
    // --- Arrive -----------------------------------------------------------
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
      for (const outcome of M.resolveArrival(player, system.index, day)) {
        if (outcome.ok) {
          incomeContracts += outcome.reward;
          tally[outcome.contract.type] = (tally[outcome.contract.type] || 0) + 1;
        } else {
          tally.failed += 1;
        }
      }
      for (const outcome of M.checkBounties(player, system.index)) {
        incomeContracts += outcome.reward;
        tally.bounty += 1;
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

    // --- Still hunting? Hold position, but only once you are there. -------
    // The first version held position whenever `clearing` was set, including
    // before it had travelled to the target - so the days never ticked down and
    // the run ended with the ship parked for ever in the wrong system.
    if (clearing && system.index === clearing.target) {
      day += 1;
      curve.push({ jump, day, cash: player.cash, system: system.name, note: 'clearing' });
      continue;
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
        const board = M.generateBoard(system, galaxy, player, boardSeed(system.index, day), day);
        const feasible = board
          .filter((o) => hopsBetween(system, o.targetIndex, player.fuelMax) <= o.days)
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
    if (carry && !player.cargo[carry.id]) {
      const row = hereMarket[carry.id];
      if (row) {
        const tons = Math.min(carry.tons, Math.floor(row.stock),
          Math.floor(player.cash / Math.max(0.01, row.buy)),
          Math.floor(P.holdMaxOf(player) - P.cargoUsed(player)));
        if (tons > 0) {
          player.cash -= tons * row.buy;
          P.addCargo(player, carry.id, tons);
          player.activity += tons * 0.6;
        }
      }
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
      // Nothing worth carrying and nowhere to be: wait a day and look again.
      day += 1;
      curve.push({ jump, day, cash: player.cash, system: system.name, note: 'no run' });
      continue;
    }

    player.fuel = Math.max(0, player.fuel - hop.ly);
    system = hop.system;
    day += 1;

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
  console.log(name.padEnd(20) + 'days ' + String(r.day).padStart(4)
    + '   stranded ' + stranded + ', no-run ' + barren + ', clearing ' + clearing);
}
