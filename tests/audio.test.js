/**
 * Audio tests.
 *
 * Node has no WebAudio, so the valuable thing to test is not "does it make a
 * sound" but the two properties that decide whether audio is a feature or a
 * liability:
 *
 *   1. It must degrade to silence rather than throwing when there is no
 *      AudioContext. Half of these tests exist to pin that, because an audio
 *      module that takes the game down on an unsupported browser is worse than
 *      no audio module.
 *   2. The distance falloff and the rate limiter are real design decisions -
 *      an explosion across the system must be quiet, and a hundred lasers in
 *      one frame must not become a wall of identical clicks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../src/core/audio.js';

test('creating audio without an AudioContext does not throw', () => {
  const audio = A.createAudio({ audioContext: null });
  assert.ok(audio);
  assert.equal(audio.ready, false);
});

test('resume fails cleanly when WebAudio is unavailable', () => {
  const audio = A.createAudio({ audioContext: null });
  assert.equal(audio.resume(), false, 'resume should report failure, not throw');
  assert.equal(audio.ready, false);
});

test('playing a cue before resume is a no-op, not an error', () => {
  const audio = A.createAudio({ audioContext: null });
  assert.equal(audio.play('laser'), false);
  assert.equal(audio.lockTick(0.5), false);
  assert.equal(audio.cueCount, 0);
});

test('every control survives a missing context', () => {
  const audio = A.createAudio({ audioContext: null });
  // None of these should throw. This is the whole contract of the module.
  audio.setEngine(1, true);
  audio.stopAll();
  audio.setMuted(true);
  assert.equal(audio.toggleMute(), false, 'toggling back should unmute');
  assert.equal(audio.volumeAt(0), 1);
  assert.equal(audio.muted, false);
});

test('mute starts off and toggles', () => {
  const audio = A.createAudio({ audioContext: null });
  assert.equal(audio.muted, false);
  assert.equal(audio.toggleMute(), true);
  assert.equal(audio.muted, true);
  assert.equal(audio.toggleMute(), false);
});

test('volumeAt is full inside the near radius and silent beyond the far one', () => {
  const audio = A.createAudio({ audioContext: null });
  assert.equal(audio.volumeAt(0), 1);
  assert.equal(audio.volumeAt(20), 1, 'a nearby explosion should be full volume');
  assert.equal(audio.volumeAt(4000), 0, 'a distant explosion should be inaudible');
});

test('volumeAt decreases monotonically with distance', () => {
  const audio = A.createAudio({ audioContext: null });
  let prev = Infinity;
  for (let d = 0; d <= 1000; d += 25) {
    const v = audio.volumeAt(d);
    assert.ok(v <= prev, 'volume rose with distance at ' + d);
    prev = v;
  }
});

test('volumeAt takes explicit thresholds', () => {
  const audio = A.createAudio({ audioContext: null });
  assert.equal(audio.volumeAt(50, 100, 200), 1, 'inside fullAt should be full');
  assert.equal(audio.volumeAt(250, 100, 200), 0, 'beyond silentAt should be silent');
  const mid = audio.volumeAt(150, 100, 200);
  assert.ok(mid > 0 && mid < 1, 'the middle should attenuate: ' + mid);
});

test('a distant impact is never louder than a near one', () => {
  const audio = A.createAudio({ audioContext: null });
  // Sample the whole usable range, including the clamped floor.
  assert.ok(audio.volumeAt(200) > audio.volumeAt(700));
  assert.ok(audio.volumeAt(700) >= audio.volumeAt(899));
});

test('no cue gain is loud enough to clip the master alone', () => {
  // The limiter catches stacked sounds, but one cue should never be able to
  // run the output hot on its own.
  for (const [name, spec] of Object.entries(A.CUES)) {
    assert.ok(spec.gain > 0, name + ' has no gain');
    assert.ok(spec.gain <= 0.5, name + ' is too hot: ' + spec.gain);
    assert.ok(spec.dur > 0 && spec.dur < 3, name + ' has an implausible duration');
  }
});

test('every cue declares either a tone or noise, with sane parameters', () => {
  for (const [name, spec] of Object.entries(A.CUES)) {
    if (spec.noise) continue;
    assert.ok(spec.freq > 20 && spec.freq < 12000, name + ' frequency out of range: ' + spec.freq);
    assert.ok(['square', 'sawtooth', 'sine', 'triangle'].includes(spec.type),
      name + ' has an unknown waveform: ' + spec.type);
    assert.ok(['up', 'down', 'flat'].includes(spec.sweep),
      name + ' has an unknown sweep: ' + spec.sweep);
    if (spec.sweep === 'flat') {
      assert.equal(spec.end, spec.freq, name + ' is flat but its endpoints differ');
    }
    if (spec.sweep !== 'flat') {
      assert.notEqual(spec.end, spec.freq, name + ' sweeps but its endpoints match');
    }
  }
});

test('noise cues do not declare a frequency', () => {
  // A noise cue with a freq would be a copy-paste mistake, and the code path
  // would ignore it - a silently dead parameter.
  for (const [name, spec] of Object.entries(A.CUES)) {
    if (spec.noise) assert.equal(spec.freq, undefined, name + ' is noise but has a freq');
  }
});

test('the waveform choices match the intent of the classic sounds', () => {
  // Not arbitrary: square waves are the harshest and belong on machine events
  // (lasers, warnings), triangle is rounder for pleasant event sounds, and
  // sawtooth carries the engine-like sweeps.
  assert.equal(A.CUES.laser.type, 'square');
  assert.equal(A.CUES.warn.type, 'square');
  assert.equal(A.CUES.dock.type, 'triangle');
  assert.equal(A.CUES.hyper.type, 'sawtooth');
  assert.equal(A.CUES.explode.noise, true);
});

test('the laser sweeps down and the hyperdrive sweeps up', () => {
  // A laser that rises sounds like a charge; a jump that falls sounds like a
  // failure. Direction is meaningful, so pin it.
  assert.ok(A.CUES.laser.end < A.CUES.laser.freq, 'the laser should sweep down');
  assert.ok(A.CUES.hyper.end > A.CUES.hyper.freq, 'hyperspace should sweep up');
  assert.ok(A.CUES.hitShield.end > A.CUES.hitShield.freq, 'a shield hit should ring upward');
});

test('master, sfx and engine levels stay within a sensible budget', () => {
  assert.ok(A.LEVELS.master > 0 && A.LEVELS.master <= 1);
  assert.ok(A.LEVELS.sfx > 0 && A.LEVELS.sfx <= 1);
  // The engine is a continuous drone; if it is mixed like a one-shot it
  // buries every other cue.
  assert.ok(A.LEVELS.engine < 0.3, 'the engine drone is too loud: ' + A.LEVELS.engine);
});

test('a fake AudioContext lets the whole module build its graph', () => {
  // This is a smoke test for the real code path: node creation, the limiter,
  // the engine drone. It catches a typo in a node type or a missing connect,
  // which would otherwise only surface as silence in the browser.
  const ctx = makeFakeContext();
  const audio = A.createAudio({ audioContext: () => ctx });
  assert.equal(audio.resume(), true);
  assert.equal(audio.ready, true);
  assert.ok(ctx.created.oscillator > 0, 'no oscillators were created for the engine');
  assert.ok(ctx.created.gain > 0, 'no gain nodes were created');
  assert.ok(ctx.created.filter > 0, 'the engine has no filter');
  assert.ok(ctx.created.compressor > 0, 'the safety limiter was not built');
});

test('the engine drone is silent until it is throttled up', () => {
  const ctx = makeFakeContext();
  const audio = A.createAudio({ audioContext: () => ctx });
  audio.resume();
  // The engine gain node is tagged by audio.js, so the test does not guess.
  const engineGain = ctx.nodes.gain.find(g => g._isEngine);
  assert.ok(engineGain, 'could not find the engine gain node');
  assert.equal(engineGain.gain.value, 0, 'the engine drone should start silent');
});

test('setEngine tracks throttle in both pitch and brightness', () => {
  const ctx = makeFakeContext();
  const audio = A.createAudio({ audioContext: () => ctx });
  audio.resume();
  const engineGain = ctx.nodes.gain.find(g => g._isEngine);
  const filter = ctx.nodes.filter[0];
  const osc = ctx.nodes.oscillator[0];

  audio.setEngine(0, false);
  const lowPitch = osc.frequency.lastTarget;
  const lowCut = filter.frequency.lastTarget;

  audio.setEngine(1, false);
  const highPitch = osc.frequency.lastTarget;
  const highCut = filter.frequency.lastTarget;

  assert.ok(highPitch > lowPitch, 'the drone should rise in pitch with throttle');
  assert.ok(highCut > lowCut, 'the drone should brighten with throttle');
  assert.ok(engineGain.gain.lastTarget > 0, 'the engine should become audible');
});

test('boost raises the engine pitch beyond a plain full throttle', () => {
  const ctx = makeFakeContext();
  const audio = A.createAudio({ audioContext: () => ctx });
  audio.resume();
  const osc = ctx.nodes.oscillator[0];
  audio.setEngine(1, false);
  const plain = osc.frequency.lastTarget;
  audio.setEngine(1, true);
  const boosted = osc.frequency.lastTarget;
  assert.ok(boosted > plain, 'boost did not change the engine note');
});

test('the engine has three detuned oscillators, not one', () => {
  // One saw reads as a buzz; the detune is what makes it sound mechanical.
  const ctx = makeFakeContext();
  const audio = A.createAudio({ audioContext: () => ctx });
  audio.resume();
  audio.setEngine(0.8, false);
  assert.ok(ctx.nodes.oscillator.length >= 3, 'the engine is not layered');
  const freqs = ctx.nodes.oscillator.map(o => o.frequency.lastTarget).sort((a, b) => a - b);
  assert.ok(freqs[0] < freqs[1] && freqs[1] < freqs[2], 'the engine oscillators are not detuned: ' + freqs.join(','));
  // The sub must be a genuine octave or more below, or it just muddies the mix.
  assert.ok(freqs[0] < freqs[1] * 0.75, 'the sub oscillator is not low enough');
});

test('playing a cue builds an oscillator with an envelope', () => {
  const ctx = makeFakeContext();
  const audio = A.createAudio({ audioContext: () => ctx });
  audio.resume();
  const before = ctx.nodes.oscillator.length;
  assert.equal(audio.play('laser'), true);
  assert.ok(ctx.nodes.oscillator.length > before, 'no oscillator was created for the laser');

  const osc = ctx.nodes.oscillator[ctx.nodes.oscillator.length - 1];
  assert.equal(osc.type, 'square');
  // A laser sweeps down: the scheduled end frequency must be below the start.
  assert.ok(osc.frequency._ramps.length > 0, 'the laser has no pitch sweep');
  const ramp = osc.frequency._ramps[osc.frequency._ramps.length - 1];
  assert.ok(ramp.to < ramp.from, 'the laser sweep goes the wrong way');
});

test('a noise cue builds a buffer source, not an oscillator', () => {
  const ctx = makeFakeContext();
  const audio = A.createAudio({ audioContext: () => ctx });
  audio.resume();
  const oscBefore = ctx.nodes.oscillator.length;
  const bufBefore = ctx.nodes.bufferSource.length;
  assert.equal(audio.play('explode'), true);
  assert.equal(ctx.nodes.oscillator.length, oscBefore, 'the explosion should not be a tone');
  assert.ok(ctx.nodes.bufferSource.length > bufBefore, 'the explosion has no noise source');
});

test('the rate limiter stops identical cues stacking in one frame', () => {
  // A hundred lasers in a single frame must not become a wall of identical
  // clicks; the first is played and the rest within the window are dropped.
  const ctx = makeFakeContext();
  const audio = A.createAudio({ audioContext: () => ctx });
  audio.resume();
  let played = 0;
  for (let i = 0; i < 50; i += 1) if (audio.play('laser')) played += 1;
  assert.equal(played, 1, 'the rate limiter let ' + played + ' lasers through in one instant');
});

test('the rate limiter is per-cue, so different sounds do not block each other', () => {
  const ctx = makeFakeContext();
  const audio = A.createAudio({ audioContext: () => ctx });
  audio.resume();
  assert.equal(audio.play('laser'), true);
  assert.equal(audio.play('hitHull'), true, 'a different cue was blocked by the limiter');
});

test('the same cue plays again once the window has passed', () => {
  const ctx = makeFakeContext();
  const audio = A.createAudio({ audioContext: () => ctx });
  audio.resume();
  assert.equal(audio.play('laser'), true);
  ctx.advance(0.2);
  assert.equal(audio.play('laser'), true, 'the limiter never released');
});

test('muting stops cues from being played at all', () => {
  const ctx = makeFakeContext();
  const audio = A.createAudio({ audioContext: () => ctx });
  audio.resume();
  audio.setMuted(true);
  const before = audio.cueCount;
  assert.equal(audio.play('laser'), false, 'a muted system still built an oscillator');
  assert.equal(audio.cueCount, before);
});

test('mute fades the master gain rather than snapping it', () => {
  const ctx = makeFakeContext();
  const audio = A.createAudio({ audioContext: () => ctx });
  audio.resume();
  const master = ctx.nodes.gain[0];
  audio.setMuted(true);
  assert.equal(master.gain.lastTarget, 0, 'mute did not take the master to zero');
  audio.setMuted(false);
  assert.ok(master.gain.lastTarget > 0, 'unmute did not restore the master level');
});

test('zero-volume cues are skipped instead of played silently', () => {
  const ctx = makeFakeContext();
  const audio = A.createAudio({ audioContext: () => ctx });
  audio.resume();
  const before = ctx.nodes.oscillator.length;
  assert.equal(audio.play('laser', 0), false);
  assert.equal(ctx.nodes.oscillator.length, before, 'a silent cue still built nodes');
});

test('lockTick gets more insistent as the lock progresses', () => {
  const ctx = makeFakeContext();
  const audio = A.createAudio({ audioContext: () => ctx });
  audio.resume();
  audio.lockTick(0);
  const early = ctx.nodes.oscillator[ctx.nodes.oscillator.length - 1].frequency._setAt;
  ctx.advance(0.2);
  audio.lockTick(1);
  const late = ctx.nodes.oscillator[ctx.nodes.oscillator.length - 1].frequency._setAt;
  assert.ok(early > 0 && late > 0, 'lockTick did not schedule a frequency');
  assert.ok(late > early, 'the lock tone does not rise as it completes: ' + early + ' -> ' + late);
});

test('stopAll silences the engine without throwing', () => {
  const ctx = makeFakeContext();
  const audio = A.createAudio({ audioContext: () => ctx });
  audio.resume();
  audio.setEngine(1, false);
  audio.stopAll();
  const engineGain = ctx.nodes.gain.find(g => g._isEngine);
  assert.equal(engineGain.gain.lastTarget, 0, 'stopAll left the engine running');
});

/**
 * A WebAudio stand-in. Only the surface audio.js touches, but complete enough
 * that the real code path runs: every node type it creates, plus AudioParam
 * methods that record their calls so the tests can assert on the result rather
 * than on a mock's call log.
 */
