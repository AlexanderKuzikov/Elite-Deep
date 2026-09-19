/**
 * World tests.
 *
 * The renderer needs a GPU; the *logic* in world.js does not. Everything here
 * runs against real three.js geometry in Node, which means these tests catch
 * the failures that matter in a space game:
 *
 *   - a system that builds scenery the player cannot reach or see
 *   - a docking check that accepts an approach it should refuse (which would
 *     let the player dock from anywhere, deleting the whole station phase)
 *   - a hitscan that hits things behind the shooter
 *   - arrival poses that face away from the station, leaving the player
 *     staring at empty space with no idea where they are
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import * as W from '../src/sim/world.js';
import * as G from '../src/logic/galaxy.js';
import * as C from '../src/logic/combat.js';
import * as F from '../src/sim/flight.js';
import * as M from '../src/sim/models.js';
import * as MIS from '../src/logic/missions.js';

const galaxy = G.generate(1984);
const home = galaxy.systems[0];

test('a system scene builds with a station, a planet and a star', () => {
  const scene = W.buildSystemScene(home, 12345);
  assert.ok(scene.root, 'no root group');
  assert.ok(scene.station, 'no station');
  assert.ok(scene.planet, 'no planet');
  assert.ok(scene.star, 'no star');
  assert.ok(scene.rocks.length >= 40, 'belt is too sparse: ' + scene.rocks.length);
});

test('the station sits at the origin, so docking maths is simple', () => {
  const scene = W.buildSystemScene(home, 1);
  const p = scene.station.position;
  assert.equal(p.x, 0);
  assert.equal(p.y, 0);
  assert.equal(p.z, 0);
});

test('scene construction is deterministic for a given seed', () => {
  const a = W.buildSystemScene(home, 777);
  const b = W.buildSystemScene(home, 777);
  assert.equal(a.rocks.length, b.rocks.length);
  for (let i = 0; i < Math.min(10, a.rocks.length); i += 1) {
    assert.equal(a.rocks[i].position.x.toFixed(6), b.rocks[i].position.x.toFixed(6));
    assert.equal(a.rocks[i].scale.x.toFixed(6), b.rocks[i].scale.x.toFixed(6));
  }
  // And a different seed must actually differ, or "procedural" is a lie.
  const c = W.buildSystemScene(home, 778);
  assert.notEqual(
    a.rocks.map(r => r.position.x.toFixed(3)).join(),
    c.rocks.map(r => r.position.x.toFixed(3)).join(),
  );
});

test('the planet is far enough away to read as a world, not a wall', () => {
  const scene = W.buildSystemScene(home, 42);
  const d = W.dist({ x: 0, y: 0, z: 0 }, scene.planet.position);
  assert.ok(d > W.LAYOUT.stationRadius * 6,
    'planet is practically touching the station: ' + d);
  // But close enough that it is a visible disc rather than a dot.
  assert.ok(d < W.LAYOUT.planetRadius * 20,
    'planet is so far it will never read: ' + d);
});

test('the asteroid belt is navigable - rocks are spaced, not stacked', () => {
  // Two rocks occupying the same point is a collision nightmare and looks
  // broken. With 90 rocks over a wide annulus they should be well separated.
  const scene = W.buildSystemScene(home, 99);
  let minPair = Infinity;
  const n = scene.rocks.length;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const a = scene.rocks[i], b = scene.rocks[j];
      const d = W.dist(a.position, b.position) - (a.userData.radius + b.userData.radius);
      if (d < minPair) minPair = d;
    }
  }
  assert.ok(minPair > 0, 'rocks overlap by ' + (-minPair).toFixed(1) + ' units');
});

test('every rock declares a cargo and a hit radius', () => {
  const scene = W.buildSystemScene(home, 5);
  for (const r of scene.rocks) {
    assert.ok(typeof r.userData.cargo === 'string' && r.userData.cargo.length, 'rock has no cargo');
    assert.ok(r.userData.radius > 1, 'rock has no radius');
    assert.equal(r.userData.kind, 'asteroid');
  }
});

test('traffic spawns the kinds the system deserves', () => {
  const scene = buildScene(1984, 0);
  const traffic = W.createTraffic(scene.root, home, 1984);
  traffic.topUp();
  assert.ok(traffic.ships.length > 0, 'no traffic spawned');
  for (const s of traffic.ships) {
    assert.ok(['pirate', 'raider', 'viper', 'trader'].includes(s.kind),
      'unexpected ship kind ' + s.kind);
    assert.ok(s.hp > 0);
    assert.ok(s.speed > 0);
  }
});

test('an anarchy spawns more hostiles than a corporate state', () => {
  // This is the faction model showing up in the world, which is the whole
  // point of having factions. Sample many seeds because a single roll is noisy.
  const quiet = { ...home, gov: 6, faction: 0, condition: 0, profile: home.profile };
  const wild = { ...home, gov: 0, faction: 3, condition: 0, profile: home.profile };
  let quietHostiles = 0, wildHostiles = 0;
  for (let seed = 0; seed < 40; seed += 1) {
    const sq = W.createTraffic(new THREE.Group(), quiet, seed);
    sq.topUp();
    quietHostiles += sq.ships.filter(s => s.hostile).length;
    const sw = W.createTraffic(new THREE.Group(), wild, seed);
    sw.topUp();
    wildHostiles += sw.ships.filter(s => s.hostile).length;
  }
  assert.ok(wildHostiles > quietHostiles * 1.5,
    'anarchy should be markedly more hostile: ' + wildHostiles + ' vs ' + quietHostiles);
});

test('traffic spawns in a shell around the station, not on top of it', () => {
  const traffic = W.createTraffic(new THREE.Group(), home, 11);
  for (let i = 0; i < 30; i += 1) traffic.spawn();
  for (const s of traffic.ships) {
    const d = Math.hypot(s.mesh.position.x, s.mesh.position.y, s.mesh.position.z);
    assert.ok(d > W.LAYOUT.spawnShellInner * 0.6,
      'a ship spawned in the player face: ' + d);
    assert.ok(d < W.LAYOUT.spawnShellOuter * 1.6,
      'a ship spawned unreachably far: ' + d);
  }
});

test('traffic prunes ships that drift out of range', () => {
  const parent = new THREE.Group();
  const traffic = W.createTraffic(parent, home, 3);
  traffic.spawn();
  assert.equal(traffic.ships.length, 1);
  // Teleport it beyond the despawn sphere.
  traffic.ships[0].mesh.position.set(W.LAYOUT.despawnDistance + 500, 0, 0);
  traffic.prune();
  assert.equal(traffic.ships.length, 0, 'the far ship was not pruned');
  assert.equal(parent.children.length, 0, 'the far ship is still in the scene');
});

test('prune removes destroyed ships', () => {
  const parent = new THREE.Group();
  const traffic = W.createTraffic(parent, home, 4);
  traffic.spawn();
  traffic.spawn();
  traffic.ships[0].dead = true;
  traffic.prune();
  assert.equal(traffic.ships.length, 1);
});

test('dropped cargo can actually be reached by the collision scan', () => {
  // The whole point of the mechanic, and the one thing that was broken: the
  // kill handler built the canisters and threw the array away, so nothing the
  // collision loop walks ever contained one and scooping could not fire.
  const parent = new THREE.Group();
  const traffic = W.createTraffic(parent, home, 8);
  const dropped = W.dropCargo(parent, { x: 10, y: 0, z: 0 }, 'food', 1234);
  assert.ok(dropped.length > 0, 'dropCargo produced nothing to adopt');

  const added = traffic.addWreckage(dropped);
  assert.equal(added.length, dropped.length);
  for (const can of added) {
    assert.ok(traffic.ships.indexOf(can) >= 0,
      'the canister is not in the list the collision scan walks');
  }
  assert.equal(parent.children.length, dropped.length,
    'the canister meshes are not in the scene');
});

test('a canister carries every field the simulation step reads', () => {
  // `integrateEntity` reads `speed` and `velocity` with no guard. An undefined
  // `speed` multiplies the nose into NaN and writes it into the mesh position,
  // which poisons the canister on its first frame. `dropCargo` supplies both,
  // and `addWreckage` fills them in if a future caller does not.
  const parent = new THREE.Group();
  const traffic = W.createTraffic(parent, home, 9);
  const dropped = W.dropCargo(parent, { x: 5, y: 5, z: 5 }, 'machinery', 77);
  const added = traffic.addWreckage(dropped);

  for (const can of added) {
    assert.equal(typeof can.speed, 'number', 'no numeric speed');
    assert.ok(can.velocity, 'no velocity');
    assert.ok(can.spin, 'no spin, so it would not turn');
    assert.equal(typeof can.radius, 'number', 'no radius, so nothing can hit it');
    // Everything else the step decrements or compares. Each is guarded by
    // short-circuit today (`missiles > 0`, `state === 'engage'`), but a field
    // that is only safe because nobody reads it yet is a NaN waiting for the
    // next reader.
    assert.equal(typeof can.missiles, 'number', 'no magazine count');
    assert.equal(typeof can.missileCooldown, 'number', 'no missile cooldown');
    assert.equal(typeof can.canFire, 'number', 'no gun cooldown');
    assert.equal(typeof can.wanderTimer, 'number', 'no wander timer');
  }

  const before = added.map((c) => ({ ...c.mesh.position }));
  for (let i = 0; i < 120; i += 1) {
    W.stepTraffic(traffic, { vel: { x: 0, y: 0, z: 0 } }, { x: 0, y: 0, z: 0 }, 1 / 60,
      { onEnemyShot() {} });
  }
  added.forEach((can, i) => {
    const p = can.mesh.position;
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z),
      'the canister position went non-finite: ' + p.x + ',' + p.y + ',' + p.z);
    // A canister has no engine, so it must hold station rather than fly off.
    assert.ok(Math.abs(p.x - before[i].x) < 1e-6 && Math.abs(p.y - before[i].y) < 1e-6
      && Math.abs(p.z - before[i].z) < 1e-6, 'a canister drifted under its own power');
  });
});

test('wreckage does not count against the traffic cap', () => {
  // `topUp` measures the ship count against `cap`. If canisters were counted, a
  // commander who scooped a few wrecks would quietly starve the system of
  // traffic - the restock would think the sky was full.
  const parent = new THREE.Group();
  const quiet = { ...home, danger: 0 };
  const traffic = W.createTraffic(parent, quiet, 12);
  traffic.topUp();
  const cap = traffic.ships.length;
  assert.ok(cap > 0, 'no traffic to begin with');

  const dropped = W.dropCargo(parent, { x: 0, y: 0, z: 0 }, 'food', 5);
  traffic.addWreckage(dropped);
  traffic.topUp();

  assert.equal(traffic.ships.length, cap + dropped.length,
    'the restock spawned on top of the wreckage or refused to spawn at all');
});

test('a jump takes the wreckage with it', () => {
  // The canisters live in the renderer's scene, not the system group, so a jump
  // only frees them through `dispose`. The comment on `createTraffic` records
  // the same mistake being made once already with ships: 104 frozen hulls after
  // twelve jumps.
  const parent = new THREE.Group();
  const traffic = W.createTraffic(parent, home, 13);
  const dropped = W.dropCargo(parent, { x: 0, y: 0, z: 0 }, 'food', 6);
  traffic.addWreckage(dropped);
  assert.ok(parent.children.length > 0, 'nothing in the scene to clean up');

  traffic.dispose();
  assert.equal(traffic.ships.length, 0, 'the wreckage survived the jump');
  assert.equal(parent.children.length, 0, 'the wreckage meshes are still in the scene');
});

test('ships fly nose-first along their own nose vector', () => {
  // The same +Z convention as models.js and flight.js. If this breaks, ships
  // visibly fly backwards, which is the single most embarrassing bug possible.
  const traffic = W.createTraffic(new THREE.Group(), home, 21);
  for (let i = 0; i < 20; i += 1) traffic.spawn();
  for (const s of traffic.ships) {
    W.stepTraffic(traffic, { vel: { x: 0, y: 0, z: 0 } }, { x: 4000, y: 0, z: 0 }, 1 / 60, { onEnemyShot() {} });
    const nose = W.noseOf(s);
    const v = s.velocity;
    const sp = Math.hypot(v.x, v.y, v.z);
    if (sp < 1) continue;
    const alignment = (nose.x * v.x + nose.y * v.y + nose.z * v.z) / sp;
    assert.ok(alignment > 0.8,
      s.kind + ' is not flying along its nose: alignment ' + alignment.toFixed(3));
  }
});

test('a hostile closes on the player when in range', () => {
  const traffic = W.createTraffic(new THREE.Group(), home, 55);
  const s = traffic.spawn('pirate');
  s.aggression = 1;
  s.mesh.position.set(0, 0, 500);
  s.mesh.lookAt(0, 0, 0);
  const player = { x: 0, y: 0, z: 0 };
  const before = Math.hypot(s.mesh.position.x, s.mesh.position.y, s.mesh.position.z);
  for (let i = 0; i < 240; i += 1) {
    W.stepTraffic(traffic, { vel: { x: 0, y: 0, z: 0 } }, player, 1 / 60, { onEnemyShot() {} });
  }
  const after = Math.hypot(s.mesh.position.x, s.mesh.position.y, s.mesh.position.z);
  assert.ok(after < before, 'the hostile did not close: ' + before + ' -> ' + after);
});

test('a hostile only shoots when roughly pointed at the player', () => {
  const traffic = W.createTraffic(new THREE.Group(), home, 77);
  const s = traffic.spawn('pirate');
  s.aggression = 1;
  s.canFire = 0;
  s.mesh.position.set(0, 0, 300);
  // Point it away from the player.
  s.mesh.lookAt(0, 0, 1000);
  let shots = 0;
  for (let i = 0; i < 120; i += 1) {
    W.stepTraffic(traffic, { vel: { x: 0, y: 0, z: 0 } }, { x: 0, y: 0, z: 0 }, 1 / 60,
      { onEnemyShot() { shots += 1; } });
  }
  assert.equal(shots, 0, 'a ship shot the player while facing away');
});

test('a hostile does shoot once it has turned onto the player', () => {
  const traffic = W.createTraffic(new THREE.Group(), home, 78);
  const s = traffic.spawn('pirate');
  s.aggression = 1;
  s.canFire = 0;
  s.turnRate = 4; // let it snap around quickly for the purposes of the test
  s.mesh.position.set(0, 0, 300);
  s.mesh.lookAt(0, 0, 0);
  let shots = 0;
  for (let i = 0; i < 600; i += 1) {
    W.stepTraffic(traffic, { vel: { x: 0, y: 0, z: 0 } }, { x: 0, y: 0, z: 0 }, 1 / 60,
      { onEnemyShot() { shots += 1; } });
  }
  assert.ok(shots > 0, 'a pirate sat on the player nose for 10s and never fired');
});

test('traders do not shoot in a safe system', () => {
  const safe = { ...home, gov: 6, faction: 0, condition: 0, profile: home.profile };
  const traffic = W.createTraffic(new THREE.Group(), safe, 90);
  const s = traffic.spawn('trader');
  s.canFire = 0;
  s.mesh.position.set(0, 0, 200);
  s.mesh.lookAt(0, 0, 0);
  let shots = 0;
  for (let i = 0; i < 600; i += 1) {
    W.stepTraffic(traffic, { vel: { x: 0, y: 0, z: 0 } }, { x: 0, y: 0, z: 0 }, 1 / 60,
      { onEnemyShot() { shots += 1; } });
  }
  assert.equal(shots, 0, 'a trader opened fire in a corporate state');
});

test('petrol chips away at a distant hostile but never at a destroyed one', () => {
  const traffic = W.createTraffic(new THREE.Group(), home, 12);
  const s = traffic.spawn('pirate');
  s.dead = true;
  let shots = 0;
  W.stepTraffic(traffic, { vel: { x: 0, y: 0, z: 0 } }, { x: 0, y: 0, z: 0 }, 1 / 60,
    { onEnemyShot() { shots += 1; } });
  assert.equal(shots, 0);
});

test('hitscan hits a target straight ahead and reports the surface point', () => {
  const traffic = W.createTraffic(new THREE.Group(), home, 30);
  const s = traffic.spawn('pirate');
  s.mesh.position.set(0, 0, 400);
  const origin = { x: 0, y: 0, z: 0 };
  const hit = W.raycast(origin, { x: 0, y: 0, z: 1 }, [s], 5000);
  assert.ok(hit, 'raycast missed a target dead ahead');
  assert.equal(hit.target, s);
  assert.ok(hit.distance < 400, 'hit distance should be in front of the centre');
  assert.ok(hit.distance > 400 - 20, 'hit landed absurdly early: ' + hit.distance);
});

test('hitscan ignores targets behind the shooter', () => {
  const traffic = W.createTraffic(new THREE.Group(), home, 31);
  const s = traffic.spawn('pirate');
  s.mesh.position.set(0, 0, -400);
  const hit = W.raycast({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, [s], 5000);
  assert.equal(hit, null, 'shot a target behind us');
});

test('hitscan returns the nearest of several targets', () => {
  const traffic = W.createTraffic(new THREE.Group(), home, 32);
  const near = traffic.spawn('pirate');
  const far = traffic.spawn('pirate');
  near.mesh.position.set(0, 0, 200);
  far.mesh.position.set(0, 0, 800);
  const hit = W.raycast({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, [near, far], 5000);
  assert.equal(hit.target, near, 'hit the far target through the near one');
});

test('hitscan ignores a destroyed target', () => {
  const traffic = W.createTraffic(new THREE.Group(), home, 33);
  const s = traffic.spawn('pirate');
  s.mesh.position.set(0, 0, 300);
  s.dead = true;
  assert.equal(W.raycast({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, [s], 5000), null);
});

test('hitscan misses a target beside the beam', () => {
  const traffic = W.createTraffic(new THREE.Group(), home, 34);
  const s = traffic.spawn('pirate');
  s.mesh.position.set(90, 0, 400);
  const hit = W.raycast({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, [s], 5000);
  assert.equal(hit, null, 'hit a target 90 units off-axis');
});

test('hitscan respects maxDist', () => {
  const traffic = W.createTraffic(new THREE.Group(), home, 35);
  const s = traffic.spawn('pirate');
  s.mesh.position.set(0, 0, 400);
  assert.equal(W.raycast({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, [s], 100), null);
});

test('docking succeeds on a clean, slow, head-on approach', () => {
  const scene = W.buildSystemScene(home, 111);
  const st = scene.station;
  const pose = W.arrivalPose(st);
  // Come in from the arrival pose, nose on the station, at docking speed.
  const dir = {
    x: st.position.x - pose.position.x,
    y: st.position.y - pose.position.y,
    z: st.position.z - pose.position.z,
  };
  const dl = Math.hypot(dir.x, dir.y, dir.z);
  const vel = { x: dir.x / dl * 40, y: dir.y / dl * 40, z: dir.z / dl * 40 };
  // Point the nose at the station using the same convention the game uses.
  const f = F.createFlight();
  F.faceToward(f, { x: dir.x / dl, y: dir.y / dl, z: dir.z / dl });

  // Walk in until we are close to the slot, then check.
  let pos = { ...pose.position };
  for (let i = 0; i < 400; i += 1) {
    pos = { x: pos.x + vel.x * (1 / 60), y: pos.y + vel.y * (1 / 60), z: pos.z + vel.z * (1 / 60) };
    const verdict = W.checkDocking(st, pos, vel, f.quat);
    if (verdict.ok) {
      assert.equal(verdict.reason, 'docking');
      assert.ok(verdict.lateral < W.DOCKING.maxOffset);
      return;
    }
  }
  assert.fail('a textbook approach was never accepted');
});

test('docking refuses an approach that is too fast', () => {
  const scene = W.buildSystemScene(home, 112);
  const st = scene.station;
  const slot = localToWorld(st, st.userData.slotPointLocal);
  const normal = localDirToWorld(st, st.userData.slotNormalLocal);
  const pos = { x: slot.x + normal.x * 30, y: slot.y + normal.y * 30, z: slot.z + normal.z * 30 };
  const vel = { x: -normal.x * 200, y: -normal.y * 200, z: -normal.z * 200 };
  const f = F.createFlight();
  F.faceToward(f, { x: -normal.x, y: -normal.y, z: -normal.z });
  const verdict = W.checkDocking(st, pos, vel, f.quat);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'too-fast');
});

test('docking refuses a ship that is not lined up with the slot', () => {
  const scene = W.buildSystemScene(home, 113);
  const st = scene.station;
  const slot = localToWorld(st, st.userData.slotPointLocal);
  const normal = localDirToWorld(st, st.userData.slotNormalLocal);
  // Sit far off to one side of the slot axis.
  const pos = {
    x: slot.x + normal.x * 30 + 200,
    y: slot.y + normal.y * 30 + 200,
    z: slot.z + normal.z * 30,
  };
  const f = F.createFlight();
  F.faceToward(f, { x: -normal.x, y: -normal.y, z: -normal.z });
  const verdict = W.checkDocking(st, pos, { x: 0, y: 0, z: 0 }, f.quat);
  assert.equal(verdict.ok, false);
  // It is either off-axis or out of range, but it is definitely not docking.
  assert.notEqual(verdict.reason, 'docking');
});

test('docking refuses a ship flying away from the slot', () => {
  const scene = W.buildSystemScene(home, 114);
  const st = scene.station;
  const slot = localToWorld(st, st.userData.slotPointLocal);
  const normal = localDirToWorld(st, st.userData.slotNormalLocal);
  const pos = { x: slot.x + normal.x * 30, y: slot.y + normal.y * 30, z: slot.z + normal.z * 30 };
  const f = F.createFlight();
  // Nose pointing outward, i.e. away from the station.
  F.faceToward(f, normal);
  const verdict = W.checkDocking(st, pos, { x: 0, y: 0, z: 0 }, f.quat);
  assert.equal(verdict.ok, false, 'docked while flying backwards out of the slot');
});

test('docking refuses a ship that is nowhere near the station', () => {
  const scene = W.buildSystemScene(home, 115);
  const st = scene.station;
  const f = F.createFlight();
  const verdict = W.checkDocking(st, { x: 5000, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, f.quat);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'out-of-range');
});

test('arrival always drops the player facing the station at a sane distance', () => {
  // The worst possible first impression is spawning in the void with nothing in
  // view. Every system must put the station in front of the player.
  for (const sys of galaxy.systems.slice(0, 20)) {
    const scene = W.buildSystemScene(sys, 4242);
    const pose = W.arrivalPose(scene.station);
    const d = W.dist(pose.position, scene.station.position);
    assert.ok(d > scene.station.userData.radius * 1.5,
      sys.name + ': arrival is inside the station');
    assert.ok(d < scene.station.userData.radius * 5,
      sys.name + ': arrival is too far to see the station');
    // The facing vector must point from the arrival point *at* the station.
    const toStation = {
      x: scene.station.position.x - pose.position.x,
      y: scene.station.position.y - pose.position.y,
      z: scene.station.position.z - pose.position.z,
    };
    const dl = Math.hypot(toStation.x, toStation.y, toStation.z);
    const dot = (toStation.x / dl) * pose.facing.x
      + (toStation.y / dl) * pose.facing.y
      + (toStation.z / dl) * pose.facing.z;
    assert.ok(dot > 0.999, sys.name + ': arrival faces away from the station, dot=' + dot);
  }
});

test('destroying a trader drops scoopable cargo', () => {
  const scene = new THREE.Group();
  const drop = W.dropCargo(scene, { x: 10, y: 0, z: 20 }, 'food', 7);
  assert.ok(drop.length >= 1, 'no cargo dropped');
  for (const c of drop) {
    assert.equal(c.kind, 'canister');
    assert.equal(c.commodity, 'food');
    assert.equal(c.hostile, false, 'a cargo canister should not attack you');
    assert.ok(c.radius > 0);
  }
  assert.equal(scene.children.length, drop.length, 'cargo was not added to the scene');
});

test('dropped cargo has no velocity, so it does not fly off', () => {
  const scene = new THREE.Group();
  const drop = W.dropCargo(scene, { x: 0, y: 0, z: 0 }, 'minerals', 8);
  for (const c of drop) {
    assert.equal(c.velocity.x, 0);
    assert.equal(c.velocity.y, 0);
    assert.equal(c.velocity.z, 0);
  }
});

test('an escape capsule is marked as a capsule, not plain cargo', () => {
  const scene = new THREE.Group();
  const cap = W.dropCapsule(scene, { x: 0, y: 0, z: 0 }, 9);
  assert.equal(cap.capsule, true);
  assert.notEqual(cap.canister, true);
  assert.equal(scene.children.length, 1);
});

test('the station spin does not move its position', () => {
  // Rotation is fine; translation would break every distance check in the game.
  const scene = W.buildSystemScene(home, 116);
  const st = scene.station;
  const before = { ...st.position };
  for (let i = 0; i < 600; i += 1) W.spinStation(st, 1 / 60);
  assert.equal(st.position.x, before.x);
  assert.equal(st.position.y, before.y);
  assert.equal(st.position.z, before.z);
  // But it must actually have turned, or docking loses its timing element.
  const angle = 2 * Math.acos(Math.min(1, Math.abs(st.quaternion.w)));
  assert.ok(angle > 0.5, 'the station did not rotate: ' + angle);
});

test('beacons blink over time', () => {
  const scene = W.buildSystemScene(home, 117);
  const st = scene.station;
  const seen = new Set();
  for (let i = 0; i < 40; i += 1) {
    W.spinStation(st, 1 / 60);
    seen.add(st.userData.beacons[0].intensity.toFixed(2));
  }
  assert.ok(seen.size > 5, 'beacon intensity never changed');
});

test('enemy shot damage scales with the ship, not the system', () => {
  // Both a pirate in an anarchy and a pirate in a safe system must hit for the
  // same amount, or the difficulty curve becomes unreadable.
  const seen = new Set();
  for (const sys of [
    { ...home, gov: 0, faction: 3, condition: 0, profile: home.profile },
    { ...home, gov: 6, faction: 0, condition: 0, profile: home.profile },
  ]) {
    const traffic = W.createTraffic(new THREE.Group(), sys, 500);
    const s = traffic.spawn('pirate');
    s.aggression = 1; s.canFire = 0; s.turnRate = 6;
    s.mesh.position.set(0, 0, 200);
    s.mesh.lookAt(0, 0, 0);
    for (let i = 0; i < 600; i += 1) {
      W.stepTraffic(traffic, { vel: { x: 0, y: 0, z: 0 } }, { x: 0, y: 0, z: 0 }, 1 / 60,
        { onEnemyShot(_s, shot) { seen.add(shot.damage); } });
    }
  }
  assert.deepEqual([...seen].sort(), [5], 'pirate damage is not consistent: ' + [...seen]);
});

/** Build a scene attached to a parent group, for traffic tests. */
function buildScene(seed, index) {
  const sys = G.generate(seed).systems[index || 0];
  return W.buildSystemScene(sys, seed);
}

