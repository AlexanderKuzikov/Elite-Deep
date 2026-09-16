/**
 * Sky: the procedural starfield, the galactic band and the nebulae.
 *
 * This is the single biggest lever on whether the game *feels* like space. The
 * first version drew 2600 flat points on a uniform sphere, which is technically
 * a starfield and reads as grey noise: real skies have an obvious structure -
 * a dense galactic band, dust lanes cutting through it, bright and dim regions,
 * and a handful of coloured emission nebulae.
 *
 * Two hard constraints shape everything here:
 *
 * 1. **One self-contained HTML file.** No texture assets, no HDR environment
 *    maps, no .jpg. Every colour and every soft glow is generated at runtime on
 *    the CPU and uploaded as a small canvas-backed texture.
 *
 * 2. **Deterministic from a seed.** Two runs with the same seed must see the
 *    same sky, and a hyperspace jump must not reshuffle it.
 *
 * Cost is deliberately tiny: three draw calls for the entire sky - one for the
 * stars, and one each for the nebulae and the dust lanes, which are instanced
 * rather than one mesh per billboard. All additive and depth-write-free, drawn
 * before anything else.
 */
import * as THREE from 'three';
import * as R from '../logic/rng.js';
import { disposeTree } from './dispose.js';

/** Tuning for the sky layer. Distances are world units, far past the camera. */
export const SKY = {
  // --- Stars ---
  starCount: 9000,
  innerRadius: 14000,
  outerRadius: 26000,
  // Bright stars are rare. A long-tail power law is what makes a sky read as
  // depth rather than as wallpaper; uniform brightness looks like noise.
  brightShare: 0.03,
  minSize: 0.7,
  maxSize: 2.4,

  // --- Galactic band ---
  // Stars are concentrated toward a plane. `bandTightness` is the standard
  // deviation of the Gaussian offset from that plane, as a fraction of the
  // shell radius; smaller is a thinner band.
  bandShare: 0.55,
  bandTightness: 0.16,
  bandTilt: 0.42,          // radians the galactic plane is tilted from the horizon

  // --- Nebulae ---
  nebulaCount: 14,
  nebulaRadius: 900,
  nebulaScale: 4200,       // average radius of a nebula billboard

  // --- Dust ---
  dustCount: 520,
  dustScale: 2600,
};

/**
 * A soft radial sprite, generated on a canvas.
 *
 * Why a texture at all, given the "no assets" rule: point sprites are square
 * and hard-edged, so a star drawn as a point is a visible little block. A soft
 * falloff is the difference between "stars" and "dirt on the lens". Generating
 * it in code keeps the single-file promise.
 *
 * The falloff is deliberately sharper than a plain linear ramp: a linear ramp
 * reads as a fuzzy blob, while `pow(1 - d, 3)` gives a compact core with a soft
 * halo, which is what a point of light actually looks like.
 */
export function makeGlowTexture(size, softness) {
  const canvas = typeof document !== 'undefined'
    ? document.createElement('canvas')
    : null;
  if (!canvas) return null;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const centre = (size - 1) / 2;
  const power = softness === undefined ? 3 : softness;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x - centre) / centre;
      const dy = (y - centre) / centre;
      const d = Math.sqrt(dx * dx + dy * dy);
      const a = d >= 1 ? 0 : Math.pow(1 - d, power);
      const i = (y * size + x) * 4;
      img.data[i] = 255;
      img.data[i + 1] = 255;
      img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** The tilted galactic-plane normal, and a matching in-plane basis. */
function galacticBasis() {
  // The band is the set of directions perpendicular to this normal. Deriving
  // the basis once, here, is what stops the star layer and the nebula layer
  // from disagreeing about where the band is - an earlier version built stars
  // against this normal and placed nebulae by rotating about the X axis, which
  // does nothing to an X-aligned vector and parked every nebula near a pole.
  const normal = new THREE.Vector3(Math.sin(SKY.bandTilt), Math.cos(SKY.bandTilt), 0).normalize();
  // Two vectors spanning the plane. `up` is never parallel to the normal for
  // the tilts used here, but the fallback keeps it total.
  const ref = Math.abs(normal.y) > 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  const ax = new THREE.Vector3().crossVectors(ref, normal).normalize();
  const ay = new THREE.Vector3().crossVectors(normal, ax).normalize();
  return { normal, ax, ay };
}

/**
 * A direction inside the galactic band, at angle `a` around it, offset `off`
 * out of the plane (in fractions of the shell radius).
 */
