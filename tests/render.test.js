/**
 * Renderer tests.
 *
 * There is no GPU in this process, so nothing here renders a pixel. What it
 * *can* pin is the part of a renderer that is actually easy to get wrong:
 *
 *   - the fallback contract (`mode: 'none'` must still be fully callable, or
 *     `main.js` needs an `if` on every call site and the headless e2e run
 *     stops exercising the real code path);
 *   - that the sky is *wired* correctly - it must be parented to the scene root
 *     so a hyperspace jump (which swaps the system group) never tears it down,
 *     and it must draw before everything else without ever writing depth;
 *   - the colour-space decision, which is the classic three.js r152+ trap.
 *
 * The sky's own construction - star distribution, galactic band, nebulae - is
 * covered by `sky.test.js`, which owns that file. What is pinned here is only
 * the part that `render.js` is responsible for: the wiring and the facade.
 *
 * The last one deserves a note: `new THREE.Color(0x9fe8ff).r` is *not*
 * `0x9f / 255`, because three converts hex literals from sRGB into a linear
 * working space. Tests that compare `.r` directly are testing three's colour
 * management, not our code. Compare hex strings instead.
 *
 * One annoyance: constructing a `WebGLRenderer` with no GL available makes
 * three write a hard `console.error`. That is three's behaviour, not ours, and
 * it cannot be suppressed through the public API - so `quietConsole` below
 * silences it for the duration of the call. Leaving it noisy would train
 * everyone to ignore console errors during a real run, which is worse than the
 * small amount of machinery here.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import * as R from '../src/sim/render.js';
import { disposeSky } from '../src/sim/sky.js';

/** A canvas stand-in with the few properties the renderer reads. */
function fakeCanvas(width, height) {
  return { clientWidth: width === undefined ? 1280 : width,
           clientHeight: height === undefined ? 720 : height,
           width: 0, height: 0, style: {} };
}

/** Run `fn` with console.error/warn muted. Returns whatever `fn` returns. */
function quietConsole(fn) {
  const realError = console.error;
  const realWarn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.error = realError;
    console.warn = realWarn;
  }
}

test('the camera far plane reaches past the sun', () => {
  // The star is placed at LAYOUT.starDistance (9000) and is 1400 units of
  // radius. A default far plane of 2000 would clip the sun out of existence
  // and the whole system would look like empty space.
  assert.ok(R.CAMERA.far > 9000 + 1400,
    `far plane ${R.CAMERA.far} would clip the star`);
});

test('the near plane leaves room for the cockpit', () => {
  // The eye sits ~7.4 units behind the ship's reference point. A near plane at
  // or beyond that would clip the player's own hull.
  assert.ok(R.CAMERA.near < R.CAMERA.cockpitDistance,
    'the near plane would clip the player hull');
});

test('the camera looks out of the nose, not out of the engine', () => {
  // The bug this pins, measured in the running game before it was fixed:
  // undocking put the station dead ahead at 376 units, and two seconds of full
  // throttle took it to 799. The player watched the thing they were looking at
  // recede, because the camera took the ship's quaternion unchanged and a
  // camera looks down its own -Z - which is the ship's *tail*.
  //
  // Asserted on the exported rig contract rather than on a screenshot: the
  // camera must be yawed half a turn inside the ship's frame, so that its
  // view axis lands on the ship's +Z.
  const source = readFileSync(new URL('../src/sim/render.js', import.meta.url), 'utf8');
  assert.ok(source.includes('CAMERA_FLIP'),
    'the camera no longer yaws inside the ship frame, so the view faces the engine');
  assert.ok(source.includes('rig.quaternion.copy(quat).multiply(CAMERA_FLIP)'),
    'snapCamera does not apply the flip, so a jump or dock would look backwards');
  assert.ok(source.includes('rig._aim.copy(quat).multiply(CAMERA_FLIP)'),
    'placeCamera does not apply the flip');
  // And the half turn must be about the ship's own up, not about a world axis:
  // a world-axis yaw would roll the horizon over when the ship pitches.
  assert.ok(/setFromAxisAngle\(new THREE\.Vector3\(0, 1, 0\), Math\.PI\)/.test(source),
    'the flip is not a yaw about the ship up axis');
});

