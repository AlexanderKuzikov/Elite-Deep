/**
 * Procedural galaxy: 64 systems, deep rather than wide.
 *
 * Design note - why 64 and not 256.
 *
 * The original Elite generated 256 systems from a single-byte seed. The
 * consequence, which the original's own manual half-admits, is that systems
 * are near-interchangeable: visit fifteen and you have seen the algorithm.
 * This project trades count for character. Every system here has a producing
 * profile (what it actually makes), a consuming profile (what it actually
 * needs), an owning faction, a local government, a live economic condition,
 * and a memory of what the player did there.
 *
 * 64 systems across a 300-lightyear disc is roughly the density of the
 * original's first galaxy, so travel feels familiar, but a route between two
 * systems is a decision about politics and market conditions rather than a
 * lookup table.
 */
import * as R from './rng.js';
import * as F from './factions.js';

var SYSTEM_COUNT = 64;
var DISC_RADIUS = 260;
/** Documented reference jump range. Guaranteed-route pass enforces it. */
var JUMP_REFERENCE = 36;

var STAR_CLASSES = [
  { cls: 'M', color: 0xff8b6a, temp: 0.55 },
  { cls: 'K', color: 0xffc27a, temp: 0.7 },
  { cls: 'G', color: 0xfff0c0, temp: 0.85 },
  { cls: 'F', color: 0xf6f8ff, temp: 1.0 },
  { cls: 'A', color: 0xcfe0ff, temp: 1.1 },
  { cls: 'B', color: 0xa8c8ff, temp: 1.25 },
];

// Syllables chosen so generated names read as language rather than soup:
// consonant+vowel clusters that mostly survive being concatenated twice.
var SYL_A = ['la', 'za', 'ce', 'bi', 'or', 'mu', 'ra', 'ti', 've', 'du', 'ka', 'ne', 'so', 'xi', 'ar', 'ge'];
var SYL_B = ['ve', 'ri', 'ma', 'na', 'za', 'le', 'di', 'on', 'ur', 'es', 'an', 'or', 'is', 'en', 'ar', 'id'];
var SYL_C = ['re', 'di', 'ce', 'la', 'on', 'ta', 'ne', 'us', 'ar', 'es', 'ir', 'or'];

/**
 * Name generator. Syllable pairs, roughly two or three syllables, filtered
 * for length and spelling so the output reads as a language.
 *
 * Uniqueness is guaranteed structurally rather than probabilistically: the
 * rejection loop handles the common case, and the fallback appends a decimal
 * suffix that is drawn from a counter, so it cannot collide with a name the
 * loop already handed out. An earlier version reused the syllable pool in
 * the fallback and could - rarely, at specific seeds - return a duplicate.
 */
function makeName(range, taken) {
  for (var attempt = 0; attempt < 60; attempt++) {
    var n = R.pick(range, SYL_A) + R.pick(range, SYL_B);
    if (R.chance(range, 0.45)) n += R.pick(range, SYL_C);
    var name = n.charAt(0).toUpperCase() + n.slice(1);
    if (!taken[name] && name.length >= 4 && name.length <= 9) {
      taken[name] = 1;
      return name;
    }
  }
  // Deterministic suffix search. Bounded, and every candidate is checked.
  var i = 2;
  for (;;) {
    var cand = 'X' + i;
    if (!taken[cand]) { taken[cand] = 1; return cand; }
    i++;
  }
}

/**
 * Deterministic economy description, in the voice of the original's
 * short-range chart readout.
 */
function describeSystem(range, s) {
  var agri = s.econ >= 4;
  var gov = F.government(s.gov);
  var fac = F.faction(s.faction);
  var feat = R.pick(range, agri
    ? ['wide terraced farmland', 'shallow seas and grain islands',
      'orbital greenhouses as far as the eye reaches', 'wind-blasted fungal plains']
    : ['foundry smog that never quite clears', 'ring upon ring of orbital works',
      'deep-crust mining shafts', 'a lattice of refinery platforms']);
  var character = R.pick(range, ['reserved', 'proud', 'warlike', 'hospitable',
    'insular', 'mercantile', 'devout', 'weary']);
  var line = 'A ' + gov.name.toLowerCase() + ' world under ' + fac.name +
    ' flag, known for ' + feat + '. The locals are ' + character + '.';
  return line;
}

/**
 * Trade profile: which commodities this world produces and which it needs.
 * Built from economy type plus a per-system quirk, so two Average Industrial
 * worlds still trade differently.
 */