function bandDirection(a, off, basis) {
  return new THREE.Vector3()
    .addScaledVector(basis.ax, Math.cos(a))
    .addScaledVector(basis.ay, Math.sin(a))
    .addScaledVector(basis.normal, off)
    .normalize();
}

/**
 * Build the star layer.
 *
 * Distribution: `bandShare` of the stars are pulled toward the galactic plane
 * with a Gaussian falloff, the rest are uniform on the sphere. That single
 * choice is what produces the Milky Way look - the band is dense, the poles are
 * sparse, and the eye reads it as a galaxy rather than as a shell.
 */
function buildStars(seed, sizeScale, glowTexture) {
  const rand = R.mulberry32((seed ^ 0x5f356495) >>> 0);
  const count = Math.round(SKY.starCount * (sizeScale === undefined ? 1 : sizeScale));
  const positions = new Float32Array(count * 3);
  const colours = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const colour = new THREE.Color();
  const basis = galacticBasis();

  for (let i = 0; i < count; i += 1) {
    // Direction on the unit sphere.
    let u = rand() * 2 - 1;
    const phi = rand() * Math.PI * 2;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    let x = Math.cos(phi) * s;
    let y = u;
    let z = Math.sin(phi) * s;

    if (rand() < SKY.bandShare) {
      // Distance from the galactic plane, signed.
      const signed = x * basis.normal.x + y * basis.normal.y + z * basis.normal.z;
      // Box-Muller for a Gaussian; two uniforms in, one normal out.
      const g = Math.sqrt(-2 * Math.log(1 - rand() * 0.999999)) * Math.cos(2 * Math.PI * rand());
      const shift = -signed + g * SKY.bandTightness;
      x += basis.normal.x * shift;
      y += basis.normal.y * shift;
      z += basis.normal.z * shift;
      // Re-project onto the sphere so the shell radius stays uniform.
      const len = Math.hypot(x, y, z) || 1;
      x /= len; y /= len; z /= len;
    }

    const r = SKY.innerRadius + rand() * (SKY.outerRadius - SKY.innerRadius);
    positions[i * 3] = x * r;
    positions[i * 3 + 1] = y * r;
    positions[i * 3 + 2] = z * r;

    // Spectral classes, roughly by real relative frequency: mostly cool
    // white-blue, a tail of amber, a rare blue giant.
    const roll = rand();
    if (roll < 0.015) colour.setHex(0x9db8ff);        // hot blue
    else if (roll < 0.10) colour.setHex(0xffb070);    // cool amber
    else if (roll < 0.30) colour.setHex(0xfff0d0);    // warm white
    else if (roll < 0.70) colour.setHex(0xe8f0ff);    // white
    else colour.setHex(0xc8d8ff);                     // pale blue

    // Brightness follows a power law so a few stars dominate.
    const bright = rand() < SKY.brightShare;
    const lum = bright
      ? 0.95 + rand() * 0.05
      : 0.18 + Math.pow(rand(), 2.2) * 0.72;
    colours[i * 3] = colour.r * lum;
    colours[i * 3 + 1] = colour.g * lum;
    colours[i * 3 + 2] = colour.b * lum;

    // Size tracks brightness, but not proportionally - a very bright star is
    // big *and* intense, which is what the bloom pass then exaggerates.
    sizes[i] = bright
      ? SKY.maxSize * (0.8 + rand() * 0.2)
      : SKY.minSize + rand() * (SKY.maxSize - SKY.minSize) * 0.7;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));

  const mat = new THREE.PointsMaterial({
    vertexColors: true,
    size: 2.0,
    sizeAttenuation: false,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    map: glowTexture || null,
  });
  // With a sprite map the material needs alpha handled explicitly, or the
  // square edges show as a faint grid over the whole sky.
  if (glowTexture) { mat.alphaTest = 0.01; mat.opacity = 1; }

  const points = new THREE.Points(geo, mat);
  points.name = 'sky:stars';
  points.renderOrder = -3;
  points.frustumCulled = false;
  return points;
}

