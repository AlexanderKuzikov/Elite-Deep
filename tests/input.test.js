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
    // A canvas that exists, and can be locked.
    isConnected: true,
    lockRequests: 0,
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
    requestPointerLock() { this.lockRequests += 1; },
  };
  return el;
}

/**
 * The browser side of pointer lock: a `document` that knows which element is
 * locked, and can tell the window that it changed.
 *
 * Without this the mouse cannot be tested at all. `pointerLocked` is set from
 * `document.pointerLockElement`, so a test that only calls `requestPointerLock`
 * measures its own stub.
 */
function fakeDocument(win) {
  const listeners = new Map();
  return {
    pointerLockElement: null,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (listeners.has(type)) listeners.get(type).delete(fn);
    },
    fire(type) {
      const set = listeners.get(type);
      if (set) for (const fn of set) fn({});
      void win;
    },
    exitPointerLock() {
      this.pointerLockElement = null;
      this.fire('pointerlockchange');
    },
    /** Grant the lock to `el`, as the browser would. */
    grant(el) {
      this.pointerLockElement = el;
      this.fire('pointerlockchange');
    },
  };
}

/**
 * Attach a fake `document` for the duration of `body`, and take it away again.
 *
 * The module reads the global `document` directly - it has to, it is browser
 * code - so the test has to own that global while it runs.
 */
function withDocument(body) {
  const win = fakeWindow();
  const doc = fakeDocument(win);
  const had = 'document' in globalThis;
  const previous = globalThis.document;
  globalThis.document = doc;
  try {
    return body(win, doc);
  } finally {
    if (had) globalThis.document = previous; else delete globalThis.document;
  }
}

/** A key event with the fields the module reads. */
function key(code, extra) {
  return { code, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {}, ...(extra || {}) };
}

