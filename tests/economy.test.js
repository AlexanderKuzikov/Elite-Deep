/**
 * Economy tests.
 *
 * Two kinds of assertion live here, and the second kind matters more:
 *
 *   1. Correctness - illegal goods are illegal where they should be, tech
 *      gating hides weapons from low-tech worlds, cargo valuation is right.
 *
 *   2. Balance invariants - the properties that must hold or the game stops
 *      being a game. Chief among them: you can never profit by buying and
 *      selling in the same station, and no single price can run away far
 *      enough to become a money printer. Those are the failures that do not
 *      show up as a crash, only as a boring game, so they get tested.
 */
import test from 'node:test';
import assert from 'node:assert';
import * as E from '../src/logic/economy.js';
import * as G from '../src/logic/galaxy.js';
import * as F from '../src/logic/factions.js';

const SEEDS = [1984, 7, 90210, 555, 31337, 4242];

test('commodity table is well formed', () => {
  assert.ok(E.COMMODITIES.length >= 17, 'expected at least 17 commodities');
  const ids = new Set();
  for (const c of E.COMMODITIES) {
    assert.ok(c.id && c.name, 'commodity missing id or name');
    assert.ok(!ids.has(c.id), 'duplicate commodity id: ' + c.id);
    ids.add(c.id);
    assert.ok(c.base > 0, 'non-positive base price: ' + c.id);
    assert.ok(c.qBase > 0, 'non-positive base quantity: ' + c.id);
    assert.ok(c.minTech >= 1 && c.minTech <= 15, 'minTech out of range: ' + c.id);
  }
});

test('commodityById round-trips and rejects unknowns', () => {
  for (const c of E.COMMODITIES) assert.strictEqual(E.commodityById(c.id).id, c.id);
  assert.strictEqual(E.commodityById('unobtainium'), null);
});

test('every system produces a market for every commodity it can trade', () => {
  const gal = G.generate(1984);
  for (const s of gal.systems) {
    const m = E.computeMarket(s, 0, 0);
    assert.strictEqual(m.length, E.COMMODITIES.length);
    for (const row of m) {
      if (row.available) {
        assert.ok(row.price > 0, s.name + ': non-positive price for ' + row.com.id);
        assert.ok(row.sellPrice > 0, s.name + ': non-positive sell price');
        assert.ok(row.qty >= 0, s.name + ': negative stock');
        assert.ok(row.sellPrice < row.buyPrice, s.name + ': sell price not below buy price');
      } else {
        assert.strictEqual(row.qty, 0, 'unavailable commodity has stock');
      }
    }
  }
});

test('prices are finite and bounded across many seeds, days and conditions', () => {
  // This is the money-printer guard. If any combination of profile, condition
  // and drift pushes a price past 5x base, arbitrage stops being about
  // geography and becomes about finding the broken world.
  const gal = G.generate(1984);
  let worst = 0, worstWhat = '';
  for (const s of gal.systems) {
    for (let day = 0; day < 120; day += 7) {
      for (const row of E.computeMarket(s, day, day * 0.3)) {
        if (!row.available) continue;
        assert.ok(Number.isFinite(row.price), 'non-finite price in ' + s.name);
        const ratio = row.price / row.com.base;
        if (ratio > worst) { worst = ratio; worstWhat = s.name + '/' + row.com.id + ' day ' + day; }
      }
    }
  }
  assert.ok(worst < 5, 'price ran away to ' + worst.toFixed(2) + 'x base at ' + worstWhat);
});

test('buying and selling in the same station is always a loss', () => {
  // The single most important economic invariant: standing still must never
  // pay. Without this, trading is a no-op and the game has no reason to move.
  for (const seed of SEEDS) {
    const gal = G.generate(seed);
    for (const s of gal.systems) {
      for (const row of E.computeMarket(s, 0, 0)) {
        if (!row.available) continue;
        const margin = row.sellPrice - row.buyPrice;
        assert.ok(margin < 0,
          seed + '/' + s.name + '/' + row.com.id + ': same-station margin ' + margin);
      }
    }
  }
});

