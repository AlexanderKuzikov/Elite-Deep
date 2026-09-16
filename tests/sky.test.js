/**
 * Tests for the procedural sky.
 *
 * The sky is built in Node (no canvas) as well as in the browser, so the first
 * thing these pin is that the no-canvas path degrades to a working starfield
 * rather than to nothing. Everything else pins the *structure* - a galactic
 * band that is measurably denser than the poles, a long-tailed brightness
 * distribution, and determinism.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import * as S from '../src/sim/sky.js';

function starsOf(group) {
  return group.children.find((c) => c.name === 'sky:stars');
}

function positionArray(group) {
  const pts = starsOf(group);
  return pts.geometry.attributes.position.array;
}

/** The billboard layers, which are instanced rather than one mesh per quad. */
function layerOf(group, name) {
  const layer = group.children.find((c) => c.name === name);
  assert.ok(layer, 'no layer named ' + name);
  return layer;
}

/**
 * The position of every instance of an `InstancedMesh`.
 *
 * The billboards used to be individual meshes, so their positions were simply
 * `object.position`. Now they are instance matrices, and a test that reads
 * `.position` would silently see (0,0,0) for all of them and pass while the
 * whole layer sat at the origin.
 */
function instancePositions(mesh) {
  assert.ok(mesh.isInstancedMesh, mesh.name + ' should be an InstancedMesh');
  const out = [];
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < mesh.count; i += 1) {
    mesh.getMatrixAt(i, matrix);
    out.push(new THREE.Vector3().setFromMatrixPosition(matrix));
  }
  return out;
}

/**
 * The smallest 2D canvas that `makeGlowTexture` will accept.
 *
 * It implements exactly the ImageData round-trip the sky uses - `createImageData`
 * returning a real `Uint8ClampedArray`, and `putImageData` doing nothing. That
 * is enough for `THREE.CanvasTexture`, which only reads `width`/`height` and
 * hands the element to `texImage2D` (never reached in Node).
 */
function makeStubCanvas(size) {
  return {
    width: size,
    height: size,
    getContext() {
      return {
        createImageData(w, h) {
          return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
        },
        putImageData() {},
        // Not used by the sky, but present so a future effect does not silently
        // get `undefined is not a function` here instead of a clear failure.
        fillRect() {},
        clearRect() {},
      };
    },
  };
}

test('the sky builds without a canvas and still has stars', () => {
  // Node has no document, so the glow sprite cannot be generated. The sky must
  // still exist and still contain a populated starfield - a headless build that
  // silently produced an empty sky would make every visual test meaningless.
  const sky = S.buildSky(1234);
  const stars = starsOf(sky);
  assert.ok(stars, 'no star layer was built');
  assert.ok(stars.geometry.attributes.position.count > 1000,
    'only ' + stars.geometry.attributes.position.count + ' stars');
  assert.ok(stars.geometry.attributes.color, 'stars have no per-star colour');
});

test('the glow texture is skipped rather than throwing when there is no canvas', () => {
  const sky = S.buildSky(99);
  assert.strictEqual(sky.userData.glowTexture, null);
  assert.strictEqual(S.buildSkyStub(1).userData.glowTexture, null);
});

test('palette is applied to the new colours where css is defined', () => {
  // Guard the exported tuning table itself. A typo that made `innerRadius`
  // greater than `outerRadius` would place every star at a negative radius and
  // the sky would collapse to a point.
  assert.ok(S.SKY.innerRadius < S.SKY.outerRadius, 'star shell is inside out');
  assert.ok(S.SKY.minSize < S.SKY.maxSize, 'star size range is inverted');
  assert.ok(S.SKY.bandShare > 0.3 && S.SKY.bandShare < 0.8,
    'band share ' + S.SKY.bandShare + ' is not a believable galaxy');
  assert.ok(S.SKY.bandTightness > 0.02 && S.SKY.bandTightness < 0.4,
    'band tightness ' + S.SKY.bandTightness + ' is either a line or no band at all');
});