/** Apply a station's transform to a local point (mirrors the module's helper). */
function localToWorld(station, local) {
  const v = new THREE.Vector3(local.x, local.y, local.z);
  v.applyQuaternion(station.quaternion);
  v.add(station.position);
  return { x: v.x, y: v.y, z: v.z };
}

/** Transform a local direction (no translation). */
function localDirToWorld(station, local) {
  const v = new THREE.Vector3(local.x, local.y, local.z);
  v.applyQuaternion(station.quaternion);
  return { x: v.x, y: v.y, z: v.z };
}

test('the star light is bright enough to shape a deliberately dark hull', () => {
  // The hull fill is nearly black on purpose (models.HULL_COLOUR) - the vector
  // edges carry the silhouette. That only works if the directional light is
  // strong enough to give the facets a visible gradient, so a future tidy-up
  // that "normalises" the intensity back to 1.0 turns every ship into a
  // flat dark blob. The original ZX Spectrum could not fill a triangle at all;
  // this is the compromise that keeps the look while reading as a solid.
  const scene = buildScene(4242, 0);
  assert.ok(scene.sunLight.isDirectionalLight, 'the sun should be a directional light');
  assert.ok(scene.sunLight.intensity > 1.5,
    `sun intensity ${scene.sunLight.intensity} is too dim for a dark hull`);
  assert.ok(scene.sunLight.intensity < 4,
    `sun intensity ${scene.sunLight.intensity} would blow the hulls out to white`);
});

