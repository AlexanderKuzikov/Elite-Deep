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
 *
 * The stick rides on the *movement* of the cursor, not on its resting place:
 * `movementX`/`movementY` are integrated and the accumulated deflection decays
 * back to centre whenever the mouse is still. That is the model a joystick has -
 * push to turn, let go and it springs back - and it is the only model that works
 * under pointer lock. A resting-position stick is implied by the browser's
 * cursor being locked at the centre, which makes `clientX`/`clientY` useless as
 * a deflection signal.
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

/**
 * The virtual stick: throw, spring and the pointer-lock timing.
 */
export const MOUSE = {
  // Fraction of the stick throw that counts as centred rather than as a turn.
  deadzone: 0.06,
  /**
   * How quickly the stick springs back to centre, in *deflections per second*.
   *
   * This is the "hold a turn" control: a mouse held steady bleeds its
   * deflection off at 2.2 units/s, so a full-deflection turn relaxes to centre
   * in about 0.45 s and a gentle 0.15 nudge is gone in 0.07 s - which is what
   * makes a small correction a small correction rather than a permanent drift.
   */
  decay: 2.2,
  /**
   * Deflection per pixel, *before* decay is applied per frame.
   *
   * Chosen so that a steady drag arrives at full deflection just before the
   * decay cancels it: at 60 fps, 230 px/s only just saturates. Drag faster than
   * that and the stick pins to the stop; drag slower and it settles at a
   * fraction of the throw, which is the fine control.
   *
   * This constant is coupled to `decay`. Changing one without the other moves
   * the whole feel, so `input.test.js` measures the crossing rate where the two
   * balance rather than trusting the numbers.
   */
  gain: 2.2 / 230,
  /**
   * Viewport height the sensitivity above was measured against. DPI and window
   * size scale the pixel travel, so they must scale the gain with it.
   */
  referenceHeight: 900,
  // Multiplier applied to the mouse axes versus the keyboard's hard 1.0.
  // Slightly reduced so mouse flight is controllable at the edges.
  authority: 0.92,
  /**
   * How long after a manual release before the lock may be taken again, in
   * seconds.
   *
   * Escape releases the pointer, and if the game re-locks on the very next
   * frame the release looks broken - the cursor never even reappears. Chrome
   * additionally refuses a re-lock requested within about a second of a
   * user-initiated exit, so firing one off just produces a `pointerlockerror`
   * and leaves the game insisting on a lock it cannot get. Waiting is not
   * politeness; it is the only thing that works.
   */
  relockDelay: 1.4,
  /**
   * How many refusals in a row before the game stops asking for the pointer.
   *
   * Deliberately more than one. A single refusal is the normal answer to a
   * request that arrived without a gesture behind it - a click that landed a
   * frame too early, a re-lock inside Chrome's post-Escape ban - and the next
   * honest gesture usually succeeds. Giving up at the first one is what used to
   * cost the player the mouse for the rest of the session; never giving up
   * would mean a `pointerlockerror` on every click forever.
   */
  giveUpAfter: 3,
};

/**
 * A frame-by-frame input state.
 *
 * `keys` is a Set of codes currently held. `mouse` is the integrated virtual
 * stick, -1..1 per axis, and `pending` collects one-shot actions between frames
 * (a laser shot should fire once on press, not sixty times a second).
 *
 * `el` is where key events are listened for and `pointerTarget` is what the
 * pointer is locked to. They are usually different: keys must arrive even when
 * the canvas is not focused, and only an element - never the window - can hold
 * a pointer lock.
 */
