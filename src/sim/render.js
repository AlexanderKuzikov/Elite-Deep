/**
 * Rendering: the camera, the scene, the sky, and the modern take on the look.
 *
 * ## Where the look ended up
 *
 * The ZX Spectrum Elite had no textures and no shading - it drew flat coloured
 * polygons and bright wireframe edges, because that was all the hardware could
 * afford in real time. The first version of this project leaned hard on that:
 * near-black hulls with neon outlines. It read as authentic and it was, frankly,
 * hard to look at.
 *
 * The current build keeps the *structural* insight - facets, hard silhouettes,
 * bright edges - and spends the modern budget properly:
 *
 *   1. **Physically-based materials.** Hulls are `MeshStandardMaterial` with
 *      real roughness and metalness, lit by a procedural environment probe. The
 *      dark fill is gone; the edges are now an accent rather than the only
 *      thing visible.
 *   2. **A real sky.** A galactic band, emission nebulae, dust, and a
 *      long-tailed star brightness distribution, all generated in code. This is
 *      the single biggest contributor to "this is space".
 *   3. **Procedural planet surfaces.** fBm terrain, polar caps, cloud layers
 *      and a fresnel atmosphere limb, baked per-vertex from the system seed.
 *   4. **A star with a corona.** Layered additive shells instead of a flat disc.
 *   5. **Bloom and ACES tone mapping.** The star is drawn far brighter than the
 *      hulls; tone mapping stops it clipping into a flat white disc, and bloom
 *      makes the bright edges glow the way a CRT phosphor did for free.
 *
 * Outlines survive because they are load-bearing, not decorative: the ship
 * meshes are 6-10 vertices, and without an edge overlay a rotating Sidewinder
 * is an unreadable dark smear. They are now thin, distance-faded and tinted by
 * the local lighting rather than being a flat neon stroke.
 *
 * ## The colour-space trap
 *
 * This is the single most confusing thing in the file, so it is written down.
 * On three r152+, every hex literal passed to a material is interpreted as
 * **sRGB** and converted into the renderer's linear working space. So
 * `new Color(0x9fe8ff).r` is *not* `0x9f / 255`. Anything comparing colours
 * must go through `getHexString()` or it will silently disagree.
 *
 * The second half: `EffectComposer` allocates its own render targets, and those
 * default to a *linear* colour space with *no* tone mapping. Rendering a
 * composer chain without a final `OutputPass` therefore produces the
 * too-dark, oversaturated "my bloom wrecked my colours" result. `OutputPass`
 * exists solely to read `renderer.outputColorSpace` and `renderer.toneMapping`
 * back off the renderer and apply them at the very end of the chain. It must be
 * the last pass, always.
 *
 * ## Why post-processing is optional
 *
 * The game ships as one HTML file and has to run anywhere, including inside a
 * headless browser with a software GL stack and inside Node where there is no
 * WebGL context at all. So the renderer has two paths:
 *
 *   - **Composed** - the full chain, used whenever the necessary float render
 *     target support is present.
 *   - **Direct** - `renderer.render(scene, camera)` straight to the canvas.
 *     No bloom, no CRT. The geometry, lighting and edges are all still there,
 *     so the game is entirely playable; it just looks a little flatter.
 *
 * The choice is made once at construction, reported on `mode`, and never
 * re-evaluated mid-frame, because switching mid-frame would thrash the GPU
 * and is not worth the complexity for a fallback nobody should ever see.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SKY, buildSky, disposeSky } from './sky.js';
import { buildEnvProbe, disposeEnvProbe } from './environment.js';

/**
 * Re-exported so callers keep importing the sky from one place.
 *
 * The sky used to be built in this file as `buildStarfield`. It moved to
 * `sky.js` when it grew a galactic band, nebulae and dust, but `main.js` and
 * the tests still reach for it here rather than importing `sky.js` directly -
 * which keeps `sky.js` free to change its internals.
 */
export { buildSky, disposeSky };

/** Camera setup. The FOV is wide - a cockpit view should feel enclosed. */
export const CAMERA = {
  fov: 74,
  near: 0.5,
  far: 40000,       // the star sits at 9000; it must not be clipped
  /** How far behind the ship's reference point the eye sits. */
  cockpitDistance: 7.4,
  /** How far above it, so the view looks over the nose rather than along it. */
  cockpitRise: 0.65,
};