test('the sun light aims at the station, not off into space', () => {
  // The light is placed 3000 units out on a bearing; its target has to be the
  // origin. If the target drifts, the whole system is lit from a direction
  // nobody can predict and the terminator on the planet stops matching the
  // station's shading.
  const scene = buildScene(4242, 0);
  assert.ok(scene.sunLight.target, 'the light needs a target');
  assert.deepEqual(
    [scene.sunLight.target.position.x, scene.sunLight.target.position.y, scene.sunLight.target.position.z],
    [0, 0, 0],
  );
  const dist = Math.hypot(
    scene.sunLight.position.x, scene.sunLight.position.y, scene.sunLight.position.z,
  );
  assert.ok(dist > 1000, `the sun light is only ${dist.toFixed(0)} units out`);
});

test('the hull colour is dark but not black', () => {
  // Read through getHexString() because three converts hex literals out of
  // sRGB into the linear working space - comparing raw .r/.g/.b against the
  // bytes in the source silently fails.
  const hex = M.HULL_COLOUR.toString(16).padStart(6, '0');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  assert.ok(r + g + b > 60, `hull ${hex} is so dark the facets will not read`);
  assert.ok(r + g + b < 260, `hull ${hex} is too light for a vector game`);
  assert.ok(b > r, 'the hull should stay cool-toned rather than warm grey');
});

// ---------------------------------------------------------------------------
// The planet
//
// These are shape tests, not pixel tests. A planet is generated geometry, so
// the questions worth pinning are: is it actually spherical, does it have
// terrain rather than noise, are the caps where they should be, and is it
// deterministic. The one thing that cannot be checked in Node is whether it
// *looks* like a world - that is a screenshot job.
// ---------------------------------------------------------------------------

/** Extract the planet from a scene built for a given system index. */
function planetOf(index, seed) {
  const sys = galaxy.systems[index % galaxy.systems.length];
  const scene = W.buildSystemScene(sys, seed === undefined ? 4242 : seed);
  return scene.planet;
}

test('the planet is a real sphere, not a deformed blob', () => {
  const planet = planetOf(0);
  const body = planet.userData.body;
  const geo = body.geometry;
  const pos = geo.attributes.position;
  const target = W.LAYOUT.planetRadius;

  let min = Infinity, max = 0;
  for (let i = 0; i < pos.count; i += 1) {
    const r = Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i));
    if (r < min) min = r;
    if (r > max) max = r;
  }
  // Terrain may lift or sink the surface, but only by a few percent. If the
  // relief amplitude ever gets cranked up the planet turns into a rock and the
  // ring/cap maths starts missing the equator.
  assert.ok(min > target * 0.93, `the surface dips to ${(min / target).toFixed(3)} of radius`);
  assert.ok(max < target * 1.08, `the surface rises to ${(max / target).toFixed(3)} of radius`);
});

test('the planet actually has terrain, not a smooth ball', () => {
  const planet = planetOf(0);
  const relief = planet.userData.relief;
  assert.ok(Array.isArray(relief) && relief.length > 1000, 'relief was not recorded');

  let min = Infinity, max = -Infinity;
  for (const h of relief) { if (h < min) min = h; if (h > max) max = h; }
  // Enough range that there is a visible ocean/land split. A tiny range means
  // the noise normalisation is broken and every vertex sits at sea level.
  assert.ok(max - min > 0.15, `relief only spans ${(max - min).toFixed(3)}`);
  // And both ocean and land must exist, or the palette never shows its bands.
  assert.ok(min < -0.05, `no ocean: minimum relief ${min.toFixed(3)}`);
  assert.ok(max > 0.10, `no high land: maximum relief ${max.toFixed(3)}`);
});

test('the planet carries vertex colours spanning more than one band', () => {
  // A palette bug that paints everything one colour is invisible to a shape
  // test but obvious on screen. Count how many distinct-ish colours came out.
  const planet = planetOf(0);
  const colours = planet.userData.body.geometry.attributes.color;
  assert.ok(colours, 'no vertex colour attribute');
  const seen = new Set();
  for (let i = 0; i < colours.count; i += 7) {
    const key = [colours.getX(i), colours.getY(i), colours.getZ(i)]
      .map((n) => Math.round(n * 24) / 24).join(',');
    seen.add(key);
  }
  assert.ok(seen.size > 8, `only ${seen.size} distinct surface colours - palette collapsed`);
});

