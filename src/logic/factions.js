/**
 * Factions and governments.
 *
 * Two orthogonal axes, on purpose:
 *
 *   faction  - WHO owns the place. Drives whom you meet, what is legal,
 *              how your reputation moves, what the stations look like.
 *   gov      - HOW the place is run locally. Drives danger, patrol frequency
 *              and how much the local law cares about your record.
 *
 * Collapsing them into one enum (like the original Elite did with government)
 * loses the thing that makes a world feel like a place: an Alliance mining
 * colony under a corporate dictatorship behaves nothing like an Alliance
 * agri-world under anarchy, even though both fly the same flag.
 */

/**
 * The three powers plus unaligned space.
 *
 * `law` scales how aggressively bounty hunters and patrols respond to your
 * record. `tradeBias` nudges every price in their space: the Federation
 * taxes heavily, the Alliance runs thin margins on bulk goods, the Empire
 * pays absurdly for anything it considers a luxury.
 */
var FACTIONS = {
  FEDERATION: {
    id: 'FEDERATION',
    name: 'Federation',
    short: 'FED',
    color: 0x6fa8dc,
    law: 1.35,
    tradeBias: 0.06,
    hullTint: 0xbcc7d6,
    blurb: 'Old, rich and bureaucratic. Everything is taxed, everything is ' +
      'logged, and the patrols arrive fast when something goes wrong.',
  },
  EMPIRE: {
    id: 'EMPIRE',
    name: 'Empire',
    short: 'EMP',
    color: 0xd98a6a,
    law: 1.15,
    tradeBias: 0.12,
    hullTint: 0xd6c0b0,
    blurb: 'Decadent and severe. Slavery is ordinary commerce here, luxury ' +
      'goods fetch obscene prices, and outsiders are tolerated, never trusted.',
  },
  ALLIANCE: {
    id: 'ALLIANCE',
    name: 'Alliance',
    short: 'ALI',
    color: 0x8fd98a,
    law: 0.72,
    tradeBias: -0.05,
    hullTint: 0xc2cdb4,
    blurb: 'A loose trading compact. Cheap raw materials, thin margins, and a ' +
      'navy too small to be everywhere at once.',
  },
  INDEPENDENT: {
    id: 'INDEPENDENT',
    name: 'Independent',
    short: 'IND',
    color: 0xc0a070,
    law: 0.85,
    tradeBias: 0.0,
    hullTint: 0xa8a8a8,
    blurb: 'Nobody\u2019s flag flies here. The locals make their own rules and ' +
      'enforce them as far as they can see.',
  },
};

var FACTION_IDS = ['FEDERATION', 'EMPIRE', 'ALLIANCE', 'INDEPENDENT'];

/**
 * Local government forms. Kept from the original Elite because the ladder
 * from anarchy to corporate state is a genuinely useful difficulty dial,
 * and because players who know the original read it instantly.
 */
var GOVERNMENTS = [
  { id: 0, name: 'Anarchy', law: 0.15, patrol: 0.0 },
  { id: 1, name: 'Feudal', law: 0.3, patrol: 0.15 },
  { id: 2, name: 'Multi-Government', law: 0.4, patrol: 0.25 },
  { id: 3, name: 'Dictatorship', law: 0.6, patrol: 0.45 },
  { id: 4, name: 'Communist', law: 0.7, patrol: 0.55 },
  { id: 5, name: 'Confederacy', law: 0.8, patrol: 0.7 },
  { id: 6, name: 'Democracy', law: 0.9, patrol: 0.85 },
  { id: 7, name: 'Corporate State', law: 1.0, patrol: 1.0 },
];

var ECONOMIES = [
  { id: 0, name: 'Rich Industrial', agri: 0.0, rich: 1.0, techBias: 3 },
  { id: 1, name: 'Average Industrial', agri: 0.2, rich: 0.7, techBias: 2 },
  { id: 2, name: 'Poor Industrial', agri: 0.4, rich: 0.4, techBias: 1 },
  { id: 3, name: 'Mainly Industrial', agri: 0.55, rich: 0.25, techBias: 0 },
  { id: 4, name: 'Mainly Agricultural', agri: 0.7, rich: 0.1, techBias: -1 },
  { id: 5, name: 'Rich Agricultural', agri: 0.85, rich: 0.3, techBias: -1 },
  { id: 6, name: 'Average Agricultural', agri: 0.95, rich: 0.05, techBias: -2 },
  { id: 7, name: 'Poor Agricultural', agri: 1.0, rich: 0.0, techBias: -3 },
];

