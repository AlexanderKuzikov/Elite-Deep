/**
 * Tests for the 3D noise added for the modernised visuals.
 *
 * The planet surfaces are baked from `fbm3`/`ridged3` at load time, so a defect
 * here is not a subtle shading bug - it is a planet that looks like a ball of
 * static, or a grid of lines, or a flat grey sphere. These pin the properties
 * that make the output usable as terrain.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../src/logic/rng.js';

test('noise3 is deterministic and stays in [-1, 1]', () => {
  // The whole planet surface is baked from this. If it can exceed the range,
  // the biome thresholds layered on top silently misclassify.
  for (let i = 0; i < 500; i += 1) {
    const x = (i * 0.37) % 20, y = (i * 0.71) % 20, z = (i * 1.13) % 20;
    const a = R.noise3(1234, x, y, z);
    const b = R.noise3(1234, x, y, z);
    assert.strictEqual(a, b, 'noise3 is not deterministic');
    assert.ok(a >= -1.0001 && a <= 1.0001, 'noise3 out of range: ' + a);
  }
});

test('noise3 actually varies - it is not a constant', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) seen.add(R.noise3(7, i * 0.31, i * 0.17, i * 0.53).toFixed(4));
  assert.ok(seen.size > 150, 'noise3 only produced ' + seen.size + ' distinct values');
});

test('noise3 is smooth - nearby samples are close', () => {
  // Linear interpolation would still pass a variation check while looking like
  // crumpled paper. The step between adjacent samples has to be small relative
  // to the range, which is what makes it read as terrain rather than static.
  let maxStep = 0;
  for (let i = 0; i < 400; i += 1) {
    const x = i * 0.05;
    const a = R.noise3(99, x, 0.5, 0.5);
    const b = R.noise3(99, x + 0.05, 0.5, 0.5);
    maxStep = Math.max(maxStep, Math.abs(b - a));
  }
  assert.ok(maxStep < 0.3, 'noise3 jumps by ' + maxStep.toFixed(3) + ' between adjacent samples');
});

test('gradient noise is zero on the lattice, and smooth away from it', () => {
  // This is the property that makes the lattice invisible, and it is the whole
  // reason the noise was changed from value to gradient. The old version was
  // flat *along whole lattice planes*, which drew a visible grid of hexagonal
  // cells across every planet - see the note on `noise3`.
  //
  // Zero at the lattice points themselves is not a defect to be caught: it is
  // the construction. What matters is that the field varies around them and
  // does so without a step, because a step would be a seam where the cells meet.
  for (const t of [0, 1, 2, 3, 7]) {
    assert.equal(R.noise3(5, t, 3, 4), 0,
      'the field is not zero at the lattice point (' + t + ', 3, 4)');
  }

  const vals = [];
  for (let i = 0; i <= 40; i += 1) vals.push(R.noise3(5, 2.5 + i * 0.05, 3.25, 4.25));
  let maxStep = 0;
  for (let i = 1; i < vals.length; i += 1) {
    maxStep = Math.max(maxStep, Math.abs(vals[i] - vals[i - 1]));
  }
  const spread = Math.max.apply(null, vals) - Math.min.apply(null, vals);
  assert.ok(spread > 0.1, 'the field is flat near the lattice: spread ' + spread.toFixed(4));
  assert.ok(maxStep < 0.15,
    'the field steps by ' + maxStep.toFixed(4) + ' between adjacent samples - that is a seam');
});

test('noise3 differs between seeds', () => {
  // Sampled at fifty points rather than one. A single point is not enough: the
  // twelve-gradient set has cell centres where the field is exactly zero
  // whatever the seed, so a one-point comparison can collide by construction
  // rather than because the seed failed to reach the hash. That is exactly what
  // happened when this was first written - seeds 1 and 2 both gave 0 at
  // (2.5, 3.5, 4.5).
  let differing = 0;
  for (let i = 0; i < 50; i += 1) {
    const x = 1.3 + i * 0.37, y = 2.7 + i * 0.11, z = 3.1 + i * 0.53;
    if (R.noise3(1, x, y, z) !== R.noise3(2, x, y, z)) differing += 1;
  }
  assert.ok(differing >= 45,
    'only ' + differing + ' of 50 samples differed between seeds');
});

test('fbm3 layers octaves and stays normalised', () => {
  // Normalisation by the amplitude sum is what keeps the output in range as
  // octaves are added. Without it, 6 octaves would triple the amplitude and
  // every planet would clamp to the biome extremes.
  for (let oct = 1; oct <= 6; oct += 1) {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < 300; i += 1) {
      const v = R.fbm3(31, i * 0.23, i * 0.41, i * 0.11, oct);
      assert.ok(Number.isFinite(v), 'fbm3 not finite at ' + oct + ' octaves');
      min = Math.min(min, v); max = Math.max(max, v);
    }
    assert.ok(min >= -1.0001 && max <= 1.0001,
      'fbm3 out of range at ' + oct + ' octaves: [' + min + ', ' + max + ']');
    assert.ok(max - min > 0.2, 'fbm3 barely varies at ' + oct + ' octaves');
  }
});

test('fbm3 accepts its default arguments', () => {
  assert.doesNotThrow(() => R.fbm3(3, 1, 2, 3));
  assert.ok(Number.isFinite(R.fbm3(3, 1, 2, 3)));
});

test('ridged3 returns [0, 1] and is folded, not centred', () => {
  // Ridged noise is (1 - |n|)^2, so it is a mask in [0, 1]. A negative value
  // means the abs or the square was dropped.
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < 400; i += 1) {
    const v = R.ridged3(17, i * 0.19, i * 0.37, i * 0.29);
    assert.ok(v >= -0.0001 && v <= 1.0001, 'ridged3 out of range: ' + v);
    min = Math.min(min, v); max = Math.max(max, v);
  }
  assert.ok(max - min > 0.3, 'ridged3 is nearly constant');

  // The distinguishing property of ridged noise is the *shape* of the
  // distribution, not its mean. `(1 - |n|)^2` over a roughly normal `n` has a
  // mean a little above 0.5 and is strongly skewed toward the top (sharp
  // crests are common, wide valleys are rare). Ordinary fBm, by contrast, is
  // symmetric about 0. Comparing the two directly is what proves the fold is
  // actually there - an earlier version of this test asserted an arbitrary
  // mean threshold below 0.45 and was simply wrong about the maths.
  let rSum = 0, rN = 0, fAbove = 0;
  for (let i = 0; i < 4000; i += 1) {
    const x = i * 0.041, y = i * 0.073, z = i * 0.029;
    const r = R.ridged3(17, x, y, z);
    rSum += r; rN += 1;
    if (R.fbm3(17, x, y, z) > 0) fAbove += 1;
  }
  const rMean = rSum / rN;
  assert.ok(rMean > 0.4 && rMean < 0.65,
    'ridged3 mean ' + rMean.toFixed(3) + ' is outside the expected folded range');

  // fBm is symmetric, so about half its samples are positive. Ridged noise is
  // shifted far above that, which is the fold showing up.
  const fShare = fAbove / rN;
  assert.ok(Math.abs(fShare - 0.5) < 0.08,
    'fbm3 is not symmetric about zero: positive share ' + fShare.toFixed(3));
  assert.ok(rMean > 0.45,
    'ridged3 does not look folded: its mean ' + rMean.toFixed(3) + ' is too close to fbm');
});

test('the default mirror exports the new noise', () => {
  assert.strictEqual(R.default.noise3, R.noise3);
  assert.strictEqual(R.default.fbm3, R.fbm3);
  assert.strictEqual(R.default.ridged3, R.ridged3);
});