/**
 * The half turn that puts the view on the ship's nose.
 *
 * A camera looks down its own -Z and the ship's nose is +Z, so the camera has
 * to be yawed half a turn *inside the ship's frame*. Applied on the right of
 * the ship's quaternion so it stays a local rotation. See `placeCamera`.
 */
const CAMERA_FLIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

/**
 * How the starfield backdrop is built.
 *
 * Kept as an export because the tuning is genuinely useful to read, but the
 * actual construction now lives in `sky.js` - the backdrop grew a galactic
 * band, nebulae and dust, and it stopped belonging in the same file as the
 * camera rig. `STARFIELD.count` is still the star count of record.
 */
export const STARFIELD = {
  count: SKY.starCount,
  innerRadius: SKY.innerRadius,
  outerRadius: SKY.outerRadius,
  minSize: SKY.minSize,
  maxSize: SKY.maxSize,
};

/**
 * Bloom and tone mapping. The CRT dials are gone: with PBR materials and a real
 * sky the scanline/grain overlay was fighting the image rather than framing it.
 * What remains is the part that still earns its keep - a restrained bloom that
 * makes bright edges and the star bleed, which is what sells "emissive" on a
 * renderer with no real HDR display.
 */
export const LOOK = {
  bloom: { strength: 0.78, radius: 0.5, threshold: 0.62 },
  toneMappingExposure: 1.0,
};

/**
 * Probe whether a composed chain is available.
 *
 * Two separate questions, and both must be yes:
 *   1. Is there a WebGL context at all? In Node there is not.
 *   2. Does it support float render targets and the half-float extension
 *      bloom needs? Software GL stacks often do not, and asking for them
 *      produces a black screen rather than an error.
 *
 * Never throws: the caller decides what to do with `false`.
 */
export function probeContext(canvas, opts) {
  const options = opts || {};
  // Checked before touching WebGL, because this is the one case where the
  // answer is knowable without a context - and on a machine with no GPU the
  // renderer would otherwise be constructed (and log an error) for nothing.
  if (options.forceDirect) return { ok: false, reason: 'forced-direct', maxSamples: 0 };
  try {
    const test = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,
    });
    const gl = test.getContext();
    if (!gl) {
      test.dispose();
      return { ok: false, reason: 'no-context', maxSamples: 0 };
    }
    // `EXT_color_buffer_float` is what bloom's render targets need. WebGL2
    // exposes it as an extension; on WebGL1 the whole chain is off the table.
    const floatOk = typeof gl.getExtension === 'function'
      && !!gl.getExtension('EXT_color_buffer_float');
    const halfOk = typeof gl.getExtension === 'function'
      && !!gl.getExtension('OES_texture_half_float');
    const samples = gl.getParameter ? (gl.getParameter(gl.MAX_SAMPLES) || 0) : 0;
    test.dispose();
    if (!floatOk && !halfOk) return { ok: false, reason: 'no-float-targets', maxSamples: samples };
    return { ok: true, reason: null, maxSamples: samples };
  } catch (err) {
    return { ok: false, reason: 'threw', error: err, maxSamples: 0 };
  }
}

/**
 * Create the renderer, scene, camera and post chain.
 *
 * @param {object} opts
 * @param {HTMLCanvasElement} opts.canvas      - the drawing surface
 * @param {number}   [opts.pixelRatio]         - defaults to the device's
 * @param {boolean}  [opts.forceDirect]        - skip post entirely (for tests)
 * @param {number}   [opts.seed]               - starfield seed
 * @returns {object} the render facade; see `api` below
 */
