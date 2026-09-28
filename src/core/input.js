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
 *   mouse     - pointer-lock, direct: the ship keeps turning for as long as you
 *               keep moving the mouse, and holds the last rate when you stop
 *
 * ## Why direct, and not a spring-centred stick
 *
 * This used to be a virtual stick: mouse movement was *integrated* into a
 * deflection which then decayed back to centre at 2.2 units/s. The reasoning
 * was that Elite is a game about holding a turn, and a relative mouse would
 * make holding one impossible without endless re-dragging.
 *
 * The premise was wrong, and the model that replaced it measures out like this
 * (all figures from the same instrument that the tests use):
 *
 *   - The old model had an **equilibrium hand speed** of 230 px/s: drag slower
 *     and the spring cancelled every pixel you contributed, drag faster and the
 *     stick grew. Below about 130 px/s the stick never left the deadzone at all
 *     - a slow correction produced *exactly nothing*, not a gentle turn.
 *   - A turn died in 0.42 s once the hand stopped, so holding a course meant
 *     continuously dragging the mouse.
 *   - Reaching full deflection took 0.3-1.4 s of sustained fast dragging.
 *
 * The correct reading of "hold a turn" is that the *applied rate* should stay
 * put when the hand stops - which is what happens here, and what every modern
 * space sim does. Nothing has to be re-dragged: the ship holds the rate it was
 * given until it is given another.
 *
 * The two models are the same integration, differing only in whether the state
 * decays. There is no spring, no equilibrium hand speed and no threshold below
 * which input is discarded. What replaces them is one constant: `MOUSE.rate`,
 * the turn rate one pixel of travel buys. Measured on the same instrument the
 * tests use, with the old numbers beside it for scale:
 *
 *   - 10 px of travel produces a 0.035 rate that is still 0.035 a second and a
 *     half later (was: 0.035 that had decayed to 0 by frame one of stillness).
 *   - A full-rate turn is a 285 px sweep - about a third of the screen width.
 *   - A 9 px correction steers (was: exactly nothing, forever).
 *   - The frame rate does not enter the arithmetic at all.
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
  escapeCapsule: ['KeyK'],
};

/**
 * Mouse flight: sensitivity and the pointer-lock timing.
 *
 * There is no spring here any more. The applied rate is *held* rather than
 * released, which is what makes a slow correction a slow correction instead of
 * nothing at all. See the header for the measurements that killed the old
 * model.
 */