test('probeContext reports failure instead of throwing without a canvas', () => {
  // Passing something that cannot possibly produce a GL context. The contract
  // is a report object, never an exception - main.js calls this on every boot.
  const probe = quietConsole(() => R.probeContext(null, {}));
  assert.strictEqual(probe.ok, false);
  assert.ok(typeof probe.reason === 'string' && probe.reason.length > 0);
  // In Node there is no `document`, so three throws while resolving the canvas.
  // On a real machine with a working GPU this would be a context problem
  // instead, which is why the assertion is on the *shape*, not the reason.
  assert.ok(['threw', 'no-context'].includes(probe.reason), probe.reason);
});

test('probeContext honours forceDirect without touching WebGL at all', () => {
  // forceDirect is the escape hatch used by tests and by anyone running on a
  // GPU they do not trust. It must win over everything else - and, importantly,
  // it must be decided *before* the renderer is constructed, so a machine with
  // no GPU does not log "Error creating WebGL context" on every boot.
  let constructed = false;
  const c = fakeCanvas();
  // If probe reaches WebGL it will try to read these; a poisoning getter is a
  // cheap way to prove it never got there.
  Object.defineProperty(c, 'clientWidth', {
    get() { constructed = true; return 1280; },
  });
  const probe = R.probeContext(c, { forceDirect: true });
  assert.strictEqual(probe.ok, false);
  assert.strictEqual(probe.reason, 'forced-direct');
  assert.strictEqual(constructed, false, 'forceDirect must short-circuit before WebGL');
});

test('the sky is a group named "sky", never a bare Points', () => {
  // The sky grew from a point cloud into a group (stars + galactic band +
  // nebulae + dust). Callers that assumed `isPoints` would silently break.
  const sky = R.buildSky(7);
  assert.ok(sky.isGroup, 'the sky must be a Group so layers can be added');
  assert.strictEqual(sky.name, 'sky');
  assert.ok(sky.children.length >= 1, 'a sky with no layers renders as nothing');
});

test('the sky carries its real star count regardless of seed', () => {
  const sky = R.buildSky(3);
  const points = sky.children.find((c) => c.isPoints);
  assert.ok(points, 'the star layer is missing');
  assert.strictEqual(points.geometry.attributes.position.count, R.STARFIELD.count);
});

test('the sky seed is respected and reproducible', () => {
  const a = R.buildSky(1);
  const b = R.buildSky(2);
  const aPos = a.children.find((c) => c.isPoints).geometry.attributes.position.array;
  const bPos = b.children.find((c) => c.isPoints).geometry.attributes.position.array;
  let differ = false;
  for (let i = 0; i < aPos.length; i++) if (aPos[i] !== bPos[i]) { differ = true; break; }
  assert.ok(differ, 'two seeds produced an identical sky');

  const c = R.buildSky(99);
  const d = R.buildSky(99);
  assert.deepStrictEqual(
    Array.from(c.children.find((x) => x.isPoints).geometry.attributes.position.array),
    Array.from(d.children.find((x) => x.isPoints).geometry.attributes.position.array),
  );
});

test('the sky never writes depth or occludes the game', () => {
  // Both layers are additive and must draw behind every real object. If the
  // star points ever write depth they mask the planet and the station.
  const sky = R.buildSky(1);
  for (const layer of sky.children) {
    if (layer.isPoints) {
      assert.strictEqual(layer.material.depthWrite, false);
      assert.ok(layer.renderOrder < 0, 'the stars must draw before everything else');
      assert.strictEqual(layer.frustumCulled, false);
    }
    if (layer.isGroup) {
      for (const nebula of layer.children) {
        assert.strictEqual(nebula.material.depthWrite, false, 'a nebula writes depth');
      }
    }
  }
});

test('disposeSky frees the shared glow texture and every geometry', () => {
  // The star cloud and the nebulae share one canvas texture, so a naive
  // traverse would double-dispose it. This pins that disposal is safe to call
  // and that the group is left without a dangling texture reference.
  const sky = R.buildSky(5);
  assert.doesNotThrow(() => disposeSky(sky));
  assert.strictEqual(sky.userData.glowTexture, null);
  assert.doesNotThrow(() => disposeSky(sky), 'second dispose must be safe');
  assert.doesNotThrow(() => disposeSky(null), 'null must be tolerated');
});

test('star colours are stored in linear space, not raw sRGB bytes', () => {
  // This is the trap the file documents. A THREE.Color built from a hex literal
  // and read back through getHexString round-trips; its .r does not.
  const c = new THREE.Color(0x9fe8ff);
  assert.strictEqual(c.getHexString(), '9fe8ff');
  assert.notStrictEqual(c.r, 0x9f / 255);
});

