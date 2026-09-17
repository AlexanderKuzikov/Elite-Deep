/**
 * Player state: purse, ship, cargo, equipment, legal record, standing.
 *
 * Deliberately pure - no DOM, no THREE. Everything here is arithmetic that can
 * be reasoned about and tested. The renderer reads this, never writes it.
 *
 * Balance posture for this project: friendlier than the 1984 original. The
 * original handed you 100 credits, 7 light years of fuel and one missile, then
 * punished every mistake permanently. Here the purse and prices are the same
 * (the arbitrage curve depends on them) but the ship is tougher, fuel is
 * cheaper, repair is affordable, and reputation can be rebuilt.
 *
 * The one import is `reputation.js`, and it exists to keep a single standing
 * ladder in the project rather than two that can drift apart. That module
 * imports nothing, so there is no cycle - it duck-types the player record
 * rather than depending on this one.
 */
import * as REP from './reputation.js';

/**
 * Rank ladder. Kill counts are the original's, because they are a joke that
 * only pays off over a long game - ELITE at 25600 kills is unreachable for
 * almost everyone, which is exactly the point of it.
 */
var RANKS = [
  { kills: 0, name: 'Harmless' },
  { kills: 8, name: 'Mostly Harmless' },
  { kills: 16, name: 'Poor' },
  { kills: 32, name: 'Average' },
  { kills: 64, name: 'Above Average' },
  { kills: 128, name: 'Competent' },
  { kills: 512, name: 'Dangerous' },
  { kills: 2560, name: 'Deadly' },
  { kills: 6400, name: '---- E L I T E ----' },
  { kills: 25600, name: 'ELITE' },
];

/**
 * Equipment. Prices follow the original where a direct equivalent existed.
 * The docking computer being more expensive than a laser is intentional and
 * correct: it removes the hardest skill gate in the game.
 */
var EQUIPMENT = [
  {
    id: 'cargoExt', name: 'Large Cargo Bay', price: 1200, once: true,
    desc: 'Extends the hold from 20 to 35 tonnes. Pays for itself in six runs.',
  },
  {
    id: 'scoop', name: 'Fuel Scoops', price: 1500, once: true,
    // "and skim fuel from a star surface" was the second half of this, and it
    // was never true. The scoop does collect cargo - `main.js` refuses a
    // canister without it - but there is no skimming code anywhere, and the
    // star sits at 9000 units, which `LAYOUT` calls "pure backdrop, not
    // reachable in a session". The name is the original's; the description has
    // to be this hull's.
    desc: 'Recover cargo canisters and escape capsules from wrecks. Needs a free tonne of hold space.',
  },
  {
    id: 'shieldBoost', name: 'Shield Boosters', price: 2000, once: true,
    desc: 'Raises shield capacity by 50%. Stacks with repairs.',
  },
  {
    id: 'dock', name: 'Docking Computer', price: 2500, once: true,
    desc: 'Docks the ship for you when aligned with the slot. Removes the hardest part of flying.',
  },
  {
    id: 'beamLaser', name: 'Beam Laser', price: 4000, once: true,
    // It said "double damage, faster cycle, more heat". The damage is 1.7x
    // (12 against 7), and the cycle is *slower* (0.44 s against 0.35) - the
    // design note in `combat.js` says the beam's advantage is "1.7x damage per
    // shot in two thirds the shots". Two of the three claims were wrong, and
    // one of them backwards.
    desc: 'Replaces the pulse laser: 1.7x damage a shot, at the cost of a slower cycle and more heat.',
  },
  {
    id: 'capsule', name: 'Escape Capsule', price: 1000, once: true,
    desc: 'Saves you from destruction once per purchase. You lose the ship and cargo.',
  },
  {
    id: 'fuelTank', name: 'Long-Range Fuel Tank', price: 3600, once: true,
    desc: 'Doubles fuel capacity to 14 light years.',
  },
];

