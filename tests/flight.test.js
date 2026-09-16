/**
 * Flight model tests.
 *
 * Two classes of thing are worth testing here:
 *
 *   1. Frame conventions. A drifting quaternion or an inverted nose shows up
 *      as "ships fly sideways" at runtime and is almost impossible to debug
 *      from a screenshot, so the basis vectors are pinned exactly.
 *   2. Feel, expressed as inequalities. "The stick ramps in, snaps out",
 *      "turning at speed slides", "you cannot stop instantly" - each of those
 *      is a claim about the model that a future tweak could silently break.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../src/sim/flight.js';

/** Run n frames of the same input, so decay/ramp behaviour can be observed. */
function hold(f, input, seconds, step) {
  const dt = step || 1 / 60;
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i += 1) F.applyInput(f, input, dt);
  return f;
}

function angleBetweenVectors(a, b) {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z;
  const la = Math.hypot(a.x, a.y, a.z);
  const lb = Math.hypot(b.x, b.y, b.z);
  return Math.acos(Math.max(-1, Math.min(1, dot / (la * lb))));
}

const NEUTRAL = { pitch: 0, roll: 0, yaw: 0, throttle: 0, braking: false, boost: false };

test('a fresh ship faces along +Z and has a unit quaternion', () => {
  const f = F.createFlight();
  const fwd = F.forwardOf(f);
  assert.ok(Math.abs(fwd.x) < 1e-9);
  assert.ok(Math.abs(fwd.y) < 1e-9);
  assert.ok(Math.abs(fwd.z - 1) < 1e-9, 'nose must point +Z, got z=' + fwd.z);
  const len = Math.hypot(f.quat.x, f.quat.y, f.quat.z, f.quat.w);
  assert.ok(Math.abs(len - 1) < 1e-9, 'quaternion not normalised: ' + len);
});

test('the basis vectors are orthonormal and right-handed', () => {
  const f = F.createFlight();
  // Rotate it somewhere awkward first, so this is not just testing identity.
  hold(f, { pitch: 0.4, roll: -0.7, yaw: 0.25, throttle: 0 }, 1.1);
  const fwd = F.forwardOf(f), up = F.upOf(f), right = F.rightOf(f);

  for (const [name, v] of [['forward', fwd], ['up', up], ['right', right]]) {
    const l = Math.hypot(v.x, v.y, v.z);
    assert.ok(Math.abs(l - 1) < 1e-6, name + ' is not unit length: ' + l);
  }
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  assert.ok(Math.abs(dot(fwd, up)) < 1e-6, 'forward and up are not perpendicular');
  assert.ok(Math.abs(dot(fwd, right)) < 1e-6, 'forward and right are not perpendicular');
  assert.ok(Math.abs(dot(up, right)) < 1e-6, 'up and right are not perpendicular');

  // right x up should equal forward in a right-handed basis under our
  // convention, where the ship looks down its own +Z.
  const cx = right.y * up.z - right.z * up.y;
  const cy = right.z * up.x - right.x * up.z;
  const cz = right.x * up.y - right.y * up.x;
  assert.ok(Math.abs(cx - fwd.x) < 1e-6);
  assert.ok(Math.abs(cy - fwd.y) < 1e-6);
  assert.ok(Math.abs(cz - fwd.z) < 1e-6, 'basis is left-handed');
});

test('the quaternion never drifts away from unit length', () => {
  const f = F.createFlight();
  // Hammer it with the worst possible input: full deflection on every axis
  // with a wildly varying timestep.
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 4000; i += 1) {
    F.applyInput(f, {
      pitch: rnd() * 2 - 1, roll: rnd() * 2 - 1, yaw: rnd() * 2 - 1,
      throttle: rnd() * 2 - 1, boost: rnd() > 0.5,
    }, 0.001 + rnd() * 0.05);
    const len = Math.hypot(f.quat.x, f.quat.y, f.quat.z, f.quat.w);
    assert.ok(Math.abs(len - 1) < 1e-6, 'drifted to ' + len + ' at frame ' + i);
  }
});