test('high-tech goods are unavailable at low-tech worlds', () => {
  const gal = G.generate(1984);
  for (const s of gal.systems) {
    if (s.tech >= 8) continue;
    const m = E.computeMarket(s, 0, 0);
    const weapons = m.find(r => r.com.id === 'weapons');
    if (s.tech < 6) {
      assert.strictEqual(weapons.available, false,
        s.name + ' (tech ' + s.tech + ') should not sell weapons');
    }
  }
});

test('at least one world sells weapons, or the tech ladder is pointless', () => {
  const gal = G.generate(1984);
  const sellers = gal.systems.filter(s =>
    E.computeMarket(s, 0, 0).find(r => r.com.id === 'weapons' && r.available));
  assert.ok(sellers.length > 0, 'no system sells weapons at all');
});

test('contraband legality follows the local government', () => {
  // `bannedUnderGov` lists the governments that police a good, so the test
  // reads the same way the table does. Anarchy appears only where the design
  // says the absence of a state means the absence of a crime.
  const narcotics = E.commodityById('narcotics');
  const slaves = E.commodityById('slaves');
  const firearms = E.commodityById('firearms');
  const weapons = E.commodityById('weapons');

  assert.deepStrictEqual(narcotics.bannedUnderGov, [1, 2, 3, 4, 5, 6]);
  assert.deepStrictEqual(slaves.bannedUnderGov, [1, 2, 3, 4, 5, 6]);

  // Narcotics and slaves: contraband under every real state, tolerated in
  // anarchy (no law) and under the corporate state (no interest).
  assert.ok(E.isIllegal({ gov: 6 }, narcotics), 'narcotics should be illegal in a democracy');
  assert.ok(E.isIllegal({ gov: 4 }, slaves), 'slaves should be illegal under communism');
  assert.ok(!E.isIllegal({ gov: 0 }, narcotics), 'narcotics should be tolerated in anarchy');
  assert.ok(!E.isIllegal({ gov: 7 }, slaves), 'slaves should be tolerated in a corporate state');

  // Firearms follow a different list, so the two must not converge by accident.
  assert.notDeepStrictEqual(firearms.bannedUnderGov, narcotics.bannedUnderGov);
  assert.ok(E.isIllegal({ gov: 0 }, firearms), 'firearms should be barred in anarchy');
  assert.ok(E.isIllegal({ gov: 6 }, firearms), 'firearms should be barred in a democracy');
  assert.ok(!E.isIllegal({ gov: 1 }, firearms), 'firearms should be tolerated under feudalism');

  // Weapons: barred under anarchy, multi-government and democracy.
  assert.ok(E.isIllegal({ gov: 0 }, weapons) && E.isIllegal({ gov: 6 }, weapons));
  assert.ok(!E.isIllegal({ gov: 3 }, weapons), 'weapons should be tolerated under a dictatorship');
});

test('legal goods are never flagged as contraband', () => {
  for (const c of E.COMMODITIES) {
    if (c.bannedUnderGov && c.bannedUnderGov.length) continue;
    for (const gov of [0, 3, 7]) {
      assert.ok(!E.isIllegal({ gov: gov }, c), c.id + ' flagged illegal under gov ' + gov);
    }
  }
});

test('cargo valuation and tonnage are consistent', () => {
  const gal = G.generate(1984);
  const s = gal.systems[0];
  const m = E.computeMarket(s, 0, 0);
  const food = m.find(r => r.com.id === 'food');
  const cargo = { food: 10 };
  assert.strictEqual(E.cargoTons(cargo), 10);
  assert.strictEqual(E.cargoValue(m, cargo), Math.round(food.sellPrice * 10 * 100) / 100);

  assert.strictEqual(E.cargoTons({}), 0);
  assert.strictEqual(E.cargoValue(m, {}), 0);
  assert.strictEqual(E.cargoTons({ food: 3, minerals: 4 }), 7);
});

