/**
 * Environment probe: the indirect light that PBR materials reflect.
 *
 * ## Why this module exists
 *
 * A `MeshStandardMaterial` with metalness above zero reflects its surroundings.
 * If the surroundings are not supplied, a metal surface reflects nothing and
 * renders **black** - which is the exact trap the project notes flagged: "PBR,
 * no environment probe, metal without it will be black."
 *
 * So the moment the hulls stop being `MeshLambertMaterial` and start being
 * `MeshStandardMaterial`, this module is mandatory, not decorative.
 *
 * ## Why a hand-built equirect instead of PMREMGenerator
 *
 * The obvious approach is `PMREMGenerator.fromScene(skyGroup)`, which bakes the
 * real sky into the mip-chained cube map that PBR expects. It is more
 * "physically correct" and it was the first thing considered. It was rejected
 * for three concrete reasons:
 *
 * 1. **It costs a render target and a GPU pass at boot.** PMREM allocates
 *    cube render targets, runs a blur chain, and has a lifetime to manage. That
 *    is real complexity, and it runs before the first frame.
 * 2. **It does not exist in the headless path.** The e2e suite boots the real
 *    game inside Chrome with a software GL stack, and the stranded path boots
 *    it with *no* WebGL at all. A probe that only works with a live GPU means
 *    the two paths see different materials - and then the test is not testing
 *    the game.
 * 3. **What the probe actually needs is a gradient field, not the sky.** The
 *    material does not need to resolve individual 9000 stars; it needs
 *    *plausible directional colour*: cool starlight from above, warm dust from
 *    below, the pale smear of the galactic band across one horizon, and a few
 *    nebula blooms. That is a low-frequency description. Authoring it directly
 *    is cheaper, more predictable, and - crucially - **testable**, because the
 *    whole thing is an array of bytes a unit test can read.
 *
 * So: a small equirectangular `DataTexture`, generated in pure JS from the
 * same `SKY` constants the geometry uses, so the reflection and the sky agree
 * about which way the band runs. `scene.environment` accepts a plain equirect
 * texture with `EquirectangularReflectionMapping` and does the cube lookup in
 * the shader, so no PMREM pass is required for a rough, low-frequency probe.
 *
 * ## Encoding (the part that is easy to get wrong)
 *
 * The texture is authored in **linear** light, not sRGB. If it were tagged
 * `SRGBColorSpace`, three would decode it and roughly square the values, so
 * every reflection would come out much darker than authored - the kind of bug
 * that reads as "PBR made everything muddy" and gets blamed on the materials.
 * `LinearSRGBColorSpace` with `FloatType` keeps the authored radiance intact and
 * lets values exceed 1.0, which is what makes a bright reflection actually
 * catch the bloom gate in the same way the star does.
 */
import * as THREE from 'three';
import * as R from '../logic/rng.js';
import { SKY } from './sky.js';

/** Tuning for the probe. Width doubles as the horizontal resolution. */
export const ENV = {
  width: 96,               // equirect width; height is half
  // Overall radiance. Kept low: this is *indirect* light, it must not compete
  // with the directional star light that actually shapes the facets.
  intensity: 0.55,

  // --- The vertical gradient -------------------------------------------------
  // The two poles of the probe. Space has no real "up", but the game's camera
  // does, and a hull that reflects cool light from the zenith and warm light
  // from the deck reads as three-dimensional when it rolls. This is the same
  // trick as the hemisphere light, given to the materials as well.
  zenith: 0x2b3d5c,        // cool starlight
  nadir: 0x2a1c12,         // warm dust

  // --- The galactic band -----------------------------------------------------
  // The band is what makes the horizon of a reflection interesting. It is built
  // against the *same* tilted plane as the sky geometry (see `SKY.bandTilt`), so
  // a hull catching the band reflects it in the right place.
  band: 0xcfd8ea,
  bandGain: 0.55,
  bandTightness: 0.30,     // wider than the sky's: this is a blurred probe

  // --- Nebula blooms ---------------------------------------------------------
  // A handful of soft coloured patches, borrowed from the sky's own emission
  // palette. At probe resolution they are just low-frequency colour variation,
  // which is all a rough metal reflection can resolve anyway.
  bloomCount: 7,
  bloomGain: 0.5,

  // --- The local star --------------------------------------------------------
  // The probe is built at boot, before a system exists, so it carries a neutral
  // warm star. Bodies brighter than that get their own highlight from the real
  // directional light, which this cannot replace.
  starTint: 0xfff0d8,
  starGain: 2.4,
};