test('pitch alone rotates the nose toward the ship up axis', () => {
  const f = F.createFlight();
  const before = F.upOf(f);
  hold(f, { ...NEUTRAL, pitch: 1 }, 0.6);
  const after = F.forwardOf(f);
  // Pitching up must move the nose toward the original up vector.
  const dot = after.x * before.x + after.y * before.y + after.z * before.z;
  assert.ok(dot > 0.2, 'pitch did not raise the nose, dot=' + dot);
  // And it must stay in the plane, i.e. not introduce roll.
  assert.ok(Math.abs(after.x) < 1e-6, 'pitch leaked into x: ' + after.x);
});

test('positive pitch raises the nose and negative lowers it', () => {
  const up = F.createFlight();
  hold(up, { ...NEUTRAL, pitch: 1 }, 0.5);
  const down = F.createFlight();
  hold(down, { ...NEUTRAL, pitch: -1 }, 0.5);
  assert.ok(F.forwardOf(up).y > 0.1, 'positive pitch should climb');
  assert.ok(F.forwardOf(down).y < -0.1, 'negative pitch should dive');
});

test('positive roll banks to starboard and does not move the nose', () => {
  const f = F.createFlight();
  hold(f, { ...NEUTRAL, roll: 1 }, 0.5);
  const fwd = F.forwardOf(f);
  assert.ok(Math.abs(fwd.z - 1) < 1e-6, 'roll moved the nose: ' + JSON.stringify(fwd));

  const up = F.upOf(f);
  const right = F.rightOf(f);
  // Rolling starboard drops the right wing. The up vector therefore tips
  // toward the nose-right direction (+X), and the right vector acquires a
  // downward sense in world Y.
  assert.ok(up.x > 0.1, 'positive roll should tip up toward +X, got ' + up.x);
  assert.ok(right.y < -0.1, 'positive roll should drop the right wing, got ' + right.y);

  // The mirrored input must mirror exactly, and the basis must stay
  // right-handed while rolled: right x up still equals forward.
  const g = F.createFlight();
  hold(g, { ...NEUTRAL, roll: -1 }, 0.5);
  assert.ok(F.upOf(g).x < -0.1, 'negative roll should tip up toward -X');
  assert.ok(F.rightOf(g).y > 0.1, 'negative roll should raise the right wing');
  const rx = right.y * up.z - right.z * up.y;
  const ry = right.z * up.x - right.x * up.z;
  const rz = right.x * up.y - right.y * up.x;
  assert.ok(Math.abs(rx - fwd.x) < 1e-6 && Math.abs(ry - fwd.y) < 1e-6 && Math.abs(rz - fwd.z) < 1e-6,
    'the basis went left-handed while rolled');
});

test('yaw is weaker than pitch, and weaker than roll', () => {
  // This is a design claim, not an accident: yaw that matches pitch removes
  // all reason to bank, and the whole point of the model is to make banking
  // the natural way to turn.
  assert.ok(F.RATES.yaw < F.RATES.pitch, 'yaw should be slower than pitch');
  assert.ok(F.RATES.pitch < F.RATES.roll, 'roll should be the fastest axis');
});

test('the stick ramps in gradually and returns to centre faster', () => {
  const f = F.createFlight();
  F.applyInput(f, { ...NEUTRAL, pitch: 1 }, 1 / 60);
  const afterOneFrame = f.stick.pitch;
  assert.ok(afterOneFrame > 0, 'stick did not move at all');
  assert.ok(afterOneFrame < 0.5, 'stick snapped to full in one frame: ' + afterOneFrame);

  hold(f, { ...NEUTRAL, pitch: 1 }, 2);
  assert.ok(Math.abs(f.stick.pitch - 1) < 1e-6, 'stick never reached full deflection');

  // Now release: centring should be quicker than the ramp-in of a single
  // frame's worth of the same duration.
  F.applyInput(f, NEUTRAL, 0.1);
  assert.ok(f.stick.pitch < 0.7, 'stick did not return quickly, at ' + f.stick.pitch);
});

test('throttle is a delta, clamped to 0..1', () => {
  const f = F.createFlight();
  hold(f, { ...NEUTRAL, throttle: 1 }, 10);
  assert.equal(f.throttle, 1, 'throttle should saturate at 1');
  hold(f, { ...NEUTRAL, throttle: -1 }, 10);
  assert.equal(f.throttle, 0, 'throttle should floor at 0');
});