/**
 * The nebulae and dust lanes: large additive billboards, coloured, placed
 * preferentially inside the galactic band because that is where real nebulae
 * are.
 *
 * ## Why this is two `InstancedMesh` and not 534 meshes
 *
 * The obvious implementation - one `Mesh` per billboard - is what this used to
 * do, and it cost 534 of the scene's 684 meshes. That is 78 % of every draw
 * call in the game spent on a backdrop that is deterministic, static, and
 * never changes after boot. All of them were transparent and additive, so the
 * renderer could not batch any of them.
 *
 * Two instanced meshes replace the lot: one for the 14 nebulae, one for the
 * 520 dust billboards. Same pixels, three draw calls for the entire sky.
 *
 * ## Folding opacity into the instance colour
 *
 * Each nebula used to carry its own material, because each needs its own
 * colour *and* its own opacity. Under additive blending the contribution is
 * `colour * opacity * texture`, so the two multiply together and opacity is
 * redundant with the colour's magnitude. Folding it in means one shared
 * material and a per-instance colour, which is what makes a single draw call
 * possible without any shader work.
 *
 * ## Preserving the exact sky
 *
 * The PRNG draws are consumed in the same order and the same number as before,
 * so a given seed still produces the identical nebula and dust layout. The
 * orientation is taken from `Object3D.lookAt` - the same code path the old
 * per-quad meshes used - rather than a hand-derived quaternion that merely
 * happens to agree.
 */
function buildNebulae(seed, glowTexture) {
  const group = new THREE.Group();
  group.name = 'sky:nebulae';
  group.renderOrder = -2;
  if (!glowTexture) return group;

  const rand = R.mulberry32((seed ^ 0x2f9e77b1) >>> 0);
  const basis = galacticBasis();

  // Emission nebula colours. These are the real dominant lines: H-alpha red,
  // OIII teal, and the dust-scattered amber of reflection nebulae.
  const palette = [0xff4d6a, 0x5a8fff, 0x8f5aff, 0x3fd8c0, 0xff8a4d, 0x4d7fff];

  // Depth *testing* must stay on. Turning it off makes the nebula paint over
  // whatever is in front of it, which is fine when the only geometry is a
  // starfield 20000 units away, and very wrong the moment a station or a ship
  // is between the camera and the band: the quad is drawn after the scene and
  // ignores the depth buffer, so a blue wash appears *inside* the station.
  // The sky is always the farthest thing in the scene, so testing depth alone
  // puts it behind everything with no render-order tricks needed.
  function billboardMaterial() {
    return new THREE.MeshBasicMaterial({
      map: glowTexture,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      fog: false,
      side: THREE.DoubleSide,
    });
  }

  // A unit plane, scaled per instance through the instance matrix. The
  // geometry is shared by both layers.
  const quadGeometry = new THREE.PlaneGeometry(1, 1);
  const scratch = new THREE.Object3D();
  const tint = new THREE.Color();

  /**
   * Fold an opacity into a colour, reproducing what the old per-mesh materials
   * did on screen.
   *
   * This is subtler than it looks and getting it wrong changes the sky by a
   * factor of nearly three, which is why it is a named function with this
   * comment rather than an inline `multiplyScalar`.
   *
   * The old code put the opacity on `material.opacity` and left the colour
   * alone. Three applies that opacity to `diffuseColor.a`, and with additive
   * blending the blend factor is `SRC_ALPHA` - but the fragment has *already
   * been encoded to sRGB* by `colorspace_fragment` before the blend happens.
   * So the old contribution was:
   *
   *     sRGB(colour) * opacity          <- opacity applied in DISPLAY space
   *
   * An instance colour cannot do that. `instanceColor` multiplies the colour
   * *before* encoding, so folding the same scalar in naively gives:
   *
   *     sRGB(colour * opacity)          <- opacity applied in LINEAR space
   *
   * and sRGB is non-linear, so these differ - by 2.7x at the opacities this
   * sky uses. Measured, for a mid-blue at opacity 0.09: the old path rendered
   * byte 7, the naive fold renders byte 19.
   *
   * The fix is to walk the colour into display space, apply the opacity there,
   * and walk it back - so the encode the shader performs afterwards lands on
   * exactly the value the old path produced. Verified against the old
   * implementation at five opacities; the two agree to the byte.
   *
   * The dust layer does not need this: it shares one opacity across every
   * billboard, so it keeps that opacity on the material and takes the original
   * code path unchanged.
   */
  function foldOpacity(linearColour, opacity) {
    tint.copy(linearColour);
    tint.convertLinearToSRGB();
    tint.multiplyScalar(opacity);
    tint.convertSRGBToLinear();
    return tint;
  }

  /**
   * Place one billboard instance.
   *
   * `Object3D.lookAt` is used rather than a computed quaternion because it is
   * the exact code path the previous per-quad meshes took, so the orientation
   * is identical by construction instead of by agreement.
   */
  function place(mesh, index, direction, scale, colour) {
    scratch.position.copy(direction);
    scratch.scale.setScalar(scale);
    scratch.lookAt(0, 0, 0);
    scratch.updateMatrix();
    mesh.setMatrixAt(index, scratch.matrix);
    if (colour) mesh.setColorAt(index, colour);
  }

  /** Every instance of a layer sits in the band and faces the origin. */
  function finish(mesh, name) {
    mesh.name = name;
    mesh.renderOrder = -2;
    // The instances are scattered across the whole sky, so the base geometry's
    // bounding sphere says nothing useful about where they are.
    mesh.frustumCulled = false;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return mesh;
  }

  // --- Nebulae ------------------------------------------------------------
  const nebulae = new THREE.InstancedMesh(quadGeometry, billboardMaterial(), SKY.nebulaCount);
  for (let i = 0; i < SKY.nebulaCount; i += 1) {
    // Inside the band, using the same basis the stars use. The two `rand()`
    // calls here, and the three below, are consumed in the same order as the
    // pre-instancing code so the sky is unchanged for a given seed.
    const dir = bandDirection(rand() * Math.PI * 2, (rand() - 0.5) * SKY.bandTightness * 2, basis);
    dir.multiplyScalar(SKY.outerRadius * 0.94);

    tint.setHex(palette[Math.floor(rand() * palette.length) % palette.length]);
    tint.multiplyScalar(0.5 + rand() * 0.5);
    const opacity = 0.045 + rand() * 0.075;
    const scale = SKY.nebulaScale * (0.5 + rand() * 1.6);
    // Opacity and colour both scale the additive contribution, so one
    // per-instance colour carries both - folded in display space, see
    // `foldOpacity`.
    const instanceColour = foldOpacity(tint, opacity).clone();

    place(nebulae, i, dir, scale, instanceColour);
  }
  group.add(finish(nebulae, 'sky:nebula-clouds'));

  // --- Dust ---------------------------------------------------------------
  // Dark, but with additive blending there is no such thing as darkness. So
  // dust is done as very dim, very large, slightly warm haze instead, which
  // reads as structure rather than as a stain. Every billboard shares one
  // colour and one opacity, so this layer needs no per-instance tint at all.
  const dustMaterial = billboardMaterial();
  dustMaterial.color = new THREE.Color(0x6a5a4a);
  dustMaterial.opacity = 0.03;

  const dust = new THREE.InstancedMesh(quadGeometry, dustMaterial, SKY.dustCount);
  for (let i = 0; i < SKY.dustCount; i += 1) {
    const dir = bandDirection(rand() * Math.PI * 2, (rand() - 0.5) * SKY.bandTightness * 2.5, basis);
    dir.multiplyScalar(SKY.outerRadius * 0.9);
    const scale = SKY.dustScale * (0.4 + rand() * 1.2);
    place(dust, i, dir, scale, null);
  }
  group.add(finish(dust, 'sky:dust-lanes'));

  return group;
}