var MISSILE_PRICE = 150;
var REPAIR_PER_PCT = 3.2;
var FUEL_PER_LY = 1.4;
var STARTING_CASH = 100;
var BASE_HOLD = 20;
var EXTENDED_HOLD = 35;
var BASE_FUEL = 7;
var TANK_FUEL = 14;
var BASE_SHIELDS = 40;      // generous vs the original's 25: see header
var BASE_ENERGY = 100;
var BASE_HULL = 100;

function rankOf(kills) {
  var name = RANKS[0].name;
  for (var i = 0; i < RANKS.length; i++) {
    if (kills >= RANKS[i].kills) name = RANKS[i].name;
  }
  return name;
}

/** Progress toward the next rank as 0..1, or 1 at the top of the ladder. */
function nextRankProgress(kills) {
  for (var i = 0; i < RANKS.length - 1; i++) {
    if (kills < RANKS[i + 1].kills) {
      var floor = RANKS[i].kills;
      var span = RANKS[i + 1].kills - floor;
      return Math.max(0, Math.min(1, (kills - floor) / span));
    }
  }
  return 1;
}

function nextRank(kills) {
  for (var i = 0; i < RANKS.length - 1; i++) {
    if (kills < RANKS[i + 1].kills) return RANKS[i + 1];
  }
  return null;
}

/**
 * Everything a career panel needs about the next rung, in one call.
 *
 * `needed` and `remaining` are both "additional kills from here", which is the
 * number a player actually wants: not a running total they would have to
 * subtract themselves. Returns a flat record rather than a nested one so the
 * view can read `p.needed` without checking for a null rung - at ELITE the
 * fields are simply zero, which renders as "max rank" naturally.
 */
function progressTo(kills) {
  var k = Math.max(0, kills || 0);
  var next = nextRank(k);
  var fraction = nextRankProgress(k);
  if (!next) return { next: null, name: null, fraction: 1, needed: 0, remaining: 0 };
  return {
    next: next.name,
    name: next.name,
    fraction: fraction,
    // kills still required from the commander's current total
    needed: Math.max(0, next.kills - k),
    remaining: Math.max(0, next.kills - k),
  };
}

/**
 * The player's own kill count. Accepts either the player object or a raw
 * number, so a caller holding only `state.kills` does not have to fabricate a
 * player just to ask "what comes next?".
 */
function progressOf(p) {
  var kills = (p && typeof p === 'object') ? (p.kills || 0) : (p || 0);
  return progressTo(kills);
}

function create(opts) {
  opts = opts || {};
  return {
    name: opts.name || 'Jameson',
    cash: STARTING_CASH,
    day: 0,
    // Trading activity feeds the market clock, so grinding accelerates drift.
    activity: 0,
    fuel: BASE_FUEL,
    fuelMax: BASE_FUEL,
    hull: BASE_HULL,
    hullMax: BASE_HULL,
    energy: BASE_ENERGY,
    energyMax: BASE_ENERGY,
    shields: BASE_SHIELDS,
    shieldMax: BASE_SHIELDS,
    laserType: 'pulse',
    heat: 0,
    missiles: 1,
    missileMax: 4,
    cargo: {},
    // What the commander actually paid per tonne, per commodity. Kept next to
    // the cargo rather than in the caller because it is a property of *this
    // holding*: it has to survive a save/load, and it has to be dropped the
    // moment the last tonne of that commodity leaves the hold. The market
    // screen reads it to colour a sale green or red, which is the whole reason
    // to remember a purchase price at all.
    costBasis: {},
    equip: { cargoExt: false, scoop: false, shieldBoost: false, dock: false, beamLaser: false, capsule: false, fuelTank: false },
    kills: 0,
    legalStatus: 'Clean',
    bountyPending: 0,
    // Standing with each faction, -100..+100. Starts neutral everywhere.
    standing: { FEDERATION: 0, EMPIRE: 0, ALLIANCE: 0, INDEPENDENT: 0 },
    // Systems where a bounty has been posted on the player by name.
    wanted: {},
    // What each system remembers about this commander, keyed by system index.
    // Lives here rather than on the session so a hyperspace jump does not
    // erase it and so the save carries it. See `REPUTATION.memoryFor`.
    systemMemory: {},
    // Contracts taken on. A deadline is measured in game days, so they have to
    // outlive the session for the same reason the memory does.
    contracts: [],
    currentSystem: 0,
    dockedAt: null,
    visited: { 0: 1 },
  };
}