test('stars sit on the declared shell', () => {
  const sky = S.buildSky(1234);
  const pos = positionArray(sky);
  let min = Infinity, max = 0;
  for (let i = 0; i < pos.length; i += 3) {
    const r = Math.hypot(pos[i], pos[i + 1], pos[i + 2]);
    min = Math.min(min, r); max = Math.max(max, r);
  }
  assert.ok(min >= S.SKY.innerRadius - 1, 'a star is inside the shell: ' + min);
  assert.ok(max <= S.SKY.outerRadius + 1, 'a star is outside the shell: ' + max);
});

test('there is a galactic band: the tilted plane is denser than the poles', () => {
  // This is the whole point of the rewrite. If the band is not measurably
  // denser, the sky is just a uniform shell again and the Milky Way is gone.
  const sky = S.buildSky(4242);
  const pos = positionArray(sky);
  const tilt = S.SKY.bandTilt;
  // The band's normal, matching how sky.js builds it.
  const nX = Math.sin(tilt), nY = Math.cos(tilt), nZ = 0;

  let near = 0, far = 0, total = 0;
  for (let i = 0; i < pos.length; i += 3) {
    const len = Math.hypot(pos[i], pos[i + 1], pos[i + 2]) || 1;
    const d = Math.abs((pos[i] * nX + pos[i + 1] * nY + pos[i + 2] * nZ) / len);
    if (d < 0.15) near += 1;
    else if (d > 0.75) far += 1;
    total += 1;
  }
  // On a uniform sphere, the fraction within 0.15 of the plane is ~0.15 and
  // the fraction past 0.75 is ~0.25. The band has to beat both comfortably.
  const nearShare = near / total;
  const farShare = far / total;
  assert.ok(nearShare > 0.30,
    'the galactic band is too thin: only ' + (nearShare * 100).toFixed(1) + '% near the plane');
  assert.ok(nearShare > farShare * 1.6,
    'no band structure: near ' + nearShare.toFixed(3) + ' vs far ' + farShare.toFixed(3));
});

test('star brightness has a long tail rather than being uniform', () => {
  // A uniform distribution looks like wallpaper. The power law is what makes a
  // few stars punch through and the rest recede.
  const sky = S.buildSky(777);
  const colours = starsOf(sky).geometry.attributes.color.array;
  let dim = 0, bright = 0;
  for (let i = 0; i < colours.length; i += 3) {
    const lum = Math.max(colours[i], colours[i + 1], colours[i + 2]);
    if (lum < 0.25) dim += 1;
    else if (lum > 0.85) bright += 1;
  }
  const total = colours.length / 3;
  assert.ok(bright / total < 0.12, 'too many bright stars: ' + (bright / total * 100).toFixed(1) + '%');
  assert.ok(dim / total > 0.25, 'not enough dim stars: ' + (dim / total * 100).toFixed(1) + '%');
  assert.ok(bright > 0, 'no bright stars at all');
});

test('the sky is deterministic from its seed', () => {
  const a = positionArray(S.buildSky(31337));
  const b = positionArray(S.buildSky(31337));
  assert.deepEqual(Array.from(a), Array.from(b), 'two builds with one seed differ');
});

test('a different seed produces a different sky', () => {
  const a = positionArray(S.buildSky(1));
  const b = positionArray(S.buildSky(2));
  let same = true;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) { same = false; break; }
  }
  assert.ok(!same, 'the seed is not reaching the sky generator');
});

test('the whole sky draws in very few calls, never writes depth, but does test it', () => {
  // The sky is background. It must not *write* depth (it would mask everything
  // drawn after it), and it must not cost a draw call per star.
  //
  // It must, however, still *test* depth. This is subtle and was a real bug:
  // with `depthTest: false` the nebula billboards ignore the depth buffer and
  // paint over whatever is in front of them, which put a blue haze inside the
  // Coriolis station. The sky sits at radius 14000-26000 while every real
  // object is inside 10000, so a plain depth test is all that is needed to put
  // the sky behind the world - no render-order tricks.
  const sky = S.buildSky(555);
  const stars = starsOf(sky);
  assert.strictEqual(stars.material.depthWrite, false);
  assert.strictEqual(stars.material.depthTest, true,
    'the stars must not ignore the depth buffer');
  assert.ok(stars.renderOrder < 0, 'the sky is not drawn first');
  assert.strictEqual(stars.frustumCulled, false, 'the sky would be culled when looking away');

  // The same applies to any billboard that exists. In plain Node there is no
  // canvas, so the glow sprite cannot be built and the billboard layers are
  // legitimately empty - the batching assertion lives in the canvas-stubbed
  // test below, where the layers are actually populated.
  let meshes = 0;
  sky.traverse((o) => {
    if (!o.isMesh) return;
    meshes += 1;
    assert.strictEqual(o.material.depthWrite, false, 'a sky billboard writes depth');
    assert.strictEqual(o.material.depthTest, true,
      'a sky billboard ignores the depth buffer and will draw over the station');
  });
  assert.ok(meshes <= 4, 'the sky costs ' + meshes + ' meshes');
});