test('a rational trade route exists from the starting system', () => {
  // The opening minutes decide whether a player keeps playing, so this is
  // asserted rather than assumed: from Lave, with a 100 credit purse and a
  // 20 tonne hold, at least one profitable hop must be affordable.
  const gal = G.generate(1984);
  const lave = gal.systems[0];
  const markets = gal.systems.map(s => E.computeMarket(s, 0, 0));
  const laveMarket = markets[0];

  let best = 0;
  for (const r of gal.routes) {
    const otherIdx = r.a === 0 ? r.b : r.b === 0 ? r.a : -1;
    if (otherIdx < 0) continue;
    for (const row of laveMarket) {
      if (!row.available) continue;
      const b = markets[otherIdx].find(x => x.com.id === row.com.id);
      if (!b || !b.available) continue;
      const afford = Math.floor(100 / row.buyPrice);
      const tons = Math.min(afford, row.qty, 20);
      if (tons <= 0) continue;
      const profit = (b.sellPrice - row.buyPrice) * tons;
      if (profit > best) best = profit;
    }
  }
  assert.ok(best >= 30,
    'best affordable run out of Lave only yields ' + best.toFixed(0) + ' cr - too punishing to start');
});

test('the biggest run out of the capital is not a money printer', () => {
  // Upper bound on the opening: if one hop out of Lave nets more than 400
  // credits, the early game has no arc left.
  const gal = G.generate(1984);
  const markets = gal.systems.map(s => E.computeMarket(s, 0, 0));
  const laveMarket = markets[0];
  let best = 0;
  for (const r of gal.routes) {
    const otherIdx = r.a === 0 ? r.b : r.b === 0 ? r.a : -1;
    if (otherIdx < 0) continue;
    for (const row of laveMarket) {
      if (!row.available) continue;
      const b = markets[otherIdx].find(x => x.com.id === row.com.id);
      if (!b || !b.available) continue;
      const tons = Math.min(Math.floor(100000 / row.buyPrice), row.qty, 20);
      const profit = (b.sellPrice - row.buyPrice) * tons;
      if (profit > best) best = profit;
    }
  }
  assert.ok(best < 400, 'one hop out of Lave yields ' + best.toFixed(0) + ' cr - too generous');
});

test('profitable routes are common enough to trade but not ubiquitous', () => {
  // If almost every hop pays, there is no route to discover. If almost none
  // do, the chart is noise. One in roughly eight to one in three is the band.
  const gal = G.generate(1984);
  const markets = gal.systems.map(s => E.computeMarket(s, 0, 0));
  let total = 0, good = 0;
  for (const r of gal.routes) {
    const A = markets[r.a], B = markets[r.b];
    for (const row of A) {
      if (!row.available) continue;
      const b = B.find(x => x.com.id === row.com.id);
      if (!b || !b.available) continue;
      total++;
      if ((b.sellPrice - row.buyPrice) / row.buyPrice > 0.08) good++;
    }
  }
  const ratio = good / total;
  assert.ok(ratio > 0.03, 'only ' + (ratio * 100).toFixed(1) + '% of runs pay - too barren');
  assert.ok(ratio < 0.45, (ratio * 100).toFixed(1) + '% of runs pay - too easy');
});

test('dangerous destinations pay better than safe ones on average', () => {
  // Risk must be compensated, or the danger dial is decoration.
  const gal = G.generate(1984);
  const markets = gal.systems.map(s => E.computeMarket(s, 0, 0));
  const byDanger = { safe: [], risky: [] };
  for (const r of gal.routes) {
    const dest = gal.systems[r.b];
    const src = gal.systems[r.a];
    const mSrc = markets[r.a], mDst = markets[r.b];
    for (const row of mSrc) {
      if (!row.available) continue;
      const b = mDst.find(x => x.com.id === row.com.id);
      if (!b || !b.available) continue;
      const pct = (b.sellPrice - row.buyPrice) / row.buyPrice;
      if (dest.danger > 0.6) byDanger.risky.push(pct);
      else if (dest.danger < 0.25) byDanger.safe.push(pct);
    }
  }
  const mean = a => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  assert.ok(byDanger.safe.length > 10 && byDanger.risky.length > 10, 'not enough samples');
  assert.ok(mean(byDanger.risky) > mean(byDanger.safe) + 0.03,
    'risky runs pay ' + mean(byDanger.risky).toFixed(3) +
    ' vs safe ' + mean(byDanger.safe).toFixed(3) + ' - danger is not compensated');
});