function holdMaxOf(p) {
  return p.equip.cargoExt ? EXTENDED_HOLD : BASE_HOLD;
}

function cargoUsed(p) {
  var t = 0;
  for (var k in p.cargo) t += p.cargo[k];
  return t;
}

/** Add cargo up to hold capacity. Returns tonnes actually stowed. */
function addCargo(p, comId, tons) {
  var free = holdMaxOf(p) - cargoUsed(p);
  var take = Math.max(0, Math.min(tons, free));
  if (take > 0) p.cargo[comId] = (p.cargo[comId] || 0) + take;
  return take;
}

/** Remove cargo. Returns tonnes actually removed. */
function removeCargo(p, comId, tons) {
  var have = p.cargo[comId] || 0;
  var take = Math.max(0, Math.min(tons, have));
  p.cargo[comId] = have - take;
  if (p.cargo[comId] <= 0) {
    delete p.cargo[comId];
    // The basis describes a holding that no longer exists. Leaving it behind
    // would be harmless today only by accident: the weighted average in
    // `recordPurchase` multiplies the previous basis by the previous quantity,
    // and that quantity is now zero. Relying on that is fragile.
    if (p.costBasis) delete p.costBasis[comId];
  }
  return take;
}

/**
 * Remember what was paid for a delivery of cargo.
 *
 * Weighted average, so a commodity bought at two different prices reports an
 * honest break-even. This has to live next to the record rather than at the
 * call site: the caller owns the market price, but the *basis* belongs to the
 * commander and has to be updated atomically with the quantity it describes.
 */
function recordPurchase(p, comId, tons, unitPrice) {
  if (!(tons > 0)) return costBasisOf(p, comId);
  if (!p.costBasis) p.costBasis = {};
  var heldBefore = Math.max(0, (p.cargo[comId] || 0) - tons);
  var previous = p.costBasis[comId];
  p.costBasis[comId] = previous === undefined
    ? unitPrice
    : (previous * heldBefore + unitPrice * tons) / Math.max(1, heldBefore + tons);
  return p.costBasis[comId];
}

/** What was paid per tonne for this commodity, or undefined if not held. */
function costBasisOf(p, comId) {
  return (p && p.costBasis) ? p.costBasis[comId] : undefined;
}

/** Apply equipment effects. Idempotent for `once` items. */
function applyEquip(p, id) {
  if (p.equip[id]) return false;
  p.equip[id] = true;
  if (id === 'shieldBoost') p.shieldMax = Math.round(BASE_SHIELDS * 1.5);
  if (id === 'fuelTank') { p.fuelMax = TANK_FUEL; p.fuel = Math.min(p.fuelMax, p.fuel + BASE_FUEL); }
  if (id === 'beamLaser') p.laserType = 'beam';
  return true;
}

/** Is this item already installed? Used by the shop screen to grey out rows. */
function hasEquipment(p, id) {
  return !!(p && p.equip && p.equip[id]);
}

/** Look up an equipment definition by id. Returns null for an unknown id. */
function equipmentFor(id) {
  for (var i = 0; i < EQUIPMENT.length; i++) if (EQUIPMENT[i].id === id) return EQUIPMENT[i];
  return null;
}

/** Buy an item. Returns {ok, reason} so callers can report failures. */
function buyEquipment(p, id) {
  var item = null;
  for (var i = 0; i < EQUIPMENT.length; i++) if (EQUIPMENT[i].id === id) item = EQUIPMENT[i];
  if (!item) return { ok: false, reason: 'unknown' };
  if (p.equip[id]) return { ok: false, reason: 'owned' };
  if (p.cash < item.price) return { ok: false, reason: 'funds' };
  p.cash -= item.price;
  applyEquip(p, id);
  return { ok: true, item: item };
}