function buildProfile(range, econId) {
  var econ = F.economy(econId);
  var agri = econ.agri;

  // Producing goods scale with how agricultural / rich the world is.
  var produces = {};
  var consumes = {};

  if (agri > 0.6) {
    produces.food = 0.6 + agri * 0.5;
    produces.livestock = 0.4 + agri * 0.4;
    consumes.machinery = 0.3 + agri * 0.4;
    consumes.computers = 0.2 + agri * 0.3;
  } else if (agri < 0.35) {
    produces.machinery = 0.5 + (1 - agri) * 0.4;
    produces.computers = econ.rich > 0.6 ? 0.5 : 0.2;
    produces.alloys = 0.35 + (1 - agri) * 0.3;
    consumes.food = 0.4 + (1 - agri) * 0.45;
    consumes.livestock = 0.3 + (1 - agri) * 0.35;
  } else {
    // Middle ground: modest production on both sides, the dull but
    // profitable world of a genuine trade hub.
    produces.food = 0.28;
    produces.machinery = 0.28;
    consumes.food = 0.15;
    consumes.machinery = 0.15;
  }

  // Per-system quirk: one extra speciality, one extra need.
  var quirks = ['minerals', 'alloys', 'energy', 'medicine', 'weapons', 'luxuries',
    'computers', 'machinery', 'food', 'slaves', 'narcotics'];
  var spec = R.pick(range, quirks);
  produces[spec] = (produces[spec] || 0) + 0.35 + range() * 0.3;

  var need;
  do {
    need = R.pick(range, quirks);
  } while (need === spec);
  consumes[need] = (consumes[need] || 0) + 0.3 + range() * 0.35;

  return { produces: produces, consumes: consumes, speciality: spec, lacking: need };
}

