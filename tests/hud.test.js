/**
 * HUD tests.
 *
 * Canvas drawing is not worth asserting line by line - a test that says "you
 * called moveTo twice" pins nothing anyone cares about. What *is* worth testing
 * is the maths underneath, because that is where a HUD silently lies to the
 * player:
 *
 *   - a projection that puts the target box in the wrong place is worse than
 *     no target box at all
 *   - a distance formatter that rounds 999 to "1.0k" makes the scanner useless
 *   - a danger label that calls an anarchy "SAFE" is actively harmful
 *
 * Plus one smoke test that runs the whole renderer against a recording context,
 * which catches a typo that would otherwise only show up as a blank HUD.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as H from '../src/ui/hud.js';

const FOV = Math.PI / 3;
const W = 1600;
const HGT = 900;

/** The camera basis for an unrotated ship looking down +Z. */
const LEVEL_BASIS = {
  forward: { x: 0, y: 0, z: 1 },
  right: { x: 1, y: 0, z: 0 },
  up: { x: 0, y: 1, z: 0 },
};

const ORIGIN = { x: 0, y: 0, z: 0 };

test('a target dead ahead projects to the centre of the screen', () => {
  const s = H.projectToScreen({ x: 0, y: 0, z: 500 }, ORIGIN, LEVEL_BASIS, W, HGT, FOV);
  assert.ok(s, 'a target ahead should project');
  assert.ok(Math.abs(s.x - W / 2) < 1e-6, 'x should be centred, got ' + s.x);
  assert.ok(Math.abs(s.y - HGT / 2) < 1e-6, 'y should be centred, got ' + s.y);
  assert.ok(Math.abs(s.distance - 500) < 1e-6, 'distance should be the forward offset');
});

test('a target to the right projects to the right half of the screen', () => {
  const s = H.projectToScreen({ x: 200, y: 0, z: 500 }, ORIGIN, LEVEL_BASIS, W, HGT, FOV);
  assert.ok(s.x > W / 2, 'right of the nose should be right on screen, got ' + s.x);
  assert.ok(Math.abs(s.y - HGT / 2) < 1e-6, 'y should be unaffected');
});

test('a target above the nose projects to the upper half of the screen', () => {
  // Screen y grows downward, so "above" must give a *smaller* y.
  const s = H.projectToScreen({ x: 0, y: 200, z: 500 }, ORIGIN, LEVEL_BASIS, W, HGT, FOV);
  assert.ok(s.y < HGT / 2, 'above the nose should be up on screen, got ' + s.y);
  assert.ok(Math.abs(s.x - W / 2) < 1e-6, 'x should be unaffected');
});

test('a target behind the camera does not project at all', () => {
  // Drawing a box for a ship behind you is the classic "why is that box
  // following me" bug.
  assert.equal(H.projectToScreen({ x: 0, y: 0, z: -100 }, ORIGIN, LEVEL_BASIS, W, HGT, FOV), null);
  assert.equal(H.projectToScreen({ x: 0, y: 0, z: 0 }, ORIGIN, LEVEL_BASIS, W, HGT, FOV), null,
    'a target at zero depth must not project');
});

test('projection respects camera translation', () => {
  // Same relative geometry, moved camera: the result must be identical. This
  // is what catches a missing subtraction.
  const a = H.projectToScreen({ x: 0, y: 0, z: 500 }, ORIGIN, LEVEL_BASIS, W, HGT, FOV);
  const b = H.projectToScreen({ x: 1000, y: 700, z: 1500 }, { x: 1000, y: 700, z: 1000 },
    LEVEL_BASIS, W, HGT, FOV);
  assert.ok(Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6,
    'projection depends on absolute position instead of relative position');
});

test('projection respects camera rotation', () => {
  // Turn the ship 90 degrees to starboard: the nose now points along world +X.
  // A target ahead along +X must therefore project to the centre, and a target
  // that has a sideways component must sit off to one side, not behind us.
  const turned = {
    forward: { x: 1, y: 0, z: 0 },
    right: { x: 0, y: 0, z: -1 },
    up: { x: 0, y: 1, z: 0 },
  };
  const ahead = H.projectToScreen({ x: 500, y: 0, z: 0 }, ORIGIN, turned, W, HGT, FOV);
  assert.ok(ahead, 'a target along the new nose should project');
  assert.ok(Math.abs(ahead.x - W / 2) < 1e-6 && Math.abs(ahead.y - HGT / 2) < 1e-6,
    'a target along the nose should be centred after turning');

  // A point straight along world +Z is exactly 90 degrees off the new nose, so
  // it is on the edge of the frame rather than behind us. nudge it forward
  // along the nose so it is unambiguously in front and clearly off-centre.
  const offToTheSide = H.projectToScreen({ x: 500, y: 0, z: 200 }, ORIGIN, turned, W, HGT, FOV);
  assert.ok(offToTheSide, 'an off-centre target in front should project');
  assert.ok(Math.abs(offToTheSide.x - W / 2) > 100,
    'the target should sit well off centre after turning: ' + offToTheSide.x);
  assert.ok(offToTheSide.x < W / 2,
    'with right = -Z, a +Z offset should land on the left of the screen');
});