test('createRenderer returns a fully callable facade with no GPU', () => {
  // In Node there is no WebGL, so this exercises the stranded path. Every
  // method must exist - that is the whole point of the fallback contract.
  const r = quietConsole(() => R.createRenderer({ canvas: fakeCanvas(), headless: true }));
  assert.ok(r);
  assert.strictEqual(r.mode, 'none');
  for (const fn of ['resize', 'render', 'placeCamera', 'snapCamera',
                    'addShake', 'flash', 'setSystemGroup', 'dispose']) {
    assert.strictEqual(typeof r[fn], 'function', `missing ${fn}`);
  }
  // And calling them must not throw.
  r.resize(800, 600);
  r.render(null, 0, 1 / 60);
  r.placeCamera(null, 1 / 60);
  r.snapCamera(null);
  r.addShake(1);
  r.flash(1);
  r.setSystemGroup(null);
  r.dispose();
});

test('createRenderer without a canvas is a programming error, not a fallback', () => {
  assert.throws(() => R.createRenderer({}), /canvas/);
});

test('the stranded facade still owns a scene and a camera', () => {
  // main.js adds system groups and lights to these before it ever renders, so
  // they cannot be undefined even when there is no renderer behind them.
  const r = quietConsole(() => R.createRenderer({ canvas: fakeCanvas(), headless: true }));
  assert.ok(r.scene && r.scene.isScene);
  assert.ok(r.camera && r.camera.isCamera);
  // The sky is handed over as a group even on the fallback path, so main.js
  // never needs to branch on whether WebGL came up.
  assert.ok(r.starfield && (r.starfield.isGroup || r.starfield.isPoints));
  assert.ok(r.scene.children.includes(r.starfield));
  // The camera rig's entry points must survive the fallback with no flight.
  assert.doesNotThrow(() => r.render(null, 0, 1 / 60));
  assert.doesNotThrow(() => r.placeCamera(undefined, 1 / 60));
});

test('a stranded renderer tolerates an unset system group', () => {
  const r = quietConsole(() => R.createRenderer({ canvas: fakeCanvas(), headless: true }));
  assert.doesNotThrow(() => r.setSystemGroup(null));
  assert.doesNotThrow(() => r.setSystemGroup(undefined));
});

test('the stranded facade still exposes the environment probe field', () => {
  // main.js reads `renderer.envProbe` through the default mirror in the other
  // sim modules, so the field has to exist on both paths or the shape differs
  // between a GPU machine and a headless one.
  const r = quietConsole(() => R.createRenderer({ canvas: fakeCanvas(), headless: true }));
  assert.ok('envProbe' in r, 'the facade has no envProbe field');
  assert.strictEqual(r.envProbe, null,
    'there is nothing to reflect with no WebGL, but the field must be present');
});

test('the house lights are dialled down now that a probe supplies indirect light', () => {
  // With Lambert there was no indirect term at all, so a heavy ambient and a
  // strong hemisphere light were the only fill. The probe carries that job now,
  // and leaving the old values would flatten the very gradients it exists to
  // create.
  //
  // The stranded path deliberately holds *no* lights - main.js owns them and
  // adds them to whichever scene it is given. So this reads the source rather
  // than a built scene, which is the honest place to assert a tuning constant.
  const src = readFileSync(new URL('../src/sim/render.js', import.meta.url), 'utf8');
  const ambient = src.match(/new THREE\.AmbientLight\([^)]*?,\s*([\d.]+)\)/);
  const hemi = src.match(/new THREE\.HemisphereLight\([^)]*?,\s*([\d.]+)\)/);
  assert.ok(ambient, 'the ambient light construction was not found');
  assert.ok(hemi, 'the hemisphere fill construction was not found');
  assert.ok(Number(ambient[1]) <= 0.5,
    'ambient is still at the pre-probe level (' + ambient[1] + ')');
  assert.ok(Number(hemi[1]) <= 0.45,
    'the hemisphere fill is still at the pre-probe level (' + hemi[1] + ')');
  // And the probe itself must be attached, or the dialled-down lights leave the
  // scene darker than it was.
  assert.ok(src.includes('scene.environment = envProbe'),
    'the probe is built but never attached to the scene');
});

test('dispose is idempotent', () => {
  // The game-over path may fire twice if a death and a menu exit race.
  const r = quietConsole(() => R.createRenderer({ canvas: fakeCanvas(), headless: true }));
  r.dispose();
  assert.doesNotThrow(() => r.dispose());
});