test('ice caps sit at the poles and not at the equator', () => {
  // The cap test uses the snow colour, which is the brightest thing on the
  // surface. Comparing mean luminance at the poles against the equator is
  // robust regardless of which palette the system drew.
  const planet = planetOf(4);       // the grey/rock palette, capExtent 0.72
  const geo = planet.userData.body.geometry;
  const pos = geo.attributes.position;
  const col = geo.attributes.color;
  const R = W.LAYOUT.planetRadius;

  let polarLum = 0, polarN = 0, eqLum = 0, eqN = 0;
  for (let i = 0; i < pos.count; i += 1) {
    const lat = Math.abs(pos.getY(i)) / R;
    const lum = col.getX(i) + col.getY(i) + col.getZ(i);
    if (lat > 0.92) { polarLum += lum; polarN += 1; } else if (lat < 0.15) { eqLum += lum; eqN += 1; }
  }
  assert.ok(polarN > 0 && eqN > 0, 'could not sample both bands');
  assert.ok(polarLum / polarN > eqLum / eqN * 1.15,
    `poles are not brighter than the equator (${(polarLum / polarN).toFixed(3)} vs ${(eqLum / eqN).toFixed(3)})`);
});

test('the planet has a cloud layer and an atmosphere shell', () => {
  const planet = planetOf(1);
  const clouds = planet.userData.clouds;
  const atmo = planet.userData.atmo;
  assert.ok(clouds, 'no cloud layer');
  assert.ok(atmo, 'no atmosphere shell');

  // Both must sit *outside* the surface or they z-fight with it.
  const R = W.LAYOUT.planetRadius;
  const cloudPos = clouds.geometry.attributes.position;
  const atmoPos = atmo.geometry.attributes.position;
  let cloudR = 0, atmoR = 0;
  for (let i = 0; i < cloudPos.count; i += 1) {
    cloudR = Math.max(cloudR, Math.hypot(cloudPos.getX(i), cloudPos.getY(i), cloudPos.getZ(i)));
  }
  for (let i = 0; i < atmoPos.count; i += 1) {
    atmoR = Math.max(atmoR, Math.hypot(atmoPos.getX(i), atmoPos.getY(i), atmoPos.getZ(i)));
  }
  assert.ok(cloudR > R, `clouds at ${cloudR.toFixed(0)} are inside the ${R} surface`);
  assert.ok(atmoR > cloudR, `atmosphere at ${atmoR.toFixed(0)} is not above the clouds`);

  // Neither may write depth: the surface has to occlude them, not the reverse.
  assert.equal(clouds.material.depthWrite, false, 'clouds write depth');
  assert.equal(atmo.material.depthWrite, false, 'atmosphere writes depth');
  assert.equal(atmo.material.side, THREE.BackSide, 'the atmosphere must draw its far shell only');
});

test('the planet is deterministic for a given system', () => {
  const a = planetOf(3, 777);
  const b = planetOf(3, 777);
  assert.deepEqual(Array.from(a.userData.relief), Array.from(b.userData.relief));
});

test('different systems get different worlds', () => {
  // Force the same palette so this tests the noise, not the palette table.
  const paletteCount = 6;
  const a = planetOf(0, 100);
  const b = planetOf(paletteCount, 100);
  let differ = false;
  const ra = a.userData.relief, rb = b.userData.relief;
  for (let i = 0; i < ra.length; i += 97) if (ra[i] !== rb[i]) { differ = true; break; }
  assert.ok(differ, 'two systems produced identical terrain - the seed is not reaching the noise');
});

test('building a planet does not disturb the rest of the system', () => {
  // The planet draws its noise from its own PRNG stream. If it ever went back
  // to consuming the shared `range`, the star, the belt and the traffic would
  // all shift, silently rerolling every existing system. Pin the star and the
  // station as witnesses.
  const scene = W.buildSystemScene(galaxy.systems[2], 31337);
  const starPos = scene.star.position;
  const spin = scene.station.userData.spinRate;

  // Rebuild and confirm nothing moved.
  const again = W.buildSystemScene(galaxy.systems[2], 31337);
  assert.equal(starPos.x, again.star.position.x);
  assert.equal(starPos.y, again.star.position.y);
  assert.equal(starPos.z, again.star.position.z);
  assert.equal(spin, again.station.userData.spinRate);
});

// ---------------------------------------------------------------------------
// The star
// ---------------------------------------------------------------------------

/** Every mesh in a star group, by layer name. */
function starLayers(star) {
  const out = {};
  star.traverse((o) => { if (o.isMesh && o.name.startsWith('star:')) out[o.name] = o; });
  return out;
}

test('the star is built in layers that nest outward', () => {
  const star = W.buildSystemScene(galaxy.systems[0], 1).star;
  const L = starLayers(star);
  assert.ok(L['star:photosphere'], 'no photosphere');
  assert.ok(L['star:chromosphere'], 'no chromosphere');
  assert.ok(L['star:corona'], 'no corona');

  // Each shell must be strictly larger than the one inside it, or the star
  // renders as a single hard disc with no glow at all.
  const radiusOf = (m) => {
    const p = m.geometry.attributes.position;
    let r = 0;
    for (let i = 0; i < p.count; i += 1) r = Math.max(r, Math.hypot(p.getX(i), p.getY(i), p.getZ(i)));
    return r;
  };
  const r = ['star:photosphere', 'star:chromosphere', 'star:corona'].map((k) => radiusOf(L[k]));
  for (let i = 1; i < r.length; i += 1) {
    assert.ok(r[i] > r[i - 1], `layer ${i} at ${r[i].toFixed(0)} is not outside layer ${i - 1} at ${r[i - 1].toFixed(0)}`);
  }

  // The corona must stay modest. A shell several times the star radius with
  // additive blending covers most of the screen and erases the starfield and
  // every nebula behind it - the exact regression that produced a screen-wide
  // orange wash.
  assert.ok(r[2] < r[0] * 2.5, `the corona reaches ${(r[2] / r[0]).toFixed(1)}x the star radius`);
});

test('every glow layer is additive and never writes depth', () => {
  const star = W.buildSystemScene(galaxy.systems[0], 1).star;
  const L = starLayers(star);
  for (const key of ['star:chromosphere', 'star:corona']) {
    const m = L[key].material;
    assert.equal(m.blending, THREE.AdditiveBlending, `${key} is not additive`);
    assert.equal(m.depthWrite, false, `${key} writes depth and will punch a hole in the sky`);
    assert.equal(m.side, THREE.BackSide, `${key} must draw its far shell only`);
  }
  // And the glow must be driven by the shader patch, not a flat opacity - a
  // constant opacity is exactly the flat-disc look this replaced.
  assert.ok(typeof L['star:corona'].material.onBeforeCompile === 'function',
    'the corona has no radial falloff shader');
});

test('the star is bright enough to bloom, not a flat white disc', () => {
  // The post chain applies ACES tone mapping and gates bloom at 0.62. A colour
  // at 1.0 lands under that threshold after tone mapping, so a star built with
  // ordinary colours renders as a dull grey ball. The photosphere has to be
  // overdriven.
  const star = W.buildSystemScene(galaxy.systems[0], 1).star;
  const col = star.getObjectByName('star:photosphere').geometry.attributes.color;
  let max = 0;
  for (let i = 0; i < col.count; i += 1) {
    max = Math.max(max, col.getX(i), col.getY(i), col.getZ(i));
  }
  assert.ok(max > 1.5, `the photosphere peaks at ${max.toFixed(2)} - it will not bloom`);
  // But not so far that it clips to pure white and loses its spectral tint.
  assert.ok(max < 4.0, `the photosphere peaks at ${max.toFixed(2)} - the tint will be washed out`);
});

test('the star tint reaches the photosphere rather than being ignored', () => {
  // Every star rendering the same neutral white is invisible to a shape test
  // and very visible on screen.
  const a = W.buildSystemScene(galaxy.systems[0], 1).star;
  const b = W.buildSystemScene(galaxy.systems[3], 1).star;
  const colA = a.getObjectByName('star:photosphere').geometry.attributes.color;
  const colB = b.getObjectByName('star:photosphere').geometry.attributes.color;
  let differ = false;
  for (let i = 0; i < colA.count; i += 11) {
    if (colA.getX(i) !== colB.getX(i) || colA.getZ(i) !== colB.getZ(i)) { differ = true; break; }
  }
  assert.ok(differ, 'two systems produced an identical star colour');
});

test('the photosphere has granuled vertex colours, not one flat value', () => {
  const star = W.buildSystemScene(galaxy.systems[1], 1).star;
  const col = star.getObjectByName('star:photosphere').geometry.attributes.color;
  const seen = new Set();
  for (let i = 0; i < col.count; i += 5) {
    seen.add([col.getX(i), col.getY(i), col.getZ(i)].map((n) => n.toFixed(3)).join(','));
  }
  assert.ok(seen.size > 20, `photosphere is flat: only ${seen.size} distinct colours`);
});

// --- Engine flames ---------------------------------------------------------

/** Collect the flame mesh on a ship, if there is one. */
function flameOf(ship) {
  // `traffic.spawn()` hands back the entity wrapper, not the Object3D, so
  // accept either. A merchant ship in `world.js` likewise travels as a record
  // with a `.mesh` field.
  const root = ship && ship.isObject3D ? ship : ship && ship.mesh;
  if (!root || typeof root.traverse !== 'function') return null;
  let flame = null;
  root.traverse((o) => { if (o.name === 'flame') flame = o; });
  return flame;
}

test('every ship class carries an engine flame at its tail', () => {
  for (const kind of ['pirate', 'raider', 'viper', 'trader']) {
    const ship = M.makeShip(kind);
    const flame = flameOf(ship);
    assert.ok(flame, kind + ' has no engine flame');
    // Additive and depth-write-free, like every other glow in the game: an
    // opaque flame would occlude the hull behind it and read as a solid cone.
    assert.strictEqual(flame.material.blending, THREE.AdditiveBlending,
      kind + ' flame is not additive');
    assert.strictEqual(flame.material.depthWrite, false,
      kind + ' flame writes depth');
    // `BackSide` is the trick that makes one mesh read as a hot core: the far
    // wall shows through the near one and the two add.
    assert.strictEqual(flame.material.side, THREE.BackSide,
      kind + ' flame should be drawn BackSide');
  }
});

test('the flame sits behind the hull, pointing out of the tail', () => {
  // The nose convention is +Z, so the tail is the smallest z of the hull and
  // the flame must hang off that end. A flame at the wrong end would fire out
  // of the cockpit, which is very visible and very wrong.
  for (const kind of ['pirate', 'viper', 'trader']) {
    const ship = M.makeShip(kind);
    const flame = flameOf(ship);
    let hullMinZ = Infinity;
    ship.traverse((o) => {
      if (!o.isMesh || o.name === 'flame') return;
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i += 1) hullMinZ = Math.min(hullMinZ, pos.getZ(i));
    });
    // World position of the nozzle: the mesh is positioned, not the geometry.
    const nozzleZ = flame.position.z;
    assert.ok(nozzleZ <= hullMinZ + 0.35,
      kind + ': the nozzle starts inside the hull (nozzle z ' + nozzleZ.toFixed(2) +
      ' vs hull tail ' + hullMinZ.toFixed(2) + ')');

    // And the geometry itself must run further back still, so even the idle
    // flame pokes past the hull rather than vanishing behind it.
    const geo = flame.geometry.attributes.position;
    let flameMinZ = Infinity;
    for (let i = 0; i < geo.count; i += 1) flameMinZ = Math.min(flameMinZ, geo.getZ(i));
    const idleTailZ = nozzleZ + flameMinZ * M.FLAME.idle;
    assert.ok(idleTailZ < hullMinZ,
      kind + ': the idle flame is swallowed by the hull (tail z ' + idleTailZ.toFixed(2) +
      ' vs hull tail ' + hullMinZ.toFixed(2) + ')');
  }
});