export function createRenderer(opts) {
  const options = opts || {};
  const canvas = options.canvas;
  if (!canvas) throw new Error('createRenderer: a canvas is required');

  const probe = probeContext(canvas, options);
  // In Node there is no document/canvas at all, and `probeContext` may have
  // thrown on the very first `new WebGLRenderer`. Either way we do not want to
  // create the renderer again here - just report and fall back.
  const composed = probe.ok;

  let renderer = null;
  let rendererError = null;
  if (!options.headless) {
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: false,
        alpha: false,
        powerPreference: 'high-performance',
        stencil: false,
      });
    } catch (err) {
      rendererError = err;
    }
  }

  if (!renderer) {
    return strandedApi(canvas, probe, rendererError);
  }

  // Pixel ratio: cap at 2. A 4K display reporting 3.0 would otherwise render
  // nine times the pixels for a difference nobody can see on a plotter-angle
  // game, and the bloom pass would tank the frame rate for it.
  const pixelRatio = Math.min(options.pixelRatio || (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1, 2);
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(canvas.clientWidth || 1280, canvas.clientHeight || 720, false);
  renderer.setClearColor(0x02030a, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = LOOK.toneMappingExposure;
  renderer.autoClear = false;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x02030a);

  const camera = new THREE.PerspectiveCamera(CAMERA.fov, 16 / 9, CAMERA.near, CAMERA.far);
  camera.position.set(0, 0, 0);

  const starfield = buildSky(options.seed || 1);
  scene.add(starfield);

  // The environment probe supplies the indirect light that `MeshStandardMaterial`
  // reflects. Without it every metal surface in the game renders black - the
  // materials in `models.js` depend on this, it is not an enhancement. Built in
  // pure JS (no PMREM pass, no render target) so the headless and stranded paths
  // get the same materials as a real GPU. See `src/sim/environment.js`.
  const envProbe = buildEnvProbe(options.seed || 1);
  scene.environment = envProbe;

  // A dim ambient so nothing is ever pure black. Kept low, and lower than it was
  // before: the probe now supplies the indirect fill, so a heavy ambient on top
  // of it would flatten the very gradients the probe exists to create. With
  // Lambert there was no indirect term at all and this had to do that job.
  scene.add(new THREE.AmbientLight(0x2a3b4d, 0.45));

  // A hemisphere fill keyed to the sky's two dominant hues. This is what stops
  // a metal hull reading as flat grey: the top gets the cool starlight tint and
  // the bottom the warm dust tint, so a rolling ship swings through a real
  // colour gradient instead of one uniform ambient value. Dialled back from 0.55
  // for the same reason as the ambient - the probe carries most of this now.
  scene.add(new THREE.HemisphereLight(0x9db8ff, 0x3a2418, 0.38));

  let composer = null;
  let bloom = null;
  let size = { width: canvas.clientWidth || 1280, height: canvas.clientHeight || 720 };

  if (composed) {
    composer = new EffectComposer(renderer);
    composer.setPixelRatio(pixelRatio);
    composer.setSize(size.width, size.height);

    composer.addPass(new RenderPass(scene, camera));

    bloom = new UnrealBloomPass(
      new THREE.Vector2(size.width, size.height),
      LOOK.bloom.strength,
      LOOK.bloom.radius,
      LOOK.bloom.threshold,
    );
    composer.addPass(bloom);

    // Must be last: it is what converts the linear composer buffers back into
    // the renderer's declared output colour space and applies tone mapping.
    composer.addPass(new OutputPass());
  }

  /** Set the drawing buffer size. Called on window resize and at startup. */
  function resize(width, height) {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    size = { width: w, height: h };
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    if (composer) composer.setSize(w, h);
    if (bloom && typeof bloom.setSize === 'function') bloom.setSize(w, h);
  }

  // Establish the initial size from the canvas's CSS box, which is what the
  // browser has actually laid out. The buffer size then follows the ratio.
  resize(
    options.width || canvas.clientWidth || size.width,
    options.height || canvas.clientHeight || size.height,
  );

  // --- Camera rig ---------------------------------------------------------
  // `camera.position` is the *cockpit*, not the ship. The ship's flight state
  // owns position and orientation; the camera chases it with a little lag and
  // shake. Doing the smoothing here rather than in flight.js keeps all the
  // "how the view feels" decisions in one place.
  const rig = {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    shake: 0,
    lag: 0.9,          // 0 = rigid, 1 = never catches up
    _tmp: new THREE.Vector3(),
    // `flight.quat` is a plain object (flight.js deliberately has no imports),
    // so it has to be lifted into a real Quaternion before three will do
    // slerp maths on it. See `toQuaternion`.
    _quat: new THREE.Quaternion(),
    // Scratch for the cockpit basis, so `placeCamera` allocates nothing.
    _fwd: new THREE.Vector3(),
    _up: new THREE.Vector3(),
    _aim: new THREE.Quaternion(),
  };

  /**
   * Lift the plain `{x, y, z, w}` quaternion owned by `flight.js` into a real
   * `THREE.Quaternion`.
   *
   * This exists because of a genuinely nasty three.js trap. `flight.js` stores
   * rotation as a plain object literal so the module stays import-free and
   * trivially testable. Most three APIs read the *public* `x/y/z/w`, so a plain
   * object works fine - `Vector3.applyQuaternion` and `Quaternion.copy` both do.
   *
   * `Quaternion.slerp(qb, t)` does **not**. It reads the private `qb._x`,
   * `qb._y`, `qb._z`, `qb._w` fields that r186 introduced. Passed a plain
   * object those are `undefined`, and `-undefined` is `NaN`, so slerp silently
   * returns `(NaN, NaN, NaN, NaN)` instead of throwing. The camera quaternion
   * then poisons `camera.matrixWorld`, every projection returns NaN, and the
   * scene renders black with a perfectly healthy scene graph - the worst kind
   * of bug to find, because nothing anywhere reports an error.
   *
   * Copying through a real Quaternion once per frame costs one object and
   * makes the whole class of failure impossible.
   *
   * Note the returned object is shared scratch (`rig._quat`), so it must be
   * consumed before the next call. Nothing here holds onto it across a call.
   */
  function toQuaternion(q) {
    return rig._quat.set(q.x, q.y, q.z, q.w);
  }

  /**
   * Place the camera for this frame.
   *
   * `flight` is the object returned by `flight.createFlight()`: it exposes
   * `pos` and `quat`. The cockpit offset is applied along the ship's own local
   * up/back axes so it stays consistent while rolling and pitching - an offset
   * applied in world space would slide out of the hull when inverted.
   *
   * ## Why the camera is yawed half a turn inside the ship's frame
   *
   * A camera looks down its own **-Z**. The ship's nose is **+Z**. Taking the
   * ship's quaternion unchanged therefore points the view straight out of the
   * *engine*, and since `integrate` drives the ship along its nose, the ship
   * flew backwards relative to everything on screen.
   *
   * That is not a subtle mis-tune, and it was measured rather than argued:
   * undocking puts the station dead ahead (`stationAhead = 1`) at 376 units,
   * and two seconds of full throttle takes it to **799** - the player watches
   * the thing they are looking at recede. The HUD was already written for the
   * correct camera (its projection basis is the ship's nose), so target boxes
   * and tracers were being drawn into a view the camera was not showing.
   *
   * `FLIP` is a half turn about the ship's own up axis, applied on the right
   * so it stays a local rotation: the camera ends up looking along the nose,
   * with the ship's up still up and the roll sense intact.
   */
  function placeCamera(flight, dt) {
    if (!flight) return;
    const quat = toQuaternion(flight.quat);
    // Scratch vectors rather than two fresh `Vector3` per frame. At 60 Hz that
    // was 120 short-lived allocations a second, for the whole life of the
    // process, purely to be read once each. `rig._fwd` and `rig._up` are
    // consumed inside this function, so sharing them is safe.
    const back = rig._fwd.set(0, 0, -1).applyQuaternion(quat);
    const up = rig._up.set(0, 1, 0).applyQuaternion(quat);
    const aim = rig._aim.copy(quat).multiply(CAMERA_FLIP);

    const target = rig._tmp.copy(flight.pos)
      .addScaledVector(back, CAMERA.cockpitDistance)
      .addScaledVector(up, CAMERA.cockpitRise);

    // Exponential smoothing, frame-rate independent. `1 - exp(-k*dt)` is the
    // correct form here; the naive `lerp(…, k*dt)` drifts at high frame rates.
    const k = 1 - Math.exp(-dt * 22);
    rig.position.lerp(target, Math.min(1, k));
    rig.quaternion.slerp(aim, Math.min(1, 1 - Math.exp(-dt * 26)));

    camera.position.copy(rig.position);
    camera.quaternion.copy(rig.quaternion);

    // Shake: decays exponentially, applied as a small random rotation offset
    // so the horizon wobbles rather than the whole image translating (which
    // would look like the camera detaching from the ship).
    if (rig.shake > 0.0001) {
      const s = rig.shake;
      camera.rotateX((Math.random() - 0.5) * s * 0.05);
      camera.rotateY((Math.random() - 0.5) * s * 0.05);
      camera.rotateZ((Math.random() - 0.5) * s * 0.03);
      rig.shake *= Math.exp(-dt * 6.5);
      if (rig.shake < 0.0001) rig.shake = 0;
    }
  }

  /** Snap the camera to the flight pose with no lag. Used on jump/dock. */
  function snapCamera(flight) {
    if (!flight) return;
    const quat = toQuaternion(flight.quat);
    rig.position.copy(flight.pos);
    rig.quaternion.copy(quat).multiply(CAMERA_FLIP);
    rig.shake = 0;
    camera.position.copy(flight.pos);
    camera.quaternion.copy(rig.quaternion);
    placeCamera(flight, 1);
  }

  /** Add an impulse to the view shake. Clamped - a nuke should not blind you. */
  function addShake(amount) {
    rig.shake = Math.min(1.6, rig.shake + Math.max(0, amount || 0));
  }

  let elapsed = 0;
  let damageFlash = 0;

  /**
   * Draw one frame.
   *
   * `time` is seconds since start, `dt` the frame delta. Both are passed in
   * rather than read from a clock here, so the game loop stays the single
   * owner of time and the headless path can step deterministically.
   */
  function render(flight, time, dt) {
    const now = typeof time === 'number' ? time : elapsed;
    const delta = typeof dt === 'number' ? dt : 1 / 60;
    elapsed = now;

    placeCamera(flight, delta);

    // Decay the damage flash before uploading it, so a one-frame hit still
    // produces a visible (if brief) static burst.
    if (damageFlash > 0.0001) {
      damageFlash *= Math.exp(-delta * 7);
      if (damageFlash < 0.0001) damageFlash = 0;
    }

    // autoClear is off, so each path clears explicitly. The composer's first
    // pass does its own clear; the direct path has to do it by hand.
    if (composer) {
      composer.render(delta);
    } else {
      renderer.clear(true, true, false);
      renderer.render(scene, camera);
    }
  }

  /** Kick off the view shake that accompanies hull damage. */
  function flash(amount) {
    damageFlash = Math.min(1, damageFlash + Math.max(0, amount === undefined ? 1 : amount));
  }

  /**
   * Tear down and rebuild the system scenery without touching the sky.
   *
   * A hyperspace jump replaces everything in the scene except the sky and the
   * lights, which is why the sky group is parented to the scene root and never
   * to a system group.
   */
  function setSystemGroup(group) {
    if (systemGroup && systemGroup.parent) systemGroup.parent.remove(systemGroup);
    systemGroup = group || null;
    if (systemGroup) scene.add(systemGroup);
  }
  let systemGroup = null;

  /** Dispose everything. Idempotent - the game over screen may call it twice. */
  function dispose() {
    if (composer) {
      // EffectComposer has no aggregate dispose; each pass owns its targets.
      composer.passes.forEach((p) => { if (typeof p.dispose === 'function') p.dispose(); });
      if (typeof composer.dispose === 'function') composer.dispose();
    }
    disposeSky(starfield);
    disposeEnvProbe(envProbe);
    renderer.dispose();
    composer = null;
    bloom = null;
  }

  return {
    renderer,
    scene,
    camera,
    composer,
    bloom,
    starfield,
    envProbe,
    mode: composed ? 'composed' : 'direct',
    probe,
    pixelRatio,
    get size() { return { width: size.width, height: size.height }; },
    get elapsed() { return elapsed; },
    resize,
    render,
    placeCamera,
    snapCamera,
    addShake,
    flash,
    setSystemGroup,
    dispose,
  };
}