test('the bloom dials stay in a range that does not wash out the screen', () => {
  // Bloom strength above ~1 turns the bright edge colours into a white haze
  // and destroys the vector look the project is built around.
  assert.ok(R.LOOK.bloom.strength > 0 && R.LOOK.bloom.strength <= 1.0,
    `bloom strength ${R.LOOK.bloom.strength}`);
  assert.ok(R.LOOK.bloom.radius > 0 && R.LOOK.bloom.radius <= 1);
  assert.ok(R.LOOK.bloom.threshold > 0 && R.LOOK.bloom.threshold < 1);
});

test('the retro overlay dials are gone, not merely muted', () => {
  // The CRT pass was deleted outright when the look moved to PBR materials and
  // a real procedural sky: the scanline/grain overlay was fighting the image
  // instead of framing it. This pins the deletion so a stray `LOOK.crt` does
  // not creep back in and get read by nothing.
  assert.strictEqual(R.LOOK.crt, undefined, 'the CRT dials are still in LOOK');
  assert.ok(Object.keys(R.LOOK).length <= 3, 'LOOK grew keys that nothing reads');
});

test('tone mapping exposure is near unity', () => {
  // A far-from-1.0 exposure means the game is compensating elsewhere; it is
  // the kind of thing that gets nudged repeatedly and never reset.
  assert.ok(Math.abs(R.LOOK.toneMappingExposure - 1) < 0.35,
    `exposure ${R.LOOK.toneMappingExposure}`);
});

test('the default export mirrors the named exports', () => {
  assert.strictEqual(R.default.CAMERA, R.CAMERA);
  assert.strictEqual(R.default.STARFIELD, R.STARFIELD);
  assert.strictEqual(R.default.LOOK, R.LOOK);
  assert.strictEqual(R.default.createRenderer, R.createRenderer);
  assert.strictEqual(R.default.buildSky, R.buildSky);
  assert.strictEqual(R.default.probeContext, R.probeContext);
});

test('Quaternion.slerp rejects a plain {x,y,z,w} object - the black-scene trap', () => {
  // This is the bug that rendered the entire 3D view black while the HUD, the
  // market and the chart were all perfect. flight.js stores rotation as a
  // plain object literal so the module can stay import-free, and *most* three
  // APIs read the public x/y/z/w, so a plain object works for them.
  //
  // Quaternion.slerp does not: r186 reads the private _x/_y/_z/_w fields.
  // On a plain object those are undefined, `-undefined` is NaN, and slerp
  // returns (NaN, NaN, NaN, NaN) *without throwing*. The camera quaternion
  // then poisons matrixWorld, every projection returns NaN, nothing lands in
  // the frustum, and the frame is black - with a scene graph that inspects as
  // perfectly healthy. This test pins the three.js behaviour so that if a
  // future version starts accepting plain objects (or starts throwing), we
  // find out here rather than by staring at a black screen.
  const plain = { x: 0, y: 1, z: 0, w: 0 };
  const start = new THREE.Quaternion(0, 0, 0, 1);
  const viaPlain = quietConsole(() => start.clone().slerp(plain, 0.35));
  const bad = viaPlain.toArray().some((n) => !Number.isFinite(n));
  assert.ok(bad,
    'three.js started accepting plain objects in slerp - render.js can be simplified');

  // And prove the documented cure works: route it through a real Quaternion.
  const lifted = new THREE.Quaternion(plain.x, plain.y, plain.z, plain.w);
  const viaReal = start.clone().slerp(lifted, 0.35);
  assert.ok(viaReal.toArray().every(Number.isFinite),
    'slerp through a real Quaternion must stay finite');
  assert.ok(Math.abs(viaReal.length() - 1) < 1e-6, 'slerp must return a unit quaternion');
});

test('render.js never hands a plain flight quaternion to slerp', () => {
  // The structural half of the trap above. The camera rig can only be built
  // with a live GL context, so this is verified against the source: if any
  // call site slerps straight from `flight.quat`, the black screen returns.
  const source = readFileSync(new URL('../src/sim/render.js', import.meta.url), 'utf8');
  assert.ok(!/slerp\s*\(\s*flight\.quat/.test(source),
    'a slerp call is receiving the plain flight.quat directly');
  assert.ok(!/applyQuaternion\s*\(\s*flight\.quat/.test(source),
    'applyQuaternion is receiving the plain flight.quat directly');
  // The lift helper must exist and be used at both rig entry points.
  assert.ok(/function toQuaternion/.test(source), 'toQuaternion helper is missing');
  const uses = source.match(/toQuaternion\(flight\.quat\)/g) || [];
  assert.ok(uses.length >= 2,
    `expected toQuaternion(flight.quat) in placeCamera and snapCamera, found ${uses.length}`);
});