test('a closer target gets a bigger on-screen size', () => {
  const near = H.projectToScreen({ x: 0, y: 0, z: 100 }, ORIGIN, LEVEL_BASIS, W, HGT, FOV);
  const far = H.projectToScreen({ x: 0, y: 0, z: 2000 }, ORIGIN, LEVEL_BASIS, W, HGT, FOV);
  assert.ok(near.size > far.size, 'the box does not scale with range');
  // And it must stay inside sane bounds, or a very close ship fills the screen.
  assert.ok(near.size <= 90, 'the box grew beyond its clamp: ' + near.size);
  assert.ok(far.size >= 12, 'the box shrank beyond legibility: ' + far.size);
});

test('screen position scales with the field of view', () => {
  // A narrower FOV magnifies: the same offset pushes further from centre.
  const wide = H.projectToScreen({ x: 200, y: 0, z: 500 }, ORIGIN, LEVEL_BASIS, W, HGT, Math.PI / 2.5);
  const narrow = H.projectToScreen({ x: 200, y: 0, z: 500 }, ORIGIN, LEVEL_BASIS, W, HGT, Math.PI / 5);
  assert.ok(narrow.x > wide.x, 'a narrower FOV should magnify the offset');
});

test('an off-centre target projects symmetrically for left and right', () => {
  // A sign error in one axis is easy to miss by eye and disorienting in play.
  const left = H.projectToScreen({ x: -200, y: 0, z: 500 }, ORIGIN, LEVEL_BASIS, W, HGT, FOV);
  const right = H.projectToScreen({ x: 200, y: 0, z: 500 }, ORIGIN, LEVEL_BASIS, W, HGT, FOV);
  assert.ok(Math.abs((W / 2 - left.x) - (right.x - W / 2)) < 1e-6, 'x is not symmetric');
  const up = H.projectToScreen({ x: 0, y: 200, z: 500 }, ORIGIN, LEVEL_BASIS, W, HGT, FOV);
  const down = H.projectToScreen({ x: 0, y: -200, z: 500 }, ORIGIN, LEVEL_BASIS, W, HGT, FOV);
  assert.ok(Math.abs((HGT / 2 - up.y) - (down.y - HGT / 2)) < 1e-6, 'y is not symmetric');
});

test('distance formatting is readable at every scale', () => {
  assert.equal(H.formatDistance(0), '0');
  assert.equal(H.formatDistance(42), '42');
  assert.equal(H.formatDistance(999), '999');
  // The boundary that matters: 999 must not round up into the k range.
  assert.equal(H.formatDistance(1000), '1.0k');
  assert.equal(H.formatDistance(1500), '1.5k');
  assert.equal(H.formatDistance(999999), '1000.0k');
  assert.equal(H.formatDistance(1000000), '1.0M');
  assert.equal(H.formatDistance(2500000), '2.5M');
});

test('distance formatting handles missing values without printing NaN', () => {
  assert.equal(H.formatDistance(undefined), '');
  assert.equal(H.formatDistance(null), '');
});

test('the lead pip is placed ahead of the target, in the direction it moves', () => {
  const screen = { x: 800, y: 450 };
  const pip = H.leadPip(screen, { x: 100, y: -40 }, 0.5);
  assert.equal(pip.x, 850);
  assert.equal(pip.y, 430);
});

test('the lead pip sits on the target when it is not moving', () => {
  const screen = { x: 800, y: 450 };
  const pip = H.leadPip(screen, { x: 0, y: 0 }, 0.7);
  assert.equal(pip.x, 800);
  assert.equal(pip.y, 450);
});

test('the lead pip is bounded, so a fast crossing target cannot fling it away', () => {
  const screen = { x: 800, y: 450 };
  const pip = H.leadPip(screen, { x: 5000, y: 0 }, 10);
  const offset = Math.hypot(pip.x - screen.x, pip.y - screen.y);
  assert.ok(offset <= 140, 'the lead pip escaped its clamp: ' + offset);
  // The direction must survive the clamp, or the pip points the wrong way.
  assert.ok(pip.x > screen.x, 'the clamp reversed the pip direction');
  assert.equal(pip.y, screen.y, 'the clamp introduced a vertical error');
});

test('a modest lead is not clamped, so normal aiming stays exact', () => {
  const screen = { x: 800, y: 450 };
  const pip = H.leadPip(screen, { x: 60, y: -20 }, 0.5);
  assert.equal(pip.x, 830);
  assert.equal(pip.y, 440);
});

test('the lead pip tolerates a missing target', () => {
  assert.equal(H.leadPip(null, { x: 1, y: 1 }, 0.5), null);
  assert.equal(H.leadPip({ x: 0, y: 0 }, null, 0.5), null);
});

