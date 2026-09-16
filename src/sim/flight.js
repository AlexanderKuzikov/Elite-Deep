/**
 * Flight model.
 *
 * This is deliberately *not* Newtonian. The original Elite flew like an
 * aircraft with a space backdrop, and that is the feel worth preserving: you
 * point the nose and the ship goes there. Removing drag would make docking and
 * combat miserable, which is the opposite of the brief ("friendlier than 1984").
 *
 * The one concession to space is *linear* inertia: once you release the
 * throttle the hull keeps drifting and bleeds off slowly, so a full-stop takes
 * a moment and overshooting a station slot is a real risk. Rotation stays
 * critically damped because aiming must feel crisp.
 *
 * State lives in plain objects so it can be serialised and unit-tested without
 * a renderer. applyInput() is the only mutator; everything else is pure maths.
 */

/** Per-second rates. Tuned so a 180 degree turn takes well under two seconds. */
export const RATES = {
  pitch: 1.85,          // rad/s at full deflection
  roll: 2.60,           // roll is faster than pitch, as in a real aircraft
  yaw: 0.95,            // yaw is deliberately weak: it must not replace pitch
  spinUp: 3.4,          // how fast the input ramps to full deflection
  centre: 4.2,          // how fast the stick snaps back to neutral
  assist: 2.1,          // auto-centring of roll only (see below)
};

/** Throttle is expressed 0..1; speed is a fraction of max. */
export const THROTTLE = {
  accel: 0.42,          // throttle units per second
  cruise: 0.55,         // default throttle when you undock
  maxSpeed: 240,        // world units per second at full throttle
  minSpeed: 18,         // you never fully stop without the brake
  brakeRate: 90,        // world units per second, applied while braking
};

/** Linear inertia: how fast the hull settles to the commanded velocity. */
export const DRIFT = {
  grip: 2.6,            // 1/s. Higher = more arcade, lower = more slide
  boost: 1.9,           // multiplier while the afterburner is held
};

/** A hard ceiling on angular state so a spike cannot spin the camera forever. */
export const LIMITS = {
  rate: 3.2,            // rad/s
  pitch: Math.PI * 0.48, // stop short of straight up, to avoid gimbal flip
};

/**
 * Create a fresh flight state. Rotation is stored as a quaternion because the
 * roll/pitch/yaw coupling makes Euler angles gimbal-lock at exactly the moment
 * a dogfight needs them most.
 */
export function createFlight() {
  return {
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    // Angular rate per axis, in radians per second.
    rate: { pitch: 0, roll: 0, yaw: 0 },
    // Raw stick deflection, -1..1, which ramps toward the input.
    stick: { pitch: 0, roll: 0, yaw: 0 },
    throttle: THROTTLE.cruise,
    braking: false,
    boost: false,
    shake: 0,             // decays to 0; the renderer reads this
    locked: false,        // controls-disabled flag, e.g. during hyperspace
  };
}

/** Clamp helper kept local so this module has no imports at all. */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Move a scalar toward a target at a fixed rate. */
function approach(current, target, rate, dt) {
  const delta = target - current;
  const step = rate * dt;
  if (Math.abs(delta) <= step) return target;
  return current + Math.sign(delta) * step;
}

/**
 * Apply one frame of input. `input` is a normalised descriptor, not raw keys:
 *   { pitch, roll, yaw, throttle, braking, boost }
 * with the axes in -1..1 and throttle as a *delta* (-1, 0 or +1). Decoupling
 * key-handling from physics is what makes this testable without a browser.
 */
export function applyInput(f, input, dt) {
  if (f.locked) {
    // Still bleed off motion so a locked ship does not freeze mid-frame.
    f.stick.pitch = approach(f.stick.pitch, 0, RATES.centre, dt);
    f.stick.roll = approach(f.stick.roll, 0, RATES.centre, dt);
    f.stick.yaw = approach(f.stick.yaw, 0, RATES.centre, dt);
    applyRotation(f, dt);
    return f;
  }

  const p = clamp(input.pitch || 0, -1, 1);
  const r = clamp(input.roll || 0, -1, 1);
  const y = clamp(input.yaw || 0, -1, 1);

  // The stick ramps toward the target at spinUp, and returns at centre. The
  // asymmetry is what makes the ship feel heavy on the way in and obedient on
  // the way out.
  f.stick.pitch = approach(f.stick.pitch, p, p === 0 ? RATES.centre : RATES.spinUp, dt);
  f.stick.roll = approach(f.stick.roll, r, r === 0 ? RATES.centre : RATES.spinUp, dt);
  f.stick.yaw = approach(f.stick.yaw, y, y === 0 ? RATES.centre : RATES.spinUp, dt);

  f.braking = !!input.braking;
  f.boost = !!input.boost;

  const dThrottle = clamp(input.throttle || 0, -1, 1);
  f.throttle = clamp(f.throttle + dThrottle * THROTTLE.accel * dt, 0, 1);

  applyRotation(f, dt);
  applyThrust(f, dt);
  f.shake = Math.max(0, f.shake - dt * 2.4);
  return f;
}