test('speed rises and falls with throttle', () => {
  const slow = F.createFlight();
  slow.throttle = 0;
  hold(slow, { ...NEUTRAL, throttle: -1 }, 3);
  const fast = F.createFlight();
  fast.throttle = 1;
  hold(fast, { ...NEUTRAL, throttle: 1 }, 3);
  assert.ok(F.speedOf(fast) > F.speedOf(slow) * 3,
    'throttle did not affect speed: ' + F.speedOf(slow) + ' vs ' + F.speedOf(fast));
  assert.ok(F.speedOf(fast) <= F.THROTTLE.maxSpeed * 1.05,
    'speed exceeded the ceiling: ' + F.speedOf(fast));
});

test('the ship never comes to a complete stop without braking', () => {
  // Elite's ships always drift forward; a full stop would make the "flying"
  // part optional and turn the game into a turret sim.
  const f = F.createFlight();
  hold(f, { ...NEUTRAL, throttle: -1 }, 20);
  assert.ok(F.speedOf(f) >= F.THROTTLE.minSpeed * 0.9,
    'ship stopped dead at ' + F.speedOf(f));
});

test('braking does stop the ship', () => {
  const f = F.createFlight();
  hold(f, { ...NEUTRAL, throttle: 1 }, 2);
  assert.ok(F.speedOf(f) > 100);
  hold(f, { ...NEUTRAL, braking: true }, 5);
  assert.ok(F.speedOf(f) <= F.THROTTLE.minSpeed * 1.1,
    'brake failed to stop the ship: ' + F.speedOf(f));
});

test('velocity lags the nose, so hard turns slide', () => {
  // The one non-Newtonian concession in the other direction: the hull has
  // inertia, so a sustained hard turn produces a visible sideways drift. A
  // single frame is too short to see it - the nose has barely moved and grip
  // snaps velocity straight back - so this measures a real half-second turn.
  const f = F.createFlight();
  hold(f, { ...NEUTRAL, throttle: 1 }, 3);
  const before = { ...f.vel };
  hold(f, { ...NEUTRAL, throttle: 0, pitch: 1 }, 0.5);
  const after = { ...f.vel };
  const moved = Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z);
  assert.ok(moved > 1, 'velocity did not respond to turning at all');

  const fwd = F.forwardOf(f);
  const sp = F.speedOf(f);
  const alignment = (after.x * fwd.x + after.y * fwd.y + after.z * fwd.z) / sp;
  const slipDegrees = Math.acos(Math.max(-1, Math.min(1, alignment))) * 180 / Math.PI;
  assert.ok(slipDegrees > 8,
    'hard turn should visibly slide, got only ' + slipDegrees.toFixed(1) + ' degrees');
  assert.ok(slipDegrees < 45,
    'the ship slid out of control: ' + slipDegrees.toFixed(1) + ' degrees');
});

test('a gentle turn barely slides', () => {
  // The counterpart to the test above: slide must be a consequence of *hard*
  // manoeuvring, not a constant wobble that makes aiming feel mushy.
  const f = F.createFlight();
  hold(f, { ...NEUTRAL, throttle: 1 }, 3);
  hold(f, { ...NEUTRAL, throttle: 0, pitch: 0.25 }, 0.5);
  const fwd = F.forwardOf(f);
  const sp = F.speedOf(f);
  const alignment = (f.vel.x * fwd.x + f.vel.y * fwd.y + f.vel.z * fwd.z) / sp;
  const slipDegrees = Math.acos(Math.max(-1, Math.min(1, alignment))) * 180 / Math.PI;
  assert.ok(slipDegrees < 8, 'a light touch slid too much: ' + slipDegrees.toFixed(1) + ' degrees');
});

test('boosting raises the top speed above the normal ceiling', () => {
  const normal = F.createFlight();
  hold(normal, { ...NEUTRAL, throttle: 1 }, 6);
  const boosted = F.createFlight();
  hold(boosted, { ...NEUTRAL, throttle: 1, boost: true }, 6);
  assert.ok(F.speedOf(boosted) > F.speedOf(normal) * 1.2,
    'boost did nothing: ' + F.speedOf(normal) + ' -> ' + F.speedOf(boosted));
});

