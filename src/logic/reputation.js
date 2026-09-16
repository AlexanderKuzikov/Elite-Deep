/**
 * Standing, reputation and the living world's memory of the player.
 *
 * Two separate records, deliberately:
 *
 *   `standing` per faction  - a slow-moving relationship. Deeds accumulate.
 *   `_offences` / `wanted`  - the local police record, which decays.
 *
 * The split matters because they move at different speeds. Shooting one pirate
 * nudges your standing with a faction; shooting a police ship makes you a
 * fugitive in that system right now, and that record fades if you keep your
 * nose clean. Conflating them would mean either that every mistake permanently
 * poisons a relationship, or that being hunted is forgettable.
 *
 * This module also owns the world's *event* layer: what has happened in a
 * system, which is what turns a system from a price table into a place.
 */

/** Standing thresholds and the treatment they earn. */
export const STANDING_TIERS = [
  { min: 60, label: 'Allied', priceBonus: -0.06, patrolHelp: 1.0, greeting: 'The navy escorts you in without being asked.' },
  { min: 25, label: 'Trusted', priceBonus: -0.04, patrolHelp: 0.7, greeting: 'Docking control clears your approach with unusual speed.' },
  { min: 8, label: 'Liked', priceBonus: -0.02, patrolHelp: 0.4, greeting: 'Traffic gives you a little more room than you need.' },
  { min: -8, label: 'Neutral', priceBonus: 0, patrolHelp: 0, greeting: 'You are just another hull on the scanner.' },
  { min: -25, label: 'Disliked', priceBonus: 0.03, patrolHelp: -0.3, greeting: 'A patrol shadows you from the moment you arrive.' },
  { min: -60, label: 'Hostile', priceBonus: 0.08, patrolHelp: -0.8, greeting: 'Weapons are hot the instant you drop in.' },
  { min: -101, label: 'Hunted', priceBonus: 0.15, patrolHelp: -1.5, greeting: 'They knew you were coming. There is a price on your hull.' },
];

export function tierFor(standing) {
  for (const t of STANDING_TIERS) if (standing >= t.min) return t;
  return STANDING_TIERS[STANDING_TIERS.length - 1];
}

/** Price multiplier from standing: trusted commanders buy cheaper. */
export function standingPriceFactor(standing) {
  return 1 + tierFor(standing).priceBonus;
}

/**
 * Should a patrol in this system be hostile on arrival? Returns true when the
 * player is hostile-and-worse with the owner, or actively wanted locally.
 */
export function patrolHostile(player, system) {
  const standing = player.standing[system.faction] || 0;
  if (player.wanted[system.index]) return true;
  return standing <= -60;
}

/** How much of the local wanted list decays per docked day. */
export const WANTED_DECAY_PER_DAY = 1;

/**
 * Advance the police record. Called when docking, once per game day.
 * Being a fugitive should be a phase you can outlast, not a permanent state.
 *
 * Takes the system index explicitly, because a caller that knows which system
 * it means should say so. Callers that do *not* - the day tick, which is
 * global - want `decayAllWanted` instead. Passing `undefined` here is a
 * programming error, not a no-op, so it is reported rather than swallowed:
 * an earlier version of this function silently returned `null` for
 * `player.wanted[undefined]`, and the caller in `main.js` passed no index at
 * all, which made every bounty in the galaxy permanent and looked like a
 * design decision rather than a bug.
 */
export function decayWanted(player, systemIndex) {
  if (systemIndex === undefined || systemIndex === null) {
    throw new TypeError('decayWanted: a system index is required (use decayAllWanted for the day tick)');
  }
  const w = player.wanted[systemIndex];
  if (!w) return null;
  const next = w - WANTED_DECAY_PER_DAY;
  if (next <= 0) {
    delete player.wanted[systemIndex];
    return { cleared: true, remaining: 0 };
  }
  player.wanted[systemIndex] = next;
  return { cleared: false, remaining: next };
}

/**
 * Decay every wanted record by one day.
 *
 * This is what the day tick wants. A day passes everywhere at once, so docking
 * at one station should not leave a bounty on the far side of the galaxy
 * untouched - and it is the only sane reading of "keep your nose clean and it
 * fades".
 *
 * Returns a summary rather than a single result, so a caller can report
 * "your record cleared in 3 systems" without a second pass.
 */
export function decayAllWanted(player) {
  const wanted = (player && player.wanted) || {};
  const cleared = [];
  const remaining = [];
  for (const key of Object.keys(wanted)) {
    const result = decayWanted(player, key);
    if (!result) continue;
    // Keys arrive as strings from Object.keys; hand back numbers so a caller
    // comparing against `session.index` is not defeated by '5' !== 5.
    if (result.cleared) cleared.push(Number(key));
    else remaining.push(Number(key));
  }
  return { cleared: cleared, remaining: remaining };
}

export function markWanted(player, systemIndex, weight) {
  player.wanted[systemIndex] = (player.wanted[systemIndex] || 0) + (weight || 3);
  return player.wanted[systemIndex];
}