test('a flame starts at its idle scale, never at zero', () => {
  // A dark tail reads as a wreck. Even a drifting ship should show a pilot
  // light.
  for (const kind of ['pirate', 'viper']) {
    const flame = flameOf(M.makeShip(kind));
    assert.ok(flame.scale.z > 0, kind + ' starts with an invisible flame');
    assert.ok(flame.scale.z < M.FLAME.burn,
      kind + ' starts at full burn instead of idle');
  }
});

test('the flame responds to how hard a ship is turning', () => {
  // The ships have no throttle, so `integrateEntity` always pulls velocity
  // toward `speed * nose`. The only time a hull genuinely accelerates is when
  // its nose is swinging, which makes turn rate the honest signal for thrust.
  //
  // Distance matters here, and it is not a quirk of the test: `steerToward`
  // turns toward a point, so the further away the aim point the smaller its
  // angular rate. A target 40 000 units out is effectively a fixed heading and
  // the nose barely moves; a target at dogfight range reverses the nose
  // quickly. That is exactly the behaviour the effect is meant to show.
  const traffic = W.createTraffic(new THREE.Group(), home, 31);
  const ship = traffic.spawn('pirate');
  const flame = flameOf(ship);

  // Cruise: aim at a distant point and let the flame settle.
  const far = { x: 0, y: 0, z: 40000 };
  for (let i = 0; i < 300; i += 1) {
    W.stepTraffic(traffic, { vel: { x: 0, y: 0, z: 0 } }, far, 1 / 60, { onEnemyShot() {} });
  }
  const cruise = flame.scale.z;

  // Close quarters: demand the ship face a point on the other side of itself
  // every frame, so the nose swings at the AI's maximum yaw.
  let banking = 0;
  for (let i = 0; i < 300; i += 1) {
    const target = i % 2 ? { x: 300, y: 40, z: 300 } : { x: -300, y: 40, z: 300 };
    W.stepTraffic(traffic, { vel: { x: 0, y: 0, z: 0 } }, target, 1 / 60, { onEnemyShot() {} });
    banking = Math.max(banking, flame.scale.z);
  }

  assert.ok(cruise >= M.FLAME.idle - 1e-6,
    'the flame fell below its idle floor while cruising (' + cruise.toFixed(3) + ')');
  assert.ok(banking > cruise + 0.05,
    'the flame did not lengthen under a hard turn (' +
    cruise.toFixed(3) + ' -> ' + banking.toFixed(3) + ')');
});

test('the flame never exceeds its burn length', () => {
  // A runaway multiplier would push the cone out through the nose.
  const traffic = W.createTraffic(new THREE.Group(), home, 37);
  const ship = traffic.spawn('raider');
  const flame = flameOf(ship);
  let peak = 0;
  for (let i = 0; i < 200; i += 1) {
    // Alternate the aim point every frame to force maximum turn rate.
    const target = i % 2 ? { x: 400, y: 0, z: 0 } : { x: -400, y: 0, z: 0 };
    W.stepTraffic(traffic, { vel: { x: 0, y: 0, z: 0 } }, target, 1 / 60, { onEnemyShot() {} });
    peak = Math.max(peak, flame.scale.z);
    assert.ok(flame.scale.z <= M.FLAME.burn + 1e-6,
      'the flame overran its burn length: ' + flame.scale.z.toFixed(3));
    assert.ok(flame.scale.z >= M.FLAME.idle - 1e-6,
      'the flame dropped below idle: ' + flame.scale.z.toFixed(3));
  }
  // And it must actually have reached for the ceiling, or the bound proves
  // nothing about a runaway.
  assert.ok(peak > M.FLAME.idle + 0.05,
    'the flame never responded to the thrashing (' + peak.toFixed(3) + ')');
});

test('rocks and canisters have no engine flame', () => {
  // `makeAsteroid` and `shell` must not pick up the flame by accident: a
  // glowing thruster on a drifting rock would be a visible absurdity.
  const rock = M.makeAsteroid(5);
  assert.strictEqual(flameOf(rock), null, 'an asteroid has an engine flame');
  assert.strictEqual(flameOf(M.makeCanister()), null, 'a canister has an engine flame');
  assert.strictEqual(flameOf(M.makeCapsule()), null, 'a capsule has an engine flame');
});

// --- The Docking Computer's envelope ---------------------------------------

/**
 * Build an approach with a controlled lateral offset, closing speed and
 * attitude error, so the envelope can be probed at a known point rather than
 * by hoping a simulated approach lands where we want.
 */
function approachAt(station, offset, speed, angleError) {
  const slot = localToWorld(station, station.userData.slotPointLocal);
  const normal = localDirToWorld(station, station.userData.slotNormalLocal);
  // A perpendicular to the slot axis, for the lateral offset and the attitude
  // error to share. Any perpendicular will do; the check is rotationally
  // symmetric about the axis.
  const perp = Math.abs(normal.y) < 0.9
    ? { x: 0, y: 1, z: 0 }
    : { x: 1, y: 0, z: 0 };
  const px = perp.y * normal.z - perp.z * normal.y;
  const py = perp.z * normal.x - perp.x * normal.z;
  const pz = perp.x * normal.y - perp.y * normal.x;
  const pl = Math.hypot(px, py, pz) || 1;
  const u = { x: px / pl, y: py / pl, z: pz / pl };

  const pos = {
    x: slot.x + normal.x * 40 + u.x * offset,
    y: slot.y + normal.y * 40 + u.y * offset,
    z: slot.z + normal.z * 40 + u.z * offset,
  };
  const vel = { x: -normal.x * speed, y: -normal.y * speed, z: -normal.z * speed };

  // Nose into the slot, then rotate off-axis by `angleError` toward `u`.
  const f = F.createFlight();
  const into = { x: -normal.x, y: -normal.y, z: -normal.z };
  const dir = {
    x: into.x * Math.cos(angleError) + u.x * Math.sin(angleError),
    y: into.y * Math.cos(angleError) + u.y * Math.sin(angleError),
    z: into.z * Math.cos(angleError) + u.z * Math.sin(angleError),
  };
  F.faceToward(f, dir);
  return { pos, vel, quat: f.quat };
}

test('dockingLimits gives the computer a strictly wider envelope', () => {
  const stock = W.dockingLimits(false);
  const assisted = W.dockingLimits(true);
  assert.ok(assisted.maxOffset > stock.maxOffset, 'offset was not widened');
  assert.ok(assisted.maxAngle > stock.maxAngle, 'angle was not widened');
  assert.ok(assisted.maxSpeed > stock.maxSpeed, 'speed was not widened');
  assert.ok(assisted.range > stock.range, 'range was not widened');
  // And the stock numbers must still be the documented ones, so this cannot
  // pass by quietly shrinking what a player without the item gets.
  assert.equal(stock.maxOffset, W.DOCKING.maxOffset);
  assert.equal(stock.maxAngle, W.DOCKING.maxAngle);
  assert.equal(stock.maxSpeed, W.DOCKING.maxSpeed);
});

test('a sloppy approach is refused without the computer and taken with it', () => {
  // The whole point of the item: 2500 CR buys a forgiving definition of
  // "aligned". Before this the item was read by no code at all.
  const scene = W.buildSystemScene(home, 121);
  const st = scene.station;
  // Lateral offset well past the stock corridor, speed past the stock ceiling.
  const a = approachAt(st, 95, 120, 0);

  const stock = W.checkDocking(st, a.pos, a.vel, a.quat);
  const assisted = W.checkDocking(st, a.pos, a.vel, a.quat, { assisted: true });

  assert.equal(stock.ok, false, 'a sloppy approach should not dock without the computer');
  assert.equal(assisted.ok, true,
    'the computer did not accept an approach inside its envelope (' + assisted.reason + ')');
});

test('the computer still refuses to fly you in backwards', () => {
  // Widening the cone must not delete the attitude check, or the item becomes
  // "dock from anywhere facing anything".
  const scene = W.buildSystemScene(home, 122);
  const st = scene.station;
  const a = approachAt(st, 0, 40, Math.PI);
  const verdict = W.checkDocking(st, a.pos, a.vel, a.quat, { assisted: true });
  assert.equal(verdict.ok, false, 'docked while flying backwards out of the slot');
});

test('the computer still refuses an approach from across the system', () => {
  const scene = W.buildSystemScene(home, 123);
  const st = scene.station;
  const f = F.createFlight();
  const verdict = W.checkDocking(st, { x: 6000, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, f.quat,
    { assisted: true });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'out-of-range');
});

test('every verdict reports the limits that produced it', () => {
  // The HUD coaches against these. A verdict that omitted them would fall
  // back to the stock 90 and tell a computer-assisted pilot to slow down when
  // the station would already have taken them.
  const scene = W.buildSystemScene(home, 124);
  const st = scene.station;
  const a = approachAt(st, 0, 40, 0);

  const stock = W.checkDocking(st, a.pos, a.vel, a.quat);
  const assisted = W.checkDocking(st, a.pos, a.vel, a.quat, { assisted: true });

  assert.equal(stock.limits.maxSpeed, W.DOCKING.maxSpeed);
  assert.equal(assisted.limits.maxSpeed, W.DOCKING.assist.maxSpeed);
  assert.equal(stock.assisted, false);
  assert.equal(assisted.assisted, true);
});

test('a textbook approach is accepted with or without the computer', () => {
  // The item must not become a requirement for docking.
  const scene = W.buildSystemScene(home, 125);
  const st = scene.station;
  const a = approachAt(st, 0, 40, 0);
  assert.equal(W.checkDocking(st, a.pos, a.vel, a.quat).ok, true);
  assert.equal(W.checkDocking(st, a.pos, a.vel, a.quat, { assisted: true }).ok, true);
});

// --- Despawn disposal ------------------------------------------------------

test('prune frees the geometry of a ship that drifted out of range', () => {
  // A despawned ship used to be removed from the scene and nothing else, so
  // its hull, edge overlay and flame leaked. Each ship is built from its own
  // geometry, so a long session in one system climbed steadily; a hyperspace
  // jump hid it by clearing the whole scene.
  const scene = new THREE.Group();
  const traffic = W.createTraffic(scene, home, 777);
  traffic.topUp();

  const ship = traffic.ships[0];
  const disposals = [];
  ship.mesh.traverse((o) => {
    if (o.geometry) {
      const original = o.geometry.dispose.bind(o.geometry);
      o.geometry.dispose = () => { disposals.push(o.geometry.uuid); original(); };
    }
  });

  // Shove it past the despawn sphere and prune.
  ship.mesh.position.set(W.LAYOUT.despawnDistance + 500, 0, 0);
  const removed = traffic.prune();

  assert.ok(removed >= 1, 'the ship was not pruned');
  assert.ok(!traffic.ships.includes(ship), 'the ship is still in the traffic list');
  assert.ok(disposals.length > 0, 'the despawned ship\'s geometry was never freed');
});

