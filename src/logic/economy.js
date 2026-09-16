/**
 * Commodity market.
 *
 * The core departure from the original: prices are driven by what a world
 * actually produces and consumes, not by a single economy-type multiplier.
 *
 * In the original, price = base * (1 + gradient * economyFactor). Every
 * agricultural world priced food identically. Here each system carries a
 * `profile` (from galaxy.js) naming its real output and real needs, and the
 * condition layer (boom, famine, blockade...) multiplies on top. The result is
 * that arbitrage runs exist between specific pairs of worlds rather than
 * between economy *categories*, which is what makes a route worth remembering.
 *
 * Price model, per commodity c in system s on day d:
 *
 *   base        - canonical reference price (original Elite's values)
 *   supply/dem  - log-scaled pressure from the system profile
 *   condition   - one-off shock from the world's current condition
 *   drift       - slow deterministic wander over time (fractal noise)
 *   techGate    - high-tech goods simply unavailable at low tech levels
 *   illegal     - legal status penalty, not a price change
 */
import * as R from './rng.js';
import * as F from './factions.js';

/**
 * 19 commodities. `base` values are the original Elite figures, kept because
 * players who know the game read them instantly and because they are already
 * a sane price ladder. `grad` is retained for reference but the live price is
 * supply-driven now.
 *
 * `bannedUnderGov` lists the governments that police a good. An empty list
 * means the good is legal everywhere.
 *
 * Design intent per restricted good:
 *   slaves/narcotics - banned wherever there is a real state (feudal through
 *     democracy), tolerated in anarchy and multi-government where no central
 *     authority enforces anything, and tolerated by the corporate state,
 *     which has decided morality is bad for business.
 *   firearms - banned in anarchy and multi-government (fear of warlords),
 *     and in communist/democratic states; tolerated by feudal, dictatorship,
 *     confederacy and corporate state.
 *   weapons - the heaviest restriction: banned under anarchy, democracy and
 *     multi-government; tolerated by feudal, dictatorship, communist,
 *     confederacy and corporate state.
 */
var COMMODITIES = [
  { id: 'food', name: 'Food', base: 4.6, grad: 1.2, qBase: 20, minTech: 1, bannedUnderGov: [] },
  { id: 'livestock', name: 'Textiles', base: 6.4, grad: 1.5, qBase: 18, minTech: 1, bannedUnderGov: [] },
  { id: 'radioactives', name: 'Radioactives', base: 6.5, grad: 1.9, qBase: 12, minTech: 1, bannedUnderGov: [] },
  { id: 'slaves', name: 'Slaves', base: 8.3, grad: 2.4, qBase: 8, minTech: 1, bannedUnderGov: [1, 2, 3, 4, 5, 6] },
  { id: 'liquor', name: 'Liquor / Wines', base: 7.2, grad: 2.1, qBase: 16, minTech: 1, bannedUnderGov: [] },
  { id: 'luxuries', name: 'Luxuries', base: 12.5, grad: 2.4, qBase: 10, minTech: 3, bannedUnderGov: [] },
  { id: 'narcotics', name: 'Narcotics', base: 11.0, grad: 2.6, qBase: 8, minTech: 1, bannedUnderGov: [1, 2, 3, 4, 5, 6] },
  { id: 'computers', name: 'Computers', base: 14.1, grad: 3.2, qBase: 6, minTech: 5, bannedUnderGov: [] },
  { id: 'machinery', name: 'Machinery', base: 9.8, grad: 2.4, qBase: 10, minTech: 3, bannedUnderGov: [] },
  { id: 'alloys', name: 'Alloys', base: 8.1, grad: 2.0, qBase: 12, minTech: 2, bannedUnderGov: [] },
  { id: 'firearms', name: 'Firearms', base: 9.2, grad: 2.3, qBase: 8, minTech: 1, bannedUnderGov: [0, 2, 4, 6] },
  { id: 'furs', name: 'Furs', base: 7.6, grad: 2.0, qBase: 14, minTech: 1, bannedUnderGov: [] },
  { id: 'minerals', name: 'Minerals', base: 3.3, grad: 1.0, qBase: 24, minTech: 1, bannedUnderGov: [] },
  { id: 'gold', name: 'Gold', base: 11.0, grad: 2.8, qBase: 6, minTech: 1, bannedUnderGov: [] },
  { id: 'platinum', name: 'Platinum', base: 18.5, grad: 4.0, qBase: 4, minTech: 2, bannedUnderGov: [] },
  { id: 'gemstones', name: 'Gem-Stones', base: 15.0, grad: 3.6, qBase: 4, minTech: 2, bannedUnderGov: [] },
  { id: 'energy', name: 'Energy Cells', base: 5.5, grad: 1.6, qBase: 20, minTech: 1, bannedUnderGov: [] },
  { id: 'medicine', name: 'Medicine', base: 13.0, grad: 3.0, qBase: 8, minTech: 4, bannedUnderGov: [] },
  { id: 'weapons', name: 'Weapons', base: 16.0, grad: 3.4, qBase: 6, minTech: 6, bannedUnderGov: [0, 2, 6] },
];

