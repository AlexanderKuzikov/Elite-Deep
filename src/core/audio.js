/**
 * Audio: everything synthesised at runtime with WebAudio. No files, no
 * downloads, and it fits the single-HTML constraint for free.
 *
 * This is not decoration. In the original Elite, sound was the primary
 * feedback channel - the missile lock warble, the low-fuel beep, the docking
 * computer's tick. A vector game where you cannot see a missile is approaching
 * from behind is unplayable without audio, so the design rule here is:
 * **every sound must convey information the screen might not**.
 *
 * All timbres are built from oscillators and noise buffers. Short envelopes
 * everywhere, because a game plays hundreds of these and long tails turn a
 * dogfight into mud.
 */

/** Master levels. Tuned by ear against the noise floor of combat. */
export const LEVELS = {
  master: 0.55,
  sfx: 0.85,
  engine: 0.16,
  music: 0.30,
};

/** Base frequencies and durations per cue. */
export const CUES = {
  laser:      { freq: 1450, end: 380,  dur: 0.11, type: 'square',   gain: 0.24, sweep: 'down' },
  enemyShot:  { freq: 900,  end: 300,  dur: 0.13, type: 'sawtooth', gain: 0.13, sweep: 'down' },
  hitHull:    { freq: 190,  end: 60,   dur: 0.18, type: 'square',   gain: 0.30, sweep: 'down' },
  hitShield:  { freq: 620,  end: 1240, dur: 0.14, type: 'sine',     gain: 0.20, sweep: 'up' },
  explode:    { noise: true,          dur: 0.72, gain: 0.42 },
  beep:       { freq: 880,  end: 880,  dur: 0.09, type: 'square',   gain: 0.16, sweep: 'flat' },
  deny:       { freq: 220,  end: 140,  dur: 0.22, type: 'square',   gain: 0.22, sweep: 'down' },
  confirm:    { freq: 520,  end: 1040, dur: 0.16, type: 'square',   gain: 0.18, sweep: 'up' },
  dock:       { freq: 300,  end: 900,  dur: 0.55, type: 'triangle', gain: 0.30, sweep: 'up' },
  undock:     { freq: 700,  end: 200,  dur: 0.45, type: 'triangle', gain: 0.26, sweep: 'down' },
  hyper:      { freq: 120,  end: 1600, dur: 1.40, type: 'sawtooth', gain: 0.34, sweep: 'up' },
  warn:       { freq: 1240, end: 1240, dur: 0.14, type: 'square',   gain: 0.24, sweep: 'flat' },
  scoop:      { freq: 260,  end: 780,  dur: 0.30, type: 'sine',     gain: 0.24, sweep: 'up' },
  missile:    { freq: 190,  end: 1500, dur: 0.90, type: 'sawtooth', gain: 0.26, sweep: 'up' },
  lock:       { freq: 1600, end: 2100, dur: 0.07, type: 'square',   gain: 0.16, sweep: 'up' },
  lowFuel:    { freq: 660,  end: 660,  dur: 0.20, type: 'triangle', gain: 0.20, sweep: 'flat' },
  death:      { freq: 200,  end: 40,   dur: 1.60, type: 'sawtooth', gain: 0.40, sweep: 'down' },
  rank:       { freq: 440,  end: 1760, dur: 0.80, type: 'triangle', gain: 0.28, sweep: 'up' },
};

/**
 * Create the audio system.
 *
 * Nothing is constructed until `resume()` is called from a user gesture: every
 * browser blocks autoplaying audio, and an AudioContext created before the
 * gesture starts in the suspended state and stays silent, which is a confusing
 * way to fail.
 */
