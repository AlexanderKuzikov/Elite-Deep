/**
 * Space dust.
 *
 * The whole reason this module exists is that speed is invisible in open
 * space: the stars never move, so a ship at ninety units a second looks
 * exactly like a ship standing still. The dust is what makes motion legible,
 * and the one rule that makes it work is that the cloud has to stay centred on
 * the ship - motes that fall out of the shell are recycled to the far side.
 *
 * That rule is arithmetic, so it is tested as arithmetic. The Three.js half is
 * a thin wrapper and gets a smoke test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { DUST, needsRecycling, recyclePoint, createDust } from '../src/sim/dust.js';

const FORWARD = { x: 0, y: 0, z: 1 };
/** A deterministic stand-in for `Math.random`, so placement is reproducible. */
function counter(seed) {
  let s = seed || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// --- The recycling rule ----------------------------------------------------

test('a mote inside the shell is left alone', () => {
  const mid = (DUST.innerRadius + DUST.outerRadius) / 2;
  assert.equal(needsRecycling(mid, 0, 0, DUST.outerRadius, DUST.innerRadius), false);
  assert.equal(needsRecycling(0, mid, 0, DUST.outerRadius, DUST.innerRadius), false);
  assert.equal(needsRecycling(0, 0, -mid, DUST.outerRadius, DUST.innerRadius), false);
});

test('a mote beyond the outer radius is recycled', () => {
  const out = DUST.outerRadius + 5;
  assert.equal(needsRecycling(out, 0, 0, DUST.outerRadius, DUST.innerRadius), true);
  assert.equal(needsRecycling(0, out, 0, DUST.outerRadius, DUST.innerRadius), true);
});

test('a mote closer than the inner radius is recycled too', () => {
  // Without a floor a mote can sit a metre from the lens, where it reads as a
  // smudge on the canopy rather than as dust. That was the whole failure of
  // the engine exhaust this replaced.
  assert.equal(needsRecycling(1, 0, 0, DUST.outerRadius, DUST.innerRadius), true);
  assert.equal(needsRecycling(0, 0, 0.5, DUST.outerRadius, DUST.innerRadius), true);
  assert.ok(DUST.innerRadius > 5, 'the inner radius is too small to stop looming');
});

test('the rule is symmetric in all three axes', () => {
  const out = DUST.outerRadius + 1;
  for (const v of [[out, 0, 0], [0, out, 0], [0, 0, out], [0, 0, -out]]) {
    assert.equal(needsRecycling(v[0], v[1], v[2], DUST.outerRadius, DUST.innerRadius), true,
      'asymmetric at ' + v.join(','));
  }
});

// --- Where a recycled mote lands -------------------------------------------

test('a recycled mote lands on the shell, never inside or outside it', () => {
  const rand = counter(7);
  const ship = { x: 100, y: -50, z: 900 };
  for (let i = 0; i < 500; i += 1) {
    const p = recyclePoint(ship, FORWARD, rand);
    const d = Math.hypot(p.x - ship.x, p.y - ship.y, p.z - ship.z);
    assert.ok(d >= DUST.innerRadius - 1e-6, 'a mote landed inside the floor: ' + d);
    assert.ok(d <= DUST.outerRadius + 1e-6, 'a mote landed beyond the shell: ' + d);
  }
});

test('a recycled mote is placed relative to the ship, not the origin', () => {
  // The cloud follows the ship. A mote placed in world coordinates rather than
  // offset from the ship would leave the cloud behind the moment it moved.
  const rand = counter(11);
  const ship = { x: 5000, y: -2000, z: 3000 };
  for (let i = 0; i < 200; i += 1) {
    const p = recyclePoint(ship, FORWARD, rand);
    assert.ok(Math.hypot(p.x, p.y, p.z) > 1000,
      'a mote was placed near the origin instead of near the ship');
  }
});

test('recycled motes are biased ahead of the ship', () => {
  // A mote respawned directly behind could be recycled again on the very next
  // frame, which wastes the work and makes the cloud flicker.
  const rand = counter(3);
  const ship = { x: 0, y: 0, z: 0 };
  let ahead = 0;
  const N = 2000;
  for (let i = 0; i < N; i += 1) {
    const p = recyclePoint(ship, FORWARD, rand);
    if (p.z > 0) ahead += 1;
  }
  assert.ok(ahead / N > 0.7,
    'only ' + ((ahead / N) * 100).toFixed(0) + '% of motes landed ahead of the ship');
});

test('the bias follows the direction of travel', () => {
  // Turn the ship and the cloud turns with it, or dust would stream in from
  // the side while flying straight.
  const rand = counter(5);
  const ship = { x: 0, y: 0, z: 0 };
  const sideways = { x: 1, y: 0, z: 0 };
  let ahead = 0;
  const N = 2000;
  for (let i = 0; i < N; i += 1) {
    if (recyclePoint(ship, sideways, rand).x > 0) ahead += 1;
  }
  assert.ok(ahead / N > 0.7, 'the bias did not follow the nose');
});

test('the bias is a bias, not a cone', () => {
  // If every mote landed dead ahead the cloud would be a beam, and looking to
  // one side would show nothing at all. Measured: 2.8 % land behind the ship
  // and the mean perpendicular component is 0.70, so the cloud genuinely
  // surrounds the ship rather than sitting in front of it.
  const rand = counter(9);
  const ship = { x: 0, y: 0, z: 0 };
  let behind = 0;
  let perp = 0;
  const N = 6000;
  for (let i = 0; i < N; i += 1) {
    const p = recyclePoint(ship, FORWARD, rand);
    const len = Math.hypot(p.x, p.y, p.z) || 1;
    if (p.z / len < 0) behind += 1;
    perp += Math.hypot(p.x, p.y) / len;
  }
  assert.ok(behind > N * 0.01,
    'nothing meaningful lands behind the ship: ' + (behind / N * 100).toFixed(2) + '%');
  assert.ok(perp / N > 0.4,
    'the cloud is a cone, not a cloud: mean perpendicular ' + (perp / N).toFixed(2));
});

// --- The cloud -------------------------------------------------------------

test('the cloud is built with the configured number of motes', () => {
  const scene = new THREE.Group();
  const dust = createDust(scene);
  assert.equal(dust.points.geometry.attributes.position.count, DUST.count);
  assert.equal(scene.children.includes(dust.points), true, 'the cloud was not added to the scene');
});

test('the dust is dim, depth-write-free and never culled', () => {
  // Dim, because it is a background cue and not an effect; no depth write,
  // because it must not occlude anything; never culled, because its bounding
  // sphere says nothing about where the motes are.
  const dust = createDust(new THREE.Group());
  assert.equal(dust.material.depthWrite, false, 'the dust writes depth');
  assert.ok(dust.material.opacity <= 0.6, 'the dust is too bright: ' + dust.material.opacity);
  assert.equal(dust.points.frustumCulled, false, 'the dust would be culled');
  assert.ok(dust.material.size < 1, 'a mote is large enough to loom: ' + dust.material.size);
});

test('a mote that drifts out of the shell comes back', () => {
  const scene = new THREE.Group();
  const dust = createDust(scene);
  const positions = dust.geometry.attributes.position.array;

  // Put every mote far outside the shell.
  const far = DUST.outerRadius * 4;
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = far;
    positions[i + 1] = far;
    positions[i + 2] = far;
  }
  const flight = { pos: { x: 0, y: 0, z: 0 }, quat: { x: 0, y: 0, z: 0, w: 1 } };
  const moved = dust.step(flight);

  assert.equal(moved, DUST.count, 'not every stranded mote was recycled');
  for (let i = 0; i < positions.length; i += 3) {
    const d = Math.hypot(positions[i], positions[i + 1], positions[i + 2]);
    assert.ok(d <= DUST.outerRadius + 1e-6, 'a mote is still outside the shell: ' + d);
  }
});