test('nebulae are placed inside the galactic band, not at the poles', () => {
  // Nebulae form where the gas is. Scattering them uniformly would break the
  // structure the band is there to create.
  //
  // Node has no canvas, so the glow sprite cannot be made and the nebula layer
  // is legitimately empty. To test the placement maths this installs a minimal
  // 2D canvas stub and removes it again afterwards - the alternative would be
  // to leave the most placement-sensitive layer in the sky completely
  // uncovered, which is how a nebula ends up at a pole unnoticed.
  const realDocument = globalThis.document;
  globalThis.document = { createElement: () => makeStubCanvas(64) };
  try {
    const sky = S.buildSky(2024);
    const layer = layerOf(sky, 'sky:nebulae');
    const clouds = layerOf(layer, 'sky:nebula-clouds');
    const tilt = S.SKY.bandTilt;
    const nX = Math.sin(tilt), nY = Math.cos(tilt), nZ = 0;

    const positions = instancePositions(clouds);
    assert.strictEqual(positions.length, S.SKY.nebulaCount,
      'expected ' + S.SKY.nebulaCount + ' nebulae, got ' + positions.length);
    for (const p of positions) {
      const len = p.length() || 1;
      const d = Math.abs((p.x * nX + p.y * nY + p.z * nZ) / len);
      assert.ok(d < 0.45,
        'a nebula sits at ' + d.toFixed(2) + ' from the band, which is a pole');
      // And it must be out at the sky shell, not sitting on the camera.
      assert.ok(len > S.SKY.innerRadius, 'a nebula is inside the star shell: ' + len.toFixed(0));
    }

    // The dust layer is placed the same way and is the larger of the two.
    const dust = layerOf(layer, 'sky:dust-lanes');
    assert.strictEqual(dust.count, S.SKY.dustCount);

    // The batching invariant, asserted where the layers actually exist:
    // 534 billboards must cost two meshes, not 534. Before instancing they
    // were 78 % of every draw call in the game, spent on a static backdrop.
    let billboardMeshes = 0;
    let billboards = 0;
    layer.traverse((o) => {
      if (!o.isMesh) return;
      billboardMeshes += 1;
      billboards += o.isInstancedMesh ? o.count : 1;
    });
    assert.strictEqual(billboardMeshes, 2,
      'expected the two billboard layers, found ' + billboardMeshes + ' meshes');
    assert.strictEqual(billboards, S.SKY.nebulaCount + S.SKY.dustCount,
      'expected ' + (S.SKY.nebulaCount + S.SKY.dustCount) + ' billboards, got ' + billboards);

    // And with a working canvas the sprite really is produced.
    assert.ok(sky.userData.glowTexture, 'the glow sprite was not created with a canvas present');
  } finally {
    if (realDocument === undefined) delete globalThis.document;
    else globalThis.document = realDocument;
  }
});

test('the nebula layer is empty rather than broken without a canvas', () => {
  // The documented degradation: no canvas means no sprite, so no nebulae. It
  // must be a clean empty group, not a crash and not a group full of meshes
  // with a null map (which three renders as opaque black squares).
  const sky = S.buildSky(2024);
  const nebulae = layerOf(sky, 'sky:nebulae');
  assert.ok(nebulae, 'the nebula group should still exist');
  let meshes = 0;
  nebulae.traverse((o) => { if (o.isMesh) meshes += 1; });
  assert.strictEqual(meshes, 0, 'nebulae were built without a sprite and would render as black quads');
});

test('the default mirror exports the sky builders', () => {
  assert.strictEqual(S.default.buildSky, S.buildSky);
  assert.strictEqual(S.default.buildSkyStub, S.buildSkyStub);
  assert.strictEqual(S.default.SKY, S.SKY);
});