/**
 * Turn the stick into a rotation, with roll assisting the turn like a wing.
 *
 * Sign conventions, which are pinned by tests/flight.test.js and match three's
 * own `Euler(..., 'XYZ')` for a ship whose nose is local +Z:
 *
 *   pitch > 0  ->  nose toward local -Y  (dive)   : rotate about local -X
 *   yaw   > 0  ->  nose toward local +X  (right)  : rotate about local  Y
 *   roll  > 0  ->  right wing down, up tends to -X: rotate about local -Z
 *
 * The pitch and roll axes being negative is not a bug and not arbitrary: with
 * a +Z nose, a right-handed basis, and a +Y up, a *positive* rotation about +X
 * lifts the nose. Pilots expect "pull back = climb", and the input layer is
 * where that inversion belongs - but this module owns the world-space contract,
 * so it is fixed and documented here rather than left as a sign a caller has to
 * remember.
 */
function applyRotation(f, dt) {
  // Roll assist: while rolling and pitching, the pitch authority increases
  // slightly. This is the classic "bank and pull" of every flight sim, and it
  // is why yaw can afford to be weak.
  const bank = 1 + Math.abs(f.stick.roll) * 0.35;
  f.rate.pitch = clamp(-f.stick.pitch * RATES.pitch * bank, -LIMITS.rate, LIMITS.rate);
  f.rate.roll = clamp(-f.stick.roll * RATES.roll, -LIMITS.rate, LIMITS.rate);
  f.rate.yaw = clamp(f.stick.yaw * RATES.yaw, -LIMITS.rate, LIMITS.rate);

  // Integrate into the quaternion using local-axis increments. Composing on
  // the right applies the rotation in the ship's own frame, which is what a
  // cockpit control does.
  const q = f.quat;
  const half = 0.5 * dt;
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;

  let dx = 0, dy = 0, dz = 0, dw = 0;

  // The formula for composing q with a small rotation (nx, ny, nz, a) about
  // axis n in the *local* frame is: dq = 0.5 * q * (n*sin(a), cos(a)) - q.
  // Written out per axis rather than as a general multiply, because this runs
  // 60+ times a second on the hot path.
  if (f.rate.pitch !== 0) {
    const a = f.rate.pitch * half;
    const s = Math.sin(a), c = Math.cos(a);
    dx += qw * s; dy += -qz * s; dz += qy * s; dw += -qx * s;
    dw += (c - 1) * qw;
  }
  if (f.rate.yaw !== 0) {
    const a = f.rate.yaw * half;
    const s = Math.sin(a), c = Math.cos(a);
    dx += qz * s; dy += qw * s; dz += -qx * s; dw += -qy * s;
    dw += (c - 1) * qw;
  }
  if (f.rate.roll !== 0) {
    const a = f.rate.roll * half;
    const s = Math.sin(a), c = Math.cos(a);
    dx += -qy * s; dy += qx * s; dz += qw * s; dw += -qz * s;
    dw += (c - 1) * qw;
  }

  if (dx || dy || dz || dw) {
    q.x = clamp(qx + dx, -1, 1);
    q.y = clamp(qy + dy, -1, 1);
    q.z = clamp(qz + dz, -1, 1);
    q.w = clamp(qw + dw, -1, 1);
    normalise(q);
  }
}

/** Rescale a quaternion back to unit length. Drift here becomes visible spin. */
function normalise(q) {
  const len = Math.hypot(q.x, q.y, q.z, q.w);
  if (len === 0) { q.x = 0; q.y = 0; q.z = 0; q.w = 1; return; }
  q.x /= len; q.y /= len; q.z /= len; q.w /= len;
}

/** Nose direction in world space, from the quaternion. Ships point along +Z. */
export function forwardOf(f) {
  const q = f.quat;
  return {
    x: 2 * (q.x * q.z + q.w * q.y),
    y: 2 * (q.y * q.z - q.w * q.x),
    z: 1 - 2 * (q.x * q.x + q.y * q.y),
  };
}

/** Up vector in world space. Used by the HUD horizon, not by physics. */
export function upOf(f) {
  const q = f.quat;
  return {
    x: 2 * (q.x * q.y - q.w * q.z),
    y: 1 - 2 * (q.x * q.x + q.z * q.z),
    z: 2 * (q.y * q.z + q.w * q.x),
  };
}

