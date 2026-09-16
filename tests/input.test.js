/**
 * Input tests.
 *
 * The risk here is not a crash, it is a *silent* one: a key bound to the wrong
 * action, or an axis wired backwards, produces a game that is technically
 * running and completely unplayable. So these tests drive the module with
 * synthetic key events and assert on the resulting axes, plus the two
 * behaviours that only show up at runtime:
 *
 *   - alt-tabbing must release the throttle (otherwise the ship flies away
 *     while the player is in another window)
 *   - one-shot actions must fire once per press, not once per frame
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as I from '../src/core/input.js';

/** A minimal EventTarget stand-in. Node has EventTarget, but not window's. */
function fakeWindow() {
  const listeners = new Map();
  const el = {
    innerWidth: 1600,
    innerHeight: 900,
    documentElement: null,
    body: null,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (listeners.has(type)) listeners.get(type).delete(fn);
    },
    fire(type, event) {
      const set = listeners.get(type);
      if (set) for (const fn of set) fn(event || {});
    },
    listenerCount() {
      let n = 0;
      for (const set of listeners.values()) n += set.size;
      return n;
    },
    requestPointerLock() { this._lockRequested = true; },
  };
  return el;
}

/** A key event with the fields the module reads. */
function key(code, extra) {
  return { code, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {}, ...(extra || {}) };
}

test('a fresh input state is idle', () => {
  const w = fakeWindow();
  const s = I.createInput(w);
  const a = I.axes(s, 1 / 60);
  assert.equal(a.pitch, 0);
  assert.equal(a.roll, 0);
  assert.equal(a.yaw, 0);
  assert.equal(a.throttle, 0);
  assert.equal(a.braking, false);
  assert.equal(a.boost, false);
  assert.equal(s.keys.size, 0);
});

test('pressing up pitches the nose up, not down', () => {
  // The load-bearing convention. flight.js documents pitch > 0 as "nose up",
  // and the input layer owns the human-expectation inversion.
  const w = fakeWindow();
  const s = I.createInput(w);
  w.fire('keydown', key('ArrowUp'));
  const a = I.axes(s, 1 / 60);
  assert.equal(a.pitch, 1, 'up arrow should command a positive pitch (nose up)');
  w.fire('keyup', key('ArrowUp'));
  assert.equal(I.axes(s, 1 / 60).pitch, 0);
});

test('W and the up arrow are the same command', () => {
  const w = fakeWindow();
  const s = I.createInput(w);
  w.fire('keydown', key('KeyW'));
  assert.equal(I.axes(s, 1 / 60).pitch, 1);
});

test('left and right roll in the expected directions', () => {
  const w = fakeWindow();
  const s = I.createInput(w);
  w.fire('keydown', key('ArrowRight'));
  assert.equal(I.axes(s, 1 / 60).roll, 1, 'right should be positive roll');
  w.fire('keyup', key('ArrowRight'));
  w.fire('keydown', key('ArrowLeft'));
  assert.equal(I.axes(s, 1 / 60).roll, -1, 'left should be negative roll');
});

test('yaw is on Q and E and does not collide with roll', () => {
  const w = fakeWindow();
  const s = I.createInput(w);
  w.fire('keydown', key('KeyE'));
  const a = I.axes(s, 1 / 60);
  assert.equal(a.yaw, 1);
  assert.equal(a.roll, 0, 'yaw leaked into roll');
});

test('throttle is on R and F and is a delta', () => {
  const w = fakeWindow();
  const s = I.createInput(w);
  w.fire('keydown', key('KeyR'));
  assert.equal(I.axes(s, 1 / 60).throttle, 1);
  w.fire('keyup', key('KeyR'));
  w.fire('keydown', key('KeyF'));
  assert.equal(I.axes(s, 1 / 60).throttle, -1);
});

test('braking is on X and on space, and throttle-down also brakes', () => {
  const w = fakeWindow();
  const s = I.createInput(w);
  w.fire('keydown', key('KeyX'));
  assert.equal(I.axes(s, 1 / 60).braking, true);
  w.fire('keyup', key('KeyX'));
  w.fire('keydown', key('Space'));
  assert.equal(I.axes(s, 1 / 60).braking, true, 'space should brake');
  w.fire('keyup', key('Space'));
  w.fire('keydown', key('KeyF'));
  assert.equal(I.axes(s, 1 / 60).braking, true, 'throttle-down should brake too');
});

test('opposing keys cancel out', () => {
  const w = fakeWindow();
  const s = I.createInput(w);
  w.fire('keydown', key('KeyW'));
  w.fire('keydown', key('KeyS'));
  assert.equal(I.axes(s, 1 / 60).pitch, 0, 'W and S together should be neutral');
});

test('losing focus releases every key', () => {
  // Without this, alt-tabbing with the throttle held leaves the ship
  // accelerating forever in an unseen window.
  const w = fakeWindow();
  const s = I.createInput(w);
  w.fire('keydown', key('KeyR'));
  w.fire('keydown', key('KeyW'));
  assert.equal(I.axes(s, 1 / 60).throttle, 1);
  w.fire('blur');
  const a = I.axes(s, 1 / 60);
  assert.equal(a.throttle, 0, 'blur did not release the throttle');
  assert.equal(a.pitch, 0, 'blur did not release pitch');
  assert.equal(s.keys.size, 0, 'blur did not clear the key set');
});

