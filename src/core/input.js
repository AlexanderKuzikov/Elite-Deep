/**
 * Input: keyboard and mouse, normalised into the flight descriptor that
 * `flight.applyInput` consumes.
 *
 * The important design decision is the split. This module knows about *keys*;
 * flight.js knows about *axes*. Nothing here reads a DOM position directly
 * during a frame if it can be helped, and nothing here knows what a laser is.
 * That keeps the key bindings swappable and keeps the physics testable.
 *
 * Two control schemes are supported and both are always live:
 *
 *   keyboard  - arrows or WASD for pitch/roll, Q/E for yaw, A/Z throttle
 *   mouse     - pointer-lock, virtual-stick style: the further you push from
 *               the centre of the screen, the harder the ship turns
 *
 * The mouse is a "virtual stick" rather than a direct-drag scheme because
 * Elite is a game about holding a turn, and a relative-drag mouse makes holding
 * a turn impossible without endless re-dragging.
 */

/**
 * Bindings. Physical `Key*`/`Arrow*` codes, so this keeps working on a French
 * AZERTY keyboard or a Russian layout - `event.code` is layout-independent,
 * which is the whole reason to prefer it over `event.key`.
 */
export const BINDINGS = {
  pitchDown: ['ArrowUp', 'KeyW'],       // nose up
  pitchUp: ['ArrowDown', 'KeyS'],       // nose down
  rollLeft: ['ArrowLeft', 'KeyA'],
  rollRight: ['ArrowRight', 'KeyD'],
  yawLeft: ['KeyQ'],
  yawRight: ['KeyE'],
  throttleUp: ['KeyR', 'ShiftLeft'],
  throttleDown: ['KeyF', 'ControlLeft'],
  brake: ['KeyX', 'Space'],
  boost: ['KeyZ'],
  fire: ['KeyM'],
  missile: ['KeyN'],
  // `launchMissile` used to carry `KeyM` as well - a leftover from the original
  // Elite, where M *was* the missile key. When `fire` moved onto M and the
  // missile moved to N, the old alias stayed. Because `fire` is read with
  // `held` and the missile with `consume`, both fired on the same press:
  // measured, one press of M with a target locked took the missile count from
  // 3 to 2 *and* put a tracer in the air. The commander's primary weapon key
  // was draining their scarce missiles. `missile` covers the action; the alias
  // is gone.
  // Trade a single tonne rather than the whole hold. Bound to `1` rather than
  // to a modifier because `Shift` is already the tab key on the station
  // screens, and a modifier that also does something else is worse than a
  // dedicated key that does one thing.
  tradeOne: ['Digit1'],
  targetNext: ['KeyT'],
  targetPrev: ['KeyG'],
  dock: ['KeyC'],
  hyperspace: ['KeyH'],
  chart: ['KeyO'],
  jump: ['KeyJ'],
  scannerRange: ['KeyV'],
  pause: ['KeyP'],
  /**
   * Leave the screen you are on.
   *
   * The station's own hint has promised "Esc undock" since it was written, and
   * Escape was bound to nothing at all - so the one key a player is most likely
   * to try first was the one key that did nothing. Kept separate from `dock`
   * rather than aliased to it, because `dock` means *request docking* in flight
   * and "leave the station" on a station screen, and one binding cannot mean
   * both.
   */
  leave: ['Escape'],
  mute: ['KeyB'],
  save: ['F5'],
  load: ['F9'],
  escapeCapsule: ['KeyK'],
};

/** Mouse sensitivity: how far from centre counts as full deflection. */
export const MOUSE = {
  // Fraction of the smaller viewport dimension that means "full stick".
  deadzone: 0.06,
  saturation: 0.42,
  // How much the mouse axes are damped toward the target per second.
  smoothing: 14,
  // Multiplier applied to the mouse axes versus the keyboard's hard 1.0.
  // Slightly reduced so mouse flight is controllable at the edges.
  authority: 0.92,
};

/**
 * A frame-by-frame input state.
 *
 * `keys` is a Set of codes currently held. `axes` is the smoothed, normalised
 * output. `pending` collects one-shot actions between frames (a laser shot
 * should fire once on press, not sixty times a second).
 */
export function createInput(target, options) {
  const opts = options || {};
  const el = target || (typeof window !== 'undefined' ? window : null);

  const state = {
    keys: new Set(),
    // Smoothed mouse deflection, -1..1 per axis.
    mouse: { x: 0, y: 0 },
    // Raw, unsmoothed mouse deflection target.
    mouseTarget: { x: 0, y: 0 },
    pointerLocked: false,
    pending: [],
    // Set while the browser tab is hidden: everything releases.
    blurred: false,
    el,
    mouseEnabled: opts.mouse !== false,
    invertPitch: !!opts.invertPitch,
    listeners: [],
  };

  if (!el || !el.addEventListener) return state;

  function onKeyDown(e) {
    // Do not swallow the browser's own shortcuts.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!state.keys.has(e.code)) {
      // A fresh press: record the edge so one-shot actions can consume it.
      state.pending.push(e.code);
    }
    state.keys.add(e.code);
    // Space and the arrows scroll the page otherwise.
    if (SCROLL_KEYS.has(e.code)) e.preventDefault();
  }

  function onKeyUp(e) {
    state.keys.delete(e.code);
  }

  function onBlur() {
    // Alt-tabbing away must not leave the ship on full throttle forever.
    state.keys.clear();
    state.mouse.x = 0;
    state.mouse.y = 0;
    state.mouseTarget.x = 0;
    state.mouseTarget.y = 0;
    state.blurred = true;
  }

  function onFocus() {
    state.blurred = false;
  }

  function onMouseMove(e) {
    if (!state.pointerLocked) return;
    const w = el.innerWidth || 1;
    const h = el.innerHeight || 1;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const dx = (e.clientX - cx) / cx;
    const dy = (e.clientY - cy) / cy;
    const r = Math.hypot(dx, dy);
    if (r > 1) {
      // Clamp onto the unit circle so diagonal input is not stronger.
      state.mouseTarget.x = dx / r;
      state.mouseTarget.y = dy / r;
    } else {
      state.mouseTarget.x = dx;
      state.mouseTarget.y = dy;
    }
  }

  function onPointerLockChange() {
    state.pointerLocked = document.pointerLockElement === el
      || document.pointerLockElement === el.documentElement
      || document.pointerLockElement === el.body;
    if (!state.pointerLocked) {
      state.mouseTarget.x = 0;
      state.mouseTarget.y = 0;
    }
  }

  add(state, el, 'keydown', onKeyDown);
  add(state, el, 'keyup', onKeyUp);
  add(state, el, 'blur', onBlur);
  add(state, el, 'focus', onFocus);
  add(state, el, 'mousemove', onMouseMove);
  if (typeof document !== 'undefined') {
    add(state, document, 'pointerlockchange', onPointerLockChange);
  }

  return state;
}