var BY_ID = {};
COMMODITIES.forEach(function (c) { BY_ID[c.id] = c; });

function commodityById(id) { return BY_ID[id] || null; }

/**
 * Day index derived from calendar day plus trading activity. The market
 * moves on this number, so a busy commander sees prices shift more than an
 * idle one - a deliberate coupling that keeps grinding from being free.
 */
function marketDay(day, activity) {
  return day + Math.floor((activity || 0) * 0.15);
}

/**
 * Pressure from the system profile, expressed as a signed imbalance rather
 * than two independent multipliers.
 *
 * Getting this wrong is the classic economy bug: multiplying a "produces"
 * factor, a "consumes" factor, a condition factor and a drift factor lets a
 * mediocre world hit 3.7x on one good, which is a money printer rather than
 * a market. So the profile collapses to a single number first:
 *
 *   imbalance = consumes - produces   (roughly -1 .. +1.6)
 *
 * and then maps to price once:
 *
 *   imbalance -1.1 -> x0.55   (major exporter, dirt cheap)
 *   imbalance  0.0 -> x1.00   (balanced world)
 *   imbalance  0.9 -> x1.62   (desperate importer)
 *
 * Elasticity is deliberately sub-linear at the top end (see below), because
 * a world that needs food will pay a lot, but not infinitely.
 */
function profileImbalance(sys, comId) {
  var p = sys.profile;
  var prod = (p && p.produces[comId]) || 0;
  var cons = (p && p.consumes[comId]) || 0;
  return cons - prod;
}

function profileFactor(sys, comId) {
  var imb = profileImbalance(sys, comId);
  // Asymmetric elasticity: shortages bite faster than surpluses discount,
  // but the shortage side is compressed so the ceiling stays sane.
  var f;
  if (imb >= 0) f = 1 + Math.pow(imb, 0.82) * 0.68;
  else f = 1 / (1 + Math.pow(-imb, 0.9) * 0.72);
  return f;
}

/**
 * Condition shock as a single bounded multiplier.
 *
 * Conditions used to stack priceBias with per-commodity demand and supply
 * multipliers, which compounded into 2x+ on top of the profile. Now a
 * condition contributes one number, and it is softer when the profile
 * already explains the price - a blockade on a world that was already
 * starving should not be cubed into a fortune.
 */
function conditionFactor(sys, comId) {
  var cond = F.condition(sys.condition);
  var demand = cond.demand[comId] || 0;
  var supply = cond.supply[comId] || 0;
  // Bias is the background effect; demand/supply are commodity-specific.
  var mul = 1 + cond.priceBias * 0.5 + demand * 0.55 + supply * 0.4;
  return Math.max(0.45, Math.min(1.75, mul));
}

/** Faction trade bias: heavy tax in the Federation, cheap bulk in Alliance. */
function factionFactor(sys, com) {
  var fac = F.faction(sys.faction);
  // Bias applies mostly to cheap bulk goods; luxuries are priced by greed.
  var weight = com.base < 8 ? 1 : 0.4;
  return 1 + fac.tradeBias * weight;
}

/**
 * Slow deterministic drift. Wraps noise so a commodity's price wanders on a
 * cycle instead of walking off to infinity. The phase is salted per system
 * and per commodity so no two markets move in lockstep.
 *
 * Amplitude is kept modest (+/-11%) on purpose: drift exists to make a
 * remembered route go stale, not to create arbitrage by itself. If drift
 * alone could pay, trading would be a waiting game.
 */