/** A mousemove carrying only the deltas, which is all pointer lock delivers. */
function move(dx, dy) {
  return { movementX: dx, movementY: dy };
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

// --- The mouse virtual stick -----------------------------------------------

/** Build a locked, mouse-enabled input whose viewport height is `h`. */
function capturedWindow(h) {
  const win = fakeWindow();
  win.innerHeight = h || 900;
  const doc = fakeDocument(win);
  return withDocumentOn(doc, () => {
    // `pointerTarget` is the window stand-in here for the same reason the real
    // game passes a canvas: the module only ever calls three things on it.
    const state = I.createInput(win, { pointerTarget: win });
    doc.grant(win);
    return { win, doc, state };
  });
}

/**
 * Run `body` with `doc` installed as the global `document`.
 *
 * The restore happens *after* the body, which matters: the grant has to be
 * delivered while the module can still see the document that describes it.
 */
function withDocumentOn(doc, body) {
  const had = 'document' in globalThis;
  const previous = globalThis.document;
  globalThis.document = doc;
  try {
    return body();
  } finally {
    if (had) globalThis.document = previous; else delete globalThis.document;
  }
}

test('the mouse is a spring-centred stick with a deadzone', () => {
  // The whole model in one test. Under pointer lock there is no cursor
  // position, so the stick is the *integral* of the movement - and it is a
  // spring, not a ratchet: a push that stops ends.
  const { win, doc, state } = capturedWindow();
  assert.equal(state.pointerLocked, true, 'the pointer is not captured');

  // A nudge well inside the deadzone: no turn at all. `MOUSE.deadzone` is a
  // fraction of the stick, so the pixel threshold is deadzone / gain.
  const insidePx = Math.floor(I.MOUSE.deadzone / I.MOUSE.gain * 0.5);
  win.fire('mousemove', move(insidePx, 0));
  assert.equal(I.axes(state, 1 / 60).roll, 0,
    'a nudge of ' + insidePx + 'px steered the ship');

  // A firm push to the right rolls right.
  win.fire('mousemove', move(60, 0));
  const pushed = I.axes(state, 1 / 60).roll;
  assert.ok(pushed > 0, 'pushing the mouse right should roll right, got ' + pushed);

  // Let go and it springs back. At 60 fps and a decay of 2.2 units/s, half a
  // second is more than enough to reach centre from any deflection.
  withDocumentOn(doc, () => {
    for (let i = 0; i < 40; i += 1) I.axes(state, 1 / 60);
  });
  assert.equal(I.axes(state, 1 / 60).roll, 0, 'the stick did not spring back to centre');
});

test('a slower drag turns more gently than a fast one', () => {
  // Proportionality is what makes the mouse usable rather than a light switch.
  const gentle = capturedWindow();
  gentle.win.fire('mousemove', move(30, 0));
  const small = I.axes(gentle.state, 1 / 60).roll;

  const hard = capturedWindow();
  hard.win.fire('mousemove', move(30, 0));
  hard.win.fire('mousemove', move(30, 0));
  hard.win.fire('mousemove', move(30, 0));
  const big = I.axes(hard.state, 1 / 60).roll;

  assert.ok(big > small * 2, 'three times the mouse travel did not turn harder: '
    + small + ' vs ' + big);
});

test('the stick saturates at the end of its travel', () => {
  // Past full deflection the ship must not turn harder, or a fast flick would
  // out-turn a held key.
  const { win, state } = capturedWindow();
  for (let i = 0; i < 40; i += 1) win.fire('mousemove', move(50, 0));
  const a = I.axes(state, 1 / 60);
  assert.ok(a.roll <= 1, 'the stick exceeded full deflection: ' + a.roll);
  assert.ok(a.roll > 0.8, 'a sustained drag did not reach the stop: ' + a.roll);
});

test('the spring rate does not depend on the frame rate', () => {
  // The same wall-clock push must give the same turn at 30 fps and at 144 fps,
  // or two players on the same machine but different settings fly different
  // ships. Measured as the deflection remaining after a fixed 0.25 s.
  const settled = (dt) => {
    const { win, state } = capturedWindow();
    win.fire('mousemove', move(80, 0));
    let frames = Math.round(0.25 / dt);
    for (let i = 0; i < frames; i += 1) I.axes(state, dt);
    return state.mouseTarget.x;
  };
  const t30 = settled(1 / 30);
  const t144 = settled(1 / 144);
  assert.ok(Math.abs(t30 - t144) < 0.06,
    'the spring is frame-rate dependent: ' + t30.toFixed(3) + ' vs ' + t144.toFixed(3));
});

test('the mouse cannot steer without pointer lock', () => {
  // Otherwise moving the cursor to click something yanks the ship.
  const win = fakeWindow();
  const state = I.createInput(win, { pointerTarget: win });
  assert.equal(state.pointerLocked, false);
  for (let i = 0; i < 20; i += 1) win.fire('mousemove', move(60, 0));
  assert.equal(I.axes(state, 1 / 60).roll, 0, 'the mouse steered without pointer lock');
});

test('keyboard and mouse combine without exceeding full deflection', () => {
  const { win, state } = capturedWindow();
  win.fire('keydown', key('ArrowRight'));
  for (let i = 0; i < 20; i += 1) win.fire('mousemove', move(40, 0));
  const a = I.axes(state, 1 / 60);
  assert.ok(a.roll <= 1, 'axes exceeded full deflection: ' + a.roll);
  assert.ok(a.roll > 0.8, 'the keyboard and mouse together lost authority: ' + a.roll);
});

test('releasing the pointer centres the virtual stick', () => {
  const { win, doc, state } = capturedWindow();
  for (let i = 0; i < 10; i += 1) win.fire('mousemove', move(40, 0));
  assert.ok(Math.abs(I.axes(state, 1 / 60).roll) > 0, 'the stick never moved');

  // Escape is the browser's own event, not the game's: it clears
  // `pointerLockElement` and fires the change. That is what the game has to
  // react to, because a player who presses Escape never tells the game.
  withDocumentOn(doc, () => doc.exitPointerLock());
  assert.equal(state.pointerLocked, false, 'the release was not noticed');
  assert.equal(state.mouseTarget.x, 0, 'the stick kept its deflection after the release');
  assert.equal(I.axes(state, 1 / 60).roll, 0, 'the ship kept turning after the pointer was let go');
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
  const win = fakeWindow();
  const doc = fakeDocument(win);
  const state = withDocumentOn(doc, () => {
    const s = I.createInput(win, { mouse: false, pointerTarget: win });
    doc.grant(win);
    return s;
  });
  win.fire('mousemove', move(200, 0));
  assert.equal(I.axes(state, 1 / 60).roll, 0);
  assert.equal(I.requestMouse(state), false, 'a disabled mouse still tried to lock');
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

// --- Pointer lock: asking, refusing and escaping ---------------------------

test('the lock is requested on the pointer target, not on the key target', () => {
  // The defect this whole feature was blocked on: `createInput` was handed the
  // window so key events would arrive whatever had focus, and the window has no
  // `requestPointerLock` at all - so every request quietly returned false.
  const win = fakeWindow();
  const canvas = fakeWindow();
  const doc = fakeDocument(win);
  const state = withDocumentOn(doc, () => I.createInput(win, { pointerTarget: canvas }));

  assert.equal(I.requestMouse(state), true, 'the request was not made');
  assert.equal(canvas.lockRequests, 1, 'the canvas was not asked for the lock');
  assert.equal(win.lockRequests || 0, 0, 'the window was asked for a lock it cannot give');
});

test('a second request while already captured is not sent', () => {
  const { win, state } = capturedWindow();
  const before = win.lockRequests;
  assert.equal(I.requestMouse(state), false);
  assert.equal(win.lockRequests, before, 'a redundant lock request was sent');
});

test('one refusal does not kill the mouse for the session', () => {
  // The old behaviour made a single refusal permanent, and that was the bug:
  // a click that landed a frame too early cost the player the mouse until they
  // reloaded the page. A refusal is counted, not carved in stone.
  const win = fakeWindow();
  const doc = fakeDocument(win);
  const state = withDocumentOn(doc, () => I.createInput(win, { pointerTarget: win }));

  assert.equal(I.requestMouse(state), true);
  doc.fire('pointerlockerror');
  assert.equal(state.lockFailures, 1, 'the refusal was not counted');
  assert.equal(I.lockRefused(state), false, 'one refusal was treated as permanent');

  const before = win.lockRequests;
  assert.equal(I.requestMouse(state), true, 'the next honest gesture was refused');
  assert.equal(win.lockRequests, before + 1, 'the retry was not actually sent');
});

test('one gesture counts one refusal, not two', async () => {
  // Chrome both rejects the request promise and fires `pointerlockerror` for
  // the same gesture. Counting both scored a single refusal as two and halved
  // the patience the threshold promises.
  const win = fakeWindow();
  win.requestPointerLock = function () {
    this.lockRequests += 1;
    return Promise.reject(new Error('no gesture'));
  };
  const doc = fakeDocument(win);
  const state = withDocumentOn(doc, () => I.createInput(win, { pointerTarget: win }));

  I.requestMouse(state);
  doc.fire('pointerlockerror');
  await new Promise((r) => setImmediate(r));
  assert.equal(state.lockFailures, 1, 'one gesture scored twice');
  assert.equal(I.lockRefused(state), false);
});

test('the game gives up only after repeated refusals', () => {
  const win = fakeWindow();
  const doc = fakeDocument(win);
  const state = withDocumentOn(doc, () => I.createInput(win, { pointerTarget: win }));

  for (let i = 0; i < I.MOUSE.giveUpAfter; i += 1) {
    I.requestMouse(state);
    doc.fire('pointerlockerror');
  }
  assert.equal(I.lockRefused(state), true, 'the game never gave up');
  const before = win.lockRequests;
  assert.equal(I.requestMouse(state), false, 'the game kept asking after giving up');
  assert.equal(win.lockRequests, before, 'a request was sent after giving up');
});

test('a lock that comes back clears the refusal count', () => {
  // The counter is a run of failures, not a lifetime tally: the browser
  // granting a lock is proof the next one can be granted too.
  const win = fakeWindow();
  const doc = fakeDocument(win);
  const state = withDocumentOn(doc, () => I.createInput(win, { pointerTarget: win }));

  I.requestMouse(state);
  doc.fire('pointerlockerror');
  assert.equal(state.lockFailures, 1);

  withDocumentOn(doc, () => doc.grant(win));
  assert.equal(state.lockFailures, 0, 'a granted lock left the count standing');
  assert.equal(I.lockRefused(state), false);
});

test('the host is told when the pointer is captured and released', () => {
  // A host that keeps its own UI over the canvas has to know: while the pointer
  // is captured its clicks go to the game.
  const seen = [];
  const win = fakeWindow();
  const doc = fakeDocument(win);
  const state = withDocumentOn(doc, () => {
    const s = I.createInput(win, {
      pointerTarget: win,
      onPointerLock: (v) => seen.push(v),
    });
    I.addPointerLock(s, (v) => seen.push('observer:' + v));
    doc.grant(win);
    return s;
  });
  void state;

  withDocumentOn(doc, () => doc.exitPointerLock());
  assert.deepEqual(seen, [true, 'observer:true', false, 'observer:false']);
});

test('Escape cannot be re-captured on the next frame', () => {
  // Escape is how a player gets their cursor back. If the game re-locks
  // immediately the cursor never reappears and the key looks broken; Chrome
  // also refuses a re-lock that soon, so the attempt is wasted anyway.
  const { win, state } = capturedWindow();
  I.releaseMouse(state);
  assert.ok(state.relockIn > 0, 'the release set no cooldown');
  assert.equal(I.requestMouse(state), false, 'the lock was taken straight back');

  // Half a second in, still refused.
  for (let i = 0; i < 30; i += 1) I.endFrame(state);
  assert.ok(state.relockIn > 0);
  assert.equal(I.requestMouse(state), false, 'the lock came back before the cooldown ended');

  // Past the cooldown, allowed again.
  for (let i = 0; i < 60; i += 1) I.endFrame(state);
  assert.equal(state.relockIn, 0, 'the cooldown never expired');
  assert.equal(I.requestMouse(state), true, 'the lock could not be taken back at all');
  void win;
});

test('the browser taking the pointer back arms the same cooldown', () => {
  // This is the defect the review found, and it is worth stating plainly: only
  // the *programmatic* release armed the cooldown, so a browser release -
  // Escape, which is the one the player is told to use - went straight past it.
  // The next click asked for the pointer immediately, Chrome refused (its own
  // post-Escape ban lasts about a second), the refusal was permanent, and the
  // mouse was dead until the page was reloaded.
  const { doc, state } = capturedWindow();
  assert.equal(I.mouseActive(state), true);

  withDocumentOn(doc, () => doc.exitPointerLock());
  assert.equal(I.mouseActive(state), false, 'the pointer was still locked');
  assert.ok(state.relockIn > 0, 'a browser release armed no cooldown');
  assert.equal(I.requestMouse(state), false, 'the pointer was taken back on the next frame');
});

test('a release the game decides on is quiet, so a routine undock still flies', () => {
  // Docking takes the cursor back to show the station screen, and the player
  // pressed nothing. The player-facing cooldown answered a question nobody
  // asked: dock, undock a second later, and the ship launched with a dead
  // mouse and a hint telling the player to click - the same symptom as the bug
  // the cooldown was added to fix, but with no Escape in the story.
  const { doc, state } = capturedWindow();
  assert.equal(I.mouseActive(state), true);

  withDocumentOn(doc, () => I.releaseMouse(state, true));
  assert.equal(state.pointerLocked, false, 'the pointer was not released');
  assert.equal(state.relockIn, 0, 'a quiet release armed the player-facing cooldown');
  assert.equal(I.requestMouse(state), true,
    'the pointer could not be taken back after a quiet release');
});

test('a quiet release still stands in for Escape when asked to', () => {
  // The other half: the cooldown has to survive for the case it exists for.
  // `releaseMouse` with no second argument is the Escape-equivalent path, and
  // it must still refuse an immediate re-lock.
  const { doc, state } = capturedWindow();
  withDocumentOn(doc, () => I.releaseMouse(state));
  assert.ok(state.relockIn > 0, 'an Escape-equivalent release armed no cooldown');
  assert.equal(I.requestMouse(state), false, 'the pointer came back on the next frame');
});

test('the change event a quiet release fires does not re-arm the cooldown', () => {
  // The ordering hazard: `exitPointerLock` fires `pointerlockchange`, whose
  // handler arms the cooldown by default. If the handler did not know the call
  // was quiet, every docking would arm the player-facing delay through the
  // back door - the flag would be pointless. So the release and the event it
  // causes are checked together, in the only order that happens.
  const { doc, state } = capturedWindow();
  withDocumentOn(doc, () => {
    // One call. It fires `pointerlockchange` internally, as the browser does.
    I.releaseMouse(state, true);
  });
  assert.equal(state.relockIn, 0,
    'the change event re-armed the cooldown after a quiet release');
  assert.equal(state.quietRelease, false, 'the quiet flag was not consumed');
});

test('a later, separate loss is not silenced by an earlier quiet release', () => {
  // The flag has to be consumed, not sticky. A commander who docks (quiet),
  // undocks, and then presses Escape must still get the cooldown - otherwise
  // the one case the delay exists for stops working after the first dock.
  const { doc, state } = capturedWindow();
  withDocumentOn(doc, () => {
    I.releaseMouse(state, true);
    doc.grant(state.pointerTarget);
    assert.equal(I.mouseActive(state), true, 'the pointer was not taken back');
    // Now a genuine browser release, with no quiet flag anywhere.
    doc.exitPointerLock();
  });
  assert.ok(state.relockIn > 0,
    'Escape after a quiet release armed no cooldown');
  assert.equal(I.requestMouse(state), false, 'the pointer came back on the next frame');
});

test('a refusal after Escape is not fatal', () => {  // The whole chain: Escape, an impatient click, a browser refusal. The last
  // step used to end the session's mouse control. Now it costs one attempt.
  const { doc, win, state } = capturedWindow();
  const before = win.lockRequests;
  withDocumentOn(doc, () => doc.exitPointerLock());
  doc.fire('pointerlockerror');
  assert.equal(I.lockRefused(state), false, 'one refusal after Escape was treated as final');

  // Wait out the cooldown; the next gesture must be able to work.
  for (let i = 0; i < 120; i += 1) I.endFrame(state);
  assert.equal(I.requestMouse(state), true, 'the mouse never came back after Escape');
  assert.equal(win.lockRequests, before + 1, 'the request was not actually sent');
});

test('the cooldown comes down even when nobody is flying', () => {
  // `lastDt` is refreshed by `axes`, and `axes` only runs while flying. So a
  // cooldown that rode `lastDt` alone stopped dead the moment the player was
  // docked, on the chart, or at the title - the exact places the pointer is
  // released on purpose. Escape at the title left the timer stuck a shade above
  // 1.4 s, so the next gesture was refused, and the retry after that was
  // refused as well: the player's mouse never came back at all.
  const { doc, state } = capturedWindow();
  // No `axes` call anywhere in this test, which is the whole point.
  withDocumentOn(doc, () => doc.exitPointerLock());
  assert.ok(state.relockIn > 1, 'the release armed no cooldown to begin with');

  // Two seconds of frames at 1/60, passed the way `main.js` passes it.
  for (let i = 0; i < 120; i += 1) I.endFrame(state, 1 / 60);
  assert.equal(state.relockIn, 0, 'the cooldown froze because no frame set `lastDt`');
});

test('mouseActive answers whether the mouse is really flying the ship', () => {
  const { doc, state } = capturedWindow();
  assert.equal(I.mouseActive(state), true);
  withDocumentOn(doc, () => doc.exitPointerLock());
  assert.equal(I.mouseActive(state), false, 'a released pointer still counted as active');
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