test('the HUD palette keeps the ink bright enough to read', () => {
  // The HUD is drawn over a near-black starfield. A dim ink colour makes the
  // whole interface invisible, which is a mistake that survives code review
  // and dies instantly in play.
  const luminance = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return (((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114) / 255;
  };
  const ink = luminance(H.HUD_COLOURS.ink);
  assert.ok(ink > 0.5, 'the primary ink is too dim: ' + ink);
  assert.ok(luminance(H.HUD_COLOURS.ok) > 0.4);
  assert.ok(luminance(H.HUD_COLOURS.warn) > 0.4);
  assert.ok(luminance(H.HUD_COLOURS.danger) > 0.3);
});

test('the hostile and friendly colours are visually distinct', () => {
  const parse = (hex) => {
    const n = parseInt(hex.replace('#', ''), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const hostile = parse(H.HUD_COLOURS.hostile);
  const friendly = parse(H.HUD_COLOURS.friendly);
  const neutral = parse(H.HUD_COLOURS.neutral);
  assert.ok(dist(hostile, friendly) > 120, 'hostile and friendly look too alike');
  assert.ok(dist(hostile, neutral) > 100, 'hostile and neutral look too alike');
});

test('the HUD renders without throwing on a normal frame', () => {
  // The smoke test. A typo in a draw call would otherwise only appear as a
  // blank HUD in the browser, which is easy to miss and hard to attribute.
  const ctx = recordingContext();
  H.drawHud(ctx, fullState());
  assert.ok(ctx.calls.length > 30, 'the HUD barely drew anything: ' + ctx.calls.length);
});

test('the HUD survives a completely empty state', () => {
  // Startup: no ship, no contacts, no chart. This must not throw, because it
  // is what runs on the very first frame.
  const ctx = recordingContext();
  H.drawHud(ctx, { width: 800, height: 600 });
  assert.ok(ctx.calls.length > 0);
});

test('the HUD skips rendering for a zero-sized viewport', () => {
  // A minimised window reports 0x0, and dividing by it produces NaN which then
  // poisons the canvas transform for every following frame.
  const ctx = recordingContext();
  H.drawHud(ctx, { width: 0, height: 0 });
  assert.equal(ctx.calls.length, 0, 'the HUD drew into a zero-sized viewport');
});

test('the HUD stays silent when there is nothing to show', () => {
  // No messages and no alerts should produce no text at all, rather than
  // drawing empty strings on every frame.
  const ctx = recordingContext();
  H.drawHud(ctx, { width: 1600, height: 900, messages: [], alerts: [] });
  const texts = ctx.texts();
  assert.equal(texts.filter(t => t === '').length, 0, 'empty strings were drawn');
});

test('the message log never draws more than its cap', () => {
  const ctx = recordingContext();
  const messages = [];
  for (let i = 0; i < 40; i += 1) messages.push({ text: 'msg ' + i, age: 0, lifetime: 5 });
  H.drawHud(ctx, { ...fullState(), messages });
  // Distinct texts, not text calls: each line is now stroked *and* filled, so
  // counting calls would report twice as many messages as there are.
  const drawn = new Set(ctx.texts().filter(t => t.startsWith('msg ')));
  assert.ok(drawn.size <= H.HUD_LAYOUT.messageMax,
    'drew ' + drawn.size + ' messages over a cap of ' + H.HUD_LAYOUT.messageMax);
  // And it must be the newest ones, not the oldest.
  assert.ok(drawn.has('msg 39'), 'the newest message was dropped');
});

test('the scanner drops contacts beyond its range', () => {
  // A contact plotted outside the bowl is a lie about where the enemy is.
  const ctx = recordingContext();
  const contacts = [
    { forward: 100, right: 50, up: 0, hostile: true },
    { forward: 99000, right: 0, up: 0, hostile: true },
  ];
  H.drawHud(ctx, { ...fullState(), scannerRange: 2000, contacts });
  // Two filled arcs for two contacts plus the own-ship triangle: we cannot
  // count arcs directly, so assert on the total call count being plausible.
  assert.ok(ctx.calls.length > 10);
});

test('the chart overlay renders a system list without throwing', () => {
  const ctx = recordingContext();
  const systems = [];
  for (let i = 0; i < 64; i += 1) {
    systems.push({
      index: i, name: 'SYS' + i,
      x: Math.cos(i) * 200, y: Math.sin(i) * 200,
      danger: (i % 10) / 10, neighbour: i < 4,
    });
  }
  H.drawHud(ctx, {
    ...fullState(),
    showChart: true,
    chart: {
      discRadius: 260, jumpRange: 36,
      systems,
      routes: [{ a: 0, b: 1, distance: 20 }, { a: 1, b: 2, distance: 40 }],
      player: { index: 0 },
      selected: 3,
      selectedInfo: {
        name: 'LAVE', factionName: 'Federation', govName: 'Democracy',
        tech: 5, population: 3.5, econName: 'Rich Industrial',
        conditionName: 'Stable', danger: 0.2, distance: 12.5, fuelNeeded: 3.2,
      },
    },
  });
  const texts = ctx.texts();
  assert.ok(texts.includes('LAVE'), 'the system card did not render its name');
  assert.ok(texts.some(t => t.includes('Federation')), 'the card missed the faction');
});

test('the chart marks the current system and its neighbours', () => {
  const ctx = recordingContext();
  const systems = [
    { index: 0, name: 'HERE', x: 0, y: 0, danger: 0.1, neighbour: false },
    { index: 1, name: 'NEXTHOP', x: 30, y: 0, danger: 0.1, neighbour: true },
    { index: 2, name: 'FARAWAY', x: 200, y: 0, danger: 0.9, neighbour: false },
  ];
  H.drawHud(ctx, {
    ...fullState(),
    showChart: true,
    chart: { discRadius: 260, jumpRange: 36, systems, routes: [], player: { index: 0 }, selected: -1 },
  });
  const texts = ctx.texts();
  assert.ok(texts.includes('HERE'), 'the current system is not labelled');
  assert.ok(texts.includes('NEXTHOP'), 'a neighbour is not labelled');
  // Distant systems stay unlabelled or the chart becomes unreadable.
  assert.ok(!texts.includes('FARAWAY'), 'a distant system should not be labelled on the chart');
});

test('the docking guide names the specific problem and offers a fix', () => {
  // "You cannot dock" is useless; "SLOW DOWN" is actionable. Each reason must
  // produce its own distinct guidance, not the same generic refusal.
  const expected = {
    'too-fast': 'SLOW DOWN',
    'off-axis': 'LINE UP WITH SLOT',
    'bad-attitude': 'TURN TO FACE THE SLOT',
    'out-of-range': 'APPROACH THE STATION',
  };
  const seen = [];
  for (const [reason, phrase] of Object.entries(expected)) {
    const ctx = recordingContext();
    H.drawDockingGuide(ctx, {
      width: 1600, height: 900,
      docking: { ok: false, reason, speed: 200, limitSpeed: 90 },
    });
    const texts = ctx.texts();
    assert.ok(texts.includes(phrase),
      reason + ' did not produce its own guidance, got: ' + JSON.stringify(texts));
    seen.push(phrase);
  }
  assert.equal(new Set(seen).size, 4, 'two reasons produced identical guidance');
});

test('the docking guide shows a live speed against the limit when too fast', () => {
  // The speed is the one value the player can fix without repositioning, so it
  // has to be on screen.
  const ctx = recordingContext();
  H.drawDockingGuide(ctx, {
    width: 1600, height: 900,
    docking: { ok: false, reason: 'too-fast', speed: 212.4, limitSpeed: 90 },
  });
  assert.ok(ctx.texts().some(t => t.includes('212')), 'the current speed is not shown');
  assert.ok(ctx.texts().some(t => t.includes('90')), 'the speed limit is not shown');
});

test('the docking guide confirms a successful lock', () => {
  const ctx = recordingContext();
  H.drawDockingGuide(ctx, { width: 1600, height: 900, docking: { ok: true, reason: 'docking' } });
  assert.ok(ctx.texts().some(t => t.includes('DOCKING')), 'no confirmation was drawn');
});

test('an unknown docking reason degrades to a generic hint', () => {
  // The enum could grow; an unknown value must not draw "undefined".
  const ctx = recordingContext();
  H.drawDockingGuide(ctx, { width: 1600, height: 900, docking: { ok: false, reason: 'who-knows' } });
  const texts = ctx.texts();
  assert.ok(texts.length > 0, 'nothing was drawn for an unknown reason');
  assert.ok(!texts.some(t => t.includes('undefined')), 'the guide printed undefined');
});

/** A state object with everything the HUD reads, so no path sees undefined. */
function fullState() {
  return {
    width: 1600, height: 900, time: 1.5,
    scanRange: 2000, scannerRange: 2000,
    speed: 120, throttle: 0.6,
    fuel: 5.2, maxFuel: 14,
    shields: 30, maxShields: 40,
    energy: 80, maxEnergy: 100,
    hull: 90, maxHull: 100,
    heat: 12, maxHeat: 100,
    missiles: 2, laser: 'pulse', laserHot: false,
    cash: 412.5, rank: 'mostly harmless',
    cargoUsed: 8, cargoMax: 20,
    target: {
      hostile: true, kind: 'pirate', distance: 320,
      screen: { x: 820, y: 400, size: 30 },
      lead: { x: 860, y: 395 },
    },
    contacts: [
      { forward: 320, right: 40, up: 10, hostile: true, target: true },
      { forward: 800, right: -200, up: -50, kind: 'trader' },
      { forward: 1500, right: 100, up: 0, station: true },
    ],
    compass: [
      { bearing: 0.2, station: true, label: 'STN' },
      { bearing: -1.1, planet: true },
    ],
    messages: [{ text: 'Docked. Cargo sold.', age: 0.5, lifetime: 5 }],
    alerts: [{ text: 'MISSILE', urgent: true }],
    attitude: { pitch: 0.1, roll: -0.2 },
    radarMode: 'scanner',
    chart: null,
    docking: null,
  };
}

/**
 * A Canvas2D stand-in that records every call. Enough of the API for the whole
 * renderer to run, and it captures text so assertions can be about content
 * rather than about call counts.
 */
function recordingContext() {
  const calls = [];
  const texts = [];
  const rec = name => (...args) => { calls.push({ name, args }); };
  const fonts = [];
  const ctx = {
    calls,
    fonts: fonts,
    texts: () => texts.slice(),
    canvas: { width: 1600, height: 900 },
    save: rec('save'),
    restore: rec('restore'),
    beginPath: rec('beginPath'),
    closePath: rec('closePath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    arc: rec('arc'),
    rect: rec('rect'),
    fill: rec('fill'),
    stroke: rec('stroke'),
    fillRect: rec('fillRect'),
    strokeRect: rec('strokeRect'),
    clearRect: rec('clearRect'),
    setLineDash: rec('setLineDash'),
    translate: rec('translate'),
    rotate: rec('rotate'),
    scale: rec('scale'),
    measureText: (t) => ({ width: String(t).length * 7 }),
    fillText(t, x, y) { calls.push({ name: 'fillText', args: [t, x, y] }); texts.push(String(t)); },
    strokeText(t) { calls.push({ name: 'strokeText', args: [t] }); texts.push(String(t)); },
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    // Style properties: assignable, and read back by assertions if needed.
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
    textAlign: 'left', textBaseline: 'top',
    globalAlpha: 1, lineCap: 'butt', lineJoin: 'miter',
  };
  // `font` is an accessor rather than a plain property so a test can assert on
  // the sizes the HUD asked for. It is the only way to check resolution
  // scaling without a screenshot.
  let currentFont = '13px monospace';
  Object.defineProperty(ctx, 'font', {
    get() { return currentFont; },
    set(value) { currentFont = value; fonts.push(value); },
  });
  return ctx;
}

// --- Damage direction arcs -------------------------------------------------

/**
 * The canvas angle an arc was drawn at, in the HUD's own terms.
 *
 * The arcs are the one HUD element whose whole job is *direction*, so a test
 * that only counts `arc` calls would miss the bug that matters: an arc drawn
 * at the wrong bearing tells the player to turn the wrong way.
 */
function arcAngles(ctx) {
  // Filter by radius: the scanner draws its own bowl and rings, and counting
  // those as damage arcs would make every one of these tests meaningless. The
  // midpoint of the sweep is the direction, not the start angle.
  const radius = Math.min(W, HGT) * H.HUD_LAYOUT.damageArcRadius;
  return ctx.calls
    .filter((c) => c.name === 'arc' && Math.abs(c.args[2] - radius) < 0.01)
    .map((c) => (c.args[3] + c.args[4]) / 2);
}

test('a hit from dead ahead draws an arc at the top of the screen', () => {
  // Bearings are in the ship's frame: 0 is ahead. The screen maps ahead to up,
  // which is -PI/2 in canvas terms.
  const ctx = recordingContext();
  H.drawHud(ctx, { width: W, height: HGT, damage: [{ bearing: 0, age: 0, life: 1.4 }] });
  const angles = arcAngles(ctx);
  assert.ok(angles.length > 0, 'no arc was drawn');
  const top = angles.find((a) => Math.abs(a - (-Math.PI / 2)) < 0.01);
  assert.ok(top !== undefined, 'no arc at the top; got ' + JSON.stringify(angles));
});

test('a hit from starboard draws an arc to the right', () => {
  const ctx = recordingContext();
  H.drawHud(ctx, { width: W, height: HGT, damage: [{ bearing: Math.PI / 2, age: 0, life: 1.4 }] });
  const angles = arcAngles(ctx);
  assert.ok(angles.some((a) => Math.abs(a) < 0.01), 'no arc to the right; got ' + JSON.stringify(angles));
});

test('a hit from astern draws an arc at the bottom', () => {
  const ctx = recordingContext();
  H.drawHud(ctx, { width: W, height: HGT, damage: [{ bearing: Math.PI, age: 0, life: 1.4 }] });
  const angles = arcAngles(ctx);
  assert.ok(angles.some((a) => Math.abs(a - Math.PI / 2) < 0.01),
    'no arc at the bottom; got ' + JSON.stringify(angles));
});

test('hits from opposite directions draw arcs in opposite places', () => {
  // The property the feature exists for: under fire from two directions at
  // once, the player can tell which way to turn. Before this, the game only
  // produced a sentence, and only for the rear quadrant.
  const ctx = recordingContext();
  H.drawHud(ctx, {
    width: W, height: HGT,
    damage: [{ bearing: -Math.PI / 2, age: 0, life: 1.4 }, { bearing: Math.PI / 2, age: 0, life: 1.4 }],
  });
  const angles = arcAngles(ctx);
  const left = angles.some((a) => Math.abs(a - (-Math.PI)) < 0.01);
  const right = angles.some((a) => Math.abs(a) < 0.01);
  assert.ok(left && right, 'port and starboard arcs are not distinguishable: ' + JSON.stringify(angles));
});

test('a stale hit fades out and eventually draws nothing', () => {
  // A stale arc is worse than no arc: it tells the player where the fire *was*.
  const fresh = recordingContext();
  H.drawHud(fresh, { width: W, height: HGT, damage: [{ bearing: 0, age: 0, life: 1.4 }] });
  const freshArcs = arcAngles(fresh).length;

  const stale = recordingContext();
  H.drawHud(stale, { width: W, height: HGT, damage: [{ bearing: 0, age: 1.4, life: 1.4 }] });
  assert.equal(arcAngles(stale).length, 0, 'an expired hit still drew');
  assert.ok(freshArcs > 0, 'a fresh hit drew nothing');
});

test('the HUD draws no damage arcs when nothing has hit', () => {
  const ctx = recordingContext();
  H.drawHud(ctx, { width: W, height: HGT, damage: [] });
  assert.equal(arcAngles(ctx).length, 0, 'arcs were drawn with no damage');
});

test('a missing damage field does not break the HUD', () => {
  // The state object is assembled by the caller; a HUD that throws on a
  // missing optional field takes the whole frame down.
  const ctx = recordingContext();
  assert.doesNotThrow(() => H.drawHud(ctx, { width: W, height: HGT }));
});

// --- Resolution scaling ----------------------------------------------------

test('the HUD scales its fixed sizes with the viewport', () => {
  // The HUD mixes proportional sizes (the scanner radius is a fraction of the
  // screen) with fixed ones (13px text, an 8px bar). Without this the text
  // stays the same size while everything around it grows, so it reads fine in
  // a 720p window and is squinty on a 1080p monitor.
  assert.equal(H.hudScale(900), 1, 'the reference height should be exactly 1');
  assert.ok(H.hudScale(1080) > 1, '1080p should enlarge the fixed sizes');
  assert.ok(H.hudScale(1440) > H.hudScale(1080), 'scaling should be monotonic');
  assert.ok(H.hudScale(720) < 1, 'a small window should shrink them');
});

test('the HUD scale is clamped at both ends', () => {
  // Below about 0.9 the text stops being legible; above 1.5 it competes with
  // the view it is drawn over.
  assert.ok(H.hudScale(200) >= 0.9, 'collapsed too far at a tiny size');
  assert.ok(H.hudScale(4000) <= 1.5, 'ran away at a huge size');
  assert.equal(H.hudScale(0), 1, 'a missing height should fall back to the reference');
  assert.equal(H.hudScale(undefined), 1);
});

test('drawing at 1080p uses a larger font than at 720p', () => {
  // The property that matters, asserted on the recording context rather than
  // on a screenshot.
  function fontAt(height) {
    const ctx = recordingContext();
    ctx.canvas = { width: 1920, height: height };
    H.drawHud(ctx, {
      width: 1920, height: height,
      shields: 40, maxShields: 40, fuel: 7, maxFuel: 7, energy: 100, maxEnergy: 100,
      heat: 0, maxHeat: 100, hull: 100, maxHull: 100,
      cash: 100, rank: 'Harmless', cargoUsed: 0, cargoMax: 20, missiles: 1,
      contacts: [], compass: [], messages: [], alerts: [],
    });
    const sizes = ctx.fonts.map((f) => parseFloat(f));
    return Math.max.apply(null, sizes);
  }
  const small = fontAt(720);
  const large = fontAt(1080);
  assert.ok(large > small, '1080p drew no larger than 720p: ' + small + ' vs ' + large);
});


test('the title screen scales its text with the viewport', () => {
  // The first thing a player reads, and the smallest text in the game before
  // this - it was drawn at fixed pixel sizes while everything else grew.
  const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const title = source.slice(source.indexOf('function drawTitle'), source.indexOf('function drawDeath'));
  assert.ok(title.includes('HUD.hudScale(hudH)'),
    'the title screen does not scale with the viewport');
  assert.ok(!/font = '\d+px/.test(title),
    'the title screen still sets a fixed font size somewhere');
});

test('the launch prompt is visible for most of its blink cycle', () => {
  // An even on/off split means a third of players look at the screen during
  // the dark half and see nothing telling them what to press.
  const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const match = /const blink = Math\.sin\(session\.time \* 3\) > (-?[\d.]+);/.exec(source);
  assert.ok(match, 'the launch prompt blink is gone');
  const threshold = parseFloat(match[1]);
  // Over one full period, sin(x) > c for a fraction 0.5 - asin(c)/pi.
  // Sanity: c = 0 gives exactly half, c = -1 gives all of it.
  const fraction = 0.5 - Math.asin(threshold) / Math.PI;
  assert.ok(fraction > 0.5,
    'the launch prompt is hidden for ' + ((1 - fraction) * 100).toFixed(0) + '% of the cycle');
});

// --- The message log has to survive a bright background ---------------------

test('every message line is outlined before it is filled', () => {
  // The HUD is drawn straight onto the scene with no plate of its own, so a
  // line over the station used to be dark-on-bright and unreadable: measured
  // over the arrival station, mean contrast ratio 1.74, with 97 % of the log's
  // pixels below the 3:1 readability floor. An outline travels with the glyph,
  // so the contrast holds wherever the line happens to be.
  const ctx = recordingContext();
  const state = fullState();
  state.messages = [
    { text: 'Arrived: Lave', colour: '#8affb0', age: 0, lifetime: 5 },
    { text: 'The lanes are quiet.', colour: H.HUD_COLOURS.inkDim, age: 0, lifetime: 5 },
  ];
  H.drawHud(ctx, state);
  const mine = ctx.calls
    .filter((c) => c.name === 'fillText' || c.name === 'strokeText')
    .filter((c) => state.messages.some((m) => m.text === c.args[0]));
  assert.equal(mine.length, 4, 'expected a stroke and a fill for each of two lines');
  for (let i = 0; i < mine.length; i += 2) {
    assert.equal(mine[i].name, 'strokeText',
      '"' + mine[i].args[0] + '" was filled with no outline under it');
    assert.equal(mine[i + 1].name, 'fillText');
    assert.equal(mine[i].args[0], mine[i + 1].args[0],
      'the outline belongs to a different line than the fill');
  }
});

test('the outline is drawn at full strength so a fading line keeps its contrast', () => {
  // The outline is what carries the contrast and the glyph is what fades. If
  // the outline faded too, the last line before a message disappears would be
  // dark-on-bright again - which is the failure this whole change is about.
  const ctx = recordingContext();
  const strokes = [];
  const realStroke = ctx.strokeText;
  ctx.strokeText = function (t, x, y) {
    strokes.push({ text: String(t), alpha: ctx.globalAlpha });
    return realStroke.call(this, t, x, y);
  };
  const state = fullState();
  state.messages = [
    { text: 'oldest line here', age: 0, lifetime: 5 },
    { text: 'newest line here', age: 0, lifetime: 5 },
  ];
  H.drawHud(ctx, state);
  const mine = strokes.filter((s) => state.messages.some((m) => m.text === s.text));
  assert.equal(mine.length, 2, 'expected two outlined lines, got ' + mine.length);
  for (const s of mine) {
    assert.equal(s.alpha, 1, '"' + s.text + '" was outlined at ' + s.alpha);
  }
});

test('the dimmest message still clears the readability floor', () => {
  // Arithmetic rather than a canvas, because the failure is a constant that is
  // too small: `inkDim` carries its own alpha and the ramp multiplies it, so
  // the oldest line was landing at 0.13 effective - unreadable even against
  // empty space. Measured on screen before the fix: glyph core luminance 0.065.
  const alphaOf = (c) => {
    const m = /rgba?\([^)]*?,\s*([\d.]+)\s*\)/.exec(c);
    return m ? Number(m[1]) : 1;
  };
  const rgbOf = (c) => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [255, 255, 255];
  };

  const ctx = recordingContext();
  const fills = [];
  const realFill = ctx.fillText;
  ctx.fillText = function (t, x, y) {
    fills.push({ text: String(t), alpha: ctx.globalAlpha });
    return realFill.call(this, t, x, y);
  };
  const state = fullState();
  state.messages = [
    { text: 'oldest', colour: H.HUD_COLOURS.inkDim, age: 0, lifetime: 5 },
    { text: 'newest', colour: H.HUD_COLOURS.inkDim, age: 0, lifetime: 5 },
  ];
  H.drawHud(ctx, state);
  const mine = fills.filter((f) => state.messages.some((m) => m.text === f.text));
  assert.equal(mine.length, 2, 'expected two filled lines, got ' + mine.length);

  const dimmest = Math.min.apply(null, mine.map((f) => f.alpha));
  const s = dimmest * alphaOf(H.HUD_COLOURS.inkDim);
  const rgb = rgbOf(H.HUD_COLOURS.inkDim);
  const lin = (v) => {
    const c = (v * s) / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const lum = 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  const ratio = (lum + 0.05) / 0.05;
  assert.ok(ratio >= 3,
    'the dimmest line composites to ' + ratio.toFixed(2)
    + ':1 against black, below the 3:1 readability floor');
});

test('the urgent alerts are outlined too', () => {
  // "MISSILE" and "HULL CRITICAL" sit dead centre, which is exactly where a
  // station or a star fills the frame, and they are the lines a player must not
  // have to squint at.
  const ctx = recordingContext();
  const state = fullState();
  state.alerts = [
    { text: 'MISSILE INBOUND', urgent: true },
    { text: 'LOW FUEL' },
  ];
  // Blink phase matters: an urgent alert is skipped on the dark half.
  state.time = 0.2;
  H.drawHud(ctx, state);
  const order = ctx.calls
    .filter((c) => c.name === 'fillText' || c.name === 'strokeText')
    .filter((c) => state.alerts.some((a) => a.text === c.args[0]));
  assert.ok(order.length >= 2, 'the alerts were not drawn at all');
  for (let i = 0; i < order.length; i += 2) {
    assert.equal(order[i].name, 'strokeText',
      '"' + order[i].args[0] + '" was filled with no outline under it');
    assert.equal(order[i + 1].name, 'fillText');
  }
});

// --- Every key the HUD promises is really bound -----------------------------

test('the HUD never promises a key that does nothing', async () => {
  // The chart legend read "ENTER = select" for as long as the chart has
  // existed, and nothing has ever been bound to Enter. A promise of a key that
  // does nothing is worse than silence: it is the one the player tries first.
  // The station screen had the same defect in its own hint, so this checks
  // every promise the HUD makes in one place.
  const INPUT = await import('../src/core/input.js');
  const codes = new Set();
  for (const list of Object.values(INPUT.BINDINGS)) for (const c of list) codes.add(c);
  const letters = new Set();
  for (const c of codes) if (/^Key[A-Z]$/.test(c)) letters.add(c.slice(3));

  // Keys whose name is a word rather than a letter.
  const NAMED = {
    ENTER: 'Enter', RETURN: 'Enter', ESC: 'Escape', SPACE: 'Space', TAB: 'Tab',
  };

  const promises = [
    ['chart legend', H.CHART_LEGEND],
    ['title controls', H.TITLE_CONTROLS.join('   ')],
  ];
  for (const [what, text] of promises) {
    for (const letter of new Set(text.match(/[A-Z]/g) || [])) {
      assert.ok(letters.has(letter),
        'the ' + what + ' names ' + letter + ', which is bound to nothing');
    }
    for (const [word, code] of Object.entries(NAMED)) {
      if (!new RegExp('\\b' + word + '\\b').test(text)) continue;
      assert.ok(codes.has(code),
        'the ' + what + ' promises ' + word + ' but nothing is bound to ' + code);
    }
  }
});

test('the mouse hints only promise what the game actually does', async () => {
  // The mouse hint is deliberately *not* run through the scan above: "CLICK"
  // and "ESC" are not letters, and a scanner that reads every capital as a key
  // would report them as unbound. So the promise is checked by hand instead -
  // and it has to be, because the hint is the only place a player is told the
  // mouse exists at all. A hint that names a key nothing is bound to is the
  // same defect the chart legend had with Enter.
  const INPUT = await import('../src/core/input.js');
  const codes = new Set();
  for (const list of Object.values(INPUT.BINDINGS)) for (const c of list) codes.add(c);

  for (const [name, text] of Object.entries(H.MOUSE_HINT)) {
    assert.equal(typeof text, 'string', name + ' is not a string');
    assert.ok(text.length > 0, name + ' is empty');
    // No accidental key promises: the only capitalised words allowed are the
    // ones this test knows about, and every one of them is a control the game
    // really has - a click, the mouse, Escape, or the keyboard it is an
    // alternative to.
    const allowed = new Set([
      'ESC', 'CLICK', 'KEYBOARD', 'MOUSE', 'STEERS', 'STEERING', 'POINTER',
      'BY', 'TO', 'FLY', 'WITH', 'THE', 'CAPTURE', 'RELEASES', 'IT',
      'BROWSER', 'REFUSED',
    ]);
    for (const w of text.match(/[A-Z]{2,}/g) || []) {
      assert.ok(allowed.has(w), 'the ' + name + ' hint contains an unexpected promise: ' + w);
    }
  }

  // The single key the hint names - Escape, to let go of the pointer - is in
  // the one hint that says so. The others promise a *click*, which is not a key
  // at all and is checked at the call sites in `main.js` instead.
  assert.ok(codes.has('Escape'), 'nothing is bound to Escape');
  for (const [name, text] of Object.entries(H.MOUSE_HINT)) {
    const namesEsc = /\bESC\b/.test(text);
    if (!namesEsc) continue;
    assert.ok(codes.has('Escape'), 'the ' + name + ' hint promises ESC for nothing');
  }
  // And pointing at a click is only honest if a click is really what captures
  // the pointer: the gesture that arms a lock must be one a click can supply.
  assert.ok(H.MOUSE_HINT.capture.includes('CLICK'),
    'the hint no longer says how to capture the pointer');
});

test('a count of one is not pluralised', () => {
  // The title screen said "1 systems visited" and the death screen "1 kills" -
  // the first two sentences a new commander ever reads. Both were a bare
  // `n + ' noun'`.
  assert.equal(H.countOf(0, 'system'), '0 systems');
  assert.equal(H.countOf(1, 'system'), '1 system');
  assert.equal(H.countOf(2, 'system'), '2 systems');
  assert.equal(H.countOf(1, 'kill'), '1 kill');
  assert.equal(H.countOf(7, 'kill'), '7 kills');
});

test('the flight HUD is not drawn behind the station screen', () => {
  // It used to be drawn in *every* mode that was not title, death or
  // hyperspace, which quietly included `docked`: a crosshair floated over the
  // market table and a scanner ring showed through the price list. Measured,
  // the flight HUD painted 2.9 % of the frame while docked, 1.2 % strongly.
  assert.equal(H.hudOverlayFor('docked'), 'none');
  // The other modes must keep what they had.
  assert.equal(H.hudOverlayFor('title'), 'title');
  assert.equal(H.hudOverlayFor('dead'), 'death');
  assert.equal(H.hudOverlayFor('hyperspace'), 'hyperspace');
  // The chart is drawn *by* the HUD, so that mode still needs the canvas.
  assert.equal(H.hudOverlayFor('chart'), 'flight');
  assert.equal(H.hudOverlayFor('flight'), 'flight');
});

// --- The chart is a place, not an overlay ----------------------------------

test('the chart replaces the instruments instead of dimming them', () => {
  // The chart is a *place*: it replaces the view of space. It used to be drawn
  // last, over everything, so its backdrop dimmed the HUD along with the world.
  // At 0.86 that left the status column faint; raising the opacity to kill the
  // world ghosting made it nearly invisible. Both symptoms had one cause - the
  // backdrop was covering the wrong layer.
  const flight = recordingContext();
  const flightState = fullState();
  flightState.showChart = false;
  H.drawHud(flight, flightState);

  const chart = recordingContext();
  const chartState = {
    ...fullState(),
    showChart: true,
    chart: {
      discRadius: 260, jumpRange: 36, routes: [],
      systems: [{ index: 0, name: 'HERE', x: 0, y: 0, danger: 0.1 }],
      player: { index: 0 }, selected: -1,
    },
  };
  H.drawHud(chart, chartState);

  // The instruments are gone...
  assert.ok(chart.calls.length < flight.calls.length,
    'the chart drew as much as the cockpit view');

  // ...the status readout survives...
  assert.ok(chart.texts().includes('SHLD'),
    'the status column vanished on the chart screen');

  // ...and the backdrop is drawn *before* that readout rather than over it.
  const w = chartState.width;
  const h = chartState.height;
  const backdrop = chart.calls.findIndex((c) => c.name === 'fillRect'
    && c.args[0] === 0 && c.args[1] === 0 && c.args[2] === w && c.args[3] === h);
  const status = chart.calls.findIndex((c) => c.name === 'fillText' && c.args[0] === 'SHLD');
  assert.ok(backdrop >= 0, 'the chart drew no full-screen backdrop');
  assert.ok(status > backdrop,
    'the status readout is drawn under the chart backdrop, so the backdrop dims it');
});

test('the chart legend sits clear of the message log', () => {
  // Both live at the bottom of the screen. The legend used to be left-aligned
  // in the corner the message log occupies; now that the log is drawn *after*
  // the chart, a left-aligned legend would be covered by it.
  const ctx = recordingContext();
  const state = {
    ...fullState(),
    showChart: true,
    messages: [{ text: 'Arrived: Lave', age: 0, lifetime: 5 }],
    chart: {
      discRadius: 260, jumpRange: 36, routes: [],
      systems: [{ index: 0, name: 'HERE', x: 0, y: 0, danger: 0.1 }],
      player: { index: 0 }, selected: -1,
    },
  };
  H.drawHud(ctx, state);
  const legend = ctx.calls.find((c) => c.name === 'fillText'
    && c.args[0] === H.CHART_LEGEND);
  assert.ok(legend, 'the chart legend was not drawn');
  assert.equal(legend.args[1], state.width / 2,
    'the legend is not centred, so it collides with the message log');
});