function buyMissile(p) {
  if (p.missiles >= p.missileMax) return { ok: false, reason: 'full' };
  if (p.cash < MISSILE_PRICE) return { ok: false, reason: 'funds' };
  p.cash -= MISSILE_PRICE;
  p.missiles++;
  return { ok: true };
}

function repairCost(p) {
  var missing = p.hullMax - p.hull;
  return Math.ceil(missing * REPAIR_PER_PCT);
}

function repair(p) {
  if (p.hull >= p.hullMax) return { ok: false, reason: 'pristine' };
  var cost = repairCost(p);
  if (p.cash < cost) return { ok: false, reason: 'funds' };
  p.cash -= cost;
  p.hull = p.hullMax;
  return { ok: true, cost: cost };
}

function refuelCost(p) {
  var need = Math.ceil(p.fuelMax - p.fuel);
  return Math.ceil(need * FUEL_PER_LY);
}

function refuel(p) {
  if (p.fuel >= p.fuelMax) return { ok: false, reason: 'full' };
  var cost = refuelCost(p);
  if (p.cash < cost) {
    // Partial refuel is better than a flat refusal: being stranded is the
    // worst feeling in the genre and the original was notoriously cruel here.
    var affordable = Math.floor(p.cash / FUEL_PER_LY);
    if (affordable <= 0) return { ok: false, reason: 'funds' };
    p.fuel = Math.min(p.fuelMax, p.fuel + affordable);
    p.cash -= Math.ceil(affordable * FUEL_PER_LY);
    return { ok: true, partial: true, cost: Math.ceil(affordable * FUEL_PER_LY) };
  }
  p.fuel = p.fuelMax;
  p.cash -= cost;
  return { ok: true, cost: cost };
}

/** Legal status from accumulated offences. Milder than the original. */
function legalStatusFor(offences) {
  if (offences >= 12) return 'Fugitive';
  if (offences >= 4) return 'Offender';
  return 'Clean';
}

function recordOffence(p, weight) {
  p._offences = (p._offences || 0) + (weight || 1);
  p.legalStatus = legalStatusFor(p._offences);
  return p.legalStatus;
}

/** Wanted list decays as time passes without further offences. */
function decayRecord(p) {
  p._offences = Math.max(0, (p._offences || 0) - 0.5);
  p.legalStatus = legalStatusFor(p._offences);
}

/** Shift standing with a faction, clamped to [-100, 100]. */
function adjustStanding(p, factionId, delta) {
  var cur = p.standing[factionId] || 0;
  p.standing[factionId] = Math.max(-100, Math.min(100, Math.round((cur + delta) * 10) / 10));
  return p.standing[factionId];
}

/**
 * How a faction treats you, given standing.
 *
 * Delegates to `reputation.tierFor`, which is where the ladder lives because
 * that is where the ladder is *used*: `priceBonus` and `patrolHelp` hang off
 * the same tiers. There used to be a second, independently written ladder
 * here, and it disagreed with the authoritative one at exactly three
 * boundaries (-60, -25 and +8) because the two used opposite conventions for
 * whether a boundary value belongs to the tier above or below. A commander at
 * +8 was shown "Neutral" while the market quietly gave them the "Liked"
 * discount. `src/ui/station.js` carried a `techdebt:` note describing this
 * duplication and prescribing exactly this fix; the note's premise that the
 * two ladders "agree today" turned out to be false.
 *
 * Kept as a named re-export so callers that only want a display string do not
 * have to know where the ladder lives.
 */
function standingLabel(v) {
  return REP.tierFor(v).label;
}