test('prune leaves ships inside the sphere alone', () => {
  const scene = new THREE.Group();
  const traffic = W.createTraffic(scene, home, 778);
  traffic.topUp();
  const before = traffic.ships.length;
  for (const s of traffic.ships) s.mesh.position.set(100, 0, 0);
  assert.equal(traffic.prune(), 0, 'nothing should have been pruned');
  assert.equal(traffic.ships.length, before);
});

test('prune drops destroyed ships from the list', () => {
  const scene = new THREE.Group();
  const traffic = W.createTraffic(scene, home, 779);
  traffic.topUp();
  const before = traffic.ships.length;
  traffic.ships[0].dead = true;
  traffic.prune();
  assert.equal(traffic.ships.length, before - 1);
});

// --- The world responds to what the commander has done ---------------------

test('a system the commander cleared is less dangerous and busier', () => {
  // The feedback loop the event layer exists to close: clearing the lanes has
  // to change the system, not just the bounty total.
  const calm = W.createTraffic(new THREE.Group(), home, 900, {
    dangerDelta: -0.25, trafficDelta: 0.4,
  });
  const baseline = W.createTraffic(new THREE.Group(), home, 900);

  assert.ok(calm.danger < baseline.danger, 'clearing the lanes did not lower danger');
  assert.ok(calm.trafficScale > 1, 'a cleared system should carry more shipping');
});

test('a system whose patrols were killed is more dangerous', () => {
  const lawless = W.createTraffic(new THREE.Group(), home, 901, { dangerDelta: 0.25 });
  const baseline = W.createTraffic(new THREE.Group(), home, 901);
  assert.ok(lawless.danger > baseline.danger);
});

test('the traffic scale is clamped, so a long history cannot empty or flood a system', () => {
  // The deltas come from a capped memory, but the scale is applied to the cap
  // itself - an unbounded multiplier would let a long session produce either
  // an empty sky or a swarm.
  const empty = W.createTraffic(new THREE.Group(), home, 902, { trafficDelta: -99 });
  const swarm = W.createTraffic(new THREE.Group(), home, 903, { trafficDelta: 99 });
  assert.ok(empty.trafficScale >= 0.3, 'traffic scale collapsed below its floor');
  assert.ok(swarm.trafficScale <= 1.6, 'traffic scale ran away above its ceiling');
});

test('danger stays inside 0..1 however extreme the history', () => {
  const none = W.createTraffic(new THREE.Group(), home, 904, { dangerDelta: -99 });
  const all = W.createTraffic(new THREE.Group(), home, 905, { dangerDelta: 99 });
  assert.ok(none.danger >= 0 && none.danger <= 1, 'danger left the unit range: ' + none.danger);
  assert.ok(all.danger >= 0 && all.danger <= 1, 'danger left the unit range: ' + all.danger);
});

test('a cleared system still restocks to at least one ship', () => {
  // `topUp` uses the cap; a floor of zero would leave the player alone in a
  // system that is supposed to be busy, which reads as a bug rather than as
  // consequence.
  const traffic = W.createTraffic(new THREE.Group(), home, 906, { trafficDelta: -99 });
  traffic.topUp();
  assert.ok(traffic.ships.length >= 1, 'the system emptied completely');
});

test('patrols turn hostile when the commander is hunted', () => {
  // "Weapons are hot the instant you drop in." The tier table has promised
  // this since it was written; nothing read it until now.
  const scene = new THREE.Group();
  const traffic = W.createTraffic(scene, home, 907);
  traffic.topUp();

  // Force the roster to contain a patrol, whatever the system rolled.
  const viper = traffic.spawn('viper');
  assert.equal(viper.hostile, false, 'a patrol should start neutral in a clean system');

  W.stepTraffic(traffic, {
    vel: { x: 0, y: 0, z: 0 }, shields: 40, hull: 100, hostilePatrols: true,
  }, { x: 0, y: 0, z: 0 }, 1 / 60, { onEnemyShot() {} });

  assert.equal(viper.hostile, true, 'a patrol ignored a hunted commander');
  assert.ok(viper.aggression >= 0.9, 'the patrol turned hostile but not willing');
});

test('patrols stay neutral when the commander is not hunted', () => {
  const scene = new THREE.Group();
  const traffic = W.createTraffic(scene, home, 908);
  traffic.topUp();
  const viper = traffic.spawn('viper');

  W.stepTraffic(traffic, {
    vel: { x: 0, y: 0, z: 0 }, shields: 40, hull: 100, hostilePatrols: false,
  }, { x: 0, y: 0, z: 0 }, 1 / 60, { onEnemyShot() {} });

  assert.equal(viper.hostile, false, 'a patrol turned hostile with no reason to');
});

test('turning patrols hostile leaves pirates and traders alone', () => {
  // Only the police react to the commander's record; a pirate was already
  // hostile and a trader has its own reasons.
  const scene = new THREE.Group();
  const traffic = W.createTraffic(scene, home, 909);
  const trader = traffic.spawn('trader');
  const wasHostile = trader.hostile;

  W.stepTraffic(traffic, {
    vel: { x: 0, y: 0, z: 0 }, shields: 40, hull: 100, hostilePatrols: true,
  }, { x: 0, y: 0, z: 0 }, 1 / 60, { onEnemyShot() {} });

  assert.equal(trader.hostile, wasHostile, 'a trader was made hostile by the commander\'s record');
});

test('stepTraffic still works without the new playerState field', () => {
  // The field is new; a caller that omits it must not crash, because the
  // existing tests and the e2e driver both call this with a plain state.
  const scene = new THREE.Group();
  const traffic = W.createTraffic(scene, home, 910);
  traffic.topUp();
  assert.doesNotThrow(() => W.stepTraffic(
    traffic, { vel: { x: 0, y: 0, z: 0 } }, { x: 0, y: 0, z: 0 }, 1 / 60, { onEnemyShot() {} },
  ));
});

// --- Morale and pack response ----------------------------------------------

test('a badly damaged ship breaks off instead of flying into the guns', () => {
  // The state machine has had a `fleeing` branch since it was written and
  // nothing ever set the flag, so every NPC fought to the death - a pirate
  // with two hit points left would still turn into the player's fire.
  const traffic = W.createTraffic(new THREE.Group(), home, 401);
  const pirate = traffic.spawn('pirate');
  pirate.mesh.position.set(0, 0, 300);
  pirate.hp = pirate.maxHp * 0.9;

  W.stepTraffic(traffic, { vel: { x: 0, y: 0, z: 0 } }, { x: 0, y: 0, z: 0 }, 1 / 60,
    { onEnemyShot() {} });
  assert.notEqual(pirate.state, 'flee', 'a healthy ship ran away');

  pirate.hp = pirate.maxHp * 0.1;
  W.stepTraffic(traffic, { vel: { x: 0, y: 0, z: 0 } }, { x: 0, y: 0, z: 0 }, 1 / 60,
    { onEnemyShot() {} });
  assert.equal(pirate.fleeing, true, 'a nearly dead ship did not break off');
  assert.equal(pirate.state, 'flee');
});

test('a ship that has broken off stays broken off', () => {
  // There is no repairing in space, so a ship that ran has nothing to come
  // back for. A flag that reset would produce enemies that rally for no reason.
  const traffic = W.createTraffic(new THREE.Group(), home, 402);
  const pirate = traffic.spawn('pirate');
  pirate.mesh.position.set(0, 0, 300);
  pirate.hp = 1;
  W.stepTraffic(traffic, { vel: { x: 0, y: 0, z: 0 } }, { x: 0, y: 0, z: 0 }, 1 / 60,
    { onEnemyShot() {} });
  assert.equal(pirate.fleeing, true);

  pirate.hp = pirate.maxHp;          // as if it had been repaired
  W.stepTraffic(traffic, { vel: { x: 0, y: 0, z: 0 } }, { x: 0, y: 0, z: 0 }, 1 / 60,
    { onEnemyShot() {} });
  assert.equal(pirate.fleeing, true, 'the ship rallied after being repaired');
  assert.equal(pirate.state, 'flee');
});

test('a fleeing ship runs away from the player, not around them', () => {
  // A ship that still circles the station is loitering, not fleeing.
  const traffic = W.createTraffic(new THREE.Group(), home, 403);
  const pirate = traffic.spawn('pirate');
  pirate.mesh.position.set(0, 0, 400);
  pirate.hp = 1;

  const dist = () => Math.hypot(pirate.mesh.position.x, pirate.mesh.position.y, pirate.mesh.position.z);
  const step = () => W.stepTraffic(traffic, { vel: { x: 0, y: 0, z: 0 } }, { x: 0, y: 0, z: 0 },
    1 / 60, { onEnemyShot() {} });

  // It spawns with a tangential heading, and turning a hundred and eighty
  // degrees takes three to six seconds at these turn rates. Measure from after
  // it has come about, or the test measures the turn rather than the flight.
  for (let i = 0; i < 120; i += 1) step();
  const before = dist();
  for (let i = 0; i < 300; i += 1) step();
  const after = dist();

  assert.ok(after > before,
    'a fleeing ship did not get further away once it had turned: '
    + before.toFixed(0) + ' -> ' + after.toFixed(0));
});

test('a fleeing ship stops shooting', () => {
  // Otherwise breaking off is only cosmetic: it runs while still firing.
  const traffic = W.createTraffic(new THREE.Group(), home, 404);
  const pirate = traffic.spawn('pirate');
  pirate.mesh.position.set(0, 0, -200);
  pirate.hp = 1;
  pirate.canFire = 0;
  pirate.fleeing = true;

  let shots = 0;
  for (let i = 0; i < 120; i += 1) {
    W.stepTraffic(traffic, { vel: { x: 0, y: 0, z: 0 } }, { x: 0, y: 0, z: 0 }, 1 / 60,
      { onEnemyShot() { shots += 1; } });
  }
  assert.equal(shots, 0, 'a ship that had broken off kept firing');
});

test('a fight in progress draws nearby raiders in', () => {
  // Without this, three pirates in range take turns duelling the player one at
  // a time while the other two fly their patrol, which reads as a bug rather
  // than as mercy.
  const traffic = W.createTraffic(new THREE.Group(), home, 405);
  const leader = traffic.spawn('pirate');
  leader.mesh.position.set(0, 0, 300);
  leader.state = 'engage';
  leader.aggression = 1;

  const bystander = traffic.spawn('pirate');
  bystander.mesh.position.set(60, 0, 320);
  bystander.state = 'patrol';
  bystander.aggression = 0;          // it would rather not fight
  bystander.hostile = true;

  W.stepTraffic(traffic, { vel: { x: 0, y: 0, z: 0 } }, { x: 0, y: 0, z: 0 }, 1 / 60,
    { onEnemyShot() {} });
  assert.equal(bystander.state, 'engage', 'a nearby raider ignored a fight in progress');
});

test('a raider too far away is not drawn in', () => {
  const traffic = W.createTraffic(new THREE.Group(), home, 406);
  const leader = traffic.spawn('pirate');
  leader.mesh.position.set(0, 0, 200);
  leader.state = 'engage';
  leader.aggression = 1;

  const distant = traffic.spawn('pirate');
  distant.mesh.position.set(0, 0, 200 + W.MORALE.joinRadius * 2);
  distant.state = 'patrol';
  distant.aggression = 0;
  distant.hostile = true;

  W.stepTraffic(traffic, { vel: { x: 0, y: 0, z: 0 } }, { x: 0, y: 0, z: 0 }, 1 / 60,
    { onEnemyShot() {} });
  assert.notEqual(distant.state, 'engage', 'the pack response reached too far');
});

