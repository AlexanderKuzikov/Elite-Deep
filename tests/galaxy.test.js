/**
 * Galaxy tests.
 *
 * The navigability invariants are the strictest here, because they are the
 * ones a random-layout generator silently violates. A chart that is 40%
 * unreachable does not look broken - it just quietly makes whole regions of
 * the game unplayable - so these run across many seeds on purpose.
 */
import test from 'node:test';
import assert from 'node:assert';
import * as G from '../src/logic/galaxy.js';
import * as F from '../src/logic/factions.js';
import * as E from '../src/logic/economy.js';

const SEEDS = [1984, 7, 90210, 555, 31337, 1, 2, 3, 99, 4242, 123456, 8675309];

test('generates exactly the advertised system count', () => {
  assert.strictEqual(G.generate(1984).systems.length, G.SYSTEM_COUNT);
  assert.strictEqual(G.SYSTEM_COUNT, 64);
});

test('generation is deterministic for a given seed', () => {
  const a = G.generate(7777);
  const b = G.generate(7777);
  assert.strictEqual(a.systems.length, b.systems.length);
  for (let i = 0; i < a.systems.length; i++) {
    assert.strictEqual(a.systems[i].name, b.systems[i].name);
    assert.strictEqual(a.systems[i].x, b.systems[i].x);
    assert.strictEqual(a.systems[i].gov, b.systems[i].gov);
    assert.strictEqual(a.systems[i].faction, b.systems[i].faction);
    assert.strictEqual(a.systems[i].danger, b.systems[i].danger);
  }
});

test('different seeds produce different galaxies', () => {
  const a = G.generate(1);
  const b = G.generate(2);
  const sameNames = a.systems.filter((s, i) => s.name === b.systems[i].name).length;
  assert.ok(sameNames < 5, 'seeds 1 and 2 produced near-identical charts');
  const samePos = a.systems.filter((s, i) => s.x === b.systems[i].x && s.y === b.systems[i].y).length;
  assert.ok(samePos < 5, 'seeds 1 and 2 produced near-identical positions');
});

test('system names are unique across every seed tested', () => {
  for (const seed of SEEDS) {
    const gal = G.generate(seed);
    const names = new Set(gal.systems.map(s => s.name));
    assert.strictEqual(names.size, gal.systems.length, 'duplicate names at seed ' + seed);
  }
});

test('system names look like language, not noise', () => {
  const gal = G.generate(1984);
  for (const s of gal.systems) {
    assert.ok(s.name.length >= 4 && s.name.length <= 12, 'odd name length: ' + s.name);
    assert.ok(/^[A-Z][a-z]+$/.test(s.name), 'name is not cleanly capitalised: ' + s.name);
    assert.ok(/[aeiou]/.test(s.name), 'name has no vowel: ' + s.name);
    assert.ok(!/(.)\1\1/.test(s.name), 'name has a triple letter: ' + s.name);
  }
});

test('every field is inside its documented range', () => {
  for (const seed of SEEDS) {
    for (const s of G.generate(seed).systems) {
      assert.ok(s.gov >= 0 && s.gov <= 7, 'gov out of range: ' + s.gov + ' in ' + s.name);
      assert.ok(s.econ >= 0 && s.econ <= 7, 'econ out of range');
      assert.ok(s.tech >= 1 && s.tech <= 15, 'tech out of range: ' + s.tech);
      assert.ok(s.population > 0, 'non-positive population');
      assert.ok(s.radius > 0, 'non-positive radius');
      assert.ok(s.danger >= 0 && s.danger <= 1, 'danger out of range: ' + s.danger);
      assert.ok(F.FACTION_IDS.includes(s.faction), 'unknown faction: ' + s.faction);
      assert.ok(F.condition(s.condition).id === s.condition, 'unknown condition');
      assert.ok(typeof s.desc === 'string' && s.desc.length > 20, 'missing description');
    }
  }
});