/** Economic conditions a system can be in. Modifies prices and traffic. */
var CONDITIONS = [
  {
    id: 'STABLE', name: 'Stable', weight: 100,
    priceBias: 0, traffic: 0, danger: 0, demand: {}, supply: {},
    note: 'Nothing unusual to report.',
  },
  {
    id: 'BOOM', name: 'Boom', weight: 22,
    priceBias: 0.08, traffic: 0.5, danger: -0.05,
    demand: { computers: 0.3, machinery: 0.25 }, supply: { minerals: 0.3, alloys: 0.25 },
    note: 'Factories are running flat out and they are buying anything that moves.',
  },
  {
    id: 'BLOCKADE', name: 'Blockade', weight: 14,
    priceBias: 0.2, traffic: -0.3, danger: 0.3,
    demand: { food: 0.7, medicine: 0.8, weapons: 0.5 }, supply: { computers: 0.4 },
    note: 'Shipping lanes are contested. Prices are wild and the navy is jumpy.',
  },
  {
    id: 'FAMINE', name: 'Famine', weight: 10,
    priceBias: 0.15, traffic: -0.1, danger: 0.1,
    demand: { food: 1.5, livestock: 0.9, medicine: 0.6 }, supply: { food: -0.6 },
    note: 'Harvest failed. They will pay anything for food and they know it.',
  },
  {
    id: 'PLAGUE', name: 'Plague', weight: 8,
    priceBias: 0.12, traffic: -0.4, danger: 0.15,
    demand: { medicine: 2.0 }, supply: { slaves: -0.3, computers: -0.2 },
    note: 'Quarantine in force. Medical supplies command a ransom.',
  },
  {
    id: 'GOLD_RUSH', name: 'Gold Rush', weight: 12,
    priceBias: 0.1, traffic: 0.7, danger: 0.2,
    demand: { machinery: 0.5, alloys: 0.5, computers: 0.2 }, supply: { minerals: 0.6 },
    note: 'Prospectors are pouring in. Ore is cheap, equipment is not.',
  },
  {
    id: 'ECLIPSE', name: 'Solar Eclipse', weight: 6,
    priceBias: 0.05, traffic: -0.2, danger: 0.25,
    demand: { energy: 0.8 }, supply: {},
    note: 'Power rationing while the star is occluded. Energy cells are gold.',
  },
];

function faction(id) {
  return FACTIONS[id] || FACTIONS.INDEPENDENT;
}

function government(id) {
  return GOVERNMENTS[Math.max(0, Math.min(7, id | 0))];
}

function economy(id) {
  return ECONOMIES[Math.max(0, Math.min(7, id | 0))];
}

function condition(id) {
  for (var i = 0; i < CONDITIONS.length; i++) {
    if (CONDITIONS[i].id === id) return CONDITIONS[i];
  }
  return CONDITIONS[0];
}

/**
 * Danger of a system as a 0..1 dial, used to decide pirate density.
 * Both the local government and the owning faction pull on it: an anarchy
 * inside the Federation is still policed by the Federation eventually, an
 * anarchy on the rim is not policed at all.
 */
function dangerOf(govId, factionId, conditionId) {
  var gov = government(govId);
  var fac = faction(factionId);
  var base = 1 - gov.law;
  var policed = gov.patrol * fac.law;
  var cond = condition(conditionId).danger;
  var d = base * 0.8 + (1 - Math.min(1, policed)) * 0.35 + cond;
  return Math.max(0, Math.min(1, d));
}

/** Chance per minute of an encounter being hostile, from the same inputs. */
function hostilityOf(danger, factionId) {
  var fac = faction(factionId);
  // Empires shoot first slightly more often; Alliance space is more relaxed.
  var bias = fac.id === 'EMPIRE' ? 0.12 : fac.id === 'ALLIANCE' ? -0.1 : 0;
  return Math.max(0.05, Math.min(0.92, danger * 0.8 + bias + 0.08));
}

/** Roll a condition id for a system from its own seed. */
function rollCondition(R, seed, sysIndex, epoch) {
  // Conditions persist for a while, so hash on epoch/8 rather than epoch.
  var bucket = Math.floor(epoch / 8);
  var total = 0;
  var weights = CONDITIONS.map(function (c) {
    // Poor systems suffer more, rich systems boom more.
    var w = c.weight;
    if (c.id === 'BOOM') w *= 1;
    total += w;
    return w;
  });
  var roll = R.rand01(seed, sysIndex * 31 + 7, bucket) * total;
  var acc = 0;
  for (var i = 0; i < CONDITIONS.length; i++) {
    acc += weights[i];
    if (roll <= acc) return CONDITIONS[i].id;
  }
  return 'STABLE';
}

export {
  FACTIONS,
  FACTION_IDS,
  GOVERNMENTS,
  ECONOMIES,
  CONDITIONS,
  faction,
  government,
  economy,
  condition,
  dangerOf,
  hostilityOf,
  rollCondition,
};

/**
 * Default mirror, matching the other modules in the project.
 * Factions, governments, economies and the condition layer.
 */
export default {
  FACTIONS, FACTION_IDS, GOVERNMENTS, ECONOMIES, CONDITIONS,
  faction, government, economy, condition, dangerOf, hostilityOf, rollCondition,
};