test('one-shot actions fire once per press, not once per frame', () => {
  // A laser that fires every frame while M is held would be a different game.
  const w = fakeWindow();
  const s = I.createInput(w);
  w.fire('keydown', key('KeyM'));
  assert.equal(I.consume(s, 'fire'), true, 'first press should fire');
  assert.equal(I.consume(s, 'fire'), false, 'second consume without a new press must not fire');
  I.endFrame(s);
  assert.equal(I.consume(s, 'fire'), false, 'endFrame must not re-arm the key');
  // Release and press again.
  w.fire('keyup', key('KeyM'));
  w.fire('keydown', key('KeyM'));
  assert.equal(I.consume(s, 'fire'), true, 'a fresh press should fire again');
});

test('auto-repeat does not requeue a held key', () => {
  // Browsers fire repeated keydown events while a key is held. Each one must
  // not become a new laser shot.
  const w = fakeWindow();
  const s = I.createInput(w);
  w.fire('keydown', key('KeyM'));
  w.fire('keydown', key('KeyM'));
  w.fire('keydown', key('KeyM'));
  assert.equal(I.consume(s, 'fire'), true);
  assert.equal(I.consume(s, 'fire'), false, 'key auto-repeat queued extra actions');
});

test('modifier combinations are ignored', () => {
  // Ctrl+S and friends must reach the browser, not the game.
  const w = fakeWindow();
  const s = I.createInput(w);
  w.fire('keydown', key('KeyM', { ctrlKey: true }));
  assert.equal(s.keys.has('KeyM'), false, 'ctrl+M was captured by the game');
  assert.equal(I.consume(s, 'fire'), false);
});