test('a mote that is already in place is not touched', () => {
  // Recycling is work. Doing it to motes that are fine would churn the buffer
  // every frame and make the dust crawl.
  const dust = createDust(new THREE.Group());
  const positions = dust.geometry.attributes.position.array;
  const snapshot = Float32Array.from(positions);
  const flight = { pos: { x: 0, y: 0, z: 0 }, quat: { x: 0, y: 0, z: 0, w: 1 } };

  const moved = dust.step(flight);
  assert.equal(moved, 0, 'a settled cloud was recycled anyway');
  for (let i = 0; i < positions.length; i += 1) {
    assert.equal(positions[i], snapshot[i], 'a settled mote moved');
  }
});

test('the cloud follows the ship rather than staying where it was built', () => {
  // The property the whole effect rests on: fly somewhere and the dust is
  // still around you.
  const dust = createDust(new THREE.Group());
  const positions = dust.geometry.attributes.position.array;
  const flight = { pos: { x: 0, y: 0, z: 0 }, quat: { x: 0, y: 0, z: 0, w: 1 } };

  // Fly a long way, recycling every step, as the game does.
  for (let step = 0; step < 400; step += 1) {
    flight.pos.z += 30;
    dust.step(flight);
  }
  let nearby = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const d = Math.hypot(positions[i] - flight.pos.x, positions[i + 1] - flight.pos.y,
      positions[i + 2] - flight.pos.z);
    if (d <= DUST.outerRadius + 1e-6) nearby += 1;
  }
  assert.equal(nearby, DUST.count, 'the cloud was left behind');
});

test('stepping without a flight is a no-op rather than a crash', () => {
  const dust = createDust(new THREE.Group());
  assert.equal(dust.step(null), 0);
  assert.equal(dust.step(undefined), 0);
});

test('createDust tolerates a scene that cannot accept children', () => {
  // The stranded renderer has no scene at all.
  assert.doesNotThrow(() => createDust(null));
  assert.doesNotThrow(() => createDust({}));
});

test('dispose removes the cloud and frees its resources', () => {
  const scene = new THREE.Group();
  const dust = createDust(scene);
  let geometryFreed = false;
  let materialFreed = false;
  dust.geometry.addEventListener('dispose', () => { geometryFreed = true; });
  dust.material.addEventListener('dispose', () => { materialFreed = true; });

  dust.dispose();

  assert.equal(scene.children.includes(dust.points), false, 'the cloud is still in the scene');
  assert.equal(geometryFreed, true, 'the geometry was not freed');
  assert.equal(materialFreed, true, 'the material was not freed');
});

test('the default export mirrors the named ones', () => {
  assert.equal(typeof createDust, 'function');
  assert.equal(typeof needsRecycling, 'function');
  assert.equal(typeof recyclePoint, 'function');
  assert.ok(DUST.count > 50, 'a cloud this small would read as specks, not as dust');
});