/** Right vector in world space. */
export function rightOf(f) {
  const q = f.quat;
  return {
    x: 1 - 2 * (q.y * q.y + q.z * q.z),
    y: 2 * (q.x * q.y + q.w * q.z),
    z: 2 * (q.x * q.z - q.w * q.y),
  };
}

/** How fast the hull actually wants to travel right now. */
export function targetSpeed(f) {
  if (f.braking) return THROTTLE.minSpeed;
  const base = THROTTLE.minSpeed + (THROTTLE.maxSpeed - THROTTLE.minSpeed) * f.throttle;
  return f.boost ? base * DRIFT.boost : base;
}

/**
 * Velocity is not set directly to forward*speed. It chases it at a finite
 * grip, so turning hard at speed produces a visible slide rather than a
 * perfectly railed turn. This is the single line that makes flight feel like
 * a ship instead of a cursor.
 */
function applyThrust(f, dt) {
  const dir = forwardOf(f);
  const speed = targetSpeed(f);
  const wish = { x: dir.x * speed, y: dir.y * speed, z: dir.z * speed };
  const t = clamp(DRIFT.grip * dt, 0, 1);
  f.vel.x += (wish.x - f.vel.x) * t;
  f.vel.y += (wish.y - f.vel.y) * t;
  f.vel.z += (wish.z - f.vel.z) * t;

  if (f.braking) {
    // An explicit brake on top of the grip, because "stop now" is a real
    // thing a player needs while lining up a docking slot.
    const sp = Math.hypot(f.vel.x, f.vel.y, f.vel.z);
    if (sp > 0) {
      const k = Math.max(0, sp - THROTTLE.brakeRate * dt) / sp;
      f.vel.x *= k; f.vel.y *= k; f.vel.z *= k;
    }
  }
}

/** Advance position. Kept separate so the renderer can interpolate. */
export function integrate(f, dt) {
  f.pos.x += f.vel.x * dt;
  f.pos.y += f.vel.y * dt;
  f.pos.z += f.vel.z * dt;
  return f;
}

/** Current speed, for the HUD. */
export function speedOf(f) {
  return Math.hypot(f.vel.x, f.vel.y, f.vel.z);
}

/**
 * Force the ship to face a world direction. Used when leaving a station and
 * when dropping out of hyperspace: arriving with a random attitude is
 * disorienting, and this is the "friendlier" choice.
 */
export function faceToward(f, dir) {
  const d = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const zx = dir.x / d, zy = dir.y / d, zz = dir.z / d;

  // Build a rotation whose +Z maps onto the requested direction, with a world
  // up of +Y as far as possible. Matches the nose convention in models.js.
  let ux = 0, uy = 1, uz = 0;
  if (Math.abs(zy) > 0.999) { ux = 0; uy = 0; uz = 1; }
  // x = up cross z
  let xx = uy * zz - uz * zy;
  let xy = uz * zx - ux * zz;
  let xz = ux * zy - uy * zx;
  const xl = Math.hypot(xx, xy, xz) || 1;
  xx /= xl; xy /= xl; xz /= xl;
  // y = z cross x
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  // Rotation matrix (x, y, z as columns) to quaternion.
  const m00 = xx, m01 = yx, m02 = zx;
  const m10 = xy, m11 = yy, m12 = zy;
  const m20 = xz, m21 = yz, m22 = zz;
  const trace = m00 + m11 + m22;
  const q = f.quat;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q.w = s * 0.25; q.x = (m21 - m12) / s; q.y = (m02 - m20) / s; q.z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q.w = (m21 - m12) / s; q.x = s * 0.25; q.y = (m01 + m10) / s; q.z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q.w = (m02 - m20) / s; q.x = (m01 + m10) / s; q.y = s * 0.25; q.z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q.w = (m10 - m01) / s; q.x = (m02 + m20) / s; q.y = (m12 + m21) / s; q.z = s * 0.25;
  }
  normalise(q);
  return f;
}

/** Trigger a camera shake, e.g. on a hit. Additive and clamped. */
export function addShake(f, amount) {
  f.shake = clamp(f.shake + amount, 0, 1);
  return f;
}

/** Wipe all motion. Called on death and on loading a save. */
export function reset(f) {
  const fresh = createFlight();
  Object.assign(f, fresh);
  return f;
}

export default {
  RATES, THROTTLE, DRIFT, LIMITS,
  createFlight, applyInput, integrate, speedOf, targetSpeed,
  forwardOf, upOf, rightOf, faceToward, addShake, reset,
};
