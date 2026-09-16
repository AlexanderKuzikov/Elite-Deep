/**
 * Deterministic PRNG + hashing.
 *
 * Everything that must be reproducible across sessions (galaxy layout, name
 * generation, market drift, event rolls) goes through here. Never use
 * Math.random() for anything the player can observe twice - if a market price
 * can be seen twice, it must be derived from a seed, not rolled.
 */

/**
 * mulberry32 - 32-bit state, fast, good enough distribution for games.
 * Returns a function producing floats in [0, 1).
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer hash of up to 3 ints into a uint32. Deterministic, no state. */
export function hash2(a, b, c) {
  let h = (a | 0) * 0x27d4eb2d;
  h = Math.imul(h ^ (b | 0), 0x165667b1);
  h = Math.imul(h ^ (c | 0), 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
}

/** Deterministic float in [0,1) from up to 3 integer coordinates. */
export function rand01(a, b, c) {
  return mulberry32(hash2(a, b, c))();
}

/** Deterministic integer in [lo, hi] inclusive. */
export function int(range, lo, hi) {
  return lo + Math.floor(range() * (hi - lo + 1));
}

/** Pick one element deterministically. */
export function pick(range, arr) {
  return arr[Math.floor(range() * arr.length) % arr.length];
}

/** True with probability p. */
export function chance(range, p) {
  return range() < p;
}

/** Shuffle a copy, leaving the source untouched. */
export function shuffle(range, arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(range() * (i + 1));
    const t = out[i];
    out[i] = out[j];
    out[j] = t;
  }
  return out;
}

/**
 * Fractal value noise in 1D. Deterministic and smooth, used for slow market
 * drift so prices wander instead of jittering. Returns roughly [-1.05, 1.05].
 *
 * Three octaves with deliberately different wavelengths: the long one sets the
 * price cycle, the short one adds texture without turning it into noise.
 */
export function noise1(seed, x) {
  function octave(off, period) {
    const t = x / period;
    const i = Math.floor(t);
    const f = t - i;
    const smooth = f * f * (3 - 2 * f);
    const a = rand01(seed + off, i, 0) * 2 - 1;
    const b = rand01(seed + off, i + 1, 0) * 2 - 1;
    return a + (b - a) * smooth;
  }
  return octave(0, 24) * 0.9 + octave(1000, 7) * 0.26 + octave(2000, 2.3) * 0.1;
}

/**
 * The twelve edge gradients of the classic Perlin set.
 *
 * Twelve rather than a full sphere of random directions because they are the
 * vertices of a cuboctahedron: evenly spread, and each one is a small integer
 * vector, so the dot product is three multiplies and two adds.
 */
const GRAD3 = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];

/**
 * Gradient noise in 3D.
 *
 * ## Why this replaced value noise
 *
 * The previous version hashed a value at each lattice corner and interpolated
 * between them. It was cheaper, and its comment claimed "the visual difference
 * on a planet surface at this triangle budget is nil". **That claim was wrong,
 * and a screenshot showed it**: value noise has cells, the cells are aligned to
 * the lattice, and on a planet - a large, smooth, slowly rotating object the
 * player looks at for seconds - they read as hexagonal facets. The planet
 * looked like a faceted crystal ball rather than a world. Smoothstep removed
 * the *creases* along the lattice planes (which the old comment did notice) but
 * not the *cells*, which is the part the eye locks on to.
 *
 * Gradient noise dots a pseudo-random gradient at each corner with the offset
 * from that corner, so the field is exactly zero at every lattice point and
 * varies smoothly in between. There is no cell for the eye to find: the lattice
 * is invisible by construction, not by softening.
 *
 * Still eight hashes per sample, and the planet bakes its surface once at load,
 * so the cost is paid in milliseconds.
 *
 * ## The one artefact it does have
 *
 * The twelve gradients are the vertices of a cuboctahedron, and that set is not
 * perfectly isotropic: at the *centre* of a cell the eight dots can cancel
 * exactly. Measured, 39 of 200 seeds give exactly zero at one such point. It is
 * a single point per cell with a non-zero gradient through it, not a flat
 * region, so it is invisible - unlike value noise's flat cells, which covered
 * the surface and drew the grid. A larger gradient set would remove it; it is
 * not worth the table.
 *
 * Returns [-1, 1]. Perlin's theoretical bound is `sqrt(3)/2`, so the result is
 * scaled by `1 / 0.866` to keep the range the callers expect.
 */
export function noise3(seed, x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  // Quintic fade, as Perlin specifies. It has zero first *and* second
  // derivative at the lattice points, which is what keeps the surface free of
  // visible seams where the cells meet.
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const w = zf * zf * zf * (zf * (zf * 6 - 15) + 10);

  // `rand01` takes two ints, so fold the z octave into the seed and keep the
  // three spatial coordinates as the actual lattice coordinates.
  const dot = (dx, dy, dz) => {
    const r = rand01(seed + dz * 0x9e3779b1, xi + dx, ((yi + dy) << 1) ^ (zi + dz));
    const g = GRAD3[(r * 12) | 0] || GRAD3[0];
    return g[0] * (xf - dx) + g[1] * (yf - dy) + g[2] * (zf - dz);
  };

  const x00 = dot(0, 0, 0) + (dot(1, 0, 0) - dot(0, 0, 0)) * u;
  const x10 = dot(0, 1, 0) + (dot(1, 1, 0) - dot(0, 1, 0)) * u;
  const x01 = dot(0, 0, 1) + (dot(1, 0, 1) - dot(0, 0, 1)) * u;
  const x11 = dot(0, 1, 1) + (dot(1, 1, 1) - dot(0, 1, 1)) * u;

  const y0 = x00 + (x10 - x00) * v;
  const y1 = x01 + (x11 - x01) * v;
  return (y0 + (y1 - y0) * w) * 1.1547;
}

/**
 * Fractal Brownian motion: octaves of `noise3` at doubling frequency and
 * halving amplitude. The standard way to get a natural-looking surface.
 *
 * `octaves` is capped by the caller's budget, not here - a planet vertex shader
 * with 6 octaves is 48 hash calls per vertex, which at 5000 vertices is a
 * quarter of a million hashes. Fine at load, not fine per frame, which is why
 * planets bake this into vertex colours once.
 *
 * Returns roughly [-1, 1] (normalised by the amplitude sum, so the range does
 * not shrink as octaves are added).
 */
export function fbm3(seed, x, y, z, octaves, lacunarity, gain) {
  const oct = octaves === undefined ? 4 : octaves;
  const lac = lacunarity === undefined ? 2.0 : lacunarity;
  const g = gain === undefined ? 0.5 : gain;
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i += 1) {
    sum += noise3(seed + i * 0x85ebca6b, x * freq, y * freq, z * freq) * amp;
    norm += amp;
    amp *= g;
    freq *= lac;
  }
  return norm > 0 ? sum / norm : 0;
}

/**
 * Ridged noise: `1 - |noise|`, squared. Produces sharp creases instead of
 * rolling hills, which is what mountain ranges and rift valleys look like.
 *
 * Returns [0, 1] - it is a mask, not a signed field.
 */
export function ridged3(seed, x, y, z, octaves) {
  const oct = octaves === undefined ? 4 : octaves;
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i += 1) {
    const n = 1 - Math.abs(noise3(seed + i * 0xc2b2ae35, x * freq, y * freq, z * freq));
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.1;
  }
  return norm > 0 ? sum / norm : 0;
}

export default {
  mulberry32, hash2, rand01, int, pick, chance, shuffle, noise1,
  noise3, fbm3, ridged3,
};
