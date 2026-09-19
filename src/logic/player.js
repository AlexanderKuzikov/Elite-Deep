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

/**
 * A number that is present and finite, or a fallback.
 *
 * `Number.isFinite` rather than a `typeof` check, because the failure this
 * exists to stop is not a missing field - it is a field that parsed fine and
 * is still unusable. `JSON.parse` turns `Infinity` into `null` and accepts
 * `1e999` as `Infinity`, so a save with unlimited fuel is something a player
 * can actually produce by editing the string, and a string `cash` is what a
 * hand-edited or half-written save looks like.
 */
function finiteOr(value, fallback) {
  return typeof value === 'number' && isFinite(value) ? value : fallback;
}

/** Clamp to a range, falling back first if the value is not usable at all. */
function clamped(value, lo, hi, fallback) {
  return Math.max(lo, Math.min(hi, finiteOr(value, fallback)));
}

/**
 * Is this a save we can actually play?
 *
 * `loadGame` used to check only that the JSON parsed and that the galaxy seed
 * matched, and then hand the record straight to `deserialize`, which is an
 * unguarded `Object.assign`. That is not a security boundary - this is an
 * offline game with no server and no other players - but it *is* a way to
 * brick the game, which is worse here than a crash would be: `enterSystem`
 * indexes `galaxy.systems[currentSystem]` and throws on a system that does not
 * exist, and the station screen formats `cash` as a number, so a string there
 * renders the whole screen as one broken line. The game then fails on every
 * boot, and nothing short of clearing storage by hand recovers it.
 *
 * So this rejects rather than repairs. Repairing a semantically broken save
 * means inventing a history the player did not have - which is exactly the
 * silent data loss the project already refuses elsewhere - and a fresh start
 * on a galaxy with the same seed is a legitimate, playable state.
 *
 * The known-good sets are passed in rather than imported: this module imports
 * only `reputation.js`, on purpose, and pulling in the commodity and faction
 * tables to validate a save would be the first real dependency cycle in the
 * project. The caller already holds all of them.
 *
 * Returns `{ ok: true }` or `{ ok: false, reason: '...' }`.
 */