/**
 * The price of clearing your name with a faction.
 *
 * Scaled by how badly they want you, and cheaper to buy off in a lawful state
 * where the paperwork matters more than the grudge. Deliberately affordable:
 * being permanently locked out of civilised space would be a dead end, and this
 * build is meant to be kinder than 1984.
 */
export function fineFor(player, systemIndex, multiplier) {
  const w = (player && player.wanted && player.wanted[systemIndex]) || 0;
  if (w <= 0) return 0;
  // Superlinear once you are seriously wanted, so a spree is not free, but
  // never so steep that a single trade run cannot cover it.
  const base = w <= 10 ? w * 40 : 400 + (w - 10) * 90;
  return Math.round(base * (multiplier === undefined ? 1 : multiplier));
}

/**
 * Pay off a bounty, if it can be afforded.
 *
 * Returns a result object rather than throwing, because the shop screen needs
 * to explain *why* it failed.
 *
 * ## Why this takes a system record and not an index
 *
 * Paying a fine does two things in two different key spaces: it clears the
 * entry in `wanted`, which is keyed by **system index**, and it takes the edge
 * off the grudge in `standing`, which is keyed by **faction id**. An earlier
 * version took only the index and used it for both, so
 * `player.standing[systemIndex]` was always `undefined`, the guard was always
 * false, and the relief never happened - the player paid, the record cleared,
 * and the patrol still shot on sight. Exactly the outcome the comment below
 * promises to prevent.
 *
 * Taking the system record makes both keys available and makes the mistake
 * hard to repeat. A bare index is still accepted for callers that only have
 * one, but then the standing side is skipped explicitly rather than silently.
 */
export function payFine(player, system, multiplier) {
  const isRecord = system !== null && typeof system === 'object';
  const systemIndex = isRecord ? system.index : system;
  const factionId = isRecord ? system.faction : null;

  const cost = fineFor(player, systemIndex, multiplier);
  if (cost <= 0) return { ok: false, reason: 'not-wanted' };
  if (player.cash < cost) return { ok: false, reason: 'funds', cost };

  player.cash -= cost;
  delete player.wanted[systemIndex];

  // Paying a fine should also take the edge off the grudge, or the player
  // would be bought off but still shot at.
  let standingRelief = 0;
  if (factionId && player.standing && player.standing[factionId] !== undefined) {
    const before = player.standing[factionId];
    player.standing[factionId] = Math.min(0, before + 20);
    standingRelief = player.standing[factionId] - before;
  }

  return { ok: true, cost, faction: factionId, standingRelief };
}

/**
 * The event layer.
 *
 * Each system carries a list of things that have happened there, which other
 * systems can act on. This is the mechanism behind "the world remembers":
 * clearing pirates lowers danger and raises trade; dumping contraband raises
 * customs scrutiny; running a famine relief run raises standing.
 *
 * Events are kept as a small map of counters rather than a log, because what
 * matters is the accumulated state, not the history.
 */
export function createMemory() {
  return {
    piratesCleared: 0,
    piratesActive: 0,
    contrabandSeized: 0,
    famineRelieved: 0,
    tradersLost: 0,
    patrolsKilled: 0,
    lastVisitDay: null,
    visits: 0,
  };
}

export function rememberEvent(memory, kind, amount) {
  const n = amount === undefined ? 1 : amount;
  if (memory[kind] === undefined) memory[kind] = 0;
  memory[kind] += n;
  return memory[kind];
}

/**
 * The world's memory of one system, created on first use.
 *
 * ## Why this lives on the player record
 *
 * `createMemory` used to be called inside `enterSystem`, which meant a fresh,
 * empty memory every single time the player arrived somewhere. Nothing could
 * ever accumulate, so the whole event layer was inert even before you noticed
 * that `rememberEvent` had no callers.
 *
 * It belongs to the commander, not to the session: the point of the feature is
 * that a system *remembers you* across visits, and a visit that ends in a
 * hyperspace jump must not erase it. Hanging it off the player record also
 * gets persistence for free, because that record is what the save writes.
 *
 * Keyed by system index as a string, because that is what survives JSON.
 */
export function memoryFor(player, systemIndex) {
  if (!player) return createMemory();
  if (!player.systemMemory) player.systemMemory = {};
  const key = String(systemIndex);
  let memory = player.systemMemory[key];
  if (!memory) {
    memory = createMemory();
    player.systemMemory[key] = memory;
  }
  return memory;
}

/** Record something that happened, in the system it happened in. */
export function remember(player, systemIndex, kind, amount) {
  return rememberEvent(memoryFor(player, systemIndex), kind, amount);
}

/**
 * Systems the player has left a mark on, most recent first.
 *
 * Used by the status screen to answer "where do they know me?" without walking
 * all sixty-four entries itself.
 */