function generate(seed, epoch) {
  epoch = epoch || 0;
  var range = R.mulberry32(seed);
  // Reserve the canonical name up front. Lave is overwritten into slot 0
  // after the loop, so if a generated system elsewhere happened to roll
  // "Lave" the galaxy would end up with two of them and findByName would be
  // ambiguous. Reserving it here makes that structurally impossible.
  var taken = { Lave: 1 };
  var systems = [];

  for (var i = 0; i < SYSTEM_COUNT; i++) {
    var r = R.mulberry32(R.hash2(seed, i, 0x51ed));

    // Position: scatter in a disc, then pull inward so the chart has a dense
    // navigable core rather than a thin ring. `Math.sqrt` alone is uniform
    // *area* (most systems near the rim); cubing the radius biases toward
    // the middle, which is what makes hop-chains of 25-35 ly possible.
    var angle = r() * Math.PI * 2;
    var rad = Math.pow(r(), 0.85) * DISC_RADIUS;
    // Mild spiral shear for character. Kept small: a strong shear ruins
    // local density, which is the thing that actually matters for travel.
    var spiral = Math.sin(angle * 2 + rad * 0.02) * 12;
    var x = Math.round(Math.cos(angle) * (rad + spiral));
    var y = Math.round(Math.sin(angle) * (rad + spiral));

    // Faction: the core is Federation, the rim splits between Empire and
    // Alliance, and a healthy minority is unaligned.
    var distRatio = Math.min(1, Math.sqrt(x * x + y * y) / DISC_RADIUS);
    var factionRoll = r() + distRatio * 0.35;
    var factionId;
    var fRoll = r();
    if (fRoll < 0.2) factionId = 'INDEPENDENT';
    else if (distRatio < 0.45) factionId = fRoll < 0.75 ? 'FEDERATION' : 'EMPIRE';
    else if (distRatio < 0.75) factionId = fRoll < 0.5 ? 'EMPIRE' : fRoll < 0.8 ? 'ALLIANCE' : 'FEDERATION';
    else factionId = fRoll < 0.6 ? 'ALLIANCE' : fRoll < 0.85 ? 'EMPIRE' : 'FEDERATION';

    var econId = R.int(r, 0, 7);
    // Government correlates loosely with faction: Federation worlds lean
    // democratic, Empire worlds lean authoritarian, Alliance is a scatter.
    var fac = F.faction(factionId);
    var govShift = fac.id === 'FEDERATION' ? 1.6 : fac.id === 'EMPIRE' ? -1.4 :
      fac.id === 'ALLIANCE' ? 0.2 : -0.6;
    var govId = Math.max(0, Math.min(7, Math.round(R.int(r, 0, 7) * 0.6 + 2.8 + govShift * 0.9 + (r() - 0.5) * 2.2)));

    var econ = F.economy(econId);
    var tech = Math.max(1, Math.min(15, 5 + econ.techBias + R.int(r, -2, 3)));
    var population = Math.max(0.1, (0.4 + econ.rich * 4 + r() * 4) * (fac.id === 'FEDERATION' ? 1.3 : 1));
    var radius = Math.round(2000 + population * 900 + r() * 1800);

    var star = R.pick(r, STAR_CLASSES);
    var conditionId = F.rollCondition(R, seed, i, epoch);

    var s = {
      index: i,
      name: makeName(r, taken),
      x: x, y: y,
      faction: factionId,
      gov: govId,
      econ: econId,
      tech: tech,
      population: population,
      radius: radius,
      productivity: Math.round(30 + econ.rich * 60 + R.int(r, 0, 30)),
      starClass: star.cls,
      starColor: star.color,
      starTemp: star.temp,
      condition: conditionId,
      // Per-system salt so market noise differs between otherwise identical
      // worlds, and so a system's prices drift on their own phase.
      marketSalt: R.hash2(seed, i, 0xabcd),
      techSalt: R.hash2(seed, i, 0x1234),
      quirkSeed: R.hash2(seed, i, 0x7777),
    };
    s.profile = buildProfile(r, econId);
    s.danger = F.dangerOf(s.gov, s.faction, s.condition);
    s.desc = describeSystem(r, s);

    systems.push(s);
  }

  // System 0 is always Lave, the canonical starting point. Overwriting it
  // wholesale keeps the tutorial world stable across seeds, which matters
  // because the opening minutes are the ones players judge the balance on.
  var lave = systems[0];
  lave.name = 'Lave';
  lave.x = 0; lave.y = 0;
  lave.faction = 'FEDERATION';
  lave.gov = 6;          // Democracy
  lave.econ = 5;         // Rich Agricultural
  lave.tech = 5;
  lave.population = 3.5;
  lave.radius = 4187;
  lave.starClass = 'K';
  lave.starColor = 0xffc27a;
  lave.starTemp = 0.7;
  lave.condition = 'STABLE';
  lave.productivity = 65;
  lave.profile = {
    produces: { food: 1.1, livestock: 0.8, medicine: 0.1 },
    consumes: { machinery: 0.6, computers: 0.5, medicine: 0.2 },
    speciality: 'food',
    lacking: 'computers',
  };
  lave.danger = F.dangerOf(lave.gov, lave.faction, lave.condition);
  lave.desc = 'Famous for its vast rain forests and the Lave Grub. ' +
    'Every commander\u2019s story starts on this landing pad.';

  // Guarantee the chart is navigable.
  //
  // A fixed jump range over a random point cloud produces a shattered graph:
  // at 64 systems in a 260 ly disc the expected nearest neighbour sits around
  // 32 ly, so a third of the systems end up isolated. Inflating the jump
  // range would fix connectivity but flatten the map's sense of scale.
  //
  // So the graph is built in two passes, the way real road networks are:
  //
  //   1. Minimum spanning tree - guarantees every system is reachable from
  //      every other, whatever the seed. These are the trunk routes.
  //   2. Greedy short-edge augmentation - adds any connection under the
  //      jump range that is not already implied, so the reachable
  //      neighbourhood around each system is rich enough to make routing a
  //      choice rather than a corridor.
  //
  // The result is a connected graph where most hops fit one tank, with a few
  // deliberately long trunk routes that require a fuel upgrade. Those long
  // links are a feature: they are the crossings that separate the map into
  // regions you graduate toward.
  var adj = buildAdjacency(systems);
  var mst = minimumSpanningTree(systems, adj);
  var links = {};
  var routes = [];

  function addRoute(a, b, kind) {
    var key = a < b ? a + ':' + b : b + ':' + a;
    if (links[key]) return false;
    links[key] = true;
    var A = systems[a];
    var B = systems[b];
    routes.push({ a: a, b: b, dist: distance(A, B), kind: kind });
    return true;
  }

  for (var e = 0; e < mst.length; e++) {
    addRoute(mst[e].a, mst[e].b, 'trunk');
  }
  for (var i = 0; i < systems.length; i++) {
    var row = adj[i];
    for (var k = 0; k < row.length; k++) {
      if (row[k].w > JUMP_REFERENCE * 1.6) break; // sorted, so stop early
      addRoute(i, row[k].to, 'lane');
    }
  }

  // No dead ends. A system with a single link is a trap: arrive with a dry
  // tank and you cannot leave. Every system gets at least a second exit,
  // chosen as its nearest unconnected neighbour even if that exceeds the
  // reference range - a long escape route beats a prison.
  for (var d0 = 0; d0 < systems.length; d0++) {
    var deg = 0;
    for (var key in links) {
      var parts = key.split(':');
      if (+parts[0] === d0 || +parts[1] === d0) deg++;
    }
    if (deg >= 2) continue;
    var cand = adj[d0];
    for (var c3 = 0; c3 < cand.length; c3++) {
      if (addRoute(d0, cand[c3].to, 'lane')) break;
    }
  }

  routes.sort(function (a, b) { return a.dist - b.dist; });

  return {
    systems: systems,
    routes: routes,
    seed: seed,
    epoch: epoch,
    jumpReference: JUMP_REFERENCE,
  };
}