test('browser scroll keys are suppressed', () => {
  const w = fakeWindow();
  const s = I.createInput(w);
  let prevented = false;
  w.fire('keydown', { code: 'Space', ctrlKey: false, metaKey: false, altKey: false, preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'space would have scrolled the page');
});

test('destroyInput removes every listener', () => {
  const w = fakeWindow();
  const s = I.createInput(w);
  assert.ok(w.listenerCount() > 0);
  I.destroyInput(s);
  assert.equal(w.listenerCount(), 0, 'listeners leaked');
  // And the input must now be inert rather than throwing.
  w.fire('keydown', key('KeyM'));
  assert.equal(s.keys.size, 0);
});

test('every binding action resolves to at least one key code', () => {
  // A typo here is an action that silently never fires - the worst class of
  // bug in a control scheme because nothing looks wrong.
  for (const [action, codes] of Object.entries(I.BINDINGS)) {
    assert.ok(Array.isArray(codes), action + ' is not a list');
    assert.ok(codes.length > 0, action + ' has no keys bound');
    for (const c of codes) {
      assert.equal(typeof c, 'string');
      assert.ok(/^(Key[A-Z]|Arrow(Up|Down|Left|Right)|Digit\d|Space|F\d+|ShiftLeft|ControlLeft|Enter|Escape|Tab)$/.test(c),
        action + ' is bound to an implausible code: ' + c);
    }
  }
});

test('no key is bound to two conflicting movement actions', () => {
  // Two actions on the same key is occasionally intended (throttle-down and
  // brake), but the *movement axes* must be disjoint or one silently wins.
  const axisActions = ['pitchDown', 'pitchUp', 'rollLeft', 'rollRight', 'yawLeft', 'yawRight'];
  const seen = new Map();
  for (const a of axisActions) {
    for (const c of I.BINDINGS[a]) {
      assert.ok(!seen.has(c), c + ' is bound to both ' + seen.get(c) + ' and ' + a);
      seen.set(c, a);
    }
  }
});

test('the mouse is a centred virtual stick with a deadzone', () => {
  const w = fakeWindow();
  const s = I.createInput(w);
  s.pointerLocked = true;

  // Dead centre: no deflection.
  w.fire('mousemove', { clientX: 800, clientY: 450 });
  let a = I.axes(s, 1 / 60);
  assert.equal(a.roll, 0, 'a centred mouse should not steer');

  // A small offset inside the deadzone: still nothing.
  w.fire('mousemove', { clientX: 800 + 1600 * 0.03, clientY: 450 });
  a = I.axes(s, 1 / 60);
  assert.equal(a.roll, 0, 'inside the deadzone the stick must stay centred');

  // Far out: full deflection. Smoothing means it takes a few frames.
  w.fire('mousemove', { clientX: 1600 - 4, clientY: 450 });
  for (let i = 0; i < 240; i += 1) a = I.axes(s, 1 / 60);
  assert.ok(a.roll > 0.8, 'pushing the mouse right should roll right, got ' + a.roll);
});

test('the mouse cannot steer without pointer lock', () => {
  // Otherwise moving the cursor to click a menu button yanks the ship.
  const w = fakeWindow();
  const s = I.createInput(w);
  assert.equal(s.pointerLocked, false);
  w.fire('mousemove', { clientX: 1590, clientY: 450 });
  for (let i = 0; i < 120; i += 1) I.axes(s, 1 / 60);
  assert.equal(I.axes(s, 1 / 60).roll, 0, 'the mouse steered without pointer lock');
});

test('keyboard and mouse combine without exceeding full deflection', () => {
  const w = fakeWindow();
  const s = I.createInput(w);
  s.pointerLocked = true;
  w.fire('keydown', key('ArrowRight'));
  w.fire('mousemove', { clientX: 1600 - 4, clientY: 450 });
  for (let i = 0; i < 240; i += 1) I.axes(s, 1 / 60);
  const a = I.axes(s, 1 / 60);
  assert.ok(a.roll <= 1, 'axes exceeded full deflection: ' + a.roll);
  assert.ok(a.roll > 0.8, 'combined input lost authority: ' + a.roll);
});

test('mouse smoothing is frame-rate independent', () => {
  // Reaching the same stick position must take the same wall-clock time at
  // 30fps and at 144fps, or the ship handles differently on different machines.
  const measure = (dt) => {
    const w = fakeWindow();
    const s = I.createInput(w);
    s.pointerLocked = true;
    w.fire('mousemove', { clientX: 1600 - 4, clientY: 450 });
    let steps = 0;
    while (steps < 1000) {
      I.axes(s, dt);
      steps += 1;
      if (Math.abs(s.mouse.x) > 0.9) break;
    }
    return steps * dt; // seconds to reach 90% deflection
  };
  const t30 = measure(1 / 30);
  const t144 = measure(1 / 144);
  assert.ok(Math.abs(t30 - t144) < 0.05,
    'smoothing depends on frame rate: ' + t30.toFixed(3) + 's vs ' + t144.toFixed(3) + 's');
});

test('releasing pointer lock centres the virtual stick', () => {
  const w = fakeWindow();
  const s = I.createInput(w);
  s.pointerLocked = true;
  w.fire('mousemove', { clientX: 1600 - 4, clientY: 450 });
  for (let i = 0; i < 60; i += 1) I.axes(s, 1 / 60);
  s.pointerLocked = false;
  s.mouseTarget.x = 0;
  s.mouseTarget.y = 0;
  for (let i = 0; i < 240; i += 1) I.axes(s, 1 / 60);
  assert.ok(Math.abs(I.axes(s, 1 / 60).roll) < 0.02, 'the stick did not recentre');
});

test('invertPitch flips only the pitch axis', () => {
  const w = fakeWindow();
  const s = I.createInput(w, { invertPitch: true });
  w.fire('keydown', key('ArrowUp'));
  w.fire('keydown', key('ArrowRight'));
  const a = I.axes(s, 1 / 60);
  assert.equal(a.pitch, -1, 'invertPitch did not flip pitch');
  assert.equal(a.roll, 1, 'invertPitch should not touch roll');
});

test('the mouse can be disabled entirely', () => {
  const w = fakeWindow();
  const s = I.createInput(w, { mouse: false });
  s.pointerLocked = true;
  w.fire('mousemove', { clientX: 1590, clientY: 450 });
  for (let i = 0; i < 120; i += 1) I.axes(s, 1 / 60);
  assert.equal(I.axes(s, 1 / 60).roll, 0);
});

test('createInput tolerates a missing window', () => {
  // The module must not throw when imported in Node for the tests above, or
  // when a page is torn down mid-session.
  for (const arg of [null, undefined, {}]) {
    const s = I.createInput(arg);
    assert.ok(s);
    assert.equal(I.axes(s, 1 / 60).pitch, 0);
    assert.equal(I.consume(s, 'fire'), false);
    I.destroyInput(s);
  }
});

// --- One key, one action ---------------------------------------------------

test('no physical key is bound to two different actions', () => {
  // `fire` and `launchMissile` both carried KeyM - a leftover from the original
  // Elite, where M *was* the missile key. Because `fire` is read with `held` and
  // the missile with `consume`, both fired on the same press: measured, one
  // press of M with a target locked took the missile count from 3 to 2 *and*
  // put a tracer in the air. The commander's primary weapon key was quietly
  // draining their scarce missiles.
  //
  // `consume` hands a key to whichever caller asks first and removes it, so an
  // overlap is always silent: one of the two actions simply never happens, or
  // both do. Neither is a decision anybody made.
  const owner = new Map();
  for (const [action, codes] of Object.entries(I.BINDINGS)) {
    for (const code of codes) {
      if (owner.has(code)) {
        assert.fail(code + ' is bound to both `' + owner.get(code) + '` and `' + action + '`');
      }
      owner.set(code, action);
    }
  }
  assert.ok(owner.size > 20, 'the binding table looks empty: ' + owner.size);
});

test('the fire key is not also the missile key', () => {
  // Stated separately because it is the one overlap that actually happened, and
  // because it is the most expensive one: missiles are a handful per ship.
  for (const f of I.BINDINGS.fire) {
    assert.ok(!I.BINDINGS.missile.includes(f),
      'the fire key ' + f + ' also launches missiles');
  }
});