test('integrate moves the ship along its velocity', () => {
  const f = F.createFlight();
  f.vel = { x: 10, y: 0, z: -20 };
  F.integrate(f, 0.5);
  assert.equal(f.pos.x, 5);
  assert.equal(f.pos.y, 0);
  assert.equal(f.pos.z, -10);
});

test('a locked ship ignores input but still coasts', () => {
  const f = F.createFlight();
  hold(f, { ...NEUTRAL, throttle: 1 }, 2);
  const speedBefore = F.speedOf(f);
  const headingBefore = F.forwardOf(f);
  f.locked = true;
  const posBefore = { ...f.pos };
  hold(f, { ...NEUTRAL, pitch: 1, roll: 1, throttle: 1 }, 0.5);
  const headingAfter = F.forwardOf(f);
  assert.ok(angleBetweenVectors(headingBefore, headingAfter) < 1e-6,
    'a locked ship turned');
  assert.ok(F.speedOf(f) > 0, 'a locked ship stopped moving');
  F.integrate(f, 0.5);
  assert.ok(Math.hypot(f.pos.x - posBefore.x, f.pos.y - posBefore.y, f.pos.z - posBefore.z) > 0,
    'a locked ship stopped travelling');
  assert.ok(Math.abs(F.speedOf(f) - speedBefore) < speedBefore * 0.6);
});

test('faceToward points the nose at the requested direction', () => {
  for (const dir of [
    { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0.3, y: -0.8, z: 0.5 },
  ]) {
    const f = F.createFlight();
    F.faceToward(f, dir);
    const fwd = F.forwardOf(f);
    const a = angleBetweenVectors(fwd, dir);
    assert.ok(a < 1e-6, 'faceToward missed by ' + a + ' rad for ' + JSON.stringify(dir));
  }
});

test('faceToward survives a straight-up direction without producing NaN', () => {
  // The degenerate case: the requested direction is parallel to the world up
  // axis, so the "up cross forward" reference collapses. A naive implementation
  // divides by zero here and the ship disappears.
  const f = F.createFlight();
  F.faceToward(f, { x: 0, y: 1, z: 0 });
  const fwd = F.forwardOf(f);
  assert.ok(Number.isFinite(fwd.x) && Number.isFinite(fwd.y) && Number.isFinite(fwd.z));
  assert.ok(Math.abs(fwd.y - 1) < 1e-6, 'did not point straight up: ' + JSON.stringify(fwd));
});

test('shake is additive and clamps', () => {
  const f = F.createFlight();
  F.addShake(f, 0.4);
  assert.ok(Math.abs(f.shake - 0.4) < 1e-9);
  F.addShake(f, 0.4);
  assert.ok(f.shake > 0.4, 'shake should accumulate');
  F.addShake(f, 5);
  assert.equal(f.shake, 1, 'shake must clamp to 1');
});

test('shake decays to zero within about half a second', () => {
  const f = F.createFlight();
  F.addShake(f, 1);
  hold(f, NEUTRAL, 0.6);
  assert.equal(f.shake, 0, 'shake did not decay: ' + f.shake);
});

test('reset returns the ship to its starting attitude', () => {
  const f = F.createFlight();
  hold(f, { ...NEUTRAL, pitch: 1, roll: 1, yaw: 1, throttle: 1 }, 2);
  F.addShake(f, 1);
  F.reset(f);
  const fwd = F.forwardOf(f);
  assert.ok(Math.abs(fwd.z - 1) < 1e-9);
  assert.equal(f.shake, 0);
  assert.equal(f.throttle, F.THROTTLE.cruise);
  assert.equal(F.speedOf(f), 0);
});

test('the frame is stable at a long timestep', () => {
  // A stalled tab can hand us a huge dt. If the integrator is unstable the
  // ship explodes; this pins that it merely moves a lot.
  const f = F.createFlight();
  for (let i = 0; i < 60; i += 1) {
    F.applyInput(f, { ...NEUTRAL, pitch: 1, roll: 0.6, throttle: 1 }, 0.25);
    assert.ok(Math.abs(f.quat.w) <= 1 && Number.isFinite(f.quat.w));
    assert.ok(Number.isFinite(f.pos.x) && Number.isFinite(f.pos.y));
  }
  const len = Math.hypot(f.quat.x, f.quat.y, f.quat.z, f.quat.w);
  assert.ok(Math.abs(len - 1) < 1e-6);
});