/**
 * The nebula emission colours, copied deliberately from `sky.js`.
 *
 * Duplicated rather than imported because `buildNebulae` keeps its palette as a
 * local constant. If the sky's palette changes and this drifts, the mismatch is
 * invisible - both are soft low-frequency colour - so there is no correctness
 * risk, only a slightly different flavour of bloom. Recorded here so the
 * duplication is a decision, not an accident.
 */
const BLOOM_PALETTE = [0xff4d6a, 0x5a8fff, 0x8f5aff, 0x3fd8c0, 0xff8a4d, 0x4d7fff];

/** The probe's own PRNG stream, so it can never perturb the world's. */
const ENV_SEED = 0x4e19a5c3;

/**
 * Fraction of the way from the south pole to the north, given a v coordinate.
 * Equirect images are addressed with v = 0 at the **bottom** (the DataTexture is
 * flipped at upload), so `polarity` is +1 for the north and -1 for the south.
 */
function polar(v) {
  return v * 2 - 1;
}

/**
 * Generate the equirectangular probe as a linear-space Float32 array.
 *
 * Returned separately from the texture so a unit test can inspect the pixels
 * without a WebGL context - which is the entire point of authoring this by hand.
 *
 * Layout follows the equirect convention used by three's `EquirectangularReflectionMapping`:
 *   u = 0 at -X, increasing toward +Z; v = 0 at -Y (south), increasing to +Y.
 */