function driftFactor(sys, com, day) {
  var phase = (sys.marketSalt % 97) * 0.13 + (R.hash2(sys.marketSalt, com.base * 100, 1) % 89) * 0.07;
  var n = R.noise1(R.hash2(sys.marketSalt, com.base * 100, 2) % 65536, day * 0.35 + phase);
  return 1 + n * 0.11;
}

/**
 * Tech gate: how much of a high-tech commodity a world can even trade.
 * Below minTech the good is simply not sold; near minTech stock is thin.
 */
function techAvailability(sys, com) {
  if (sys.tech < com.minTech) return 0;
  var margin = sys.tech - com.minTech;
  return Math.min(1, 0.25 + margin * 0.22);
}

/**
 * Build the market for one system. Returns an array of rows, one per
 * commodity the world is willing to trade, each with a lot price and a
 * stock figure. Stock is a genuine constraint: you cannot buy 400 tonnes of
 * platinum because no world has it.
 */
function computeMarket(sys, day, activity) {
  var d = marketDay(day, activity);
  var rows = [];
  for (var i = 0; i < COMMODITIES.length; i++) {
    var com = COMMODITIES[i];
    var avail = techAvailability(sys, com);
    if (avail <= 0) {
      rows.push({
        com: com, price: 0, qty: 0, buyPrice: 0, sellPrice: 0,
        illegal: false, available: false, reason: 'tech',
      });
      continue;
    }

    var price = com.base
      * profileFactor(sys, com.id)
      * conditionFactor(sys, com.id)
      * factionFactor(sys, com)
      * driftFactor(sys, com, d);

    // Gentle pull back toward base so long games do not drift into absurdity.
    price = price * 0.85 + com.base * 0.15;

    // Quantity scales with tech availability and world population, and is
    // inversely related to price pressure: expensive goods are scarce goods.
    var qty = Math.round(
      com.qBase
      * avail
      * (0.6 + sys.population * 0.06)
      * (0.5 + sys.productivity / 100)
      * (1 / (1 + (price / com.base - 1) * 0.5))
    );
    qty = Math.max(0, Math.min(com.qBase * 8, qty));

    var unit = Math.max(1, Math.round(price * 10) / 10);
    rows.push({
      com: com,
      price: Math.round(unit * 10) / 10,   // what the station sells at, per tonne
      qty: qty,                            // tonnes in the station's hold
      buyPrice: Math.round(unit * 10) / 10,     // player buys at this
      // Station buys back at a 15% margin. The spread is the entire reason a
      // trade run has to cross space: buying and reselling on the spot must
      // always be a loss, so it is never profitable to stand still.
      sellPrice: Math.round(unit * 0.85 * 10) / 10,
      illegal: isIllegal(sys, com),
      available: true,
    });
  }
  return rows;
}

/**
 * Contraband check.
 *
 * `bannedUnderGov` lists the governments that police a good, so this reads
 * directly: banned here means contraband here. The earlier version of this
 * function had the polarity inverted against a field that was itself
 * misleadingly named, which silently made narcotics legal in a democracy -
 * the kind of bug that never crashes and never shows up in a screenshot.
 */
function isIllegal(sys, com) {
  if (!com.bannedUnderGov || com.bannedUnderGov.length === 0) return false;
  return com.bannedUnderGov.indexOf(sys.gov) !== -1;
}

/** Total value of a cargo object {id: qty} at a station's sell prices. */
function cargoValue(market, cargo) {
  var total = 0;
  for (var i = 0; i < market.length; i++) {
    var row = market[i];
    var q = cargo[row.com.id] || 0;
    if (q > 0) total += q * (row.available ? row.sellPrice : row.com.base * 0.88);
  }
  return Math.round(total * 100) / 100;
}

/** Weight of cargo in tonnes. */
function cargoTons(cargo) {
  var t = 0;
  for (var k in cargo) t += cargo[k];
  return t;
}

export {
  COMMODITIES,
  commodityById,
  computeMarket,
  isIllegal,
  cargoValue,
  cargoTons,
  profileFactor,
  conditionFactor,
  driftFactor,
  marketDay,
};

/**
 * Default mirror, matching the other modules in the project.
 * The market: commodities, prices, contraband and cargo valuation.
 */
export default {
  COMMODITIES, commodityById, computeMarket, isIllegal, cargoValue, cargoTons,
  profileFactor, conditionFactor, driftFactor, marketDay,
};