test('traders are never drawn into a fight', () => {
  // A trader joining a pirate's fight would be absurd, and it would also make
  // the lanes far more dangerous than the brief asks for.
  const traffic = W.createTraffic(new THREE.Group(), home, 407);
  const leader = traffic.spawn('pirate');
  leader.mesh.position.set(0, 0, 300);
  leader.state = 'engage';
  leader.aggression = 1;

  const trader = traffic.spawn('trader');
  trader.mesh.position.set(50, 0, 310);
  trader.state = 'patrol';
  trader.aggression = 0;
  trader.hostile = false;

  W.stepTraffic(traffic, { vel: { x: 0, y: 0, z: 0 } }, { x: 0, y: 0, z: 0 }, 1 / 60,
    { onEnemyShot() {} });
  assert.notEqual(trader.state, 'engage', 'a trader joined a firefight');
  assert.equal(trader.hostile, false, 'a trader was made hostile by a nearby fight');
});

test('a fleeing ship does not lead a pack', () => {
  // A ship running away should not be what draws others in.
  const traffic = W.createTraffic(new THREE.Group(), home, 408);
  const coward = traffic.spawn('pirate');
  coward.mesh.position.set(0, 0, 300);
  coward.state = 'flee';
  coward.fleeing = true;
  coward.hp = 1;

  const other = traffic.spawn('pirate');
  other.mesh.position.set(60, 0, 320);
  other.state = 'patrol';
  other.aggression = 0;
  other.hostile = true;
  other.hp = other.maxHp;

  W.stepTraffic(traffic, { vel: { x: 0, y: 0, z: 0 } }, { x: 0, y: 0, z: 0 }, 1 / 60,
    { onEnemyShot() {} });
  assert.notEqual(other.state, 'engage', 'a fleeing ship drew in a pack');
});

test('rocks never take morale', () => {
  const traffic = W.createTraffic(new THREE.Group(), home, 409);
  const rock = traffic.spawn('asteroid');
  rock.hp = 1;
  W.stepTraffic(traffic, { vel: { x: 0, y: 0, z: 0 } }, { x: 0, y: 0, z: 0 }, 1 / 60,
    { onEnemyShot() {} });
  assert.notEqual(rock.fleeing, true, 'an asteroid tried to run away');
});

// --- Enemy missiles --------------------------------------------------------

/** Run one frame and collect any missiles launched. */
function fireFrame(traffic, playerPos) {
  const launched = [];
  W.stepTraffic(traffic, { vel: { x: 0, y: 0, z: 0 } }, playerPos, 1 / 60, {
    onEnemyShot() {},
    onEnemyMissile(entity, spec) { launched.push({ entity: entity, spec: spec }); },
  });
  return launched;
}

/** A pirate lined up on the player, ready to launch. */
function loadedPirate(seed, kind, distance) {
  const traffic = W.createTraffic(new THREE.Group(), home, seed);
  const ship = traffic.spawn(kind || 'pirate');
  ship.state = 'engage';
  ship.aggression = 1;
  ship.missileCooldown = 0;
  // Dead ahead of the player, nose toward them, at the given range.
  ship.mesh.position.set(0, 0, -distance);
  ship.mesh.quaternion.set(0, 0, 0, 1);
  return { traffic, ship };
}

test('a pirate in the launch window fires a missile', () => {
  // The player has had missiles since the beginning and the NPCs never did,
  // which made the one attack you have to *answer* rather than absorb a
  // one-way street.
  const { traffic, ship } = loadedPirate(501, 'pirate', 500);
  const launched = fireFrame(traffic, { x: 0, y: 0, z: 0 });
  assert.equal(launched.length, 1, 'no missile was launched');
  assert.equal(launched[0].entity, ship);
  assert.ok(launched[0].spec.damage > 0, 'the missile does no damage');
  assert.ok(launched[0].spec.turn > 0, 'the missile does not home');
  assert.ok(launched[0].spec.radius > 0, 'the missile cannot be shot down');
});

test('launching spends a missile from a small magazine', () => {
  const { traffic, ship } = loadedPirate(502, 'pirate', 500);
  const before = ship.missiles;
  assert.ok(before > 0, 'a pirate should carry at least one missile');
  fireFrame(traffic, { x: 0, y: 0, z: 0 });
  assert.equal(ship.missiles, before - 1, 'the magazine was not spent');
});

test('an empty magazine cannot fire again', () => {
  const { traffic, ship } = loadedPirate(503, 'pirate', 500);
  ship.missiles = 0;
  assert.equal(fireFrame(traffic, { x: 0, y: 0, z: 0 }).length, 0, 'fired with no missiles');
});

test('the cooldown stops a ship firing twice in a row', () => {
  // Without it a raider with two missiles empties both in two frames.
  const { traffic, ship } = loadedPirate(504, 'raider', 500);
  assert.equal(fireFrame(traffic, { x: 0, y: 0, z: 0 }).length, 1);
  assert.equal(fireFrame(traffic, { x: 0, y: 0, z: 0 }).length, 0,
    'a second missile went out on the next frame');
  assert.ok(ship.missileCooldown > 5, 'the cooldown is too short to matter');
});

test('a missile is not launched from point blank', () => {
  // At knife range the missile is a formality, and the player has no room to
  // evade it. That is what the gun is for.
  const { traffic } = loadedPirate(505, 'pirate', 120);
  assert.equal(fireFrame(traffic, { x: 0, y: 0, z: 0 }).length, 0,
    'a missile was launched at point blank range');
});

test('a missile is not launched from across the system', () => {
  const { traffic } = loadedPirate(506, 'pirate', 1400);
  assert.equal(fireFrame(traffic, { x: 0, y: 0, z: 0 }).length, 0,
    'a missile was launched from outside its range');
});

test('a missile needs a lock, not just proximity', () => {
  // The nose has to be roughly on the target. A sloppier lock than the gun
  // needs, because a homing missile does not have to be pointed at anything -
  // but not no lock at all.
  const traffic = W.createTraffic(new THREE.Group(), home, 507);
  const ship = traffic.spawn('pirate');
  ship.state = 'engage';
  ship.missileCooldown = 0;
  ship.mesh.position.set(0, 0, -500);
  // Nose pointing ninety degrees away from the player.
  ship.mesh.quaternion.set(0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4));
  assert.equal(fireFrame(traffic, { x: 0, y: 0, z: 0 }).length, 0,
    'a missile was launched with no lock');
});

test('a ship that has broken off does not launch', () => {
  // Firing on the way out is not fleeing.
  const { traffic, ship } = loadedPirate(508, 'pirate', 500);
  ship.fleeing = true;
  assert.equal(fireFrame(traffic, { x: 0, y: 0, z: 0 }).length, 0,
    'a fleeing ship fired a missile');
});

test('traders never carry missiles', () => {
  // A hauler shooting back is a different game, and it would make the trade
  // lanes far more dangerous than the brief asks for.
  const traffic = W.createTraffic(new THREE.Group(), home, 509);
  const trader = traffic.spawn('trader');
  assert.equal(trader.missiles, 0, 'a trader is carrying missiles');
  trader.state = 'engage';
  trader.missileCooldown = 0;
  trader.mesh.position.set(0, 0, -500);
  trader.mesh.quaternion.set(0, 0, 0, 1);
  assert.equal(fireFrame(traffic, { x: 0, y: 0, z: 0 }).length, 0, 'a trader fired a missile');
});

test('raiders carry more than pirates', () => {
  const traffic = W.createTraffic(new THREE.Group(), home, 510);
  const raider = traffic.spawn('raider');
  const pirate = traffic.spawn('pirate');
  assert.ok(raider.missiles > pirate.missiles,
    'a raider carries ' + raider.missiles + ' and a pirate ' + pirate.missiles);
});

test('an enemy missile is weaker and less agile than the player\'s', () => {
  // The asymmetry is the design. A missile that turns as hard as yours and
  // hits as hard is not a threat you can answer, it is a coin flip.
  assert.ok(C.ENEMY_MISSILE_DAMAGE < C.MISSILE_DAMAGE, 'the enemy missile hits as hard as yours');
  assert.ok(C.ENEMY_MISSILE_TURN < C.MISSILE_TURN, 'the enemy missile turns as hard as yours');
  assert.ok(C.ENEMY_MISSILE_SPEED < C.MISSILE_SPEED, 'the enemy missile is as fast as yours');
});

test('a step without the missile hook does not crash', () => {
  // The e2e driver and several tests call `stepTraffic` with only the gun hook.
  const { traffic } = loadedPirate(511, 'pirate', 500);
  assert.doesNotThrow(() => W.stepTraffic(
    traffic, { vel: { x: 0, y: 0, z: 0 } }, { x: 0, y: 0, z: 0 }, 1 / 60, { onEnemyShot() {} },
  ));
});

// --- A cleanup contract's defended pocket ----------------------------------

/** How many ships in a system are willing to shoot at the commander. */
function hostilesOf(traffic) {
  return traffic.ships.filter((s) => s.kind === 'pirate' || s.kind === 'raider').length;
}

/** The calmest system in the galaxy - the worst case for a cleanup contract. */
function calmestSystem() {
  let best = null;
  for (const s of galaxy.systems) {
    const t = W.createTraffic(new THREE.Group(), s, 90210);
    if (!best || t.danger < best.danger) best = { system: s, danger: t.danger };
  }
  return best.system;
}

test('a system with no contract is built exactly as it always was', () => {
  // The pocket is opt-in, and it must not perturb the spawn stream of a system
  // that has no contract: same kinds, same positions, bit for bit. `spawn`
  // consumes no extra randomness on the ordinary path, and this is what proves
  // it rather than asserting it in a comment.
  const a = W.createTraffic(new THREE.Group(), home, 606);
  const b = W.createTraffic(new THREE.Group(), home, 606, { bounty: 0 });
  a.topUp();
  b.topUp();
  assert.equal(a.pocket, 0);
  assert.equal(b.pocket, 0);
  assert.equal(a.ships.length, b.ships.length);
  for (let i = 0; i < a.ships.length; i += 1) {
    assert.equal(a.ships[i].kind, b.ships[i].kind, 'kind drifted at ' + i);
    assert.equal(a.ships[i].mesh.position.x.toFixed(6), b.ships[i].mesh.position.x.toFixed(6));
    assert.equal(a.ships[i].mesh.position.z.toFixed(6), b.ships[i].mesh.position.z.toFixed(6));
    assert.equal(a.ships[i].pocket, false, 'a ship was marked as pocket with no contract');
  }
});

test('a cleanup contract fills the sky with hostiles', () => {
  const plain = W.createTraffic(new THREE.Group(), home, 707);
  plain.topUp();
  const pocket = W.createTraffic(new THREE.Group(), home, 707, { bounty: 4 });
  pocket.topUp();
  assert.equal(pocket.pocket, 4);
  assert.ok(hostilesOf(pocket) >= 4,
    'the pocket did not guarantee four hostiles: ' + hostilesOf(pocket));
  assert.ok(hostilesOf(pocket) >= hostilesOf(plain),
    'taking a contract made the system *less* dangerous');
});

