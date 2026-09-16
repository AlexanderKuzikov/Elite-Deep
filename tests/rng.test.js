/**
 * RNG: determinism is load-bearing for the whole game. If these fail, saves
 * desync, markets drift differently between sessions, and the galaxy stops
 * being a place you can learn.
 */
import test from 'node:test';
import assert from 'node:assert';
import * as R from '../src/logic/rng.js';

test('mulberry32 is reproducible from the same seed', () => {
  const a = R.mulberry32(1234);
  const b = R.mulberry32(1234);
  for (let i = 0; i < 50; i++) assert.strictEqual(a(), b());
});

test('mulberry32 produces floats in [0,1)', () => {
  const r = R.mulberry32(99);
  for (let i = 0; i < 2000; i++) {
    const v = r();
    assert.ok(v >= 0 && v < 1, 'value out of range: ' + v);
  }
});

test('different seeds diverge immediately', () => {
  const a = R.mulberry32(1);
  const b = R.mulberry32(2);
  let same = 0;
  for (let i = 0; i < 100; i++) if (a() === b()) same++;
  assert.ok(same < 5, 'seeds 1 and 2 produced too many identical draws: ' + same);
});

test('hash2 is stable and coordinate-sensitive', () => {
  assert.strictEqual(R.hash2(1, 2, 3), R.hash2(1, 2, 3));
  assert.notStrictEqual(R.hash2(1, 2, 3), R.hash2(1, 2, 4));
  assert.notStrictEqual(R.hash2(1, 2, 3), R.hash2(2, 1, 3));
});

test('rand01 is in range and deterministic', () => {
  for (let i = 0; i < 500; i++) {
    const v = R.rand01(7, i, 11);
    assert.ok(v >= 0 && v < 1);
    assert.strictEqual(v, R.rand01(7, i, 11));
  }
});

test('int stays within inclusive bounds', () => {
  const r = R.mulberry32(5);
  for (let i = 0; i < 1000; i++) {
    const v = R.int(r, 3, 7);
    assert.ok(v >= 3 && v <= 7, 'out of bounds: ' + v);
    assert.strictEqual(v, Math.floor(v));
  }
});

test('pick always returns an element of the array', () => {
  const r = R.mulberry32(11);
  const arr = ['a', 'b', 'c', 'd'];
  for (let i = 0; i < 200; i++) assert.ok(arr.includes(R.pick(r, arr)));
});

test('shuffle preserves the multiset', () => {
  const r = R.mulberry32(3);
  const src = [1, 2, 3, 4, 5, 6, 7, 8];
  const out = R.shuffle(r, src);
  assert.deepStrictEqual(out.slice().sort((a, b) => a - b), src);
  assert.deepStrictEqual(src, [1, 2, 3, 4, 5, 6, 7, 8], 'source was mutated');
});

test('noise1 spans a useful range and is continuous', () => {
  let min = 9, max = -9;
  for (let x = -300; x < 300; x += 0.05) {
    const v = R.noise1(42, x);
    min = Math.min(min, v);
    max = Math.max(max, v);
    assert.ok(v >= -1.6 && v <= 1.6, 'noise out of plausible band: ' + v);
  }
  assert.ok(max - min > 0.8, 'noise has too little range: ' + (max - min));
  assert.ok(max - min < 2.6, 'noise is unbounded in a way that would break prices');

  // Continuity: a small step must not jump.
  let prev = R.noise1(42, 0);
  for (let x = 0.05; x < 20; x += 0.05) {
    const v = R.noise1(42, x);
    assert.ok(Math.abs(v - prev) < 0.05, 'noise has a discontinuity at ' + x);
    prev = v;
  }
});

test('noise1 is deterministic', () => {
  for (let i = 0; i < 100; i++) {
    assert.strictEqual(R.noise1(8, i * 0.37), R.noise1(8, i * 0.37));
  }
});
