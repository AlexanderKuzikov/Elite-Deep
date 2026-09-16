/**
 * Space dust: the cue that tells you how fast you are going.
 *
 * The original Elite had this, and it is the cheapest possible answer to a
 * problem this game has without it. The stars are effectively at infinity and
 * never move, so a ship at ninety units a second and a ship standing still
 * look *identical* in open space. Near the belt the rocks give the eye
 * something to judge against; anywhere else there is nothing at all.
 *
 * ## How it works
 *
 * A cloud of motes surrounds the ship and does not move. The ship flies
 * through it, so the motes streak past with real parallax - the near ones
 * fast, the far ones slow - which is the depth cue the eye actually uses.
 * Motes that fall outside the shell are recycled to the far side, so the cloud
 * is always centred on wherever the ship happens to be.
 *
 * ## Why this is not the engine exhaust that was removed
 *
 * That was world geometry a metre from the lens, spawned behind the ship and
 * left there, which covered 55-97 % of the frame with an additive wash. This
 * is small, dim, spread through the volume the ship is flying *through*, and
 * deliberately kept out of a minimum radius so nothing looms.
 *
 * ## Why the recycling is a pure function
 *
 * `recyclePoint` and `needsRecycling` take plain numbers and return plain
 * numbers, so the rule that keeps the cloud around the ship can be tested
 * without a GPU. The Three.js half below is a thin wrapper over them.
 */
import * as THREE from 'three';
import { makeGlowTexture } from './sky.js';

export const DUST = {
  count: 170,
  /** Motes further out than this are recycled to the far side. */
  outerRadius: 60,
  /**
   * And motes closer than this. Without a floor, a mote can sit a metre from
   * the lens and read as a smudge on the canopy rather than as dust.
   */
  innerRadius: 14,
  size: 0.42,
  colour: 0x9fb4c8,
  opacity: 0.5,
  /** How far ahead of the ship a recycled mote reappears, as a fraction. */
  forwardBias: 0.9,
};

/** Should this mote be moved? Too far, or too close. */
export function needsRecycling(dx, dy, dz, outer, inner) {
  const d2 = dx * dx + dy * dy + dz * dz;
  return d2 > outer * outer || d2 < inner * inner;
}

/**
 * Where a recycled mote goes: on the shell around the ship, biased into the
 * hemisphere it is heading toward.
 *
 * The bias matters. A mote respawned uniformly could reappear directly behind
 * the ship and be recycled again on the next frame, which wastes the draw and
 * makes the cloud flicker. Putting most of them ahead means they have a full
 * traverse to make before they come round again.
 */
export function recyclePoint(shipPos, forward, rand, dust) {
  const d = dust || DUST;
  // A random direction, nudged toward the direction of travel.
  let rx = rand() * 2 - 1;
  let ry = rand() * 2 - 1;
  let rz = rand() * 2 - 1;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;

  let x = forward.x * d.forwardBias + rx;
  let y = forward.y * d.forwardBias + ry;
  let z = forward.z * d.forwardBias + rz;
  const len = Math.hypot(x, y, z) || 1;
  x /= len; y /= len; z /= len;

  const radius = d.innerRadius + rand() * (d.outerRadius - d.innerRadius);
  return {
    x: shipPos.x + x * radius,
    y: shipPos.y + y * radius,
    z: shipPos.z + z * radius,
  };
}

/**
 * Build the cloud and attach it to the scene.
 *
 * `scene` may be anything with `add`; the stub renderer has no scene at all,
 * and `createDust` tolerates that by returning an inert handle.
 */
export function createDust(scene, opts) {
  const d = Object.assign({}, DUST, opts || {});
  const positions = new Float32Array(d.count * 3);
  const rand = () => Math.random();

  // Seeded around the origin, which is where the ship starts in every system.
  for (let i = 0; i < d.count; i += 1) {
    const p = recyclePoint({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, rand, d);
    positions[i * 3] = p.x;
    positions[i * 3 + 1] = p.y;
    positions[i * 3 + 2] = p.z;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.userData = { shared: false };

  const glow = makeGlowTexture(16, 2.0);
  const material = new THREE.PointsMaterial({
    map: glow || null,
    color: d.colour,
    size: d.size,
    sizeAttenuation: true,
    transparent: true,
    opacity: d.opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });

  const points = new THREE.Points(geometry, material);
  points.name = 'space-dust';
  // The cloud is centred on the ship, so the base geometry's bounds say
  // nothing useful about where the motes are.
  points.frustumCulled = false;
  points.renderOrder = 2;
  points.userData.glowTexture = glow;
  if (scene && typeof scene.add === 'function') scene.add(points);

  const scratch = { x: 0, y: 0, z: 1 };

  /**
   * One frame: recycle whatever has fallen out of the shell, then hand the
   * buffer to the GPU.
   *
   * `forward` is the direction the ship is travelling. When it is standing
   * still there is nothing to recycle and nothing moves, which is correct -
   * stationary dust should look stationary.
   */
  function step(flight) {
    if (!flight) return 0;
    const ship = flight.pos;
    const q = flight.quat;
    // The ship's nose, which is the direction `integrate` drives it along.
    scratch.x = 2 * (q.x * q.z + q.w * q.y);
    scratch.y = 2 * (q.y * q.z - q.w * q.x);
    scratch.z = 1 - 2 * (q.x * q.x + q.y * q.y);

    let moved = 0;
    for (let i = 0; i < d.count; i += 1) {
      const o = i * 3;
      const dx = positions[o] - ship.x;
      const dy = positions[o + 1] - ship.y;
      const dz = positions[o + 2] - ship.z;
      if (!needsRecycling(dx, dy, dz, d.outerRadius, d.innerRadius)) continue;
      const p = recyclePoint(ship, scratch, rand, d);
      positions[o] = p.x;
      positions[o + 1] = p.y;
      positions[o + 2] = p.z;
      moved += 1;
    }
    if (moved) geometry.attributes.position.needsUpdate = true;
    return moved;
  }

  function dispose() {
    if (scene && typeof scene.remove === 'function') scene.remove(points);
    geometry.dispose();
    material.dispose();
    if (glow && typeof glow.dispose === 'function') glow.dispose();
  }

  return { points, geometry, material, step, dispose, config: d };
}

export default { DUST, needsRecycling, recyclePoint, createDust };