/**
 * Build the whole sky as one group.
 *
 * Returns a group holding the stars and the nebulae. Parented to the scene root
 * and never removed, because a hyperspace jump tears down the system group and
 * the sky must survive it.
 */
export function buildSky(seed, opts) {
  const options = opts || {};
  const group = new THREE.Group();
  group.name = 'sky';

  // Generated once and shared: the nebulae are the same sprite as the stars,
  // just stretched. Two textures would be two uploads for no visual gain.
  const glow = makeGlowTexture(64, 2.2);

  group.add(buildStars(seed, options.starScale, glow));
  group.add(buildNebulae(seed, glow));

  group.userData.glowTexture = glow;
  return group;
}

/**
 * A cheap stand-in for the real sky, used in Node and anywhere a canvas is not
 * available. Keeps the same shape so callers never branch on the environment.
 */
export function buildSkyStub(seed) {
  const group = new THREE.Group();
  group.name = 'sky';
  group.userData.glowTexture = null;
  return group;
}

/**
 * Release everything `buildSky` allocated.
 *
 * Walks the group rather than naming the two layers: the star cloud and the
 * nebula billboards share one glow texture, so disposing it once from the
 * group's `userData` and letting each child free its own geometry is both
 * shorter and correct if a third layer is ever added. Tolerates `null` and the
 * stub, so `renderer.dispose()` can call it unconditionally.
 */
export function disposeSky(group) {
  if (!group) return;
  const glow = group.userData ? group.userData.glowTexture : null;
  if (glow && typeof glow.dispose === 'function') glow.dispose();
  // The per-child walk is shared with every other disposal path in the
  // project, so the `userData.shared` rule cannot drift between them again.
  disposeTree(group);
  if (group.userData) group.userData.glowTexture = null;
}

export default {
  SKY, buildSky, buildSkyStub, disposeSky, makeGlowTexture,
};