test('a calm lawful system cannot starve a cleanup contract', () => {
  // This is the whole point of the floor. A corporate system's spawn table
  // rolls mostly traders, so without it the commander would accept a job,
  // launch into an empty sky, and have to leave and come back.
  const system = calmestSystem();
  const plain = W.createTraffic(new THREE.Group(), system, 808);
  plain.topUp();
  const hired = W.createTraffic(new THREE.Group(), system, 808, { bounty: 4 });
  hired.topUp();
  assert.ok(hostilesOf(hired) >= 4,
    system.name + ' (danger ' + hired.danger.toFixed(2) + ') still starved the contract: '
    + hostilesOf(hired));
  assert.ok(hostilesOf(hired) > hostilesOf(plain),
    'the pocket did not add a single hostile to ' + system.name);
});

test('the pocket is waiting close, not scattered to the edge of the system', () => {
  // Measured: pocket ships spawn at 478..732 (mean 599), ordinary traffic at
  // 735..1098 (mean 918). The band has to be genuinely tighter, or "they are
  // waiting for you" is a comment rather than a behaviour.
  assert.ok(W.POCKET.spawnOuter < W.LAYOUT.spawnShellOuter,
    'the pocket shell is not tighter than ordinary traffic');
  const t = W.createTraffic(new THREE.Group(), home, 909, { bounty: 5 });
  t.topUp();
  const pocketShips = t.ships.filter((s) => s.pocket);
  assert.ok(pocketShips.length >= 5, 'only ' + pocketShips.length + ' pocket ships');
  for (const s of pocketShips) {
    const r = Math.hypot(s.mesh.position.x, s.mesh.position.y, s.mesh.position.z);
    assert.ok(r <= W.POCKET.spawnOuter + 1e-6,
      'a pocket ship spawned at ' + r.toFixed(1) + ', outside the pocket shell');
    // But never on top of the station: the commander has to be able to launch.
    assert.ok(r >= W.LAYOUT.spawnShellInner - 1e-6,
      'a pocket ship spawned at ' + r.toFixed(1) + ', practically on the pad');
  }
});

test('the pocket is bounded, so a huge contract is not a wall of ships', () => {
  const a = W.createTraffic(new THREE.Group(), home, 1010, { bounty: W.POCKET.maxExtra });
  const b = W.createTraffic(new THREE.Group(), home, 1010, { bounty: 999 });
  a.topUp();
  b.topUp();
  assert.equal(b.pocket, W.POCKET.maxExtra);
  assert.equal(a.ships.length, b.ships.length, 'the cap is not bounded by maxExtra');
  assert.equal(hostilesOf(a), hostilesOf(b));
});

test('taking a contract mid-visit fills the sky immediately', () => {
  // A cleanup contract names the system it was posted in, so there is no
  // arrival to hook: the pocket has to appear while the commander is docked,
  // or the job begins with an empty sky and the promise is not kept until the
  // restock timer comes round.
  const t = W.createTraffic(new THREE.Group(), home, 1212);
  t.topUp();
  assert.equal(t.pocket, 0);
  const before = t.ships.length;
  assert.equal(t.setPocket(3), 3);
  assert.ok(t.ships.length > before, 'not a single ship was added');
  assert.ok(hostilesOf(t) >= 3, 'the pocket is short: ' + hostilesOf(t));
});

test('the pocket keeps its floor while the contract is open', () => {
  const t = W.createTraffic(new THREE.Group(), home, 1313, { bounty: 4 });
  t.topUp();
  assert.equal(t.ships.filter((s) => s.pocket).length, 4,
    'the pocket did not fill to its own size');
  for (const s of t.ships) if (s.pocket) s.dead = true;
  t.prune();
  t.topUp();
  assert.ok(t.ships.filter((s) => s.pocket).length >= 4,
    'the pocket did not refill: ' + t.ships.filter((s) => s.pocket).length + ' left');
});

test('the pocket is its own ships, not the system\'s ordinary hostiles', () => {
  // Measured before this was fixed: counting every hostile meant a pocket of 4
  // in a danger-0 system produced 7, because the ordinary table's own pirate
  // ate into the floor and then stacked on top of it. The pocket must add its
  // own ships and leave the system's traffic alone.
  const plain = W.createTraffic(new THREE.Group(), home, 1616);
  plain.topUp();
  const hired = W.createTraffic(new THREE.Group(), home, 1616, { bounty: 4 });
  hired.topUp();
  assert.equal(hired.ships.filter((s) => s.pocket).length, 4);
  assert.equal(hired.ships.length, plain.ships.length + 4,
    'the pocket did not add exactly its own ships');
});

test('closing a contract lets the pocket go', () => {
  const t = W.createTraffic(new THREE.Group(), home, 1414, { bounty: 5 });
  t.topUp();
  assert.equal(t.pocket, 5);
  assert.ok(t.ships.some((s) => s.pocket), 'no pocket ships to begin with');
  for (const s of t.ships) if (s.pocket) s.dead = true;
  t.prune();
  assert.equal(t.setPocket(0), 0);
  t.topUp();
  assert.equal(t.ships.filter((s) => s.pocket).length, 0,
    'the pocket kept spawning after the contract closed');
});

test('the pocket is clamped, and a negative request is ignored', () => {
  const t = W.createTraffic(new THREE.Group(), home, 1515);
  assert.equal(t.setPocket(-3), 0);
  assert.equal(t.setPocket(2.6), 3, 'a fractional pocket should round');
  assert.equal(t.setPocket(1000), W.POCKET.maxExtra);
  assert.equal(t.pocket, W.POCKET.maxExtra);
});

test('the pocket is never bigger than the job it answers', () => {
  // The two constants live in different layers, so nothing but a test stops
  // them drifting. A pocket smaller than the largest contract would make the
  // biggest jobs take more than one visit for no stated reason; a much larger
  // one would turn a cleanup into a massacre.
  const largestJob = MIS.MISSION.bountyCount[1];
  assert.ok(W.POCKET.maxExtra <= largestJob,
    'the pocket holds ' + W.POCKET.maxExtra + ' but the board only ever asks for '
    + largestJob);
  // And the pocket tracks what is owed, up to that bound.
  for (const owed of [1, 3, largestJob, largestJob + 5]) {
    const t = W.createTraffic(new THREE.Group(), home, 1717, { bounty: owed });
    assert.equal(t.pocket, Math.min(owed, W.POCKET.maxExtra));
  }
});

// --- Replacing the fleet on a jump -----------------------------------------

test('disposing the traffic takes its ships out of the scene', () => {
  const scene = new THREE.Group();
  const t = W.createTraffic(scene, home, 1818, { bounty: 3 });
  t.topUp();
  assert.ok(scene.children.length > 0, 'nothing was added to the scene');
  t.dispose();
  assert.equal(scene.children.length, 0,
    'the scene still holds ' + scene.children.length + ' ships');
  assert.equal(t.ships.length, 0);
});

test('a new system does not inherit the previous fleet', () => {
  // Measured before the fix: 104 frozen ships in the scene after twelve jumps,
  // while the current system had ten. They sat exactly where traffic belongs,
  // so they read as ships that had stopped moving rather than as a leak.
  const scene = new THREE.Group();
  const first = W.createTraffic(scene, home, 1919);
  first.topUp();
  assert.ok(scene.children.length > 0);
  first.dispose();
  const second = W.createTraffic(scene, home, 1919);
  second.topUp();
  assert.equal(scene.children.length, second.ships.length,
    'the scene holds ' + scene.children.length + ' objects for '
    + second.ships.length + ' ships');
});

// --- The gun's range -------------------------------------------------------

test('the gun has a range, and it is the one combat declares', () => {
  // The 620 used to be a bare literal inside the firing condition. It is now
  // `C.FIRE_RANGE`, and this pins the behaviour to the constant: nothing is
  // fired from beyond it, and something is fired from inside it. Without the
  // second half the test would pass on a gun that never fires at all.
  const shootAt = (distance, seed) => {
    const traffic = W.createTraffic(new THREE.Group(), home, seed);
    const ship = traffic.spawn('pirate');
    ship.state = 'engage';
    ship.aggression = 1;
    ship.canFire = 0;
    ship.missiles = 0;
    // Dead ahead, nose at the commander.
    ship.mesh.position.set(0, 0, -distance);
    ship.mesh.quaternion.set(0, 0, 0, 1);
    let shots = 0;
    W.stepTraffic(traffic, { vel: { x: 0, y: 0, z: 0 } }, { x: 0, y: 0, z: 0 }, 1 / 60,
      { onEnemyShot() { shots += 1; }, onEnemyMissile() {} });
    return shots;
  };
  assert.equal(shootAt(C.FIRE_RANGE + 40, 1601), 0,
    'a pirate fired from beyond the range combat declares');
  assert.ok(shootAt(C.FIRE_RANGE - 40, 1602) > 0,
    'a pirate inside the range did not fire');
});

// --- The AI must be reproducible -------------------------------------------

test('the traffic simulation is reproducible', () => {
  // Everything random in `stepTraffic` used `Math.random()`, which breaks the
  // rule `rng.js` states at the top of the file - never use it for anything the
  // player can observe twice - and made the AI unreproducible.
  //
  // The visible symptom was a *flaky test*: the engine-flame test measures the
  // nose swinging, and a patrolling ship picks a random waypoint whenever its
  // wander timer expires. It passed five times in isolation and failed once in
  // a full run, which is the worst kind of test - one that teaches you to
  // re-run instead of to read.
  const run = () => {
    const traffic = W.createTraffic(new THREE.Group(), home, 31);
    const ship = traffic.spawn('pirate');
    for (let i = 0; i < 300; i += 1) {
      W.stepTraffic(traffic, { vel: { x: 0, y: 0, z: 0 } }, { x: 0, y: 0, z: 40000 },
        1 / 60, { onEnemyShot() {} });
    }
    return {
      x: ship.mesh.position.x, y: ship.mesh.position.y, z: ship.mesh.position.z,
    };
  };
  assert.deepStrictEqual(run(), run(), 'two identical runs of the same traffic diverged');
});

test('nothing in the traffic simulation reaches for Math.random', () => {
  // A throwing stub is the only way to be sure. A stray call would otherwise
  // just make the run irreproducible without failing anything, which is how
  // this survived so long.
  //
  // The stub goes on *after* the scene is built: three.js calls Math.random()
  // in `generateUUID` for every new Object3D, so a global stub would fail
  // inside three rather than inside the AI.
  const traffic = W.createTraffic(new THREE.Group(), home, 31);
  traffic.spawn('pirate');
  const real = Math.random;
  Math.random = () => { throw new Error('Math.random reached the simulation'); };
  try {
    for (let i = 0; i < 120; i += 1) {
      W.stepTraffic(traffic, { vel: { x: 0, y: 0, z: 0 } }, { x: 0, y: 0, z: 40000 },
        1 / 60, { onEnemyShot() {} });
    }
  } finally {
    Math.random = real;
  }
});