/** Keys the browser would otherwise use for scrolling or shortcuts. */
const SCROLL_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'F5', 'F9',
]);

/** Register a listener and remember it, so destroy() can undo everything. */
function add(state, node, type, fn) {
  node.addEventListener(type, fn);
  state.listeners.push([node, type, fn]);
}

/** Tear down every listener. Called when leaving the game. */
export function destroyInput(state) {
  for (const [node, type, fn] of state.listeners) node.removeEventListener(type, fn);
  state.listeners.length = 0;
}

/** Is any of these codes held? */
export function held(state, action) {
  const codes = BINDINGS[action];
  if (!codes) return false;
  for (const c of codes) if (state.keys.has(c)) return true;
  return false;
}

/** Consume a one-shot press. Returns true once per physical key press. */
export function consume(state, action) {
  const codes = BINDINGS[action];
  if (!codes || !state.pending.length) return false;
  for (let i = 0; i < state.pending.length; i += 1) {
    if (codes.includes(state.pending[i])) {
      state.pending.splice(i, 1);
      return true;
    }
  }
  return false;
}

/**
 * Produce the flight descriptor for this frame.
 *
 * This is where the "pull back to climb" inversion lives: `pitchDown` is bound
 * to the up arrow and to W, and it produces a positive pitch, which flight.js
 * documents as "nose up". Because the inversion is applied here, the physics
 * layer never has to know about human expectations.
 */
export function axes(state, dt) {
  let pitch = 0, roll = 0, yaw = 0;

  if (held(state, 'pitchDown')) pitch += 1;
  if (held(state, 'pitchUp')) pitch -= 1;
  if (held(state, 'rollRight')) roll += 1;
  if (held(state, 'rollLeft')) roll -= 1;
  if (held(state, 'yawRight')) yaw += 1;
  if (held(state, 'yawLeft')) yaw -= 1;

  // Fold in the mouse virtual stick, then clamp so the two devices can be used
  // together without exceeding full deflection. `stickFrom` already handles the
  // deadzone and the saturation point in one step.
  if (state.mouseEnabled) {
    const m = smoothMouse(state, dt);
    roll += stickFrom(m.x) * MOUSE.authority;
    pitch += stickFrom(m.y) * MOUSE.authority;
  }

  if (state.invertPitch) pitch = -pitch;

  let throttle = 0;
  if (held(state, 'throttleUp')) throttle += 1;
  if (held(state, 'throttleDown')) throttle -= 1;

  return {
    pitch: clamp(pitch, -1, 1),
    roll: clamp(roll, -1, 1),
    yaw: clamp(yaw, -1, 1),
    throttle,
    braking: held(state, 'brake') || held(state, 'throttleDown'),
    boost: held(state, 'boost'),
  };
}

/**
 * Map a -1..1 mouse deflection to a -1..1 stick position.
 *
 * Deadzone near the centre (so a stationary hand does not steer), then a linear
 * ramp from the deadzone edge up to `saturation`, where the stick is fully
 * over. A true exponential curve would be nicer for precision aiming, but the
 * linear ramp is guessable, and in a game where you must hold a turn for
 * seconds at a time, guessable beats optimal.
 */
function stickFrom(v) {
  const a = Math.abs(v);
  if (a <= MOUSE.deadzone) return 0;
  const t = Math.min(1, (a - MOUSE.deadzone) / (MOUSE.saturation - MOUSE.deadzone));
  return v < 0 ? -t : t;
}

/** Exponential smoothing of the mouse, frame-rate independent. */
function smoothMouse(state, dt) {
  const t = 1 - Math.exp(-MOUSE.smoothing * dt);
  state.mouse.x += (state.mouseTarget.x - state.mouse.x) * t;
  state.mouse.y += (state.mouseTarget.y - state.mouse.y) * t;
  return state.mouse;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Clear the one-shot queue. Call at the end of each frame. */
export function endFrame(state) {
  state.pending.length = 0;
}

/** Request pointer lock. Must be called from a user gesture. */
export function requestMouse(state) {
  if (!state.el || !state.el.requestPointerLock) return false;
  state.el.requestPointerLock();
  return true;
}

/** Release pointer lock. */
export function releaseMouse(state) {
  if (typeof document !== 'undefined' && document.exitPointerLock) {
    document.exitPointerLock();
  }
  state.pointerLocked = false;
}

export default {
  BINDINGS, MOUSE,
  createInput, destroyInput, held, consume, axes, endFrame,
  requestMouse, releaseMouse,
};