test('profile references only real commodities and names a speciality', () => {
  const valid = new Set(E.COMMODITIES.map(c => c.id));
  for (const seed of SEEDS) {
    for (const s of G.generate(seed).systems) {
      const p = s.profile;
      assert.ok(p && p.produces && p.consumes, 'missing profile in ' + s.name);
      for (const k of Object.keys(p.produces)) assert.ok(valid.has(k), 'unknown produced good: ' + k);
      for (const k of Object.keys(p.consumes)) assert.ok(valid.has(k), 'unknown consumed good: ' + k);
      assert.ok(valid.has(p.speciality), 'unknown speciality: ' + p.speciality);
      assert.ok(valid.has(p.lacking), 'unknown lacking good: ' + p.lacking);
      assert.ok(p.produces[p.speciality] > 0, 'speciality is not produced');
      assert.ok(p.consumes[p.lacking] > 0, 'lacking good is not consumed');
      assert.notStrictEqual(p.speciality, p.lacking, 'speciality equals lacking');
    }
  }
});

test('Lave is always the canonical stable starting system', () => {
  for (const seed of SEEDS) {
    const lave = G.generate(seed).systems[0];
    assert.strictEqual(lave.name, 'Lave');
    assert.strictEqual(lave.faction, 'FEDERATION');
    assert.strictEqual(lave.gov, 6, 'Lave should be a democracy');
    assert.strictEqual(lave.tech, 5);
    assert.ok(lave.danger < 0.2, 'Lave must be safe for a beginner');
    assert.ok(lave.profile.produces.food > 0.5, 'Lave should be an agricultural world');
  }
});

test('the chart is fully connected at every seed', () => {
  for (const seed of SEEDS) {
    const gal = G.generate(seed);
    const adj = Array.from({ length: G.SYSTEM_COUNT }, () => []);
    for (const r of gal.routes) {
      adj[r.a].push(r.b);
      adj[r.b].push(r.a);
    }
    const seen = new Set([0]);
    const stack = [0];
    while (stack.length) {
      const cur = stack.pop();
      for (const nb of adj[cur]) if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
    }
    assert.strictEqual(seen.size, G.SYSTEM_COUNT,
      'seed ' + seed + ': only ' + seen.size + ' of ' + G.SYSTEM_COUNT + ' systems reachable');
  }
});

test('no system is a dead end', () => {
  for (const seed of SEEDS) {
    const gal = G.generate(seed);
    const deg = new Array(G.SYSTEM_COUNT).fill(0);
    for (const r of gal.routes) { deg[r.a]++; deg[r.b]++; }
    for (let i = 0; i < deg.length; i++) {
      assert.ok(deg[i] >= 2, 'seed ' + seed + ': ' + gal.systems[i].name + ' has degree ' + deg[i]);
    }
  }
});

test('the route graph is rich enough to make routing a choice', () => {
  for (const seed of SEEDS) {
    const gal = G.generate(seed);
    const deg = new Array(G.SYSTEM_COUNT).fill(0);
    for (const r of gal.routes) { deg[r.a]++; deg[r.b]++; }
    const median = deg.slice().sort((a, b) => a - b)[Math.floor(G.SYSTEM_COUNT / 2)];
    assert.ok(median >= 2, 'seed ' + seed + ': median degree too low: ' + median);
    assert.ok(gal.routes.length >= G.SYSTEM_COUNT - 1, 'seed ' + seed + ': not even a spanning tree');
  }
});

test('routes carry sane distances and no duplicates', () => {
  const gal = G.generate(1984);
  const seen = new Set();
  for (const r of gal.routes) {
    assert.ok(r.dist > 0 && r.dist < 200, 'implausible route length: ' + r.dist);
    const key = r.a < r.b ? r.a + ':' + r.b : r.b + ':' + r.a;
    assert.ok(!seen.has(key), 'duplicate route ' + key);
    seen.add(key);
    assert.ok(r.a >= 0 && r.a < G.SYSTEM_COUNT && r.b >= 0 && r.b < G.SYSTEM_COUNT);
  }
});

test('distance is symmetric and zero for a system to itself', () => {
  const gal = G.generate(1984);
  const a = gal.systems[3], b = gal.systems[40];
  assert.strictEqual(G.distance(a, b), G.distance(b, a));
  assert.strictEqual(G.distance(a, a), 0);
});