/**
 * The facade returned when there is no usable WebGL context.
 *
 * Every method is present and does nothing. This matters more than it looks:
 * it means `main.js` never needs a single `if (renderer)`, and the headless
 * e2e run exercises the *real* game loop - all the state machine transitions,
 * physics, economy and HUD - right up to the point of actually painting
 * pixels. A test that took a different code path would be testing the fallback.
 */
function strandedApi(canvas, probe, error) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CAMERA.fov, 16 / 9, CAMERA.near, CAMERA.far);
  const starfield = buildSky(1);
  scene.add(starfield);
  return {
    renderer: null,
    scene,
    camera,
    composer: null,
    bloom: null,
    starfield,
    // No probe axis is built here: with no WebGL there is no material to
    // reflect anything. The field exists so callers see the same shape.
    envProbe: null,
    mode: 'none',
    probe,
    error: error || null,
    pixelRatio: 1,
    size: { width: canvas.clientWidth || 0, height: canvas.clientHeight || 0 },
    elapsed: 0,
    resize() {},
    render() {},
    placeCamera() {},
    snapCamera() {},
    addShake() {},
    flash() {},
    setSystemGroup() {},
    dispose() {},
  };
}

export default {
  CAMERA, STARFIELD, LOOK,
  probeContext, buildSky, disposeSky, createRenderer,
};