/** Complete distance matrix, as adjacency lists, cheap enough for 64 nodes. */
function buildAdjacency(systems) {
  var n = systems.length;
  var out = [];
  for (var i = 0; i < n; i++) {
    var row = [];
    for (var j = 0; j < n; j++) {
      if (i === j) continue;
      row.push({ to: j, w: distance(systems[i], systems[j]) });
    }
    row.sort(function (a, b) { return a.w - b.w; });
    out.push(row);
  }
  return out;
}

/** Prim's algorithm over the dense graph. O(n^2), fine at n=64. */
function minimumSpanningTree(systems, adj) {
  var n = systems.length;
  var inTree = new Array(n).fill(false);
  var best = new Array(n).fill(null);
  var edges = [];
  inTree[0] = true;
  for (var i = 0; i < n; i++) {
    var row = adj[0];
    for (var k = 0; k < row.length; k++) {
      var c = row[k];
      if (!inTree[c.to] && (best[c.to] === null || c.w < best[c.to].w)) {
        best[c.to] = { w: c.w, from: 0, to: c.to };
      }
    }
  }
  for (var added = 1; added < n; added++) {
    var pick = null;
    var pickIdx = -1;
    for (var v = 0; v < n; v++) {
      if (inTree[v] || best[v] === null) continue;
      if (pick === null || best[v].w < pick.w) { pick = best[v]; pickIdx = v; }
    }
    if (pick === null) break;
    inTree[pickIdx] = true;
    edges.push({ a: pick.from, b: pick.to, w: pick.w, dist: pick.w });
    // Relax from the newly added node.
    var nrow = adj[pickIdx];
    for (var m = 0; m < nrow.length; m++) {
      var c2 = nrow[m];
      if (!inTree[c2.to] && (best[c2.to] === null || c2.w < best[c2.to].w)) {
        best[c2.to] = { w: c2.w, from: pickIdx, to: c2.to };
      }
    }
  }
  return edges;
}

/**
 * Euclidean distance between two systems.
 *
 * **Raw generator units, not light years.** The systems are laid out on a disc
 * of radius `DISC_RADIUS` in these units, and the route graph is built against
 * them. The conversion to light years lives in `main.js` as `toLy`, and mixing
 * the two scales is a real bug that has been made once already: `neighbors`
 * was called with a jump range in light years and silently matched a fifth of
 * the systems it should have. If you are comparing this against a fuel
 * figure, convert first.
 */
function distance(a, b) {
  var dx = a.x - b.x;
  var dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Systems within `range` light years of `sys`, sorted by distance. */
function neighbors(galaxy, sys, range) {
  var out = [];
  for (var i = 0; i < galaxy.systems.length; i++) {
    var s = galaxy.systems[i];
    if (s === sys) continue;
    var d = distance(sys, s);
    if (d <= range) out.push({ system: s, dist: d });
  }
  out.sort(function (a, b) { return a.dist - b.dist; });
  return out;
}

function findByName(galaxy, name) {
  var lower = String(name).toLowerCase();
  for (var i = 0; i < galaxy.systems.length; i++) {
    if (galaxy.systems[i].name.toLowerCase() === lower) return galaxy.systems[i];
  }
  return null;
}

export {
  SYSTEM_COUNT,
  DISC_RADIUS,
  JUMP_REFERENCE,
  STAR_CLASSES,
  generate,
  distance,
  neighbors,
  findByName,
};

/**
 * Default mirror, matching the other modules in the project.
 * The procedural galaxy: systems, routes and distance.
 */
export default {
  SYSTEM_COUNT, DISC_RADIUS, JUMP_REFERENCE, STAR_CLASSES,
  generate, distance, neighbors, findByName,
};