test('prices drift over time but not wildly day to day', () => {
  const gal = G.generate(1984);
  const s = gal.systems[3];
  let prev = null, maxJump = 0;
  for (let day = 0; day < 90; day++) {
    const row = E.computeMarket(s, day, 0).find(r => r.com.id === 'minerals');
    if (prev !== null) maxJump = Math.max(maxJump, Math.abs(row.price - prev) / prev);
    prev = row.price;
  }
  assert.ok(maxJump < 0.25, 'day-to-day price jump of ' + (maxJump * 100).toFixed(1) + '% is too abrupt');
});

test('market prices eventually differ from where they started', () => {
  // Drift must actually move things, or remembered routes never go stale.
  const gal = G.generate(1984);
  const s = gal.systems[5];
  const a = E.computeMarket(s, 0, 0).find(r => r.com.id === 'alloys').price;
  let moved = false;
  for (let day = 1; day < 200; day++) {
    const b = E.computeMarket(s, day, 0).find(r => r.com.id === 'alloys').price;
    if (Math.abs(b - a) / a > 0.05) { moved = true; break; }
  }
  assert.ok(moved, 'alloy prices never moved meaningfully over 200 days');
});

test('faction trade bias shifts prices in the documented direction', () => {
  const base = {
    profile: { produces: {}, consumes: {}, speciality: 'minerals', lacking: 'alloys' },
    condition: 'STABLE', tech: 10, population: 5, productivity: 50,
    marketSalt: 12345,
  };
  const food = E.commodityById('food');
  const fed = E.computeMarket(Object.assign({}, base, { faction: 'FEDERATION' }), 0, 0)
    .find(r => r.com.id === 'food').price;
  const ali = E.computeMarket(Object.assign({}, base, { faction: 'ALLIANCE' }), 0, 0)
    .find(r => r.com.id === 'food').price;
  assert.ok(fed > ali, 'Federation food (' + fed + ') should cost more than Alliance (' + ali + ')');
});

test('condition shocks move prices in the documented direction', () => {
  const sys = {
    profile: { produces: {}, consumes: { food: 0.5 }, speciality: 'minerals', lacking: 'food' },
    tech: 10, population: 5, productivity: 50, marketSalt: 999, faction: 'INDEPENDENT',
  };
  const stable = E.computeMarket(Object.assign({}, sys, { condition: 'STABLE' }), 0, 0)
    .find(r => r.com.id === 'food').price;
  const famine = E.computeMarket(Object.assign({}, sys, { condition: 'FAMINE' }), 0, 0)
    .find(r => r.com.id === 'food').price;
  assert.ok(famine > stable * 1.3,
    'famine food ' + famine + ' should clearly exceed stable ' + stable);
});

test('richer, busier worlds have deeper stock', () => {
  const mk = (pop, prod) => E.computeMarket({
    profile: { produces: {}, consumes: {}, speciality: 'minerals', lacking: 'alloys' },
    condition: 'STABLE', tech: 10, population: pop, productivity: prod,
    marketSalt: 42, faction: 'INDEPENDENT',
  }, 0, 0).find(r => r.com.id === 'minerals').qty;
  assert.ok(mk(10, 80) > mk(0.5, 30), 'population and productivity should deepen stock');
});

test('a full hold of the best early cargo is affordable on a starter purse', () => {
  // Sanity check that the price ladder leaves room at the bottom: a newcomer
  // with 100 credits must be able to fill at least a few tonnes of food.
  const gal = G.generate(1984);
  const row = E.computeMarket(gal.systems[0], 0, 0).find(r => r.com.id === 'food');
  const afford = Math.floor(100 / row.buyPrice);
  assert.ok(afford >= 10, 'starter can only afford ' + afford + ' t of food at ' + row.buyPrice);
});

test('marketDay advances with trading activity', () => {
  assert.strictEqual(E.marketDay(10, 0), 10);
  assert.ok(E.marketDay(10, 100) > E.marketDay(10, 0),
    'trading should advance the market clock');
});