export function createAudio(options) {
  const opts = options || {};
  const ctxRef = { ctx: null, master: null, sfx: null, engineGain: null, music: null };
  const state = {
    ready: false,
    muted: false,
    context: null,
    // Engine drone nodes, created on first resume.
    engine: null,
    // A tiny limiter so a dozen simultaneous explosions do not clip.
    limiter: null,
    // Start time of the last play of each cue, for rate limiting.
    lastPlayed: {},
    cueCount: 0,
  };

  /** Build the graph. Safe to call repeatedly; only the first call builds. */
  function ensure() {
    if (ctxRef.ctx) return ctxRef.ctx;

    // `audioContext` may be either a constructor (the browser default) or a
    // zero-argument factory, which is what tests and custom hosts supply. A
    // factory is strictly more useful and costs nothing to support.
    const ctx = opts.audioContext
      ? (opts.audioContext.prototype ? new opts.audioContext() : opts.audioContext())
      : makeDefaultContext();
    if (!ctx) return null;

    ctxRef.ctx = ctx;
    state.context = ctx;

    const master = ctx.createGain();
    master.gain.value = LEVELS.master;
    ctxRef.master = master;

    // A DynamicsCompressor as a safety limiter: combat stacks lasers, impacts
    // and explosions within a few milliseconds, and without this the mix
    // distorts on every kill.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.18;
    state.limiter = limiter;
    limiter.connect(master);
    master.connect(ctx.destination);

    const sfx = ctx.createGain();
    sfx.gain.value = LEVELS.sfx;
    sfx.connect(limiter);
    ctxRef.sfx = sfx;

    const music = ctx.createGain();
    music.gain.value = LEVELS.music;
    music.connect(limiter);
    ctxRef.music = music;

    return ctx;
  }

  /** Instantiate the browser's AudioContext, or null if there is none. */
  function makeDefaultContext() {
    if (typeof globalThis === 'undefined') return null;
    const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctor) return null;
    try {
      return new Ctor();
    } catch (_) {
      // Some browsers throw rather than returning a suspended context when
      // there is no audio device. Silence is an acceptable outcome here.
      return null;
    }
  }

  /**
   * Start (or restart) audio. Must be called from a click or keypress. Returns
   * true if sound is now flowing.
   */
  function resume() {
    const ctx = ensure();
    if (!ctx) return false;
    if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
    state.ready = true;
    if (!state.engine) startEngine();
    return true;
  }

  /**
   * The engine drone: two slightly detuned sawtooths through a lowpass, with
   * the filter and pitch tracking throttle.
   *
   * Two oscillators rather than one because a single saw reads as a buzz; the
   * detune beats slowly and sounds mechanical, which is what we want.
   */
  function startEngine() {
    const ctx = ctxRef.ctx;
    if (!ctx) return null;

    const gain = ctx.createGain();
    gain.gain.value = 0; // silent until the player throttles up
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 380;
    filter.Q.value = 3.5;

    const a = ctx.createOscillator();
    a.type = 'sawtooth';
    a.frequency.value = 42;
    const b = ctx.createOscillator();
    b.type = 'sawtooth';
    b.frequency.value = 46.5; // ~10% detune, gives the beating
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = 21; // a sub for weight; felt more than heard

    a.connect(filter);
    b.connect(filter);
    sub.connect(filter);
    filter.connect(gain);
    gain.connect(ctxRef.sfx);

    a.start(); b.start(); sub.start();
    state.engine = { osc: [a, b, sub], gain, filter, target: 0 };
    // Tagged so the debug overlay (and the tests) can find the engine without
    // guessing at node identity.
    gain._isEngine = true;
    return state.engine;
  }

  /** Per-frame engine update. `throttle` is 0..1. */
  function setEngine(throttle, boost) {
    const e = state.engine;
    if (!e) return;
    const t = Math.max(0, Math.min(1, throttle));
    const spool = boost ? 1.35 : 1;
    // Pitch and brightness both track throttle, so the drone tells you your
    // speed without looking at the gauge. This is the single most useful
    // piece of audio feedback in the game.
    const base = 42 * (0.72 + t * 0.85) * spool;
    smoothly(e.osc[0].frequency, base, 0.08);
    smoothly(e.osc[1].frequency, base * 1.107, 0.08);
    smoothly(e.osc[2].frequency, base * 0.5, 0.08);
    smoothly(e.filter.frequency, (300 + t * 900) * spool, 0.10);
    smoothly(e.gain.gain, LEVELS.engine * (0.35 + t * 0.65), 0.12);
    e.target = t;
  }

  /** Set an AudioParam toward a value over `time` seconds, from now. */
  function smoothly(param, value, time) {
    const ctx = ctxRef.ctx;
    if (!ctx || !param) return;
    const now = ctx.currentTime;
    try {
      param.cancelScheduledValues(now);
      param.setTargetAtTime(value, now, time);
    } catch (_) {
      param.value = value;
    }
  }

  /** A short noise buffer, cached. Used for explosions and impacts. */
  let noiseBuffer = null;
  function noise() {
    const ctx = ctxRef.ctx;
    if (!ctx) return null;
    if (noiseBuffer) return noiseBuffer;
    const len = Math.floor(ctx.sampleRate * 1.2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    // Deterministic-ish white noise. Math.random is fine here: this is audio
    // texture, not simulation, and reproducibility is worthless.
    let last = 0;
    for (let i = 0; i < len; i += 1) {
      const white = Math.random() * 2 - 1;
      // One-pole lowpass, gives it a bit of body instead of pure hiss.
      last = last * 0.35 + white * 0.65;
      data[i] = last;
    }
    noiseBuffer = buf;
    return buf;
  }

  /**
   * Play a cue. `volume` scales the cue's own gain (used for distance falloff),
   * and `rate` detunes it (used so repeated shots do not sound identical).
   */
  function play(name, volume, rate) {
    if (state.muted || !state.ready) return false;
    const spec = CUES[name];
    const ctx = ctxRef.ctx;
    if (!spec || !ctx) return false;

    // Rate limiting: the same cue more than ~24 times a second is a machine
    // gun of identical beeps and just sounds broken.
    //
    // `lastPlayed` is null-initialised rather than zero-initialised, because a
    // fresh AudioContext reports currentTime === 0 and a zero default would
    // suppress the very first sound of the session.
    const now = ctx.currentTime;
    const last = state.lastPlayed[name];
    if (last !== undefined && now - last < 0.035) return false;
    state.lastPlayed[name] = now;

    const vol = (volume === undefined ? 1 : volume) * spec.gain;
    if (vol <= 0.001) return false;
    const pitch = rate || 1;

    const g = ctx.createGain();
    g.connect(ctxRef.sfx);
    const t0 = now;
    const dur = spec.dur / Math.max(0.5, pitch);

    if (spec.noise) {
      const src = ctx.createBufferSource();
      src.buffer = noise();
      src.playbackRate.value = pitch;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(2600, t0);
      f.frequency.exponentialRampToValueAtTime(180, t0 + dur);
      src.connect(f);
      f.connect(g);
      // A fast attack and a long exponential tail: this is what makes it read
      // as an explosion rather than a click.
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(vol, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.start(t0);
      src.stop(t0 + dur + 0.02);
      state.cueCount += 1;
      return true;
    }

    const osc = ctx.createOscillator();
    osc.type = spec.type || 'square';
    const f0 = spec.freq * pitch;
    const f1 = spec.end * pitch;
    osc.frequency.setValueAtTime(f0, t0);
    if (spec.sweep !== 'flat' && f0 !== f1) {
      // Exponential sweeps sound musical; linear ones sound like a siren test.
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    }
    osc.connect(g);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + Math.min(0.015, dur * 0.25));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
    state.cueCount += 1;
    return true;
  }

  /** The missile-lock warble: a short rising blip, played while locking. */
  function lockTick(progress) {
    // The closer to lock, the higher and more insistent.
    const p = Math.max(0, Math.min(1, progress || 0));
    return play('lock', 0.5 + p * 0.5, 0.85 + p * 0.5);
  }

  /** Distance falloff helper, so a far explosion is quieter. */
  function volumeAt(distance, fullAt, silentAt) {
    const full = fullAt === undefined ? 40 : fullAt;
    const silent = silentAt === undefined ? 900 : silentAt;
    if (distance <= full) return 1;
    if (distance >= silent) return 0;
    const t = (distance - full) / (silent - full);
    // Inverse-square-ish, but clamped so things never fully vanish mid-fight.
    return Math.max(0.08, (1 - t) * (1 - t));
  }

  /** Toggle mute. Returns the new muted state. */
  function toggleMute() {
    state.muted = !state.muted;
    if (ctxRef.master) {
      smoothly(ctxRef.master.gain, state.muted ? 0 : LEVELS.master, 0.05);
    }
    return state.muted;
  }

  function setMuted(m) {
    state.muted = !!m;
    if (ctxRef.master) smoothly(ctxRef.master.gain, state.muted ? 0 : LEVELS.master, 0.05);
  }

  /** Stop everything. Used on death and when leaving the page. */
  function stopAll() {
    const e = state.engine;
    if (e) smoothly(e.gain.gain, 0, 0.05);
  }

  return {
    get ready() { return state.ready; },
    get muted() { return state.muted; },
    get cueCount() { return state.cueCount; },
    resume, play, lockTick, setEngine, volumeAt, toggleMute, setMuted, stopAll,
    // Exposed for tests and for the debug overlay.
    _state: state,
  };
}

export default { LEVELS, CUES, createAudio };