export function buildProbePixels(seed) {
  const seedValue = (seed === undefined ? ENV_SEED : seed) >>> 0;
  const w = ENV.width;
  const h = ENV.width / 2;
  const data = new Float32Array(w * h * 4);

  const zenith = new THREE.Color(ENV.zenith);
  const nadir = new THREE.Color(ENV.nadir);
  const bandColour = new THREE.Color(ENV.band);
  const starColour = new THREE.Color(ENV.starTint);

  // The band's normal, derived exactly as `galacticBasis()` does in sky.js. A
  // different formula here would put the reflection's bright smear somewhere
  // the real band is not - and since the band is the most recognisable feature
  // of the reflection, that mismatch would be visible on a polished hull.
  const normal = new THREE.Vector3(Math.sin(SKY.bandTilt), Math.cos(SKY.bandTilt), 0).normalize();

  // A few nebula centres, placed inside the band and kept as unit vectors.
  const blooms = [];
  const rand = R.mulberry32(seedValue);
  const ref = Math.abs(normal.y) > 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  const ax = new THREE.Vector3().crossVectors(ref, normal).normalize();
  const ay = new THREE.Vector3().crossVectors(normal, ax).normalize();
  for (let i = 0; i < ENV.bloomCount; i += 1) {
    const a = rand() * Math.PI * 2;
    const off = (rand() - 0.5) * SKY.bandTightness * 2;
    const dir = new THREE.Vector3()
      .addScaledVector(ax, Math.cos(a))
      .addScaledVector(ay, Math.sin(a))
      .addScaledVector(normal, off)
      .normalize();
    blooms.push({
      dir,
      colour: new THREE.Color(BLOOM_PALETTE[Math.floor(rand() * BLOOM_PALETTE.length) % BLOOM_PALETTE.length]),
      // Angular radius. Small enough that a bloom is a patch, not a wash.
      radius: 0.28 + rand() * 0.34,
      strength: 0.4 + rand() * 0.6,
    });
  }

  const dir = new THREE.Vector3();
  const rgb = { r: 0, g: 0, b: 0 };

  for (let y = 0; y < h; y += 1) {
    // v from 0..1, where 0 is the south pole.
    const v = (y + 0.5) / h;
    const theta = v * Math.PI;            // 0 at south, PI at north
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);

    for (let x = 0; x < w; x += 1) {
      const u = (x + 0.5) / w;
      const phi = u * Math.PI * 2;

      // Equirect direction. Matches three's equirect lookup convention closely
      // enough for a low-frequency probe: -X at u=0, +Y at the top.
      dir.set(-Math.cos(phi) * sinTheta, cosTheta, Math.sin(phi) * sinTheta);

      // --- Vertical gradient, in linear light ---
      // Interpolated on the half-cosine so the poles do not band.
      const t = (polar(v) + 1) * 0.5;
      const ease = t * t * (3 - 2 * t);
      rgb.r = nadir.r + (zenith.r - nadir.r) * ease;
      rgb.g = nadir.g + (zenith.g - nadir.g) * ease;
      rgb.b = nadir.b + (zenith.b - nadir.b) * ease;

      // --- Galactic band ---
      // Gaussian falloff with angular distance from the band plane. `dot` is
      // exactly the signed distance from that plane for a unit vector.
      const dotBand = dir.dot(normal);
      const bandFalloff = Math.exp(-(dotBand * dotBand) / (2 * ENV.bandTightness * ENV.bandTightness));
      const band = bandFalloff * ENV.bandGain;
      rgb.r += bandColour.r * band;
      rgb.g += bandColour.g * band;
      rgb.b += bandColour.b * band;

      // --- Nebula blooms ---
      for (let i = 0; i < blooms.length; i += 1) {
        const b = blooms[i];
        const cosine = Math.max(-1, Math.min(1, dir.dot(b.dir)));
        const angle = Math.acos(cosine);
        if (angle >= b.radius) continue;
        // Smoothstep to the edge so the bloom has no hard rim.
        const q = 1 - angle / b.radius;
        const bloom = q * q * (3 - 2 * q) * b.strength * ENV.bloomGain;
        rgb.r += b.colour.r * bloom;
        rgb.g += b.colour.g * bloom;
        rgb.b += b.colour.b * bloom;
      }

      // --- The local star ---
      // A single bright spot so a polished surface has something small and
      // intense to catch. Placed up and to one side; the real directional light
      // is what shapes the hull, this is only the reflection's glint.
      const starCos = dir.x * 0.42 + dir.y * 0.86 + dir.z * 0.29;
      if (starCos > 0.965) {
        const q = (starCos - 0.965) / 0.035;
        const spike = q * q * ENV.starGain;
        rgb.r += starColour.r * spike;
        rgb.g += starColour.g * spike;
        rgb.b += starColour.b * spike;
      }

      const i4 = (y * w + x) * 4;
      data[i4] = rgb.r * ENV.intensity;
      data[i4 + 1] = rgb.g * ENV.intensity;
      data[i4 + 2] = rgb.b * ENV.intensity;
      data[i4 + 3] = 1;
    }
  }

  return data;
}

/**
 * Build the probe texture.
 *
 * Float data + `LinearSRGBColorSpace` is the combination that keeps authored
 * values above 1.0 intact; see the encoding note at the top of the file.
 * `RepeatWrapping` on the horizontal axis only, because an equirect wraps
 * around in longitude and must not wrap over the poles.
 */
export function buildEnvProbe(seed) {
  const data = buildProbePixels(seed);
  const tex = new THREE.DataTexture(data, ENV.width, ENV.width / 2, THREE.RGBAFormat, THREE.FloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  tex.userData.envProbe = true;
  return tex;
}

/**
 * Attach a probe to a scene, returning the previous one so the caller can
 * dispose it. Idempotent enough for the boot path: called once, but safe if a
 * teardown and rebuild ever both run.
 */
export function applyEnvProbe(scene, probe) {
  if (!scene) return null;
  const previous = scene.environment || null;
  scene.environment = probe || null;
  return previous;
}

/** Dispose a probe, tolerating null. */
export function disposeEnvProbe(probe) {
  if (probe && typeof probe.dispose === 'function') probe.dispose();
}

export default { ENV, buildProbePixels, buildEnvProbe, applyEnvProbe, disposeEnvProbe };