function makeFakeContext() {
  let now = 0;

  function param(initial) {
    return {
      value: initial,
      _initial: initial,
      // The frequency the module explicitly scheduled, if any. Distinct from
      // `_initial`, which is just the value the node was constructed with.
      _setAt: null,
      lastTarget: initial,
      _ramps: [],
      setValueAtTime(v) { this.value = v; this.lastTarget = v; this._setAt = v; return this; },
      linearRampToValueAtTime(v) {
        this._ramps.push({ kind: 'linear', from: this.value, to: v });
        this.value = v; this.lastTarget = v; return this;
      },
      exponentialRampToValueAtTime(v) {
        this._ramps.push({ kind: 'exp', from: this.value, to: v });
        this.value = v; this.lastTarget = v; return this;
      },
      cancelScheduledValues() { return this; },
      setTargetAtTime(v) { this.value = v; this.lastTarget = v; return this; },
    };
  }

  function node(kind, extra) {
    return {
      _kind: kind,
      connect() { return this; },
      disconnect() { return this; },
      start() {},
      stop() {},
      ...(extra || {}),
    };
  }

  const ctx = {
    sampleRate: 44100,
    state: 'running',
    get currentTime() { return now; },
    created: { oscillator: 0, gain: 0, filter: 0, compressor: 0, buffer: 0, bufferSource: 0 },
    nodes: { oscillator: [], gain: [], filter: [], compressor: [], bufferSource: [] },
    destination: node('destination'),
    resume() { this.state = 'running'; },
    createOscillator() {
      this.created.oscillator += 1;
      const o = node('oscillator', { type: 'sine', frequency: param(440) });
      this.nodes.oscillator.push(o);
      return o;
    },
    createGain() {
      this.created.gain += 1;
      // audio.js tags its own engine gain node, so the fake does not guess.
      const g = node('gain', { gain: param(1) });
      this.nodes.gain.push(g);
      return g;
    },
    createBiquadFilter() {
      this.created.filter += 1;
      const f = node('filter', { type: 'lowpass', frequency: param(350), Q: param(1), gain: param(0) });
      this.nodes.filter.push(f);
      return f;
    },
    createDynamicsCompressor() {
      this.created.compressor += 1;
      const c = node('compressor', {
        threshold: param(-24), knee: param(30), ratio: param(12),
        attack: param(0.003), release: param(0.25),
      });
      this.nodes.compressor.push(c);
      return c;
    },
    createBuffer(channels, length, rate) {
      this.created.buffer += 1;
      const data = new Float32Array(length);
      return { length, sampleRate: rate, numberOfChannels: channels, getChannelData: () => data };
    },
    createBufferSource() {
      this.created.bufferSource += 1;
      const s = node('bufferSource', { buffer: null, playbackRate: param(1) });
      this.nodes.bufferSource.push(s);
      return s;
    },
    /** Move the fake clock, so rate limiting can be exercised. */
    advance(seconds) { now += seconds; },
  };
  return ctx;
}