function validateSave(d, options) {
  var opts = options || {};
  var reasons = [];

  if (!d || typeof d !== 'object' || Array.isArray(d)) {
    return { ok: false, reason: 'not an object' };
  }

  var systems = finiteOr(opts.systems, 0);
  var commodities = opts.commodities || [];
  var factions = opts.factions || [];
  var equipment = opts.equipment || [];

  // --- Keys that must never come from a save --------------------------------
  // `JSON.parse` keeps `__proto__` as an *own* key, and `Object.assign` below
  // feeds it through the prototype setter - a save carrying one is a
  // prototype-pollution sink. These are rejected unconditionally, before any
  // merge and regardless of whether a vocabulary was passed.
  function hasDangerousKey(obj) {
    if (!obj || typeof obj !== 'object') return false;
    return Object.keys(obj).some(function (k) {
      return k === '__proto__' || k === 'constructor' || k === 'prototype';
    });
  }
  var guarded = ['cargo', 'equip', 'standing', 'wanted', 'visited',
    'systemMemory', 'costBasis'];
  for (var g = 0; g < guarded.length; g += 1) {
    if (hasDangerousKey(d[guarded[g]])) {
      reasons.push(guarded[g] + ' carries a prototype key');
    }
  }

  // --- The fields the rest of the game does arithmetic on ------------------
  // Anything that reaches a screen as a number has to *be* a number, or the
  // screen renders "NaN" or throws. These are the ones with no safe fallback,
  // because a wrong value is worse than a rejected save. Counts and days are
  // also floored at zero: a negative purse, hull or day is not a state the
  // game can ever produce, only a hand-edited one.
  var numeric = ['cash', 'day', 'fuel', 'fuelMax', 'hull', 'hullMax',
    'shields', 'shieldMax', 'missiles', 'kills', 'activity',
    'offences', 'bountyPending'];
  for (var i = 0; i < numeric.length; i += 1) {
    var key = numeric[i];
    if (d[key] === undefined && (key === 'activity' || key === 'offences'
      || key === 'bountyPending')) continue;   // newer counters, old saves lack them
    if (typeof d[key] !== 'number' || !isFinite(d[key])) {
      reasons.push(key + ' is not a finite number');
    } else if (d[key] < 0) {
      reasons.push(key + ' is negative');
    }
  }
  // A zero or negative maximum is not a ship, it is a division waiting to
  // happen: widths, fractions and refuel math all divide by these.
  var positive = ['fuelMax', 'hullMax', 'shieldMax'];
  for (var pz = 0; pz < positive.length; pz += 1) {
    var pk = positive[pz];
    if (typeof d[pk] === 'number' && isFinite(d[pk]) && d[pk] <= 0) {
      reasons.push(pk + ' is not positive');
    }
  }
  // `day`, `missiles` and `kills` move in whole steps. `_offences` does not:
  // the record decays half a point per day, so a fractional value is a
  // career a few days old, not a corrupt one - rejecting it refused every
  // save written after the commander's first week with a record.
  var whole = ['day', 'missiles', 'kills'];
  for (var w = 0; w < whole.length; w += 1) {
    var wk = whole[w];
    if (typeof d[wk] === 'number' && isFinite(d[wk]) && d[wk] % 1 !== 0) {
      reasons.push(wk + ' is not whole');
    }
  }
  if (typeof d.name !== 'undefined' && typeof d.name !== 'string') {
    reasons.push('name is not a string');
  }
  // `laserType` and `legalStatus` are read as keys and labels. An unknown
  // string would not throw where it lands, but it means the save is not the
  // shape this game writes.
  if (d.laserType !== undefined && typeof d.laserType !== 'string') {
    reasons.push('laserType is not a string');
  }
  if (d.legalStatus !== undefined && typeof d.legalStatus !== 'string') {
    reasons.push('legalStatus is not a string');
  }

  // --- The system the commander is standing in -----------------------------
  // This is the one that throws rather than draws badly: `enterSystem` reads
  // `galaxy.systems[index]` and then `.name` off the result.
  if (systems > 0) {
    var here = d.currentSystem;
    if (typeof here !== 'number' || !isFinite(here) || here % 1 !== 0
      || here < 0 || here >= systems) {
      reasons.push('currentSystem ' + here + ' is not a system index');
    }
    if (d.dockedAt !== undefined && d.dockedAt !== null) {
      var at = d.dockedAt;
      if (typeof at !== 'number' || !isFinite(at) || at % 1 !== 0 || at < 0 || at >= systems) {
        reasons.push('dockedAt ' + at + ' is not a system index');
      }
    }
  }

  // --- Cargo --------------------------------------------------------------
  // Keys must be real commodities and counts must be positive integers. An
  // unknown key would sit in the hold for ever, unremovable and unsellable,
  // because the market only ever iterates the commodity table.
  if (d.cargo !== undefined && d.cargo !== null) {
    if (typeof d.cargo !== 'object' || Array.isArray(d.cargo)) {
      reasons.push('cargo is not an object');
    } else {
      var keys = Object.keys(d.cargo);
      for (var c = 0; c < keys.length; c += 1) {
        var id = keys[c];
        if (commodities.length && commodities.indexOf(id) < 0) {
          reasons.push('cargo holds unknown commodity ' + id);
          continue;
        }
        var tons = d.cargo[id];
        if (typeof tons !== 'number' || !isFinite(tons) || tons < 0 || tons % 1 !== 0) {
          reasons.push('cargo of ' + id + ' is not a whole tonnage');
        }
      }
    }
  }

  // --- Equipment ----------------------------------------------------------
  // Same reasoning as cargo: an unknown id is a permanent phantom fitting.
  // `equip` is merged onto the defaults, so it is legitimately sparse.
  if (d.equip !== undefined && d.equip !== null) {
    if (typeof d.equip !== 'object' || Array.isArray(d.equip)) {
      reasons.push('equip is not an object');
    } else if (equipment.length) {
      var fit = Object.keys(d.equip);
      for (var e = 0; e < fit.length; e += 1) {
        if (equipment.indexOf(fit[e]) < 0) {
          reasons.push('unknown equipment ' + fit[e]);
        }
      }
    }
  }

  // --- Standing -----------------------------------------------------------
  // Unknown faction keys are harmless (nothing reads them) but they mean the
  // save is not the shape this game writes, so they are still a rejection.
  if (d.standing !== undefined && d.standing !== null) {
    if (typeof d.standing !== 'object' || Array.isArray(d.standing)) {
      reasons.push('standing is not an object');
    } else if (factions.length) {
      var names = Object.keys(d.standing);
      for (var f = 0; f < names.length; f += 1) {
        if (factions.indexOf(names[f]) < 0) {
          reasons.push('standing names unknown faction ' + names[f]);
        } else {
          var val = d.standing[names[f]];
          if (typeof val !== 'number' || !isFinite(val)) {
            reasons.push('standing with ' + names[f] + ' is not a number');
          }
        }
      }
    }
  }

  // --- Wanted, visited, memory, cost basis --------------------------------
  // These ride along untouched by any screen, but a wrong shape still breaks
  // the game: `visited` is counted, `wanted` is decayed by key, memory deltas
  // feed prices and danger. Checked lightly - plain objects, finite numeric
  // values, known keys where a vocabulary exists - because a deep audit of
  // every memory event is not worth the code.
  //
  // Two shapes, not one: `wanted`, `visited` and `costBasis` are flat maps of
  // numbers, while `systemMemory` maps a system to a whole memory object -
  // counters plus `lastVisitDay`, which is legitimately `null` before the
  // first docked visit. Treating the memories as numbers rejected every real
  // save the game writes, because every career has visited a system.
  var flatMaps = ['wanted', 'visited', 'costBasis'];
  for (var m = 0; m < flatMaps.length; m += 1) {
    var mk = flatMaps[m];
    if (d[mk] === undefined || d[mk] === null) continue;
    if (typeof d[mk] !== 'object' || Array.isArray(d[mk])) {
      reasons.push(mk + ' is not an object');
      continue;
    }
    var mkeys = Object.keys(d[mk]);
    for (var q = 0; q < mkeys.length; q += 1) {
      var mv = d[mk][mkeys[q]];
      if (typeof mv !== 'number' || !isFinite(mv)) {
        reasons.push(mk + ' of ' + mkeys[q] + ' is not a finite number');
      }
    }
  }
  if (d.systemMemory !== undefined && d.systemMemory !== null) {
    if (typeof d.systemMemory !== 'object' || Array.isArray(d.systemMemory)) {
      reasons.push('systemMemory is not an object');
    } else {
      var skeys = Object.keys(d.systemMemory);
      for (var s = 0; s < skeys.length; s += 1) {
        var mem = d.systemMemory[skeys[s]];
        if (!mem || typeof mem !== 'object' || Array.isArray(mem)) {
          reasons.push('memory of system ' + skeys[s] + ' is not an object');
          continue;
        }
        var fkeys = Object.keys(mem);
        for (var u = 0; u < fkeys.length; u += 1) {
          var fv = mem[fkeys[u]];
          // `null` is a real value here (`lastVisitDay` before the first
          // docked visit), not a missing one.
          if (fv !== null && (typeof fv !== 'number' || !isFinite(fv))) {
            reasons.push('memory of system ' + skeys[s] + ' has a non-numeric ' + fkeys[u]);
          }
        }
      }
    }
  }
  if (commodities.length && d.costBasis && typeof d.costBasis === 'object') {
    var bkeys = Object.keys(d.costBasis);
    for (var b = 0; b < bkeys.length; b += 1) {
      if (commodities.indexOf(bkeys[b]) < 0) {
        reasons.push('cost basis names unknown commodity ' + bkeys[b]);
      }
    }
  }

  // --- Contracts ----------------------------------------------------------
  if (d.contracts !== undefined && d.contracts !== null) {
    if (!Array.isArray(d.contracts)) {
      reasons.push('contracts is not an array');
    } else {
      for (var k = 0; k < d.contracts.length; k += 1) {
        var con = d.contracts[k];
        if (!con || typeof con !== 'object') {
          reasons.push('contract ' + k + ' is not an object');
        } else if (typeof con.deadlineDay !== 'number' || !isFinite(con.deadlineDay)) {
          reasons.push('contract ' + k + ' has no usable deadline');
        } else {
          if (systems > 0 && (typeof con.targetIndex !== 'number'
            || con.targetIndex % 1 !== 0
            || con.targetIndex < 0 || con.targetIndex >= systems)) {
            reasons.push('contract ' + k + ' names no system');
          }
          if (con.tons !== undefined
            && (typeof con.tons !== 'number' || !isFinite(con.tons) || con.tons < 0)) {
            reasons.push('contract ' + k + ' has no usable tonnage');
          }
          if (con.commodity !== undefined && con.commodity !== null
            && commodities.length && commodities.indexOf(con.commodity) < 0) {
            reasons.push('contract ' + k + ' names an unknown commodity');
          }
        }
      }
    }
  }

  if (reasons.length) return { ok: false, reason: reasons[0], reasons: reasons };
  return { ok: true, reasons: [] };
}

/**
 * `deserialize`, but only for a save that survives `validateSave`.
 *
 * Returns `null` on rejection so the caller takes the same path it already
 * takes for unparseable JSON - start a fresh commander. `options` is passed
 * through to the validator.
 */
function deserializeChecked(json, options) {
  var d;
  try {
    d = typeof json === 'string' ? JSON.parse(json) : json;
  } catch (err) {
    deserializeChecked.reason = 'unparseable JSON';
    return null;
  }
  var verdict = validateSave(d, options);
  if (!verdict.ok) {
    // Kept on the function (rather than thrown) so a driver can report *why*
    // a save was refused: a bare null tells the log nothing, and the last
    // three CI failures were diagnosed by guessing instead of reading.
    deserializeChecked.reason = verdict.reason;
    return null;
  }
  deserializeChecked.reason = null;
  return deserialize(d);
}
deserializeChecked.reason = null;

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
  validateSave,
  deserializeChecked,
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