export function createInput(target, options) {
  const opts = options || {};
  const el = target || (typeof window !== 'undefined' ? window : null);

  const state = {
    keys: new Set(),
    // Integrated virtual stick, -1..1 per axis. Not a cursor offset: see the
    // header. `mouseTarget` is what the stick is being pushed toward, and
    // `mouse` is the relaxed value actually handed to `axes`.
    mouse: { x: 0, y: 0 },
    mouseTarget: { x: 0, y: 0 },
    pointerLocked: false,
    // Element the pointer is (or should be) locked to.
    pointerTarget: opts.pointerTarget || el,
    // Seconds left before a lock may be requested again. See `relockDelay`.
    relockIn: 0,
    // Last frame's delta, so `endFrame` can advance the cooldown without the
    // caller having to remember to pass it.
    lastDt: 1 / 60,
    /**
     * Called with `true` when the pointer is captured and `false` when it is
     * let go - by Escape, by the browser, or by `releaseMouse`.
     *
     * This is the one signal a host needs to get right: a UI that stays
     * interactive while the pointer is locked is a UI whose clicks go to the
     * game instead.
     */
    onPointerLock: opts.onPointerLock || null,
    // Extra observers registered through `addPointerLock`. Kept separate from
    // `onPointerLock` so the option and the function are not two spellings of
    // the same thing that silently override each other.
    pointerLockListeners: [],
    pending: [],
    // Set while the browser tab is hidden: everything releases.
    blurred: false,
    /**
     * How many refusals in a row the browser has handed back.
     *
     * A refusal is normal - it is what a request without a gesture gets, and
     * what a re-lock inside Chrome's own post-Escape ban gets - so it must not
     * be retried every frame. It must not be permanent either, which is the
     * trap this counter exists to avoid: with a plain boolean, one refusal
     * (from a click that missed, or a promise rejected for reasons the player
     * never saw) left the mouse dead for the rest of the session, and no later
     * gesture could revive it.
     *
     * After `MOUSE.giveUpAfter` refusals the game stops asking and says so on
     * screen. Anything less and the next gesture tries again.
     */
    lockFailures: 0,
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
    // Under pointer lock the cursor sits at the screen centre and only the
    // *delta* carries information, so a scheme that reads `clientX` measures
    // nothing at all. See the header.
    const gain = mouseGain(state);
    const dx = typeof e.movementX === 'number' ? e.movementX : 0;
    const dy = typeof e.movementY === 'number' ? e.movementY : 0;
    state.mouseTarget.x = clamp(state.mouseTarget.x + dx * gain, -1, 1);
    state.mouseTarget.y = clamp(state.mouseTarget.y + dy * gain, -1, 1);
  }

  function onPointerLockChange() {
    state.pointerLocked = !!state.pointerTarget && document.pointerLockElement === state.pointerTarget;
    if (state.pointerLocked) {
      // A fresh lock always starts centred, whatever the stick was doing when
      // the last one ended.
      state.mouse.x = 0;
      state.mouse.y = 0;
      state.mouseTarget.x = 0;
      state.mouseTarget.y = 0;
      // A lock that came back is proof the browser will grant one. Whatever
      // refusals were counted before are stale, and keeping them would leave
      // the mouse dead for the session after a single unlucky request.
      state.lockFailures = 0;
    } else {
      // Losing the lock - Escape, alt-tab, or the browser deciding - must
      // centre the stick. Otherwise the ship keeps the last deflection and
      // flies into the station while the player is using the mouse to click
      // something.
      state.mouseTarget.x = 0;
      state.mouseTarget.y = 0;
      // Every loss arms the cooldown, not just the programmatic one. Escape is
      // a *browser* release, so it never passes through `releaseMouse` - and
      // without this the next click asks for the pointer immediately, which
      // Chrome refuses (it keeps its own second-long ban after a user exit).
      // That refusal is what used to kill the mouse for the rest of the
      // session. `releaseMouse` sets the same value; setting it twice is the
      // same as setting it once.
      state.relockIn = Math.max(state.relockIn, MOUSE.relockDelay);
    }
    notifyLock(state);
  }

  function onPointerLockError() {
    // The browser refused. Count it so the session stops insisting on the lock
    // after a few tries and can say so on screen, rather than silently doing
    // nothing every time the player clicks.
    state.lockFailures += 1;
    state.pointerLocked = false;
    notifyLock(state);
  }

  add(state, el, 'keydown', onKeyDown);
  add(state, el, 'keyup', onKeyUp);
  add(state, el, 'blur', onBlur);
  add(state, el, 'focus', onFocus);
  add(state, el, 'mousemove', onMouseMove);
  if (typeof document !== 'undefined') {
    add(state, document, 'pointerlockchange', onPointerLockChange);
    add(state, document, 'pointerlockerror', onPointerLockError);
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

/** Tell the host whether the pointer is captured. */
function notifyLock(state) {
  if (typeof state.onPointerLock === 'function') state.onPointerLock(state.pointerLocked);
  for (const fn of state.pointerLockListeners) fn(state.pointerLocked);
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
  state.lastDt = dt;

  if (held(state, 'pitchDown')) pitch += 1;
  if (held(state, 'pitchUp')) pitch -= 1;
  if (held(state, 'rollRight')) roll += 1;
  if (held(state, 'rollLeft')) roll -= 1;
  if (held(state, 'yawRight')) yaw += 1;
  if (held(state, 'yawLeft')) yaw -= 1;

  // Fold in the mouse virtual stick, then clamp so the two devices can be used
  // together without exceeding full deflection. `stickFrom` handles the
  // deadzone; the spring is handled by `stepMouse`.
  if (state.mouseEnabled) {
    const m = stepMouse(state, dt);
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
 * Map a -1..1 stick deflection to thrust authority.
 *
 * A plain deadzone, then full authority immediately past it. The previous
 * version ramped linearly from the deadzone edge to a *saturation* point, on
 * the reasoning that a guessable curve beats an optimal one - but that only
 * makes sense for a scheme where the stick has a physical travel to spend. With
 * a spring-centred stick the curve is already in the player's hand: a small
 * nudge is a small turn because it decays before it accumulates. A ramp on top
 * of that just eats the first third of the throw.
 */
function stickFrom(v) {
  return Math.abs(v) <= MOUSE.deadzone ? 0 : clamp(v, -1, 1);
}

/** How many units of deflection one pixel of mouse travel buys, this frame. */
function mouseGain(state) {
  const h = (typeof window !== 'undefined' && window.innerHeight)
    || (state.pointerTarget && state.pointerTarget.clientHeight)
    || MOUSE.referenceHeight;
  return MOUSE.gain * (MOUSE.referenceHeight / Math.max(1, h));
}

/** Drop the stick back toward centre at the spring rate. */
function releaseStick(state, dt) {
  const rate = MOUSE.decay * dt;
  if (state.mouseTarget.x > 0) state.mouseTarget.x = Math.max(0, state.mouseTarget.x - rate);
  else if (state.mouseTarget.x < 0) state.mouseTarget.x = Math.min(0, state.mouseTarget.x + rate);
  if (state.mouseTarget.y > 0) state.mouseTarget.y = Math.max(0, state.mouseTarget.y - rate);
  else if (state.mouseTarget.y < 0) state.mouseTarget.y = Math.min(0, state.mouseTarget.y + rate);
}

/**
 * The frame's delta time, for callers that have no `dt` of their own.
 *
 * `axes` is where `lastDt` comes from, and `axes` is only called while flying.
 * Everything the frame clock drives has to survive that: a cooldown measured
 * against a clock that stops advancing outside flight is not a cooldown, it is
 * a stuck timer. The default covers the first frame, before any `axes` call.
 */
export function frameDelta(state, dt) {
  if (typeof dt === 'number' && isFinite(dt) && dt > 0) state.lastDt = dt;
  return state.lastDt || 1 / 60;
}

/**
 * Integrate the virtual stick for this frame and return it.
 *
 * A joystick is not a control that stays where you leave it, and a mouse has no
 * *position* under pointer lock, so the two are reconciled by giving the mouse
 * a stick that behaves like a joystick: the cursor's motion deflects it, and
 * the deflection bleeds back to centre whenever the mouse is still. Holding a
 * turn means keeping the mouse moving, which is exactly the gesture a player
 * already makes with the keyboard held down.
 *
 * The decay runs in every case, including while no mouse has ever been seen.
 * That keeps the function pure with respect to `dt`: calling it is what advances
 * the stick, so nothing depends on whether a mousemove happened to arrive this
 * frame. A stick that had been left at 0.5 would otherwise stay there forever
 * if the mouse were unplugged.
 */
function stepMouse(state, dt) {
  releaseStick(state, dt);
  return state.mouseTarget;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Clear the one-shot queue. Call at the end of each frame. */
export function endFrame(state, dt) {
  state.pending.length = 0;
  // The re-lock cooldown rides the frame clock rather than a wall clock, so it
  // works the same in the browser and under a test that steps time by hand.
  // The frame's own `dt` is preferred here, because `lastDt` is only refreshed
  // by `axes` and `axes` only runs while flying - a cooldown that is armed by
  // releasing the mouse outside flight would never come back down.
  tickMouse(state, frameDelta(state, dt));
}

/**
 * Request pointer lock. Must be called from a user gesture.
 *
 * Returns false when the lock was not asked for - no element to lock, a lock in
 * progress, a cooldown still running after a manual release, or the browser
 * having already refused once. The caller is expected to treat all of those as
 * "the player is using the mouse, not the pointer".
 */
export function requestMouse(state) {
  if (!state.mouseEnabled) return false;
  if (state.pointerLocked) return false;
  // Only after several refusals in a row does the game stop asking. One
  // refusal is not evidence that the browser will never grant a lock - it is
  // usually a click that arrived a moment too early - and treating it as
  // permanent is how the mouse used to die for the session.
  if (state.lockFailures >= MOUSE.giveUpAfter) return false;
  if (state.relockIn > 0) return false;
  const target = state.pointerTarget;
  if (!target || typeof target.requestPointerLock !== 'function') return false;
  // A request can be refused if the element is not in the document - which is
  // exactly what happens when the caller kept a reference to a canvas that a
  // screen rebuild has since replaced. Not fatal, but not silent either: the
  // player gets no mouse, and the hint on screen has to say so.
  if (target.isConnected === false) return false;
  try {
    // Chrome returns a promise here and rejects it when the request is not
    // backed by a gesture; older browsers return nothing. Either way a failure
    // must not surface as an unhandled rejection, so it is swallowed and the
    // refusal is counted instead.
    const asked = target.requestPointerLock();
    if (asked && typeof asked.catch === 'function') {
      asked.catch(() => { state.lockFailures += 1; });
    }
  } catch (err) {
    state.lockFailures += 1;
    return false;
  }
  return true;
}

/** True once the browser has refused the pointer often enough to give up. */
export function lockRefused(state) {
  return state.lockFailures >= MOUSE.giveUpAfter;
}

/**
 * Release pointer lock, and refuse to take it again for `relockDelay`.
 *
 * The delay is the whole point. Escape is how a player gets their cursor back
 * to click something else, and a lock that is re-acquired on the next frame
 * makes Escape look broken.
 *
 * The same cooldown is armed by `onPointerLockChange` when the lock is lost
 * without going through here - Escape is a browser release and never calls
 * this function. Setting it here as well means a caller that releases the
 * pointer in an environment where no change event follows (a test, or a
 * browser that stays silent) still gets the delay.
 */
export function releaseMouse(state) {
  if (typeof document !== 'undefined' && document.exitPointerLock) {
    try { document.exitPointerLock(); } catch (err) { /* nothing to exit */ }
  }
  state.pointerLocked = false;
  state.relockIn = MOUSE.relockDelay;
  state.mouse.x = 0;
  state.mouse.y = 0;
  state.mouseTarget.x = 0;
  state.mouseTarget.y = 0;
}

/**
 * Watch pointer-lock changes, so a host that has to move out of the way can.
 *
 * Pointer lock belongs to one element at a time and stops propagating events to
 * the window, so a station screen rendered over the canvas goes dead the moment
 * the game takes the pointer. Being told when the lock is taken and released is
 * what lets that screen decide whether it may accept a click.
 */
export function addPointerLock(state, onToggle) {
  if (typeof onToggle !== 'function') return state;
  state.pointerLockListeners.push(onToggle);
  return state;
}

/** Advance the re-lock cooldown. Called once per frame by `endFrame`. */
export function tickMouse(state, dt) {
  if (state.relockIn > 0) state.relockIn = Math.max(0, state.relockIn - dt);
}

/** True while the pointer is captured and the mouse is actually flying. */
export function mouseActive(state) {
  return !!state.mouseEnabled && !!state.pointerLocked;
}

export default {
  BINDINGS, MOUSE,
  createInput, destroyInput, held, consume, axes, endFrame, frameDelta,
  requestMouse, releaseMouse, addPointerLock, tickMouse, mouseActive, lockRefused,
};