export function rememberedSystems(player) {
  const store = (player && player.systemMemory) || {};
  return Object.keys(store)
    .map((key) => ({ index: Number(key), memory: store[key] }))
    .filter((entry) => entry.memory && (
      entry.memory.visits > 0 || entry.memory.piratesCleared > 0 ||
      entry.memory.patrolsKilled > 0 || entry.memory.tradersLost > 0 ||
      entry.memory.famineRelieved > 0))
    .sort((a, b) => (b.memory.visits || 0) - (a.memory.visits || 0));
}

/**
 * Danger adjustment from what the player has done here.
 *
 * Kill pirates and the lanes get safer - for a while. Kill patrols and the
 * navy stops coming, which makes things *more* dangerous. The effect is capped
 * so a player cannot trivially flatten the whole map.
 */
export function memoryDangerDelta(memory) {
  const cleared = Math.min(memory.piratesCleared, 20);
  const patrols = Math.min(memory.patrolsKilled, 10);
  const delta = -cleared * 0.012 + patrols * 0.02;
  return Math.max(-0.25, Math.min(0.25, delta));
}

/** Traffic adjustment: a cleared system attracts shipping. */
export function memoryTrafficDelta(memory) {
  const cleared = Math.min(memory.piratesCleared, 20);
  const lost = Math.min(memory.tradersLost, 10);
  return Math.min(0.4, cleared * 0.02) - Math.min(0.3, lost * 0.03);
}

/** Price adjustment: a system the player supplied stays cheaper for a while. */
export function memoryPriceDelta(memory, comId) {
  let delta = 0;
  if (comId === 'food' && memory.famineRelieved > 0) delta -= 0.04 * Math.min(6, memory.famineRelieved);
  if (comId === 'medicine' && memory.famineRelieved > 0) delta -= 0.03 * Math.min(6, memory.famineRelieved);
  if (memory.contrabandSeized > 0) delta += 0.02 * Math.min(5, memory.contrabandSeized);
  return Math.max(-0.22, Math.min(0.15, delta));
}

/**
 * A deterministic picker for `rumourFor`.
 *
 * `rumourFor` takes a picker rather than a seed so a caller can supply its own
 * randomness - but the one that shipped with the game did not do the job. It
 * was written as
 *
 *     (i) => system.name.charCodeAt(i % system.name.length)
 *
 * which receives the *array of lines* as its argument, ignores it, and returns
 * a character code. So `rumourFor` returned a number, `say()` printed it, and
 * the arrival rumour read `76` instead of a sentence. It was invisible because
 * the same expression looked like a reasonable hash at a glance.
 *
 * This is the picker that was meant: fold a seed into a bounded index and take
 * that line. Seeded rather than random so the same system gives the same line
 * on a reload, and stable across a session.
 */
export function rumourPicker(seed) {
  return function pick(lines) {
    if (!lines || !lines.length) return undefined;
    let h = (seed >>> 0) || 1;
    // A few rounds of a cheap LCG, so consecutive seeds do not walk the array
    // one line at a time.
    for (let i = 0; i < 4; i += 1) h = (h * 1664525 + 1013904223) >>> 0;
    return lines[h % lines.length];
  };
}

/** One-line rumour shown in the station bar, derived from the memory. */
export function rumourFor(system, memory, rngPick) {
  const lines = [];
  if (memory.piratesCleared >= 4) lines.push('They say the lanes have been quiet since someone took care of the pirates out here.');
  if (memory.piratesCleared > 0 && memory.piratesCleared < 4) lines.push('A few raiders were chased off recently. It helped, a little.');
  if (memory.piratesActive >= 3) lines.push('Too many ships have gone missing on the trade lane this week.');
  if (memory.tradersLost >= 2) lines.push('Two haulers never made it in. Nobody is volunteering for the next run.');
  if (memory.patrolsKilled >= 1) lines.push('A navy patrol was destroyed in this system. Nobody has replaced them yet.');
  if (memory.contrabandSeized >= 2) lines.push('Customs have been thorough lately. Best keep your hold boring.');
  if (memory.famineRelieved >= 2) lines.push('Word is the food shipments came from a single commander. They remember.');
  if (memory.visits >= 5) lines.push('They recognise your ship now. That is either good or bad.');

  if (lines.length === 0) {
    lines.push('Quiet. The kind of quiet that makes traders nervous.');
    lines.push('Nothing unusual to report. Prices are what prices are.');
  }
  return rngPick ? rngPick(lines) : lines[0];
}

/** Headline describing a system's condition, for the chart and status screen. */
export function conditionHeadline(system, conditionDef) {
  return conditionDef ? conditionDef.note : 'Nothing unusual to report.';
}

export default {
  STANDING_TIERS, WANTED_DECAY_PER_DAY,
  tierFor, standingPriceFactor, patrolHostile, decayWanted, decayAllWanted,
  markWanted, fineFor, payFine,
  createMemory, rememberEvent, memoryFor, remember, rememberedSystems,
  memoryDangerDelta, memoryTrafficDelta, memoryPriceDelta, rumourFor,
  conditionHeadline,
};