test('routeBetween agrees with the route list and rejects off-graph pairs', () => {
  const FUEL = 14;              // the upgraded tank
  const gal = G.generate(1984);
  const ly = 7 / gal.jumpReference;

  // Every route shorter than the tank must be found, in both directions, and
  // the length it reports must be the route's own length.
  for (const r of gal.routes) {
    const len = r.dist * ly;
    if (len > FUEL) continue;
    assert.ok(Math.abs(G.routeBetween(gal, r.a, r.b, FUEL) - len) < 1e-9,
      'route ' + r.a + '-' + r.b + ' was not found by routeBetween');
    assert.ok(Math.abs(G.routeBetween(gal, r.b, r.a, FUEL) - len) < 1e-9,
      'routeBetween is not symmetric for ' + r.a + '-' + r.b);
  }

  // A route longer than the tank is drawn on the chart but is not jumpable.
  const long = gal.routes.find((r) => r.dist * ly > FUEL);
  if (long) {
    assert.strictEqual(G.routeBetween(gal, long.a, long.b, FUEL), null,
      'a lane longer than the tank was reported as jumpable');
  }

  // Nothing to itself, and nothing with no fuel.
  assert.strictEqual(G.routeBetween(gal, 3, 3, FUEL), null);
  assert.strictEqual(G.routeBetween(gal, 0, 1, 0), null);
});

test('near in space is not the same as linked by a lane', () => {
  // The defect this guards: `canJump` compared straight-line distance against
  // the tank and ignored the route graph, so on the 14 ly tank a commander could
  // jump to systems no lane connects. The two rules must be kept apart, and this
  // asserts the galaxy actually contains such pairs - otherwise the fix in
  // `canJump` is untestable and the next refactor can quietly drop it.
  const FUEL = 14;
  let offGraphInRange = 0;
  let inRangeTotal = 0;

  for (const seed of SEEDS) {
    const gal = G.generate(seed);
    const ly = 7 / gal.jumpReference;
    for (const from of gal.systems) {
      for (const to of gal.systems) {
        if (from.index === to.index) continue;
        const d = G.distance(from, to) * ly;
        if (d > FUEL) continue;
        inRangeTotal++;
        if (G.routeBetween(gal, from.index, to.index, FUEL) === null) offGraphInRange++;
      }
    }
  }

  assert.ok(inRangeTotal > 0, 'no in-range pairs at all; the probe is broken');
  assert.ok(offGraphInRange > 0,
    'expected in-range pairs with no lane: the graph and the range check have '
    + 'become the same thing, so this test no longer tests anything');
  // Always the minority: lanes cover most of what is in range, so a future
  // generator change that broke the graph would show up here as a surge.
  assert.ok(offGraphInRange / inRangeTotal < 0.5,
    'more than half of all in-range pairs are off-graph: ' + offGraphInRange
    + ' of ' + inRangeTotal + ', which suggests the graph, not the check, is wrong');
});

test('neighbors respects the range and sorts by distance', () => {
  const gal = G.generate(1984);
  const lave = gal.systems[0];
  const near = G.neighbors(gal, lave, 45);
  assert.ok(near.length > 0, 'Lave has no neighbours within 45 ly');
  for (const n of near) {
    assert.ok(n.dist <= 45);
    assert.notStrictEqual(n.system, lave, 'a system is its own neighbour');
  }
  for (let i = 1; i < near.length; i++) {
    assert.ok(near[i].dist >= near[i - 1].dist, 'neighbours are not sorted');
  }
});

test('findByName is case-insensitive and reports misses as null', () => {
  const gal = G.generate(1984);
  assert.strictEqual(G.findByName(gal, 'lave').name, 'Lave');
  assert.strictEqual(G.findByName(gal, 'LAVE').name, 'Lave');
  assert.strictEqual(G.findByName(gal, 'no-such-world'), null);
});

test('the faction mix keeps all three powers present', () => {
  for (const seed of SEEDS) {
    const counts = {};
    for (const s of G.generate(seed).systems) counts[s.faction] = (counts[s.faction] || 0) + 1;
    assert.ok(counts.FEDERATION > 0, 'seed ' + seed + ': no Federation systems');
    assert.ok(counts.EMPIRE > 0, 'seed ' + seed + ': no Imperial systems');
    assert.ok(counts.ALLIANCE > 0, 'seed ' + seed + ': no Alliance systems');
  }
});

test('danger spans its full range so travel can be risky', () => {
  const gal = G.generate(1984);
  const d = gal.systems.map(s => s.danger);
  assert.ok(Math.min(...d) < 0.15, 'no safe systems');
  assert.ok(Math.max(...d) > 0.8, 'no genuinely dangerous systems');
});

test('generation is fast enough to run on every new game', () => {
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) G.generate(i);
  const per = (Date.now() - t0) / 20;
  assert.ok(per < 50, 'generation too slow: ' + per.toFixed(1) + ' ms per galaxy');
});