function serialize(p) {
  return JSON.stringify({
    v: 1, name: p.name, cash: p.cash, day: p.day, activity: p.activity,
    fuel: p.fuel, fuelMax: p.fuelMax, hull: p.hull, hullMax: p.hullMax,
    shields: p.shields, shieldMax: p.shieldMax,
    laserType: p.laserType, missiles: p.missiles, cargo: p.cargo,
    costBasis: p.costBasis || {},
    equip: p.equip, kills: p.kills, legalStatus: p.legalStatus,
    offences: p._offences || 0, bountyPending: p.bountyPending,
    standing: p.standing, wanted: p.wanted, currentSystem: p.currentSystem,
    visited: p.visited, systemMemory: p.systemMemory || {},
    contracts: p.contracts || [],
    // The last station docked at. Was not saved, which meant a commander who
    // had crossed the galaxy came back from a reload with the death screen
    // offering to rescue them at Lave: `enterSystem` falls back to system 0
    // when this is null, and the boot used it to decide whether to open on the
    // station screen or the title. The value survived the session and vanished
    // with the save.
    dockedAt: p.dockedAt,
  });
}

function deserialize(json) {
  var d = typeof json === 'string' ? JSON.parse(json) : json;
  var p = create({ name: d.name });
  Object.assign(p, {
    cash: d.cash, day: d.day, activity: d.activity, fuel: d.fuel,
    fuelMax: d.fuelMax, hull: d.hull, hullMax: d.hullMax,
    shields: d.shields, shieldMax: d.shieldMax,
    laserType: d.laserType, missiles: d.missiles, cargo: d.cargo || {},
    costBasis: Object.assign({}, d.costBasis || {}),
    equip: Object.assign(p.equip, d.equip || {}), kills: d.kills,
    legalStatus: d.legalStatus, bountyPending: d.bountyPending,
    standing: Object.assign(p.standing, d.standing || {}),
    wanted: d.wanted || {}, currentSystem: d.currentSystem,
    visited: d.visited || { 0: 1 },
    systemMemory: Object.assign({}, d.systemMemory || {}),
    contracts: Array.isArray(d.contracts) ? d.contracts.slice() : [],
    // `undefined` for a save written before this field existed, which is the
    // same as `null`: the commander has not docked yet.
    dockedAt: d.dockedAt === undefined ? null : d.dockedAt,
  });
  p._offences = d.offences || 0;
  return p;
}

export {
  RANKS,
  EQUIPMENT,
  MISSILE_PRICE,
  REPAIR_PER_PCT,
  FUEL_PER_LY,
  STARTING_CASH,
  BASE_HOLD,
  EXTENDED_HOLD,
  BASE_SHIELDS,
  create,
  rankOf,
  nextRank,
  nextRankProgress,
  progressTo,
  progressOf,
  holdMaxOf,
  cargoUsed,
  addCargo,
  removeCargo,
  recordPurchase,
  costBasisOf,
  applyEquip,
  hasEquipment,
  equipmentFor,
  buyEquipment,
  buyMissile,
  repairCost,
  repair,
  refuelCost,
  refuel,
  legalStatusFor,
  recordOffence,
  decayRecord,
  adjustStanding,
  standingLabel,
  serialize,
  deserialize,
};

/**
 * Default mirror, matching the other modules in the project.
 * The commander's record: purse, ship, cargo, equipment and legal history.
 */
export default {
  RANKS, EQUIPMENT, MISSILE_PRICE, REPAIR_PER_PCT, FUEL_PER_LY, STARTING_CASH,
  BASE_HOLD, EXTENDED_HOLD, BASE_SHIELDS,
  create, rankOf, nextRank, nextRankProgress, progressTo, progressOf,
  holdMaxOf, cargoUsed, addCargo, removeCargo, recordPurchase, costBasisOf,
  applyEquip, hasEquipment, equipmentFor, buyEquipment, buyMissile,
  repairCost, repair, refuelCost, refuel,
  legalStatusFor, recordOffence, decayRecord, adjustStanding, standingLabel,
  serialize, deserialize,
};