export const MOUSE = {
  /**
   * Rate per pixel, as a fraction of full deflection.
   *
   * One pixel of travel buys this much turn *rate*, and the rate stays until
   * another pixel changes it. Calibrated so a comfortable flick crosses the
   * screen's worth of travel for a useful turn: at 0.0035, a 285 px sweep is
   * full rate, and the small corrections that matter in a dogfight are 10-30 px
   * - comfortably above any noise floor.
   *
   * There is deliberately **no deadzone and no decay**: a deadzone on a
   * *rate* control discards small input entirely (the old one threw away
   * everything below 130 px/s of hand speed), and decay is what made the rate
   * impossible to hold.
   */
  rate: 0.0035,
  /**
   * Viewport height the sensitivity above was calibrated against.
   *
   * A pixel of mouse travel is a physical distance; a pixel of viewport is not.
   * Without this, the same hand movement turns the ship half as fast on a 4K
   * panel as on a laptop, which reads as "the mouse is broken on my screen".
   */
  referenceHeight: 900,
  /**
   * Multiplier applied to the mouse axes versus the keyboard's hard 1.0.
   *
   * Near parity now, and that is a change of intent rather than of taste. The
   * old 0.92 existed because the spring made the mouse *unable* to hold a rate
   * and the keyboard could, so the mouse was deliberately the weaker device and
   * the manual said so. With a rate that holds, the mouse is no longer a
   * second-class control and there is no reason to hobble it.
   */
  authority: 1.0,
  /**
   * Multiplier for the vertical axis alone.
   *
   * Pitching is the axis players notice first and the one that most often feels
   * "too twitchy" at a sensitivity that suits roll, because the view moves
   * across the screen rather than spinning with it.
   */
  pitchScale: 0.85,
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
 * `keys` is a Set of codes currently held. `mouse` is the applied turn rate,
 * -1..1 per axis, and `pending` collects one-shot actions between frames
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
    /**
     * The applied turn rate, -1..1 per axis, in the ship's own frame.
     *
     * Not an integrated push that leaks away: whatever the player dialled in
     * stays until they dial something else. `x` is roll, `y` is pitch.
     *
     * The old model needed two values - a target the stick was pushed toward
     * and a relaxed value that leaked back toward centre - because the spring
     * only made sense if the two were told apart. With nothing to relax, one
     * value is the whole state, and a second would only ever drift away from
     * the first.
     */
    mouse: { x: 0, y: 0 },
    pointerLocked: false,
    // Element the pointer is (or should be) locked to.
    pointerTarget: opts.pointerTarget || el,
    // Seconds left before a lock may be requested again. See `relockDelay`.
    relockIn: 0,
    /**
     * Set while a release the *game* decided on is in flight.
     *
     * `releaseMouse(state, true)` sets it; `onPointerLockChange` consumes it, so
     * the change event the release fires does not arm the player-facing
     * cooldown. Without it the flag and the event fight, and whichever runs
     * last wins - which is not a race worth having when the answer is known.
     */
    quietRelease: false,
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
    //
    // The delta is added to the *rate*, not to a deflection: two pixels of
    // travel mean twice the turn, and the turn stays after the hand stops.
    // `clamp` is the only thing between the player and a rate beyond full, so
    // a fast sweep pins the axis rather than running past it - which is also
    // what lets the player return to centre deliberately by overshooting.
    const gain = mouseGain(state);
    const dx = typeof e.movementX === 'number' ? e.movementX : 0;
    const dy = typeof e.movementY === 'number' ? e.movementY : 0;
    state.mouse.x = clamp(state.mouse.x + dx * gain, -1, 1);
    state.mouse.y = clamp(state.mouse.y + dy * gain * MOUSE.pitchScale, -1, 1);
  }

  function onPointerLockChange() {
    state.pointerLocked = !!state.pointerTarget && document.pointerLockElement === state.pointerTarget;
    if (state.pointerLocked) {
      // A fresh lock always starts from rest, whatever the rate was when the
      // last one ended.
      state.mouse.x = 0;
      state.mouse.y = 0;
      // A lock that came back is proof the browser will grant one. Whatever
      // refusals were counted before are stale, and keeping them would leave
      // the mouse dead for the session after a single unlucky request.
      state.lockFailures = 0;
    } else {
      // Losing the lock - Escape, alt-tab, or the browser deciding - must
      // cancel the turn. Otherwise the ship keeps the last rate and flies into
      // the station while the player is using the mouse to click something.
      // With no spring to return the rate to zero on its own, this is the only
      // thing that stops the ship when the lock goes away.
      state.mouse.x = 0;
      state.mouse.y = 0;
      // Every loss arms the cooldown, not just the programmatic one. Escape is
      // a *browser* release, so it never passes through `releaseMouse` - and
      // without this the next click asks for the pointer immediately, which
      // Chrome refuses (it keeps its own second-long ban after a user exit).
      // That refusal is what used to kill the mouse for the rest of the
      // session. `releaseMouse` sets the same value; setting it twice is the
      // same as setting it once.
      //
      // Unless the release was the game's own decision - docking, dying, the
      // chart. Those set `quietRelease` before releasing, and the event fires
      // as a consequence of something the player did not ask for. Arming the
      // delay there is what made a routine undock launch a dead mouse. The
      // flag is consumed here rather than checked later so it can never leak
      // into an unrelated release.
      if (state.quietRelease) {
        state.quietRelease = false;
        state.relockIn = 0;
      } else {
        state.relockIn = Math.max(state.relockIn, MOUSE.relockDelay);
      }
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

/**
 * Keys the browser would otherwise use for scrolling or shortcuts.
 *
 * F5 and F9 were here for the `save`/`load` bindings above. Both are gone: the
 * game saves itself on dock and never asks (see `saveGame`), and a binding that
 * swallows the keypress without acting on it is worse than no binding at all -
 * the player pressed F5 to reload a stuck page and the page did not reload
 * either. Releasing the keys restores the browser's own meaning.
 */
const SCROLL_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
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

  // Fold in the mouse rate, then clamp so the two devices can be used together
  // without exceeding full deflection.
  //
  // Note what is *not* here: no integration, no spring, no deadzone. The mouse
  // value is already a rate in -1..1, so it is added as-is. `dt` is still
  // recorded above for the cooldown, but nothing in the mouse path depends on
  // it any more - which is the point. A frame rate cannot change how far the
  // ship has turned for a given hand movement, and it cannot make a slow
  // correction disappear.
  if (state.mouseEnabled) {
    roll += state.mouse.x * MOUSE.authority;
    pitch += state.mouse.y * MOUSE.authority;
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
 * How much rate one pixel of mouse travel buys, this frame.
 *
 * Scaled by the viewport so a centimetre of desk travel is a centimetre of
 * desk travel on any monitor: a pixel of mouse travel is a physical distance,
 * a pixel of viewport is not. The calibration height lives in `MOUSE`.
 */
function mouseGain(state) {
  const h = (typeof window !== 'undefined' && window.innerHeight)
    || (state.pointerTarget && state.pointerTarget.clientHeight)
    || MOUSE.referenceHeight;
  return MOUSE.rate * (MOUSE.referenceHeight / Math.max(1, h));
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
 * The mouse rate for this frame, unchanged.
 *
 * Kept as a named function rather than inlined into `axes` because the tests
 * read the applied rate directly, and "what the ship was told to do this frame"
 * should not require building a flight descriptor to inspect. Unlike the spring
 * it replaces it does not take `dt`: with nothing to decay there is no
 * integration left, and a rate that depended on the frame rate would be the
 * same defect in a new place.
 */
export function mouseRate(state) {
  return state.mouse;
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
 * having refused enough times in a row to give up (`MOUSE.giveUpAfter`, which is
 * deliberately more than one: a single refusal is a click that arrived a frame
 * too early, not a verdict). The caller is expected to treat all of those as
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
    // A request means the quiet release is over and done with, whatever the
    // browser did or did not deliver. Clearing it here is what keeps the flag
    // from leaking into a later, unrelated loss, without a timer racing the
    // change event that the release itself fires.
    state.quietRelease = false;
    // Chrome returns a promise here and rejects it when the request is not
    // backed by a gesture; older browsers return nothing. A rejection must
    // not surface as an unhandled rejection, so it is swallowed - but not
    // counted: the browser *also* fires `pointerlockerror` for the same
    // gesture, and counting both would score one refusal as two and give up
    // after a refusal and a half instead of after `giveUpAfter`.
    const asked = target.requestPointerLock();
    if (asked && typeof asked.catch === 'function') {
      asked.catch(() => { /* counted by onPointerLockError */ });
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
 *
 * `quiet` is for a release the *game* decides on, with no Escape behind it.
 * The cooldown exists to answer a player who asked for their cursor back; a
 * commander who docks and undocks again a second later asked for nothing, and
 * arming the delay for them means the ship launches with a dead mouse and a
 * hint telling them to click - which is the same symptom as the bug this
 * cooldown was added to fix. Docking and dying pass `quiet`; anything that
 * stands in for Escape does not.
 */
export function releaseMouse(state, quiet) {
  // Tell `onPointerLockChange` that the release about to happen was the game's
  // decision, so the change event it fires does not re-arm the cooldown.
  //
  // The flag is deliberately *not* cleared on a timer. Chrome fires
  // `pointerlockchange` for `exitPointerLock` asynchronously - measured, it
  // arrives after a `setTimeout(..., 0)` has already run - so a timer that
  // clears the flag "in case no event comes" clears it just before the event
  // it was waiting for. Stale-flag risk is handled the other way round: the
  // flag is consumed by the change handler, and a *request* also clears it, so
  // it can never survive into a later, unrelated release.
  if (quiet) state.quietRelease = true;
  if (typeof document !== 'undefined' && document.exitPointerLock) {
    try { document.exitPointerLock(); } catch (err) { /* nothing to exit */ }
  }
  state.pointerLocked = false;
  state.relockIn = quiet ? 0 : MOUSE.relockDelay;
  state.mouse.x = 0;
  state.mouse.y = 0;
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
  mouseRate,
};
