/**
 * ELITE: DEEP SPACE - the game.
 *
 * This file is the only place in the project that knows about *all* the other
 * modules. Everything below it is deliberately ignorant of everything above:
 * `flight.js` does not know a HUD exists, `hud.js` does not know what a market
 * is, `economy.js` has never heard of Three.js. That discipline is what made
 * 400 unit tests possible without a browser, and it is worth preserving - the
 * cost is that this file does a lot of translation, and the translation is the
 * interesting part.
 *
 * ## Structure
 *
 *   - **Mode machine** - title / flight / docked / chart / hyperspace / dead.
 *     One variable decides which update and which draw path runs, so there is
 *     never a frame where two systems both think they own the ship.
 *   - **Session** - the mutable world: which system we are in, the flight
 *     state, the traffic, the scene group, and the timers. Rebuilt wholesale on
 *     a hyperspace jump, which is why it is one object rather than loose
 *     variables.
 *   - **Adapters** - `marketRows` and `chartState`. Two small functions that
 *     turn logic-layer data into the shape the UI layer wants. They exist
 *     because the two layers were written independently and their shapes do not
 *     match; putting the mismatch in one named place per direction is much
 *     better than scattering `row.com || row.id` through the UI.
 *
 * ## The one non-obvious decision
 *
 * The renderer is *always* constructed, even in a headless browser where it
 * degrades to `mode: 'none'`. Everything upstream of the actual draw call -
 * input, physics, combat, economy, docking, the state machine - therefore runs
 * identically whether or not there are pixels. That is what lets the e2e test
 * drive the real game rather than a special "test mode" that shares nothing
 * with what a player sees.
 */

import * as THREE from 'three';

import * as GALAXY from './logic/galaxy.js';
import * as ECONOMY from './logic/economy.js';
import * as FACTIONS from './logic/factions.js';
import * as PLAYER from './logic/player.js';
import * as REP from './logic/reputation.js';
import * as MISSIONS from './logic/missions.js';
import * as COMBAT from './logic/combat.js';

import * as FLIGHT from './sim/flight.js';
import * as WORLD from './sim/world.js';
import * as RENDER from './sim/render.js';
import { disposeTree, markShared } from './sim/dispose.js';
import { createDust } from './sim/dust.js';

import * as INPUT from './core/input.js';
import * as AUDIO from './core/audio.js';

import * as HUD from './ui/hud.js';
import { createStationUI, STATION_CSS } from './ui/station.js';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Galaxy seed. Fixed so the galaxy is the same for every commander. */
const GALAXY_SEED = 0x1337c0de;

/** Autosave slot. A single slot is a deliberate choice - see `saveGame`. */
const SAVE_KEY = 'elite-deep:save:v1';

/**
 * World units per light year.
 *
 * The galaxy generator lays systems out on a disc of radius `DISC_RADIUS` in
 * raw world units, and its route graph is built against `JUMP_REFERENCE`. The
 * *player* model speaks in light years: the base tank holds 7 and `fuelMax` is
 * what a full tank buys. Those two scales have to be reconciled somewhere, and
 * this is the single place it happens - `GALAXY.DISC_RADIUS / jumpReference`
 * maps the generator's own reference hop onto a sane fraction of a tank.
 *
 * Getting this wrong is not a subtle bug. With the conversion set to 1, the
 * nearest neighbour is 200+ units away while the tank holds 7, so *no two
 * systems are reachable* and the game is unplayable in a way that looks like a
 * rendering problem.
 */
const LY_PER_UNIT = 7 / GALAXY.JUMP_REFERENCE;

/** Convert a raw generator distance into light years, rounded for display. */
function toLy(units) {
  return units * LY_PER_UNIT;
}

/** Time to hold the arrival tunnel before control is returned. */
const HYPERSPACE_DURATION = 2.6;

/** Seconds of invulnerability after arriving in a new system (friendlier). */
const ARRIVAL_GRACE = 3.0;

/**
 * How long the mouse hint stays on screen once flight begins without a captured
 * pointer, in seconds.
 *
 * Long enough to read a short line while also flying, short enough that it does
 * not become furniture at the bottom of the view. The pointer being released
 * mid-session is not on a timer at all: it stays until the lock is taken back,
 * because that is the state the player has to fix.
 */
const MOUSE_HINT_SECONDS = 8;

/** How often the traffic layer tops up, in seconds. */
const TRAFFIC_INTERVAL = 6;

/** Missile behaviour, mirroring the combat module's declared constants. */
const MISSILE = { speed: COMBAT.MISSILE_SPEED, life: COMBAT.MISSILE_LIFE, turn: COMBAT.MISSILE_TURN };

/**
 * How close an inbound missile has to get to count as a hit.
 *
 * The player's ship is not modelled in the scene - the view is first person -
 * so this is a design choice rather than a measurement. Generous enough that a
 * missile which visually passes through the hull registers, tight enough that
 * one going past a wingtip does not. The player's hull is about 88 units long,
 * so 16 is roughly "clipped the hull".
 */
const PLAYER_HIT_RADIUS = 16;

/** Modes. A string rather than an enum, so a debugger shows something readable. */
const MODE = {
  TITLE: 'title',
  FLIGHT: 'flight',
  DOCKED: 'docked',
  CHART: 'chart',
  HYPERSPACE: 'hyperspace',
  DEAD: 'dead',
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export function boot(host, options) {
  const opts = options || {};
  const log = opts.log || bootLog();

  log('boot: elite-deep');

  const galaxy = GALAXY.generate(GALAXY_SEED);
  log(`galaxy: ${galaxy.systems.length} systems`);

  // --- DOM scaffolding ----------------------------------------------------
  // The host may already provide these (the e2e test does, so it can find them
  // without racing the script), but normally we build them.
  const stage = opts.stage || document.getElementById('app') || document.body;

  const canvas = document.createElement('canvas');
  canvas.id = 'elite-world';
  stage.appendChild(canvas);

  const hudCanvas = document.createElement('canvas');
  hudCanvas.id = 'elite-hud';
  stage.appendChild(hudCanvas);

  injectCss(stage, canvas, hudCanvas);

  const hudCtx = hudCanvas.getContext('2d');

  // --- Renderer -----------------------------------------------------------
  const renderer = RENDER.createRenderer({
    canvas,
    seed: GALAXY_SEED,
    forceDirect: !!opts.forceDirect,
    headless: !!opts.headless,
  });
  log(`renderer: ${renderer.mode}${renderer.mode === 'none' ? ' (' + (renderer.probe && renderer.probe.reason) + ')' : ''}`);

  // --- Input --------------------------------------------------------------
  // Key events must reach us even when the canvas is not focused, so the window
  // is the key target. The *pointer*, on the other hand, can only be locked to
  // an element - the window has no `requestPointerLock` at all - so the canvas
  // is the lock target. The two were the same object until now, which is why
  // the mouse could never be captured: every request went to the window and
  // quietly returned false.
  //
  // The target is the world canvas and not the HUD one. Only the world canvas
  // receives clicks: the HUD sits above it with `pointer-events: none` so that
  // it can draw over the screen without stealing them. A lock held there would
  // work and then lose the mouse on the next click, because the element under
  // the cursor is never the one that took it.
  const input = INPUT.createInput(typeof window !== 'undefined' ? window : null, {
    mouse: opts.mouse !== false,
    pointerTarget: canvas,
  });

  // --- Audio --------------------------------------------------------------
  const audio = AUDIO.createAudio({});
  // Contexts may only start from a gesture. The title screen's first keypress
  // is the gesture, which is why this is not called at boot.
  let audioArmed = false;
  function armAudio() {
    if (audioArmed) return;
    audioArmed = true;
    try { audio.resume(); } catch (err) { /* no audio device: not fatal */ }
  }

  // --- Station UI ---------------------------------------------------------
  // Space dust belongs to the ship, not to a system: it is the cue that makes
  // speed visible in open space, and it has to survive a hyperspace jump for
  // the same reason the starfield does.
  const dust = createDust(renderer.scene);
  log('dust: ' + dust.config.count + ' motes');

  const stationUi = createStationUI(stage, stationActions());
  log('ui: station screens ready');

  // --- Player -------------------------------------------------------------
  let player = loadGame() || PLAYER.create({ name: opts.name || 'Jameson' });
  log(`player: ${player.name}, ${player.cash} CR, at system ${player.currentSystem}`);

  // --- Session ------------------------------------------------------------
  // Everything in here is rebuilt on a jump. Kept together so a jump is one
  // assignment rather than a list of fields that will drift out of sync.
  const session = {
    system: null,
    index: 0,
    scene: null,          // the buildSystemScene() result
    traffic: null,
    flight: null,
    mode: MODE.TITLE,
    modeTime: 0,          // seconds in the current mode
    time: 0,              // seconds since boot
    grace: 0,             // remaining invulnerability
    sinceDamage: 99,
    shotCooldown: 0,
    missiles: [],         // in-flight player missiles
    incoming: [],         // missiles fired at the player
    tracers: [],
    hits: [],             // recent damage, with the bearing it came from
    shots: [],            // in-flight enemy shots, purely visual + damage on arrival
    lastTrafficTopUp: 0,
    impactCooldown: 0,    // seconds until another collision may hurt us
    jumpTarget: null,     // system index we are jumping to
    jumpFrom: null,
    visitedCount: 0,
    dockedAtLine: '',
    stationMessage: '',
    chartCursor: 0,
    chartLinks: null,     // cached route list for the current chart
    lastDay: 0,
    // The contract board, cached per (system, day) so it is stable while the
    // commander is looking at it and refreshes when the day turns.
    offers: [],
    boardKey: '',
    // --- Declared, though they are written later -------------------------
    // These four used to appear only at their first assignment, which worked
    // but defeated the point of holding the whole mutable world in one object:
    // the literal was no longer a complete description of the session, so a
    // reader could not tell what a jump resets and what it does not.
    target: null,          // currently locked contact
    lastRankName: '',      // for detecting a promotion
    dockingVerdict: null,  // last checkDocking() result, for the HUD
    // The lights that belong to the current system. Held so the next jump can
    // take them away again: they live in the renderer's scene rather than in
    // the system group, so nothing else would.
    systemLights: [],
  };

  // -------------------------------------------------------------------------
  // Mouse capture
  // -------------------------------------------------------------------------

  /**
   * Where the mouse hint lives.
   *
   * `hintUntil` is a wall time in `session.time`, not a countdown: two things
   * set it and neither is in a position to tick it.
   */
  const mouseUI = {
    captured: false,
    hintUntil: 0,
    /**
     * True between losing the pointer in flight and taking it back. Escape, and
     * a browser that takes the lock away on its own, both land here.
     *
     * This exists because the pointer being *released* is a different event
     * from the pointer never having been captured: the first is a player who
     * just lost a control they were using and needs telling how to get it back
     * indefinitely, the second is a player who has not tried yet and needs a
     * nudge that expires. Timing the first one on the same clock as the second
     * meant the instructions vanished 1.4 seconds after Escape - exactly when
     * they were needed.
     */
    released: false,
    /** Reasons already explained to the player. Never explained twice. */
    saidManual: false,
    saidRefused: false,
  };

  INPUT.addPointerLock(input, (locked) => {
    mouseUI.captured = locked;
    if (locked) {
      // The player has the controls they asked for, so the instructions have
      // done their job and go away - including the "your pointer is free"
      // notice, which is only true until the next capture.
      mouseUI.hintUntil = 0;
      mouseUI.released = false;
    } else if (session.mode === MODE.FLIGHT) {
      // Lost while flying: the player is holding a keyboard and no mouse, and
      // only a capture gets it back. The notice stays up until they do.
      mouseUI.released = true;
    }
  });

  /**
   * Ask for the pointer, and only from a place where a gesture can back it.
   *
   * Every call site is a keypress or a click. A request with no gesture behind
   * it is refused by the browser, and a refusal is sticky - the game stops
   * asking - so a stray call here costs the player the mouse for the session.
   */
  function captureMouse() {
    if (INPUT.mouseActive(input)) return true;
    return INPUT.requestMouse(input);
  }

  /**
   * The gesture that arms a capture, and where it has to be armed from.
   *
   * Two things have to line up. The listener has to be the capturing phase on
   * the window, so it sees the click whatever element it lands on - and so it
   * runs *before* the station screen's own handlers can stop it. And the lock
   * itself has to be requested from inside that listener, because a request
   * made anywhere else has no gesture behind it and the browser refuses it.
   *
   * A click is fought over here, and the arbitration is deliberate: clicking
   * the canvas while flying means "take the pointer"; clicking while docked or
   * on the chart means "use the screen", and nothing should be captured. There
   * is no third case.
   */
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('mousedown', () => {
      if (session.mode !== MODE.FLIGHT) return;
      captureMouse();
    }, true);
  }

  /**
   * Put the mouse hint on screen for the first seconds of flight.
   *
   * Only for the case where flight began without a captured pointer. A pointer
   * released *during* flight needs no timer: `mouseUI.released` keeps the hint
   * up until it is taken back, because the player has just lost a control they
   * were using. Asserting that with a countdown from here would be wrong -
   * `MOUSE_HINT_SECONDS` is a reading time, not a notice of loss.
   */
  function showMouseHint() {
    mouseUI.hintUntil = session.time + MOUSE_HINT_SECONDS;
  }

  // Messages: {text, colour, age, lifetime}. Newest last.
  const messages = [];

  function say(text, colour) {
    messages.push({ text: text, colour: colour, age: 0 });
    if (messages.length > 40) messages.splice(0, messages.length - 40);
  }

  // -------------------------------------------------------------------------
  // System loading
  // -------------------------------------------------------------------------

  /**
   * Enter a system: build its scenery, its traffic, and place the ship.
   *
   * `arrival` chooses where the ship appears:
   *   'station' - just outside the station, facing it (used on a jump)
   *   'keep'    - leave the flight state alone (used when undocking is handled
   *               separately by `undock`)
   */
  function enterSystem(index, arrival) {
    const system = galaxy.systems[index];
    session.index = index;
    session.system = system;
    player.currentSystem = index;
    player.visited[index] = 1;
    session.visitedCount = Object.keys(player.visited).length;

    // What this system remembers about the commander. Read *before* the
    // traffic is built, because the memory decides how dangerous the system
    // feels and how much shipping it carries.
    const memory = REP.memoryFor(player, index);
    // What an open cleanup contract still owes here. Read before the traffic is
    // built, because the pocket is part of how the system is *populated*
    // rather than something that happens later.
    const owed = MISSIONS.bountyPressure(player, index);

    const seed = (GALAXY_SEED ^ (index * 2246822519)) >>> 0;
    const scene = WORLD.buildSystemScene(system, seed);
    session.scene = scene;

    // The scene's group and lights go under the renderer's own scene, which
    // holds the starfield. Handing the group over rather than adding it here
    // keeps the renderer in charge of what is in its scene.
    //
    // The lights belong to the system, not to the scene. Adding a fresh set on
    // every jump left the previous system's star still lighting the new one,
    // and four more objects in the scene each time - for ever. Measured before
    // the fix: 21 directional lights after twenty jumps.
    for (const light of session.systemLights) {
      renderer.scene.remove(light);
      if (light.target) renderer.scene.remove(light.target);
    }
    renderer.setSystemGroup(scene.root);
    const cockpitLight = WORLD.makeCockpitLight();
    session.systemLights = [scene.sunLight, scene.planetLight, cockpitLight];
    renderer.scene.add(scene.sunLight);
    renderer.scene.add(scene.sunLight.target);
    renderer.scene.add(scene.planetLight);
    renderer.scene.add(cockpitLight);
    // The haze is the scene's, not the group's, so it has to be re-applied.
    renderer.scene.fog = scene.haze;

    // The previous system's fleet belongs to the previous system. It lives in
    // the scene rather than in the system group, so nothing else takes it away.
    if (session.traffic) session.traffic.dispose();

    session.flight = FLIGHT.createFlight();
    session.traffic = WORLD.createTraffic(renderer.scene, system, seed, {
      dangerDelta: REP.memoryDangerDelta(memory),
      trafficDelta: REP.memoryTrafficDelta(memory),
      bounty: owed,
    });
    // Spawn the opening traffic immediately: arriving in an empty system and
    // waiting six seconds for the first ship is a bad first impression.
    session.traffic.topUp();
    session.traffic.topUp();

    clearMissiles();
    clearIncoming();
    session.shots.length = 0;
    session.tracers.length = 0;
    // The lock has to go with the system. Everything else that pointed into the
    // old scene is dropped here; a surviving `session.target` kept the HUD
    // drawing a lock box around a mesh that no longer belongs to anything, and
    // a missile in flight would have homed on that ghost.
    session.target = null;
    session.grace = arrival === 'station' ? ARRIVAL_GRACE : 0;
    session.sinceDamage = 99;
    session.shotCooldown = 0;
    session.lastTrafficTopUp = 0;
    session.impactCooldown = 0;
    session.chartLinks = null;

    if (arrival === 'station') {
      const pose = WORLD.arrivalPose(scene.station);
      session.flight.pos = { x: pose.position.x, y: pose.position.y, z: pose.position.z };
      FLIGHT.faceToward(session.flight, pose.facing);
      renderer.snapCamera(session.flight);
    }

    // Count the visit. The memory itself was fetched at the top of this
    // function, because the traffic layer needed it first.
    memory.visits += 1;
    memory.lastVisitDay = player.day;

    say('Arrived: ' + system.name, HUD.HUD_COLOURS.ok);

    // How this faction feels about you, in its own words. The eight greetings
    // were written with the tier table and never shown; the arrival line was
    // the same whether you were Allied or Hunted.
    const standing = player.standing[system.faction] || 0;
    const tier = REP.tierFor(standing);
    if (tier.greeting) say(tier.greeting, tierTone(tier));

    // A rumour drawn from what has actually happened here, so the station bar
    // reflects the player's own history rather than a random line.
    // Seeded from the system name and the visit count, so the same system
    // gives the same line on a reload but a different one as its history
    // changes. The previous picker returned a character code, so this line
    // read `76` instead of a sentence.
    let rumourSeed = memory.visits;
    for (let i = 0; i < system.name.length; i += 1) {
      rumourSeed = (rumourSeed * 31 + system.name.charCodeAt(i)) >>> 0;
    }
    const rumour = REP.rumourFor(system, memory, REP.rumourPicker(rumourSeed));
    if (rumour) say(rumour, HUD.HUD_COLOURS.inkDim);

    // A cleanup contract is the one job with nowhere to travel to: it names the
    // system it was posted in. Saying so on arrival is the difference between
    // "the pirates are unusually thick here" and "this is the place I was hired
    // to clear".
    if (owed > 0) {
      say('Cleanup contract: ' + owed + ' pirate' + (owed === 1 ? '' : 's')
        + ' left in this system', HUD.HUD_COLOURS.warn);
      log(`bounty pocket: ${owed} owed in ${system.name}`);
    }

    log(`system: ${system.name} (${FACTIONS.faction(system.faction).name})`);
    return system;
  }

  /**
   * The colour a standing tier's greeting is shown in.
   *
   * Presentation, so it lives here rather than in the tier table: the table
   * carries the mechanic (`priceBonus`, `patrolHelp`) and the words, and this
   * decides how loudly to say them.
   */
  function tierTone(tier) {
    if (tier.priceBonus < 0) return HUD.HUD_COLOURS.ok;        // a discount: friendly
    if (tier.priceBonus === 0) return HUD.HUD_COLOURS.inkDim;  // neutral
    if (tier.label === 'Hunted') return HUD.HUD_COLOURS.danger;
    return HUD.HUD_COLOURS.warn;
  }

  /** Leave the station and take control. */
  /**
   * Leave the station.
   *
   * Two things matter here and both were wrong at first.
   *
   * **Facing.** `arrivalPose().facing` points *at* the station, because that is
   * what you want when arriving. On departure you must point *away*, or you
   * fly straight back into the docking cone: the auto-dock then grabs you on
   * the next frame and the player is trapped in a dock/undock loop.
   *
   * **Throttle.** Also reversed. Setting cruise while facing the station means
   * the ship accelerates itself into the dock. Facing outward, cruise is a
   * clean launch.
   */
  function undock() {
    const pose = WORLD.arrivalPose(session.scene.station);
    session.flight.pos = { x: pose.position.x, y: pose.position.y, z: pose.position.z };
    // Invert the arrival facing: nose out into open space.
    FLIGHT.faceToward(session.flight, {
      x: -pose.facing.x, y: -pose.facing.y, z: -pose.facing.z,
    });
    session.flight.throttle = FLIGHT.THROTTLE.cruise;
    renderer.snapCamera(session.flight);
    stationUi.close();
    setMode(MODE.FLIGHT);
    // A keypress got us here - the launch prompt, the station's undock, or the
    // death screen - so this is a gesture and the browser will honour a lock
    // request. Everything that starts flying has to go through here for that
    // reason; a path that enters `flight` another way has no gesture to spend.
    if (!captureMouse()) showMouseHint();
    play('undock');
    say('Undocked from ' + session.system.name + ' Station');
  }

  // -------------------------------------------------------------------------
  // Mode machine
  // -------------------------------------------------------------------------

  function setMode(mode) {
    if (session.mode === mode) return;
    const previous = session.mode;
    session.mode = mode;
    session.modeTime = 0;

    if (mode === MODE.DOCKED) {
      // Quiet: docking is the game taking the cursor back to show a screen, not
      // the player asking for it. Arming the re-lock delay here punished the
      // ordinary dock-then-undock - the mouse came back dead and the hint told
      // the player to click, which reads exactly like the bug the cooldown was
      // introduced to fix, but with no Escape anywhere in sight.
      INPUT.releaseMouse(input, true);
      stationUi.open(stationState());
    } else if (previous === MODE.DOCKED) {
      stationUi.close();
    }
    if (mode === MODE.DEAD) {
      // Quiet for the same reason: the death screen needs the cursor, and the
      // player did not ask to be there.
      INPUT.releaseMouse(input, true);
    }
    // The "your pointer is free" notice belongs to the flight view and to a
    // player who is still flying. Leaving flight by any route - docking,
    // dying, the title - clears it, so the next undock does not open with an
    // instruction the player did not ask for.
    if (mode !== MODE.FLIGHT) {
      mouseUI.released = false;
      mouseUI.hintUntil = 0;
      mouseUI.captured = false;
    }
  }

  // -------------------------------------------------------------------------
  // Adapters: logic layer -> UI layer
  // -------------------------------------------------------------------------

  /**
   * Turn `ECONOMY.computeMarket` rows into the rows the market screen renders.
   *
   * The two layers were written independently and disagree, and the station
   * tests use hand-built fixtures so they never caught it. Rather than change
   * either side (both are well-tested), the translation lives here:
   *
   *   economy row        station row
   *   ------------       ------------------------
   *   com (object)   ->  id, name, base
   *   buyPrice       ->  buyPrice      (what you pay)
   *   sellPrice      ->  sellPrice     (what you get)
   *   qty            ->  stock         (units on offer)
   *   (player.cargo) ->  held, avgPaid
   */
  function marketRows(day) {
    const raw = ECONOMY.computeMarket(session.system, day, player.activity);

    // Faction standing is a real term in the price now.
    //
    // `REP.standingPriceFactor` existed from the beginning and was never
    // called, so standing was pure decoration: a commander could be Allied
    // with a faction and pay exactly what a Hunted one paid, in the same
    // station, on the same day.
    //
    // Applied to the **buy** side only, which is what the function's own
    // docstring promises ("trusted commanders buy cheaper"). Applying it to
    // both sides would be more generous but would also collapse the 15 %
    // buy/sell spread - at Allied (x0.94) it would shrink to 3.8 %, and a
    // spread that thin turns arbitrage into a formality.
    const standingFactor = REP.standingPriceFactor(player.standing[session.system.faction] || 0);

    // The world's memory of what the commander did here. A system you supplied
    // during a famine stays cheaper for a while; one you flooded with
    // contraband gets watched.
    const memory = REP.memoryFor(player, session.index);

    // What the live contracts still need, by commodity.
    //
    // Computed once per call and keyed by id, rather than asked per row: the
    // answer is the same for all nineteen rows, and `shoppingList` walks the
    // contract list - doing that nineteen times per render, on every keystroke,
    // to produce the same two numbers would be a waste the screen would feel.
    const shopping = MISSIONS.shoppingList(player);
    const needed = {};
    for (const e of shopping) needed[e.commodity] = e;

    return raw.map((r) => {
      const com = r.com || {};
      const held = (player.cargo && player.cargo[com.id]) || 0;
      const memoryFactor = 1 + REP.memoryPriceDelta(memory, com.id);
      const priceScale = standingFactor * memoryFactor;
      return {
        id: com.id,
        name: com.name || com.id,
        base: com.base,
        stock: Math.max(0, Math.floor(r.qty || 0)),
        // Rounded to a tenth like the base prices, so the screen never shows a
        // price the player cannot reconcile with what they are charged.
        buyPrice: Math.max(0.1, Math.round((r.buyPrice || 0) * priceScale * 10) / 10),
        sellPrice: r.sellPrice || 0,
        // `computeMarket` always sets `illegal` to a boolean, so this is the
        // only source of truth. There used to be a fallback here that called
        // `ECONOMY.isIllegal(com.id, law)` against a signature of
        // `isIllegal(sys, com)` - wrong on both arguments, and unreachable,
        // which is the worst combination: dead code that would quietly mark a
        // restricted good legal the moment a row arrived without the flag.
        illegal: !!r.illegal,
        available: !!r.available,
        reason: r.reason,
        held: held,
        avgPaid: PLAYER.costBasisOf(player, com.id),
        // The shopping side of the same row: how much of this a contract in
        // hand wants, and how much of that is still missing. Zero for the
        // eighteen rows that nothing wants, which is what the market screen
        // tests against before it prints anything.
        contractTons: needed[com.id] ? needed[com.id].tons : 0,
        contractShort: needed[com.id] ? needed[com.id].short : 0,
      };
    });
  }

  /** Everything the station screen needs, assembled fresh on each open/update. */
  function stationState() {
    const legal = PLAYER.legalStatusFor(player._offences || 0);
    const market = marketRows(player.day);
    const shopping = MISSIONS.shoppingList(player);
    const standings = FACTIONS.FACTION_IDS
      .filter((id) => player.standing[id] !== undefined)
      .map((id) => ({ id: id, label: PLAYER.standingLabel(player.standing[id] || 0) }));

    return {
      system: session.system,
      systemIndex: session.index,
      market: market,
      shoppingList: shopping,
      player: player,
      cash: player.cash,
      day: player.day,
      hull: player.hull, maxHull: player.hullMax,
      shields: player.shields, maxShields: player.shieldMax,
      energy: player.energy, maxEnergy: player.energyMax,
      fuel: player.fuel, maxFuel: player.fuelMax,
      missiles: player.missiles,
      hold: PLAYER.holdMaxOf(player),
      cargoUsed: PLAYER.cargoUsed(player),
      cargoMax: PLAYER.holdMaxOf(player),
      laser: player.laserType,
      killWeight: player.kills,
      kills: player.kills,
      rank: PLAYER.rankOf(player.kills),
      commanderName: player.name,
      visitedCount: session.visitedCount,
      legal: { wanted: (player.wanted[session.index] || 0) > 0, label: legal },
      standings: standings,
      manifest: manifest(),
      // The board, with each offer annotated by whether it is already taken.
      offers: boardFor().map((o) => Object.assign({}, o, {
        taken: player.contracts.some((c) => c.id === o.id),
        description: MISSIONS.describe(o),
      })),
      contracts: MISSIONS.active(player).map((c) => Object.assign({}, c, {
        description: MISSIONS.describe(c),
        daysLeft: MISSIONS.daysLeft(c, player.day),
        // Priced against the market the commander is standing in, because that
        // is the market they can act on: the number is "what buying this
        // mistake back would cost me, from here".
        stake: MISSIONS.stakeOf(player, c, market),
      })),
      maxContracts: MISSIONS.MISSION.maxActive,
    };
  }

  /** The cargo hold as a list, for the status screen. */
  function manifest() {
    const out = [];
    for (const [id, qty] of Object.entries(player.cargo || {})) {
      if (!qty) continue;
      const com = ECONOMY.commodityById(id);
      out.push({ id: id, name: com ? com.name : id, quantity: qty });
    }
    return out;
  }

  /**
   * The contract board for this station, on this day.
   *
   * Cached by (system, day) rather than regenerated per call, because the
   * screen re-renders on every keystroke and a board that reshuffled under the
   * cursor would be unusable. The day is part of the key so the board does
   * turn over - a station is not offering the same three jobs forever.
   */
  function boardFor() {
    const key = session.index + ':' + player.day;
    if (session.boardKey !== key) {
      session.boardKey = key;
      const seed = (GALAXY_SEED ^ (session.index * 2246822519) ^ (player.day * 2654435761)) >>> 0;
      session.offers = MISSIONS.generateBoard(session.system, galaxy, player, seed, player.day);
    }
    return session.offers;
  }

  /**
   * The chart overlay's state.
   *
   * The chart is a plan view of the whole galaxy, so this is the one place
   * where `chart.systems` is the *entire* system list rather than the
   * neighbours - and `routes` is the jump graph, not every possible pair.
   */
  function chartState() {
    if (!session.chartLinks) session.chartLinks = buildChartLinks();
    const links = session.chartLinks;
    const neighbourSet = new Set();
    // `neighbors` measures in the generator's own world units; `jumpRange()`
    // is in light years. The conversion is the same one `toLy` applies in the
    // other direction, and leaving it out silently shrank the query radius by
    // a factor of five - the chart then highlighted one reachable system where
    // there were six, and the route graph's own links masked the difference.
    for (const n of GALAXY.neighbors(galaxy, session.system, session.jumpRange() / LY_PER_UNIT)) {
      neighbourSet.add(n.system.index);
    }
    for (const l of links) {
      if (l.a === session.index || l.b === session.index) {
        neighbourSet.add(l.a === session.index ? l.b : l.a);
      }
    }

    const systems = galaxy.systems.map((s) => ({
      index: s.index,
      // Scaled to light years so the disc, the jump-range ring and the route
      // lengths all share one unit system.
      x: toLy(s.x),
      y: toLy(s.y),
      name: s.name,
      danger: s.danger,
      neighbour: neighbourSet.has(s.index),
    }));

    const selected = galaxy.systems[session.chartCursor];
    const dist = (selected && selected.index !== session.index)
      ? toLy(GALAXY.distance(session.system, selected)) : undefined;

    return {
      // Both these are in light years, matching the route distances. The
      // chart draws every marker at `x * scale` where scale divides by
      // discRadius, so mixing units here would silently shrink the whole map.
      discRadius: toLy(GALAXY.DISC_RADIUS),
      jumpRange: session.jumpRange(),
      routes: links,
      systems: systems,
      selected: session.chartCursor,
      player: { index: session.index },
      selectedInfo: selected ? {
        name: selected.name,
        factionName: FACTIONS.faction(selected.faction).name,
        govName: FACTIONS.government(selected.gov).name,
        econName: FACTIONS.economy(selected.econ).name,
        conditionName: FACTIONS.condition(selected.condition).name,
        tech: selected.tech,
        population: selected.population,
        danger: selected.danger,
        distance: dist,
        fuelNeeded: dist === undefined ? undefined : dist,
      } : null,
    };
  }

  /**
   * The jump graph, in the shape the chart draws.
   *
   * The generator already publishes a proper route graph on `galaxy.routes` -
   * an MST plus short-edge augmentation - and rebuilding it here would be both
   * redundant and worse, because the generator's version is the one with the
   * no-dead-end guarantee. All this adapter does is rename `dist` to
   * `distance` (the chart's field name) and convert world units into light
   * years so the route lengths agree with the fuel gauge.
   */
  function buildChartLinks() {
    const links = (galaxy.routes || []).map((r) => ({
      a: r.a,
      b: r.b,
      distance: toLy(r.dist),
      kind: r.kind,
    }));
    log(`chart: ${links.length} jump routes`);
    return links;
  }

  /**
   * How far this ship can jump right now, in light years.
   *
   * Fuel *is* jump range in Elite - one light year costs one unit - so this is
   * just the tank. It exists as a method rather than reading `player.fuel` at
   * the call sites so a future fuel-scoop or drive upgrade has one place to
   * live.
   */
  session.jumpRange = function jumpRange() {
    return Math.max(0, player.fuel);
  };

  // -------------------------------------------------------------------------
  // Actions requested by the station screen
  // -------------------------------------------------------------------------

  function stationActions() {
    return {
      buy(comId, tons) {
        const row = findMarketRow(comId);
        if (!row || !row.available) return stationUi.notify('No stock');
        const free = PLAYER.holdMaxOf(player) - PLAYER.cargoUsed(player);
        const n = Math.min(tons, free, row.stock, Math.floor(player.cash / Math.max(0.01, row.buyPrice)));
        if (n <= 0) return stationUi.notify('Cannot buy');
        const cost = n * row.buyPrice;
        player.cash -= cost;
        PLAYER.addCargo(player, comId, n);
        // The cost basis is the commander's own record, so it lives on the
        // player and travels with the save. It used to sit on the session,
        // which meant the "sold above cost" highlight on the market screen
        // silently disappeared after every reload.
        PLAYER.recordPurchase(player, comId, n, row.buyPrice);
        player.activity += n * 0.6;
        play('confirm');
        stationUi.notify(`Bought ${n} t of ${row.name} for ${cost.toFixed(1)} CR`);
        refreshStation();
      },

      sell(comId, tons) {
        const row = findMarketRow(comId);
        if (!row) return;
        const n = PLAYER.removeCargo(player, comId, tons);
        if (n <= 0) return stationUi.notify('Nothing to sell');
        const gain = n * row.sellPrice;
        player.cash += gain;
        player.activity += n * 0.6;
        recordRelief(comId, n);
        play('confirm');
        stationUi.notify(`Sold ${n} t of ${row.name} for ${gain.toFixed(1)} CR`, '#8affb0');
        refreshStation();
      },

      equip(id) {
        const res = PLAYER.buyEquipment(player, id);
        if (!res.ok) {
          play('deny');
          return stationUi.notify(res.reason === 'funds' ? 'Not enough credits' : 'Cannot install that');
        }
        play('confirm');
        stationUi.notify('Installed ' + res.item.name, '#8affb0');
        refreshStation();
      },

      repair() {
        const res = PLAYER.repair(player);
        if (!res.ok) { play('deny'); return stationUi.notify('Nothing to repair'); }
        play('confirm');
        stationUi.notify('Hull repaired for ' + res.cost + ' CR', '#8affb0');
        refreshStation();
      },

      refuel() {
        const res = PLAYER.refuel(player);
        if (!res.ok) { play('deny'); return stationUi.notify('Cannot refuel'); }
        play('confirm');
        stationUi.notify((res.partial ? 'Partly refuelled' : 'Refuelled') + ' for ' + res.cost + ' CR', '#8affb0');
        refreshStation();
      },

      missile() {
        const res = PLAYER.buyMissile(player);
        if (!res.ok) {
          play('deny');
          return stationUi.notify(res.reason === 'full' ? 'Missile rack is full' : 'Not enough credits');
        }
        play('confirm');
        stationUi.notify('Missile loaded', '#8affb0');
        refreshStation();
      },

      payFine() {
        // Pass the system record, not the index: paying a fine has to touch
        // both `wanted` (keyed by system) and `standing` (keyed by faction),
        // and only the record carries both.
        const res = REP.payFine(player, session.system);
        if (!res.ok) {
          play('deny');
          return stationUi.notify(res.reason === 'not-wanted' ? 'Not wanted here' : 'Not enough credits');
        }
        play('confirm');
        stationUi.notify('Fine paid. Record cleared', '#8affb0');
        refreshStation();
      },

      acceptContract(id) {
        const offer = boardFor().find((o) => o.id === id);
        if (!offer) return stationUi.notify('That contract is gone');
        const res = MISSIONS.accept(player, offer, player.day);
        if (!res.ok) {
          play('deny');
          return stationUi.notify(res.reason === 'full'
            ? 'Too many contracts already'
            : 'Already accepted');
        }
        play('confirm');
        say('Contract taken: ' + MISSIONS.describe(offer), HUD.HUD_COLOURS.ok);
        // A cleanup contract names this very system, so the world has to answer
        // at once rather than on the next restock timer: the pocket is raised
        // now, and the commander launches into a sky that already knows they
        // have been hired.
        const raised = applyPocket();
        if (raised > 0) say('Word travels: ' + raised + ' hostiles are waiting for you',
          HUD.HUD_COLOURS.warn);
        stationUi.notify('Contract accepted', '#8affb0');
        refreshStation();
      },

      abandonContract(id) {
        const res = MISSIONS.abandon(player, id);
        if (!res) return stationUi.notify('That contract is gone');
        play('deny');
        say('Contract abandoned: ' + res.fine + ' CR penalty', HUD.HUD_COLOURS.danger);
        stationUi.notify('Contract abandoned', '#ff6a5a');
        refreshStation();
      },

      undock: undock,
    };
  }

  /**
   * Make the current system's traffic match the cleanup contracts open here.
   *
   * One function rather than three call sites, because the answer has to be the
   * same whether the contract was just taken, just finished, or the commander
   * has simply arrived: the size of the defended pocket is a function of what
   * is still owed, and nothing else.
   */
  function applyPocket() {
    if (!session.traffic) return 0;
    return session.traffic.setPocket(MISSIONS.bountyPressure(player, session.index));
  }

  /**
   * Report what a set of contract outcomes means to the commander.
   *
   * Shared by docking and by a bounty landing on the kill, so a job is
   * announced the same way wherever it finishes.
   */
  function announceOutcomes(outcomes) {
    for (const outcome of outcomes) {
      const c = outcome.contract;
      if (outcome.ok) {
        play('rank');
        say('Contract complete: ' + c.reward + ' CR - ' + MISSIONS.describe(c),
          HUD.HUD_COLOURS.ok);
      } else {
        play('deny');
        say('Contract ' + outcome.reason + ': ' + MISSIONS.describe(c)
          + (outcome.fine ? ' (-' + outcome.fine + ' CR)' : ''),
        HUD.HUD_COLOURS.danger);
      }
    }
  }

  function findMarketRow(comId) {
    return marketRows(player.day).find((r) => r.id === comId) || null;
  }

  /**
   * Note that the commander supplied a world in trouble.
   *
   * The condition layer already knows which goods a crisis makes scarce - a
   * famine wants food, a plague wants medicine - so relief is just a matter of
   * checking what was sold against what the world is short of. The system
   * remembers, and `REP.memoryPriceDelta` keeps food and medicine cheaper
   * there for a while afterwards.
   */
  function recordRelief(comId, tons) {
    const condition = session.system.condition;
    const relieves = (condition === 'FAMINE' && comId === 'food')
      || (condition === 'PLAGUE' && comId === 'medicine');
    if (!relieves || tons <= 0) return;
    REP.remember(player, session.index, 'famineRelieved', tons);
    say('They will remember this. ' + tons + ' t delivered.',
      HUD.HUD_COLOURS.ok);
  }

  function refreshStation() {
    if (stationUi.isOpen()) stationUi.update(stationState());
  }

  // -------------------------------------------------------------------------
  // Save / load
  // -------------------------------------------------------------------------

  /**
   * One autosave slot, written on docking.
   *
   * A single slot rather than three named ones: this is a friendly build, and
   * the failure mode of a manual save system is a player who loses an evening
   * because they saved over the wrong file. Docking is already the natural
   * checkpoint in Elite, so the game saves itself there and never asks.
   */
  function saveGame() {
    if (!hasStorage()) return false;
    try {
      storage().setItem(SAVE_KEY, JSON.stringify({
        player: JSON.parse(PLAYER.serialize(player)),
        seed: GALAXY_SEED,
      }));
      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * The known-good sets a save is checked against.
   *
   * Gathered here because `player.js` deliberately imports nothing but
   * `reputation.js`, and having it reach into the commodity and faction tables
   * to validate a save would be the first dependency cycle in the project.
   */
  function saveVocabulary() {
    return {
      systems: galaxy.systems.length,
      commodities: ECONOMY.COMMODITIES.map((c) => c.id),
      factions: FACTIONS.FACTION_IDS,
      equipment: PLAYER.EQUIPMENT.map((e) => e.id),
    };
  }

  function loadGame() {
    if (!hasStorage()) return null;
    try {
      const raw = storage().getItem(SAVE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || !data.player || data.seed !== GALAXY_SEED) return null;
      // The seed check says this save belongs to this galaxy. It says nothing
      // about whether the record inside it is playable, and an unplayable one
      // used to reach the game intact: a string `cash` broke the station
      // screen, and a `currentSystem` past the end of the table threw on
      // arrival. Both are unrecoverable from inside the game, because the save
      // is reloaded on every boot. A fresh start on the same galaxy is a real
      // state, so a save that fails validation takes the path broken JSON
      // already takes.
      const p = PLAYER.deserializeChecked(data.player, saveVocabulary());
      if (!p) {
        log('save: rejected as not playable, starting fresh');
        return null;
      }
      log('save: loaded commander ' + p.name);
      return p;
    } catch (err) {
      // A corrupt save must not brick the game - start fresh instead.
      log('save: unreadable, starting fresh');
      return null;
    }
  }

  function hasStorage() {
    try {
      return typeof localStorage !== 'undefined' && !!localStorage;
    } catch (err) {
      return false;
    }
  }

  function storage() {
    return localStorage;
  }

  // -------------------------------------------------------------------------
  // Hyperspace
  // -------------------------------------------------------------------------

  /** Can we jump to this system right now? Returns a reason when we cannot. */
  function canJump(targetIndex) {
    if (targetIndex === session.index) return { ok: false, reason: 'here' };
    const target = galaxy.systems[targetIndex];
    if (!target) return { ok: false, reason: 'unknown' };
    const d = toLy(GALAXY.distance(session.system, target));
    if (d > player.fuel) return { ok: false, reason: 'fuel', distance: d };
    return { ok: true, distance: d };
  }

  function beginJump(targetIndex) {
    const check = canJump(targetIndex);
    if (!check.ok) {
      play('deny');
      if (check.reason === 'fuel') {
        say('Out of fuel: need ' + check.distance.toFixed(1) + ' ly', HUD.HUD_COLOURS.danger);
      }
      return false;
    }
    session.jumpFrom = session.index;
    session.jumpTarget = targetIndex;
    player.fuel = Math.max(0, player.fuel - check.distance);
    setMode(MODE.HYPERSPACE);
    play('hyper');
    say('Jumping ' + check.distance.toFixed(1) + ' ly...', HUD.HUD_COLOURS.warn);
    return true;
  }

  /** Complete the jump: swap the system, arrive at the station. */
  function completeJump() {
    const target = session.jumpTarget;
    session.jumpTarget = null;
    if (target === null || target === undefined) return;
    commitJumpScene();
    enterSystem(target, 'station');
    setMode(MODE.FLIGHT);
    // Arriving anywhere is worth saving, because witchspace interdiction is
    // about to become a thing the player has to survive.
    decayDay(true);
  }

  /**
   * Tear down the previous system's scene.
   *
   * Three's `Object3D` has no recursive dispose, and a system holds a station,
   * a planet, 90 rocks and up to a dozen ships. Leaking them means a visible
   * memory climb after four or five jumps - and `renderer.setSystemGroup`
   * only detaches the root, it does not free it.
   */
  function commitJumpScene() {
    const previous = session.scene;
    if (!previous) return;
    // Traffic meshes are added to the renderer's scene directly, not to the
    // system group, so they have to be removed by hand.
    if (session.traffic) {
      for (const s of session.traffic.ships) {
        renderer.scene.remove(s.mesh);
        disposeTree(s.mesh);
      }
    }
    renderer.scene.remove(previous.root);
    renderer.scene.remove(previous.sunLight);
    renderer.scene.remove(previous.sunLight.target);
    renderer.scene.remove(previous.planetLight);
    disposeTree(previous.root);
    renderer.scene.fog = null;
  }

  // `disposeTree` now lives in `sim/dispose.js`, shared with `world.js`, so the
  // despawn path and the jump path free resources by the same rules. The local
  // copy that used to be here ignored the `userData.shared` contract that the
  // debris and exhaust pools rely on - see the note in that module.

  // -------------------------------------------------------------------------
  // Day and decay
  // -------------------------------------------------------------------------

  /**
   * Advance the clock by one day. The only place that does.
   *
   * Two events cost a day, and only two: completing a jump (`completeJump`)
   * and docking (`dock`). Everything that measures time in days - market
   * drift, contract deadlines, the decay of offences and bounties - reads
   * `player.day`, so this function is the single definition of what a day is.
   *
   * It used to be described elsewhere as "a day is a dock, a jump is free",
   * and that was never true. `commitJumpScene` tears the old system down and
   * `enterSystem` builds the new one, but arriving at the station is not
   * docking: only the `dock()` path runs the contract desk and the save. So a
   * hop in the game costs a day, and a three-hop contract genuinely spends
   * three days in transit before the dock at the far end spends the fourth.
   * The descriptions that disagreed with this one were fixed, not the code.
   *
   * `silent` suppresses the messages a player does not need to see twice -
   * clearing a record and gaining a rank - for the jump, which is busy enough
   * without them.
   */
  function decayDay(silent) {
    player.day += 1;
    // Offences fade with time served, and standing slowly returns to neutral.
    if (player._offences > 0) PLAYER.decayRecord(player);
    // A day passes everywhere at once, so every bounty decays - not just the
    // one in the system we happen to be docked at. The previous call passed no
    // index at all and silently did nothing.
    const decayed = REP.decayAllWanted(player);
    if (decayed.cleared.length && !silent) {
      say(decayed.cleared.length === 1
        ? 'Your record has been cleared here'
        : 'Your record has been cleared in ' + decayed.cleared.length + ' systems',
      HUD.HUD_COLOURS.ok);
    }
    const before = PLAYER.rankOf(player.kills);
    if (!silent && before !== PLAYER.rankOf(player.kills)) {
      say('Rank: ' + String(PLAYER.rankOf(player.kills)).toUpperCase(), HUD.HUD_COLOURS.ok);
    }
  }

  // -------------------------------------------------------------------------
  // Combat wiring
  // -------------------------------------------------------------------------

  /** Fire the laser. Returns true if a shot went out. */
  function fireLaser() {
    const verdict = COMBAT.laserCanFire(player, session.shotCooldown);
    if (!verdict.ok) {
      // Overheating is worth interrupting the player for; a cooldown is not.
      if (verdict.reason === 'overheat') say('Laser overheated', HUD.HUD_COLOURS.warn);
      else play('deny');
      return false;
    }
    const shot = COMBAT.fireLaser(player);
    session.shotCooldown = shot.cooldown;
    play('laser');

    const origin = {
      x: session.flight.pos.x, y: session.flight.pos.y, z: session.flight.pos.z,
    };
    const dir = FLIGHT.forwardOf(session.flight);

    // Tracer: a short bright segment from the muzzle. Hitscan means the shot
    // has already landed, so this is pure feedback - but it is *essential*
    // feedback, because without it a hitscan weapon feels like nothing
    // happened.
    session.tracers.push({
      from: { x: origin.x, y: origin.y, z: origin.z },
      to: {
        x: origin.x + dir.x * shot.tracerLength,
        y: origin.y + dir.y * shot.tracerLength,
        z: origin.z + dir.z * shot.tracerLength,
      },
      colour: shot.colour,
      life: 0.09,
      maxLife: 0.09,
    });

    // Missiles are shootable, and they are the *nearer* target more often
    // than not - a missile on its way in is between the ship and the ship that
    // fired it. One raycast over both lists, so the nearer thing wins.
    const targets = session.traffic.ships.concat(session.incoming);
    const hit = WORLD.raycast(origin, dir, targets, 900);
    if (hit && hit.target && !hit.target.dead) {
      if (session.incoming.indexOf(hit.target) >= 0) {
        // Shot down. Worth a distinct cue: this is the one shot in the game
        // that saves the ship rather than destroying something.
        play('explode');
        spawnImpact(hit.point, 0xff7a4d);
        spawnExplosion(hit.target.mesh.position);
        say('Missile destroyed', HUD.HUD_COLOURS.ok);
        dropIncoming(session.incoming.indexOf(hit.target));
      } else {
        onPlayerHit(hit.target, shot.damage, hit.point);
      }
    }
    return true;
  }

  /** Resolve a player laser hit on an NPC. */
  function onPlayerHit(entity, damage, point) {
    const died = COMBAT.damageEntity(entity, damage);
    play(died ? 'explode' : 'hitShield');
    spawnImpact(point, 0xffd27a);

    // Damage to a ship you are not supposed to shoot is an offence even if it
    // survives; Elite has always worked that way and it is what makes the
    // police dangerous to provoke.
    const damageShift = COMBAT.standingShiftFor(entity, 'damage');
    if (damageShift) {
      PLAYER.adjustStanding(player, entity.standingFaction || 'INDEPENDENT', damageShift * damage / 10);
    }
    if (!died) {
      // Turning on a trader or a patrol must be noticed immediately.
      if (entity.kind === 'trader' || entity.kind === 'viper') markHostileTo(entity);
      return;
    }
    onEntityDestroyed(entity);
  }

  function markHostileTo(entity) {
    entity.hostile = true;
    entity.aggression = Math.max(entity.aggression, 0.8);
    entity.state = 'engage';
  }

  /** Award bounty, apply legal consequences, and drop cargo. */
  function onEntityDestroyed(entity) {
    const danger = session.traffic ? session.traffic.danger : 0;
    const bounty = COMBAT.bountyFor(entity, danger);
    const offence = COMBAT.offenceFor(entity);
    const shift = COMBAT.standingShiftFor(entity, 'kill');

    if (shift) {
      PLAYER.adjustStanding(player, entity.standingFaction || 'INDEPENDENT', shift);
    }

    // What this system will remember about it. The event layer is what turns a
    // system from a price table into a place: clearing the lanes makes it
    // safer and busier, killing the patrol makes it worse, and killing haulers
    // empties it. All three feed back into the market and the traffic.
    if (entity.kind === 'pirate' || entity.kind === 'raider') {
      REP.remember(player, session.index, 'piratesCleared');
      // A bounty pays the moment the last pirate dies rather than waiting for
      // a landing pad: it is the one contract that can be finished without
      // going anywhere.
      announceOutcomes(MISSIONS.checkBounties(player, session.index));
      // A finished cleanup contract lets the pocket go: the survivors are still
      // out there, but nobody is paying to keep the sky this crowded.
      applyPocket();
    } else if (entity.kind === 'viper') {
      REP.remember(player, session.index, 'patrolsKilled');
    } else if (entity.kind === 'trader') {
      REP.remember(player, session.index, 'tradersLost');
    }

    if (offence > 0) {
      const status = PLAYER.recordOffence(player, offence);
      REP.markWanted(player, session.index, offence);
      say('Offence recorded: ' + status, HUD.HUD_COLOURS.danger);
    }

    // Only hostile ships pay a bounty. Shooting a trader is a crime, not a job.
    if (bounty > 0 && entity.hostile) {
      player.cash += bounty;
      player.kills += 1;
      const rank = PLAYER.rankOf(player.kills);
      say('Bounty: ' + bounty + ' CR', HUD.HUD_COLOURS.ok);
      if (rank !== session.lastRankName) {
        session.lastRankName = rank;
        say('Promoted to ' + String(rank).toUpperCase(), HUD.HUD_COLOURS.ok);
        play('rank');
      }
    }

    // Traders and pirates carry cargo you can scoop. The return value used to
    // be discarded here, which made the whole mechanic dead: nothing put the
    // canister in a list the collision scan walks, so it could never be picked
    // up, and it never reached `prune` or the jump teardown either - every kill
    // left a mesh, a geometry and a material in the scene for the life of the
    // session. Handing it to the traffic puts it under all of those at once.
    if (session.traffic) {
      if (entity.cargo) {
        session.traffic.addWreckage(
          WORLD.dropCargo(renderer.scene, entity.mesh.position, entity.cargo, session.time | 0));
      }
      // A crewed hull that comes apart leaves a capsule behind. It used to be
      // unreachable content: `dropCapsule` was called from a test and nowhere
      // else, and the `kind === 'capsule'` branch of `scoop` could never run.
      // Tying it to the same event the wreck drops from is what makes it real.
      // Hostiles do not eject - the reward for rescuing a pirate is a fight.
      if (!entity.hostile && (entity.kind === 'trader' || entity.kind === 'viper')) {
        session.traffic.addWreckage(
          [WORLD.dropCapsule(renderer.scene, entity.mesh.position, session.time | 0)]);
      }
    }

    const pos = entity.mesh.position;
    spawnExplosion(pos);
    play('explode');

    // Remove it now rather than waiting for the prune pass, so the wreck does
    // not absorb the next shot.
    renderer.scene.remove(entity.mesh);
    disposeTree(entity.mesh);
    entity.dead = true;
    // `hudState` clears `session.target` itself when it finds it dead, so there
    // is nothing to do here. A `session.chartTarget` used to be nulled on this
    // line, but nothing ever assigned it - dead code dressed as bookkeeping.
  }

  /** Launch a homing missile at the current target. */
  function launchMissile() {
    if (player.missiles <= 0) { play('deny'); return say('No missiles'); }
    const target = session.target;
    if (!target || target.dead) { play('deny'); return say('No target locked'); }
    player.missiles -= 1;
    play('missile');
    const mesh = new THREE.Mesh(
      new THREE.ConeGeometry(0.35, 2.2, 6),
      new THREE.MeshBasicMaterial({ color: 0xffd27a }),
    );
    mesh.position.set(session.flight.pos.x, session.flight.pos.y, session.flight.pos.z);
    renderer.scene.add(mesh);
    session.missiles.push({
      mesh: mesh, target: target,
      velocity: { x: 0, y: 0, z: 0 },
      life: MISSILE.life,
    });
    say('Missile away', HUD.HUD_COLOURS.warn);
  }

  /** Aim the next missile at whatever is in front of the reticle. */
  function cycleTarget(dir) {
    const ships = session.traffic ? session.traffic.ships.filter((s) => !s.dead) : [];
    if (!ships.length) { session.target = null; return say('No contacts'); }
    // Sort by distance so "next" is a predictable sweep outward.
    ships.sort((a, b) => WORLD.dist(a.mesh.position, session.flight.pos)
      - WORLD.dist(b.mesh.position, session.flight.pos));
    if (!session.target || session.target.dead) {
      session.target = ships[0];
    } else {
      let i = ships.indexOf(session.target);
      if (i < 0) i = 0;
      session.target = ships[((i + (dir || 1)) % ships.length + ships.length) % ships.length];
    }
    play('lock');
    const t = session.target;
    say('Target: ' + t.kind.toUpperCase() + '  ' + WORLD.dist(t.mesh.position, session.flight.pos).toFixed(0) + ' m',
      HUD.HUD_COLOURS.warn);
  }

  /** Take damage from any source, with sound, shake, and death handling. */
  function hurtPlayer(amount, opts) {
    if (session.grace > 0 && !(opts && opts.ignoreGrace)) return null;
    const result = COMBAT.damagePlayer(player, amount, opts);
    if (result.hullLost > 0) {
      play('hitHull');
      renderer.flash(Math.min(0.9, result.hullLost / 25));
      renderer.addShake(Math.min(1.2, result.hullLost / 30));
      FLIGHT.addShake(session.flight, Math.min(1.2, result.hullLost / 30));
    } else if (result.shieldsLost > 0) {
      play('hitShield');
      renderer.addShake(0.25);
    }
    session.sinceDamage = 0;
    if (result.destroyed) die('Hull destroyed');
    return result;
  }

  /** The player has died. Offer the escape capsule if they bought one. */
  function die(cause) {
    if (session.mode === MODE.DEAD) return;
    play('death');
    renderer.flash(1);
    if (PLAYER.hasEquipment(player, 'capsule')) {
      say('Escape capsule launched!', HUD.HUD_COLOURS.warn);
      // The capsule costs the ship and the cargo but not the commander's
      // career - which is exactly what it costs to buy, and why it is cheap.
      const fine = Math.round(player.cash * 0.5);
      player.cash -= fine;
      player.cargo = {};
      player.hull = player.hullMax;
      player.shields = player.shieldMax;
      player.energy = player.energyMax;
      session.grace = ARRIVAL_GRACE * 2;
      say('Rescued. ' + fine + ' CR in recovery fees.', HUD.HUD_COLOURS.inkDim);
      const pose = WORLD.arrivalPose(session.scene.station);
      session.flight.pos = { x: pose.position.x, y: pose.position.y, z: pose.position.z };
      FLIGHT.faceToward(session.flight, pose.facing);
      renderer.snapCamera(session.flight);
      return;
    }
    say('Destroyed: ' + cause, HUD.HUD_COLOURS.danger);
    setMode(MODE.DEAD);
  }

  // -------------------------------------------------------------------------
  // Visual effects owned by the game loop
  // -------------------------------------------------------------------------

  const effects = { explosions: [], impacts: [], debris: [] };

  function spawnExplosion(position) {
    const mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(2, 0),
      new THREE.MeshBasicMaterial({
        color: 0xffd27a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending,
      }),
    );
    mesh.position.copy(position);
    renderer.scene.add(mesh);
    effects.explosions.push({ mesh: mesh, life: 0.55, maxLife: 0.55, scale: 14 });
    spawnDebris(position);
  }

  /**
   * A burst of tumbling fragments where a ship died.
   *
   * The explosion is a flash - it is over in half a second and then the kill
   * leaves nothing behind at all. Debris is what makes the *aftermath* exist:
   * glowing scraps that cool, tumble and drift apart, so a won fight leaves a
   * visible scene rather than a clean void.
   *
   * The fragments reuse `makeAsteroid`'s deformation idea at tiny scale but are
   * built from a bare tetrahedron instead: at the size they render (a couple of
   * units across, at combat range) extra facets are invisible, and a dozen of
   * them spawn per kill.
   *
   * `userData.shared` marks the material so the generic disposal paths - which
   * walk the scene graph on a jump - do not free the *shared* fragment material
   * out from under the other fragments. See `disposeSky` for the same pattern.
   */
  const DEBRIS = {
    count: 9,
    life: 1.5,
    material: null,       // created lazily, shared by every fragment
    geometry: null,
  };

  function spawnDebris(position) {
    if (!DEBRIS.geometry) {
      DEBRIS.geometry = new THREE.TetrahedronGeometry(1, 0);
      markShared(DEBRIS.geometry);
    }
    if (!DEBRIS.material) {
      DEBRIS.material = new THREE.MeshBasicMaterial({
        color: 0xffb066,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      markShared(DEBRIS.material);
    }
    for (let i = 0; i < DEBRIS.count; i += 1) {
      const mesh = new THREE.Mesh(DEBRIS.geometry, DEBRIS.material);
      mesh.position.copy(position);
      // Scatter outward on a sphere, biased so the burst has a direction.
      const a = Math.random() * Math.PI * 2;
      const b = (Math.random() - 0.5) * Math.PI;
      const speed = 26 + Math.random() * 54;
      const dir = {
        x: Math.cos(a) * Math.cos(b),
        y: Math.sin(b),
        z: Math.sin(a) * Math.cos(b),
      };
      mesh.scale.setScalar(0.5 + Math.random() * 1.4);
      renderer.scene.add(mesh);
      effects.debris.push({
        mesh,
        velocity: { x: dir.x * speed, y: dir.y * speed, z: dir.z * speed },
        spin: {
          x: (Math.random() - 0.5) * 7,
          y: (Math.random() - 0.5) * 7,
          z: (Math.random() - 0.5) * 7,
        },
        life: DEBRIS.life,
        maxLife: DEBRIS.life,
      });
    }
  }

  function spawnImpact(point, colour) {
    const mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.4, 0),
      new THREE.MeshBasicMaterial({
        color: colour || 0xffd27a, transparent: true, opacity: 1, blending: THREE.AdditiveBlending,
      }),
    );
    mesh.position.set(point.x, point.y, point.z);
    renderer.scene.add(mesh);
    effects.impacts.push({ mesh: mesh, life: 0.18, maxLife: 0.18 });
  }

  /** Advance every cosmetic effect. Purely visual, so it is safe to skip. */
  function stepEffects(dt) {
    for (let i = effects.explosions.length - 1; i >= 0; i -= 1) {
      const e = effects.explosions[i];
      e.life -= dt;
      const t = 1 - Math.max(0, e.life) / e.maxLife;
      e.mesh.scale.setScalar(0.4 + t * e.scale);
      e.mesh.material.opacity = Math.max(0, 0.9 * (1 - t));
      if (e.life <= 0) {
        renderer.scene.remove(e.mesh);
        e.mesh.geometry.dispose();
        e.mesh.material.dispose();
        effects.explosions.splice(i, 1);
      }
    }
    for (let i = effects.impacts.length - 1; i >= 0; i -= 1) {
      const e = effects.impacts[i];
      e.life -= dt;
      e.mesh.scale.setScalar(1 + (1 - e.life / e.maxLife) * 3);
      e.mesh.material.opacity = Math.max(0, e.life / e.maxLife);
      if (e.life <= 0) {
        renderer.scene.remove(e.mesh);
        e.mesh.geometry.dispose();
        e.mesh.material.dispose();
        effects.impacts.splice(i, 1);
      }
    }
    // Tracers.
    for (let i = session.tracers.length - 1; i >= 0; i -= 1) {
      session.tracers[i].life -= dt;
      if (session.tracers[i].life <= 0) session.tracers.splice(i, 1);
    }
    // Debris: tumbles, drifts, cools. The material is shared, so only the mesh
    // is removed here - disposing it would blank every other fragment.
    for (let i = effects.debris.length - 1; i >= 0; i -= 1) {
      const d = effects.debris[i];
      d.life -= dt;
      d.mesh.position.x += d.velocity.x * dt;
      d.mesh.position.y += d.velocity.y * dt;
      d.mesh.position.z += d.velocity.z * dt;
      d.mesh.rotation.x += d.spin.x * dt;
      d.mesh.rotation.y += d.spin.y * dt;
      d.mesh.rotation.z += d.spin.z * dt;
      if (d.life <= 0) {
        renderer.scene.remove(d.mesh);
        effects.debris.splice(i, 1);
      }
    }
    // One shared material for the whole burst, so cooling is applied once per
    // frame from the *oldest* fragment still alive rather than per fragment.
    if (DEBRIS.material && effects.debris.length) {
      let oldest = 0;
      for (const d of effects.debris) oldest = Math.max(oldest, 1 - d.life / d.maxLife);
      DEBRIS.material.opacity = Math.max(0, 0.95 * (1 - oldest * oldest));
    }
    // Enemy shots are tracked only for their arrival, so they are timed out
    // rather than drawn - the HUD shows incoming fire.
    for (let i = session.shots.length - 1; i >= 0; i -= 1) {
      session.shots[i].life -= dt;
      if (session.shots[i].life <= 0) session.shots.splice(i, 1);
    }
    // Damage arcs fade on their own clock, independent of the shots that
    // caused them - a hit that landed is worth showing even after the shot
    // record has gone.
    for (let i = session.hits.length - 1; i >= 0; i -= 1) {
      session.hits[i].age += dt;
      if (session.hits[i].age > HUD.HUD_LAYOUT.damageArcLifetime) session.hits.splice(i, 1);
    }
  }

  // -------------------------------------------------------------------------
  // (The player's exhaust used to live here)
  // -------------------------------------------------------------------------

  /*
   * Removed deliberately, after measuring it.
   *
   * The idea was that a pilot sees their own exhaust streaming past the
   * canopy. The implementation spawned world-space particles at the ship's
   * tail and left them behind - and the eye sits 7.4 units behind the ship's
   * reference point, so every particle spawned 3-17 units from the lens.
   *
   * Two settings are possible there and neither is acceptable. Small and
   * faint, and it is invisible; large enough to see, and thirty-eight
   * additively blended blobs within a few metres of the camera cover 55-97 %
   * of the frame with a white wash. It was also flickering between the two,
   * because the shared material opacity was driven by the oldest particle in a
   * continuously spawned pool - which is always one about to expire.
   *
   * A cockpit exhaust would have to be authored differently (screen-space
   * streaks at the frame edges, not world-space geometry next to the lens).
   * Until then, the speed readout on the HUD says everything this did, and the
   * game is better without a fog bank over the canopy.
   */

  // -------------------------------------------------------------------------
  // Missiles and enemy fire
  // -------------------------------------------------------------------------

  function stepMissiles(dt) {
    for (let i = session.missiles.length - 1; i >= 0; i -= 1) {
      const m = session.missiles[i];
      m.life -= dt;
      const target = m.target;
      if (m.life <= 0 || !target || target.dead) {
        dropMissile(i);
        continue;
      }
      // Steer toward the target with a bounded turn rate, so a fast target can
      // out-turn a missile - which is what makes evasive flying matter.
      const tp = target.mesh.position;
      const dx = tp.x - m.mesh.position.x;
      const dy = tp.y - m.mesh.position.y;
      const dz = tp.z - m.mesh.position.z;
      const d = Math.hypot(dx, dy, dz) || 1;
      const want = { x: dx / d, y: dy / d, z: dz / d };
      const step = Math.min(1, MISSILE.turn * dt);
      m.velocity.x += (want.x * MISSILE.speed - m.velocity.x) * step;
      m.velocity.y += (want.y * MISSILE.speed - m.velocity.y) * step;
      m.velocity.z += (want.z * MISSILE.speed - m.velocity.z) * step;

      m.mesh.position.x += m.velocity.x * dt;
      m.mesh.position.y += m.velocity.y * dt;
      m.mesh.position.z += m.velocity.z * dt;
      m.mesh.lookAt(tp.x, tp.y, tp.z);

      if (d < (WORLD.entityRadius(target) + 6)) {
        const died = COMBAT.damageEntity(target, COMBAT.MISSILE_DAMAGE);
        spawnExplosion(m.mesh.position);
        if (died) onEntityDestroyed(target);
        else if (target.kind === 'trader' || target.kind === 'viper') markHostileTo(target);
        dropMissile(i);
      }
    }
  }

  /**
   * An enemy shot arriving.
   *
   * Not simulated as a travelling projectile: at 600 m/s a shot crosses the
   * engagement envelope in a fraction of a second, and the player has no way to
   * dodge something they cannot see. Instead the damage is applied with a short
   * delay and the HUD warns, which is both cheaper and fairer.
   */
  function onEnemyShot(entity, shot) {
    play('enemyShot');
    // The shot lands almost immediately; the delay is only enough that the
    // sound and the flash do not coincide exactly, which reads as broken.
    session.shots.push({
      from: {
        x: entity.mesh.position.x, y: entity.mesh.position.y, z: entity.mesh.position.z,
      },
      life: 0.08,
      damage: shot.damage,
      entity: entity,
    });
    // Which way it came from. The bearing drives the damage arc on the HUD,
    // and the message is now only for the case the arc cannot cover: fire from
    // behind, where the player cannot see the shooter at all.
    const bearing = noteHit(entity.mesh.position);
    if (Math.abs(bearing) > Math.PI * 0.6) say('Under fire from behind', HUD.HUD_COLOURS.danger);
  }

  /**
   * Remember which way a hit came from.
   *
   * The bearing is in the ship's own frame: 0 is dead ahead, positive to
   * starboard, +/-pi is directly behind. Returned so a caller can decide
   * whether to also say something.
   *
   * This used to be a one-off `dot < -0.2` test that produced a sentence and
   * nothing else, so a player taking fire from two directions at once had no
   * way to tell which way to turn.
   */
  function noteHit(sourcePos) {
    const f = session.flight;
    if (!f) return 0;
    const fwd = FLIGHT.forwardOf(f);
    const right = FLIGHT.rightOf(f);
    const dx = sourcePos.x - f.pos.x;
    const dy = sourcePos.y - f.pos.y;
    const dz = sourcePos.z - f.pos.z;
    const forward = dx * fwd.x + dy * fwd.y + dz * fwd.z;
    const lateral = dx * right.x + dy * right.y + dz * right.z;
    const bearing = Math.atan2(lateral, forward);
    session.hits.push({ bearing: bearing, age: 0 });
    // A cap, so a sustained barrage cannot grow the list without bound.
    if (session.hits.length > 8) session.hits.shift();
    return bearing;
  }

  /**
   * A missile has been launched at the player.
   *
   * Deliberately its own list rather than a flag on `session.missiles`: the
   * two fly toward different things, are answered differently, and mixing them
   * would mean every step of the loop asking which kind it was holding.
   */
  function onEnemyMissile(entity, spec) {
    play('missile');
    const mesh = new THREE.Mesh(
      new THREE.ConeGeometry(0.3, 1.8, 6),
      new THREE.MeshBasicMaterial({
        color: 0xff7a4d, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    mesh.position.set(entity.mesh.position.x, entity.mesh.position.y, entity.mesh.position.z);
    mesh.renderOrder = 3;
    renderer.scene.add(mesh);
    session.incoming.push({
      mesh: mesh,
      // `radius` is what makes it shootable: `WORLD.raycast` reads it, so the
      // player's laser can lock a missile the same way it locks a ship.
      radius: spec.radius,
      dead: false,
      damage: spec.damage,
      speed: spec.speed,
      turn: spec.turn,
      life: spec.life,
      velocity: { x: 0, y: 0, z: 0 },
      from: entity.kind,
    });
    say('Missile inbound!', HUD.HUD_COLOURS.danger);
  }

  /** Homing missiles aimed at the player. */
  function stepIncoming(dt) {
    const f = session.flight;
    for (let i = session.incoming.length - 1; i >= 0; i -= 1) {
      const m = session.incoming[i];
      m.life -= dt;

      const dx = f.pos.x - m.mesh.position.x;
      const dy = f.pos.y - m.mesh.position.y;
      const dz = f.pos.z - m.mesh.position.z;
      const d = Math.hypot(dx, dy, dz) || 1;

      if (m.life <= 0 || d > 4000) {
        dropIncoming(i);
        continue;
      }

      // Bounded turn, which is the whole reason evasive flying works: the
      // missile cannot follow a hard break, so it overshoots and has to come
      // round again.
      const step = Math.min(1, m.turn * dt);
      m.velocity.x += (dx / d * m.speed - m.velocity.x) * step;
      m.velocity.y += (dy / d * m.speed - m.velocity.y) * step;
      m.velocity.z += (dz / d * m.speed - m.velocity.z) * step;

      m.mesh.position.x += m.velocity.x * dt;
      m.mesh.position.y += m.velocity.y * dt;
      m.mesh.position.z += m.velocity.z * dt;
      m.mesh.lookAt(f.pos.x, f.pos.y, f.pos.z);

      if (d < PLAYER_HIT_RADIUS) {
        spawnExplosion(m.mesh.position);
        hurtPlayer(m.damage, {});
        noteHit(m.mesh.position);
        dropIncoming(i);
      }
    }
  }

  function dropIncoming(index) {
    const m = session.incoming[index];
    if (!m) return;
    renderer.scene.remove(m.mesh);
    m.mesh.geometry.dispose();
    m.mesh.material.dispose();
    session.incoming.splice(index, 1);
  }

  /** Remove every inbound missile. Called on jump, dock and death. */
  function clearIncoming() {
    while (session.incoming.length) dropIncoming(session.incoming.length - 1);
  }

  function dropMissile(index) {
    const m = session.missiles[index];
    if (!m) return;
    renderer.scene.remove(m.mesh);
    m.mesh.geometry.dispose();
    m.mesh.material.dispose();
    session.missiles.splice(index, 1);
  }

  /**
   * Remove every missile of the player's that is still in flight.
   *
   * The array used to be emptied with a bare `length = 0` on a system change,
   * which left every geometry and material alive in a scene that was about to
   * be thrown away - inbound missiles were disposed properly one line away, so
   * the two paths disagreed about what "clearing a list" means.
   */
  function clearMissiles() {
    while (session.missiles.length) dropMissile(session.missiles.length - 1);
  }

  /** Apply any enemy shot that has finished its flight. */
  function stepEnemyShots() {
    for (let i = session.shots.length - 1; i >= 0; i -= 1) {
      const s = session.shots[i];
      if (s.life > 0) continue;
      hurtPlayer(s.damage, {});
      session.shots.splice(i, 1);
    }
  }

  // -------------------------------------------------------------------------
  // Docking
  // -------------------------------------------------------------------------

  function checkDocking() {
    if (!session.scene || !session.scene.station) return null;
    return WORLD.checkDocking(
      session.scene.station,
      session.flight.pos,
      session.flight.vel,
      session.flight.quat,
      // The Docking Computer widens the envelope rather than flying the ship:
      // the automatic pass is available to everyone, but only a fitted
      // computer accepts a sloppy approach. See `DOCKING.assist`.
      { assisted: PLAYER.hasEquipment(player, 'dock') },
    );
  }

  /** The ship has been accepted: show the station, bank the day, save. */
  function dock() {
    play('dock');
    say('Docking successful', HUD.HUD_COLOURS.ok);
    player.dockedAt = session.index;

    // Contracts resolve *before* the day advances. A deadline is inclusive: a
    // commander who arrives on the last day has made it, and advancing the
    // clock first would mark the job overdue in the same breath.
    announceOutcomes(MISSIONS.resolveArrival(player, session.index, player.day));
    announceOutcomes(MISSIONS.checkBounties(player, session.index));
    // Docking is where a job lapses or is handed in, so the pocket has to be
    // re-sized here too - a lapsed cleanup contract should stop drawing
    // hostiles into the system.
    applyPocket();

    // A missile chasing you into the docking slot would detonate on the
    // station screen. The docking computer flies you in; the warhead does not
    // come with you.
    clearIncoming();

    decayDay(false);
    saveGame();
    // Repair of the day's drift happens on dock, so prices on the screen the
    // player is about to see already reflect the new day.
    setMode(MODE.DOCKED);
  }

  // -------------------------------------------------------------------------
  // Input handling per mode
  // -------------------------------------------------------------------------

  function handleFlightInput(dt) {
    // --- Continuous axes --------------------------------------------------
    const axes = INPUT.axes(input, dt);
    FLIGHT.applyInput(session.flight, axes, dt);
    FLIGHT.integrate(session.flight, dt);

    // --- Throttle ---------------------------------------------------------
    if (axes.throttle > 0) session.flight.throttle = Math.min(1, session.flight.throttle + dt * 0.55);
    if (axes.throttle < 0) session.flight.throttle = Math.max(0, session.flight.throttle - dt * 0.55);

    // --- One-shot actions -------------------------------------------------
    if (INPUT.held(input, 'fire')) {
      fireLaser();
    }
    if (INPUT.consume(input, 'targetNext')) cycleTarget(1);
    if (INPUT.consume(input, 'targetPrev')) cycleTarget(-1);
    if (INPUT.consume(input, 'missile')) launchMissile();
    if (INPUT.consume(input, 'chart') || INPUT.consume(input, 'jump')) openChart();
    if (INPUT.consume(input, 'dock')) requestDock();
    if (INPUT.consume(input, 'hyperspace')) quickJump();
    if (INPUT.consume(input, 'scannerRange')) cycleScanner();
    if (INPUT.consume(input, 'mute')) toggleMute();
    if (INPUT.consume(input, 'pause')) setMode(MODE.TITLE);
  }

  /** Dock on request, but only if the geometry actually allows it. */
  function requestDock() {
    const verdict = checkDocking();
    if (verdict && verdict.ok) return dock();
    play('deny');
    if (!verdict) return;
    if (verdict.reason === 'too-fast') say('Too fast to dock', HUD.HUD_COLOURS.danger);
    else if (verdict.reason === 'out-of-range') say('Station out of range', HUD.HUD_COLOURS.warn);
    else if (verdict.reason === 'off-axis') say('Line up with the slot', HUD.HUD_COLOURS.warn);
    else say('Fly into the slot, not away from it', HUD.HUD_COLOURS.warn);
  }

  /** Hyperspace toward the chart cursor, without opening the chart first. */
  function quickJump() {
    // Pick the nearest reachable system in the direction the nose points, so
    // "H" is useful without the chart.
    const fwd = FLIGHT.forwardOf(session.flight);
    let best = null;
    let bestScore = -Infinity;
    for (const candidate of galaxy.systems) {
      if (candidate.index === session.index) continue;
      const check = canJump(candidate.index);
      if (!check.ok) continue;
      const dx = candidate.x - session.system.x;
      const dy = candidate.y - session.system.y;
      const len = Math.hypot(dx, dy) || 1;
      // The chart is a 2D projection; direction is judged on x/y.
      const score = (fwd.x * dx + fwd.y * dy) / len - check.distance / Math.max(1, player.fuelMax);
      if (score > bestScore) { bestScore = score; best = candidate.index; }
    }
    if (best === null) {
      play('deny');
      return say('No system in range', HUD.HUD_COLOURS.warn);
    }
    beginJump(best);
  }

  function openChart() {
    setMode(MODE.CHART);
    session.chartCursor = session.index;
    // Quiet: the player asked for the chart, not for their cursor back, and
    // closing it returns them to flight where a re-lock delay would strand
    // them with a dead mouse. Escape remains the one thing that arms it.
    INPUT.releaseMouse(input, true);
    play('beep');
  }

  function handleChartInput() {
    if (INPUT.held(input, 'pitchDown')) session.chartCursor = nearestInDirection(0, 1);
    else if (INPUT.held(input, 'pitchUp')) session.chartCursor = nearestInDirection(0, -1);
    if (INPUT.held(input, 'rollLeft')) session.chartCursor = nearestInDirection(-1, 0);
    else if (INPUT.held(input, 'rollRight')) session.chartCursor = nearestInDirection(1, 0);

    if (INPUT.consume(input, 'targetNext')) session.chartCursor = stepSystem(1);
    if (INPUT.consume(input, 'targetPrev')) session.chartCursor = stepSystem(-1);
    if (INPUT.consume(input, 'chart') || INPUT.consume(input, 'dock')
      || INPUT.consume(input, 'leave')) {
      // The key that closed the chart is also the gesture that may take the
      // pointer back. Without this the chart is a one-way door: the only way to
      // fly with the mouse again would be to dock and relaunch.
      setMode(MODE.FLIGHT);
      if (!captureMouse()) showMouseHint();
      play('beep');
    }
    if (INPUT.consume(input, 'jump') || INPUT.consume(input, 'hyperspace')) {
      beginJump(session.chartCursor);
    }
  }

  /** Move the chart cursor to the nearest system in a screen direction. */
  function nearestInDirection(dx, dy) {
    const here = galaxy.systems[session.chartCursor] || session.system;
    let best = session.chartCursor;
    let bestScore = -Infinity;
    for (const s of galaxy.systems) {
      if (s.index === session.chartCursor) continue;
      const vx = s.x - here.x;
      const vy = s.y - here.y;
      const len = Math.hypot(vx, vy) || 1;
      const dot = (vx * dx + vy * dy) / len;
      if (dot < 0.25) continue;
      // Prefer well-aligned and close: a far system directly ahead beats a
      // near one off to the side.
      const score = dot * 2 - len / GALAXY.DISC_RADIUS;
      if (score > bestScore) { bestScore = score; best = s.index; }
    }
    return best;
  }

  /** Next/previous index, skipping nothing - the chart is small enough. */
  function stepSystem(dir) {
    const n = galaxy.systems.length;
    return ((session.chartCursor + dir) % n + n) % n;
  }

  function handleDockedInput() {
    if (INPUT.consume(input, 'dock') || INPUT.consume(input, 'jump')
      || INPUT.consume(input, 'chart') || INPUT.consume(input, 'leave')) {
      undock();
      return;
    }
    // Tab between screens.
    if (INPUT.consume(input, 'throttleUp')) {
      const order = ['market', 'equip', 'contracts', 'status'];
      const i = order.indexOf(stationUi.tab);
      stationUi.setTabPublic(order[(i + 1) % order.length]);
      play('beep');
    }
    if (INPUT.held(input, 'pitchDown')) stationUi.moveSelection(-1);
    if (INPUT.held(input, 'pitchUp')) stationUi.moveSelection(1);
    if (INPUT.held(input, 'rollLeft')) stationUi.moveSelection(-1);
    if (INPUT.held(input, 'rollRight')) stationUi.moveSelection(1);
    if (INPUT.consume(input, 'fire')) stationUi.activate();
    if (INPUT.consume(input, 'missile')) stationUi.activate();
    // One tonne at a time, for when the whole load is the wrong answer.
    if (INPUT.consume(input, 'tradeOne')) stationUi.activateOne();
  }

  let scannerRanges = [2000, 4000, 8000, 16000];
  let scannerIndex = 0;
  function cycleScanner() {
    scannerIndex = (scannerIndex + 1) % scannerRanges.length;
    play('beep');
  }

  function toggleMute() {
    const muted = audio.toggleMute();
    say(muted ? 'Sound off' : 'Sound on');
  }

  // -------------------------------------------------------------------------
  // HUD state assembly
  // -------------------------------------------------------------------------

  /**
   * Build the object `drawHud` consumes.
   *
   * This is the largest piece of translation in the file and the one most worth
   * reading carefully: the HUD was written against a *generic* display model
   * (bars with current and max, contacts in ship-local coordinates) and knows
   * nothing about the player record, the traffic entities or Three.js.
   */
  function hudState() {
    const f = session.flight;
    const fwd = FLIGHT.forwardOf(f);
    const up = FLIGHT.upOf(f);
    const right = FLIGHT.rightOf(f);
    const camPos = { x: f.pos.x, y: f.pos.y, z: f.pos.z };
    const basis = { forward: fwd, up: up, right: right };

    // --- Contacts ---------------------------------------------------------
    // The scanner projects onto the player's own right/forward plane, which is
    // why these have to be computed here rather than in the HUD.
    const contacts = [];
    if (session.traffic) {
      for (const s of session.traffic.ships) {
        if (s.dead) continue;
        const p = s.mesh.position;
        const dx = p.x - f.pos.x, dy = p.y - f.pos.y, dz = p.z - f.pos.z;
        contacts.push({
          forward: dx * fwd.x + dy * fwd.y + dz * fwd.z,
          right: dx * right.x + dy * right.y + dz * right.z,
          up: dx * up.x + dy * up.y + dz * up.z,
          hostile: !!s.hostile,
          kind: s.kind,
          target: s === session.target,
          distance: Math.hypot(dx, dy, dz),
        });
      }
      // The station is the fixed point everything else is judged against.
      const st = session.scene.station.position;
      const sx = st.x - f.pos.x, sy = st.y - f.pos.y, sz = st.z - f.pos.z;
      contacts.push({
        forward: sx * fwd.x + sy * fwd.y + sz * fwd.z,
        right: sx * right.x + sy * right.y + sz * right.z,
        up: sx * up.x + sy * up.y + sz * up.z,
        station: true, kind: 'station',
        distance: Math.hypot(sx, sy, sz),
      });
      // The planet, so it does not surprise you out of the dark.
      const pl = session.scene.planet.position;
      const px = pl.x - f.pos.x, py = pl.y - f.pos.y, pz = pl.z - f.pos.z;
      contacts.push({
        forward: px * fwd.x + py * fwd.y + pz * fwd.z,
        right: px * right.x + py * right.y + pz * right.z,
        up: px * up.x + py * up.y + pz * up.z,
        planet: true, kind: 'planet',
        distance: Math.hypot(px, py, pz),
      });
    }

    // --- Target -----------------------------------------------------------
    let target = null;
    if (session.target && !session.target.dead) {
      const t = session.target;
      target = {
        screen: HUD.projectToScreen(t.mesh.position, camPos, basis, hudW, hudH, RENDER.CAMERA.fov),
        distance: WORLD.dist(t.mesh.position, f.pos),
        hostile: !!t.hostile,
        kind: t.kind,
      };
      // Lead pip: where to aim so the shot and the target arrive together.
      if (target.screen && target.screen.distance > 0) {
        // The laser is hitscan, so the only travel time is the target's own
        // motion over the frame the shot resolves in. Project the target's
        // velocity along the view plane at that range.
        const tti = Math.min(0.35, target.screen.distance / 9000);
        const v = t.velocity || { x: 0, y: 0, z: 0 };
        const lead = HUD.leadPip(
          target.screen,
          {
            x: (v.x * right.x + v.y * right.y + v.z * right.z) * tti,
            y: (v.x * up.x + v.y * up.y + v.z * up.z) * tti,
          },
          tti, 160,
        );
        if (lead) target.lead = lead;
      }
    } else if (session.target && session.target.dead) {
      session.target = null;
    }

    // --- Compass ----------------------------------------------------------
    const compass = [];
    if (session.scene) {
      const st = session.scene.station.position;
      const sx = st.x - f.pos.x, sy = st.y - f.pos.y, sz = st.z - f.pos.z;
      compass.push({
        bearing: Math.atan2(sx * right.x + sy * right.y + sz * right.z,
          sx * fwd.x + sy * fwd.y + sz * fwd.z),
        station: true,
        label: 'STN',
      });
      const pl = session.scene.planet.position;
      const px = pl.x - f.pos.x, py = pl.y - f.pos.y, pz = pl.z - f.pos.z;
      compass.push({
        bearing: Math.atan2(px * right.x + py * right.y + pz * right.z,
          px * fwd.x + py * fwd.y + pz * fwd.z),
        planet: true,
        label: 'PLN',
      });
    }

    // --- Alerts -----------------------------------------------------------
    const alerts = [];
    if (player.fuel < 3) alerts.push({ text: 'LOW FUEL', urgent: true });
    if (player.hull / Math.max(1, player.hullMax) < 0.3) alerts.push({ text: 'HULL CRITICAL', urgent: true });
    if (player.heat >= COMBAT.HEAT_LOCK) alerts.push({ text: 'LASER OVERHEATED', urgent: false });
    if (session.shots.length > 3) alerts.push({ text: 'INCOMING FIRE', urgent: true });
    // A missile outranks everything else on the screen: it is the one thing
    // that cannot be absorbed, and it is the one thing the player can shoot.
    if (session.incoming.length) {
      alerts.push({ text: 'MISSILE INBOUND', urgent: true });
    }
    if ((player.wanted[session.index] || 0) > 0) alerts.push({ text: 'WANTED IN THIS SYSTEM', urgent: false });

    // A contract about to lapse. Only when it is close: a permanent counter
    // would be one more number competing for the same corner of the screen,
    // and the only moment a deadline matters is when it is nearly gone.
    const due = MISSIONS.active(player).filter((c) => MISSIONS.daysLeft(c, player.day) <= 1);
    if (due.length) {
      const soonest = due[0];
      alerts.push({
        text: MISSIONS.daysLeft(soonest, player.day) <= 0
          ? 'CONTRACT DUE TODAY: ' + soonest.targetName
          : 'CONTRACT EXPIRES TOMORROW: ' + soonest.targetName,
        urgent: true,
      });
    }

    const rank = PLAYER.rankOf(player.kills);
    return {
      width: hudW,
      height: hudH,
      time: session.time,
      scannerRange: scannerRanges[scannerIndex],
      radarMode: session.mode === MODE.CHART ? 'chart' : 'radar',
      showChart: session.mode === MODE.CHART,
      speed: FLIGHT.speedOf(f),
      throttle: f.throttle,
      fuel: player.fuel, maxFuel: player.fuelMax,
      shields: player.shields, maxShields: player.shieldMax,
      energy: player.energy, maxEnergy: player.energyMax,
      hull: player.hull, maxHull: player.hullMax,
      heat: player.heat, maxHeat: COMBAT.HEAT_MAX,
      missiles: player.missiles,
      laser: player.laserType,
      laserHot: player.heat >= COMBAT.HEAT_LOCK,
      cash: player.cash,
      rank: rank,
      cargoUsed: PLAYER.cargoUsed(player),
      cargoMax: PLAYER.holdMaxOf(player),
      contacts: contacts,
      compass: compass,
      target: target,
      messages: messages,
      alerts: alerts,
      damage: session.hits.map((h) => ({
        bearing: h.bearing, age: h.age, life: HUD.HUD_LAYOUT.damageArcLifetime,
      })),
      docking: session.mode === MODE.FLIGHT ? session.dockingVerdict : null,
      chart: session.mode === MODE.CHART ? chartState() : null,
    };
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  let hudW = 0;
  let hudH = 0;
  let lastTime = 0;

  function update(dt) {
    session.time += dt;
    session.modeTime += dt;

    // Age messages in every mode *except the title*.
    //
    // The original reason for ageing them everywhere was right for menus: if
    // they only aged in flight, docking and undocking would make a line jump
    // its whole lifetime in one frame. But the title screen is not a pause in
    // the game, it is the time *before* it - a new commander reads the controls
    // there for as long as they like, and every message said at boot ("Arrived:
    // Lave", the greeting, the rumour) expired while they read. Measured: after
    // ten seconds on the title the log held **zero** entries, so the player
    // launched into space with nothing but "Undocked from Lave Station".
    if (session.mode !== MODE.TITLE) {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        messages[i].age = (messages[i].age || 0) + dt;
        if (messages[i].age > HUD.HUD_LAYOUT.messageLifetime) messages.splice(i, 1);
      }
    }

    // Heat, energy and shields recover in every mode except death - a docked
    // ship should be cooling down, not staying hot because time is paused.
    if (session.mode !== MODE.DEAD) {
      COMBAT.tickHeat(player, dt);
      COMBAT.regenEnergy(player, dt);
      session.sinceDamage += dt;
      COMBAT.regenShields(player, dt, session.sinceDamage);
      session.shotCooldown = Math.max(0, session.shotCooldown - dt);
    }

    switch (session.mode) {
      case MODE.FLIGHT: updateFlight(dt); break;
      case MODE.CHART: handleChartInput(); break;
      case MODE.DOCKED: handleDockedInput(); break;
      case MODE.HYPERSPACE: updateHyperspace(); break;
      case MODE.TITLE: updateTitle(); break;
      case MODE.DEAD: updateDead(); break;
      default: break;
    }

    // The station's engine drone should not be audible, so this is explicit.
    audio.setEngine(session.mode === MODE.FLIGHT ? session.flight.throttle : 0,
      session.mode === MODE.FLIGHT ? !!session.flight.boost : false);

    INPUT.endFrame(input, dt);
  }

  function updateTitle() {
    // The title screen is a live 3D view of the station you start at, because
    // a static logo does not sell a game about flying. Slowly orbit the camera.
    if (!session.scene) return;
    const st = session.scene.station.position;
    const a = session.modeTime * 0.12;
    const r = WORLD.LAYOUT.stationRadius * 3.2;
    renderer.camera.position.set(
      st.x + Math.cos(a) * r,
      st.y + WORLD.LAYOUT.stationRadius * 1.1,
      st.z + Math.sin(a) * r,
    );
    renderer.camera.lookAt(st.x, st.y, st.z);

    // Until the launch key is handled below, the cursor is the player's. A
    // frame that takes it earlier than the keypress both loses the gesture the
    // browser demands and leaves the click that *would* count falling on a
    // screen that claimed it was busy capturing.
    if (INPUT.consume(input, 'fire') || INPUT.consume(input, 'dock')) {
      armAudio();
      undock();
      return;
    }
    if (INPUT.consume(input, 'throttleUp')) {
      // A new career wipes the save. Deliberate: it is the only destructive
      // action in the game and it should take an explicit keypress.
      player = PLAYER.create({ name: player.name });
      enterSystem(0, 'station');
      say('New career started', HUD.HUD_COLOURS.warn);
    }
  }

  function updateDead() {
    if (INPUT.consume(input, 'fire')) {
      // Respawn at the last station you docked at, keeping the career.
      player.hull = player.hullMax;
      player.shields = player.shieldMax;
      player.energy = player.energyMax;
      player.fuel = Math.max(player.fuel, 4);
      player.cargo = {};
      enterSystem(player.dockedAt === null ? 0 : player.dockedAt, 'station');
      session.grace = ARRIVAL_GRACE;
      setMode(MODE.FLIGHT);
      // Death released the pointer, and this keypress is the gesture that can
      // take it back. Without this the player is resurrected into a ship they
      // can only fly with the keyboard, with no explanation.
      if (!captureMouse()) showMouseHint();
      say('Insurance claim processed. Ship replaced.', HUD.HUD_COLOURS.inkDim);
    }
  }

  function updateHyperspace() {
    // Ramp the tunnel effect, then hand over. No input is accepted during the
    // jump: the ship is in witchspace and the player has no flying to do.
    if (session.modeTime >= HYPERSPACE_DURATION) completeJump();
  }

  function updateFlight(dt) {
    if (session.grace > 0) session.grace = Math.max(0, session.grace - dt);
    handleFlightInput(dt);

    // --- Traffic ----------------------------------------------------------
    session.lastTrafficTopUp += dt;
    if (session.lastTrafficTopUp >= TRAFFIC_INTERVAL) {
      session.lastTrafficTopUp = 0;
      session.traffic.topUp();
      session.traffic.prune();
    }
    WORLD.stepTraffic(session.traffic, {
      vel: session.flight.vel,
      shields: player.shields,
      hull: player.hull,
      // "Weapons are hot the instant you drop in." A commander who is Hunted
      // by the owning faction, or wanted in this system by name, is met by
      // patrols that do not wait to be provoked. The tier table has promised
      // this since it was written; nothing read it until now.
      hostilePatrols: REP.patrolHostile(player, session.system),
    }, session.flight.pos, dt, {
      onEnemyShot: onEnemyShot,
      onEnemyMissile: onEnemyMissile,
    });

    stepEnemyShots();
    stepMissiles(dt);
    stepIncoming(dt);
    stepEffects(dt);
    dust.step(session.flight);

    // --- Station and docking ---------------------------------------------
    WORLD.spinStation(session.scene.station, dt);
    session.dockingVerdict = checkDocking();

    // Auto-dock.
    //
    // A green verdict is already a complete authorisation: `checkDocking`
    // independently verifies range, closing speed, lateral alignment *and*
    // attitude. Requiring an extra proximity gate on top of that (the first
    // version demanded `distance < clearance`, 62 units, where a valid
    // approach typically sits at 70-230) made docking a fiddly business of
    // creeping in centimetres at a time - the opposite of the brief.
    //
    // So: any clean verdict docks. The manual D key remains for players who
    // want to trigger it at a distance the automatic pass has not reached yet.
    // The grace period also blocks docking. On a hyperspace arrival the ship
    // materialises stationary on the slot axis, which is *already* a valid
    // docking state - so without this you would be re-docked before the arrival
    // message had finished fading, and the docking procedure (the best part of
    // Elite) would never be played. The grace window is the player's chance to
    // take the controls and fly in.
    const v = session.dockingVerdict;
    if (v && v.ok && session.grace <= 0) {
      dock();
      return;
    }

    // --- Collisions -------------------------------------------------------
    if (session.impactCooldown > 0) session.impactCooldown = Math.max(0, session.impactCooldown - dt);
    checkCollisions(dt);

  }

  /**
   * Collisions.
   *
   * Asteroid and station impacts pierce shields - a shield saving you from
   * your own bad flying would make the rocks decorative.
   */
  /**
   * Is this position inside the station's docking corridor?
   *
   * The corridor is the cylinder of space directly in front of the slot, wide
   * enough to fly a Cobra through. It exists so the collision sphere can be
   * generous everywhere *except* where the player is meant to be.
   */
  function insideDockingCorridor(station, pos) {
    const ud = station.userData;
    if (!ud || !ud.slotNormalLocal || !ud.slotPointLocal) return false;
    const q = station.quaternion;
    const n = ud.slotNormalLocal;
    const p = ud.slotPointLocal;
    // World-space offset from the slot point to the ship.
    const dx = pos.x - station.position.x;
    const dy = pos.y - station.position.y;
    const dz = pos.z - station.position.z;
    // Rotate the local normal into world space.
    const nx = n.x * (1 - 2 * (q.y * q.y + q.z * q.z)) + n.y * 2 * (q.x * q.y - q.w * q.z) + n.z * 2 * (q.x * q.z + q.w * q.y);
    const ny = n.x * 2 * (q.x * q.y + q.w * q.z) + n.y * (1 - 2 * (q.x * q.x + q.z * q.z)) + n.z * 2 * (q.y * q.z - q.w * q.x);
    const nz = n.x * 2 * (q.x * q.z - q.w * q.y) + n.y * 2 * (q.y * q.z + q.w * q.x) + n.z * (1 - 2 * (q.x * q.x + q.y * q.y));
    // Along the axis: positive means we are on the outside of the slot face.
    const along = dx * nx + dy * ny + dz * nz;
    if (along < -30 || along > WORLD.DOCKING.maxDistance) return false;
    // Lateral distance from the axis.
    const lx = dx - nx * along;
    const ly = dy - ny * along;
    const lz = dz - nz * along;
    const lateral = Math.hypot(lx, ly, lz);
    return lateral < WORLD.DOCKING.maxOffset + 18;
  }

  function checkCollisions(dt) {
    const f = session.flight;
    // Impact cooldown.
    //
    // This is the single most important line in the function. Without it, a
    // ship that comes to rest inside a collider is damaged *every frame* -
    // 24 points at 60 Hz is 1,440 damage per second, so a player who clips the
    // station dies before they can back off, and the death looks like a crash
    // rather than a collision. The cooldown turns a continuous overlap into a
    // discrete impact, which is what the fiction describes.
    if (session.impactCooldown > 0) return;

    // --- Station ---------------------------------------------------------
    // A Coriolis is a hollow shell with the docking slot in the middle of one
    // face, so the collision sphere is deliberately *smaller* than the hull it
    // represents. Using the full radius would make the approach corridor
    // itself lethal, and docking would be impossible without taking damage.
    const st = session.scene.station;
    const stationRadius = (st.userData.radius || WORLD.LAYOUT.stationRadius) * 0.62;
    const ds = WORLD.dist(f.pos, st.position);
    // The docking slot is a hole. A Coriolis is a hollow shell, so a ship
    // lining up on the slot axis is legitimately *inside* the collision sphere
    // and must come to no harm - otherwise the collision check and the docking
    // check fight each other and docking is impossible at close range.
    //
    // The corridor is modelled as the docking guide does: a lateral offset
    // from the slot axis smaller than `maxOffset`, and in front of the slot
    // face. Inside it, collisions are suppressed.
    if (ds < stationRadius && !insideDockingCorridor(st, f.pos)) {
      // Only a real impact hurts. Drifting in the station's vicinity at a
      // crawl is a scrape, not a breach.
      const speed = FLIGHT.speedOf(f);
      const damage = Math.min(30, 6 + speed * 0.11);
      hurtPlayer(damage, { pierce: true });
      noteHit(st.position);
      // Push out along the surface normal so we do not stick inside.
      const n = {
        x: (f.pos.x - st.position.x) / (ds || 1),
        y: (f.pos.y - st.position.y) / (ds || 1),
        z: (f.pos.z - st.position.z) / (ds || 1),
      };
      f.pos.x = st.position.x + n.x * (stationRadius + 2);
      f.pos.y = st.position.y + n.y * (stationRadius + 2);
      f.pos.z = st.position.z + n.z * (stationRadius + 2);
      // Bounce off rather than passing through, and kill most of the speed so
      // the player is not punished twice for the same mistake.
      f.vel.x *= -0.25; f.vel.y *= -0.25; f.vel.z *= -0.25;
      session.impactCooldown = 1.1;
      say('Impact with ' + session.system.name + ' Station', HUD.HUD_COLOURS.danger);
      return;
    }

    // --- Asteroids, cargo and capsules -----------------------------------
    for (const s of session.traffic.ships) {
      if (s.dead) continue;
      if (s.kind !== 'asteroid' && s.kind !== 'canister' && s.kind !== 'capsule') continue;
      const radius = WORLD.entityRadius(s) + 3;
      const d = WORLD.dist(f.pos, s.mesh.position);
      if (d >= radius) continue;
      if (s.kind === 'asteroid') {
        // Rock damage scales with how hard you hit it - a slow bump is a
        // scratch, a full-throttle ram is a serious accident.
        const speed = FLIGHT.speedOf(f);
        const damage = Math.min(34, speed * 0.13);
        if (damage < 2) continue;      // resting against a rock is not an event
        hurtPlayer(damage, { pierce: true });
        noteHit(s.mesh.position);
        // Push out so the rock does not grind the hull away over the next
        // hundred frames.
        const n = {
          x: (f.pos.x - s.mesh.position.x) / (d || 1),
          y: (f.pos.y - s.mesh.position.y) / (d || 1),
          z: (f.pos.z - s.mesh.position.z) / (d || 1),
        };
        const push = radius + 2;
        f.pos.x = s.mesh.position.x + n.x * push;
        f.pos.y = s.mesh.position.y + n.y * push;
        f.pos.z = s.mesh.position.z + n.z * push;
        f.vel.x *= -0.2; f.vel.y *= -0.2; f.vel.z *= -0.2;
        session.impactCooldown = 0.9;
        say('Asteroid impact', HUD.HUD_COLOURS.danger);
        return;
      }
      // Cargo and capsules are scooped, not collided with. A failed scoop
      // (no room, no scoop fitted) must not impose a cooldown or the player
      // passes straight through the canister they were trying to collect.
      scoop(s);
      if (s.dead) return;
    }
  }

  /** Collect a floating canister or capsule. */
  function scoop(entity) {
    if (entity.kind === 'capsule') {
      // A capsule is a person. Scooping one is a good deed with a reward.
      player.cash += 250;
      say('Escape capsule recovered: 250 CR reward', HUD.HUD_COLOURS.ok);
    } else if (entity.cargo) {
      // You need a fuel scoop to take cargo off a wreck.
      if (!PLAYER.hasEquipment(player, 'scoop')) {
        say('Fuel scoop required to recover cargo', HUD.HUD_COLOURS.warn);
        play('deny');
        return;
      }
      const got = PLAYER.addCargo(player, entity.cargo, 1);
      if (got > 0) {
        const com = ECONOMY.commodityById(entity.cargo);
        say('Scooped 1 t of ' + (com ? com.name : entity.cargo), HUD.HUD_COLOURS.ok);
        play('scoop');
      } else {
        say('Cargo hold full', HUD.HUD_COLOURS.warn);
        play('deny');
        return;
      }
    } else {
      return;
    }
    renderer.scene.remove(entity.mesh);
    disposeTree(entity.mesh);
    entity.dead = true;
  }

  /** Play a cue if audio is available. Rate-limited inside the audio module. */
  function play(name, volume, rate) {
    if (!audioArmed) return;
    try { audio.play(name, volume, rate); } catch (err) { /* no audio: ignore */ }
  }

  // -------------------------------------------------------------------------
  // Frame drawing
  // -------------------------------------------------------------------------

  /**
   * The mouse hint over the flight view.
   *
   * Three states, and it is worth being explicit about why there are three
   * rather than one. A player whose pointer is captured needs no instructions.
   * A player who just lost the pointer - Escape, or the browser taking it back
   * - needs telling, and needs it to *stay* until they act, because they are
   * now holding a keyboard they did not choose. A player flying without ever
   * having had it - a trackpad, a browser that refused, a click that missed -
   * needs the same sentence but without the accusation that they lost
   * something, and only for as long as it takes to read.
   *
   * The two cases are told apart by `mouseUI.released` rather than by the
   * re-lock cooldown. The cooldown is 1.4 seconds long, and it is there to stop
   * the game grabbing the pointer straight back - it says nothing about how
   * long the player needs the instructions.
   */
  function drawMouseHint(ctx) {
    if (session.mode !== MODE.FLIGHT) return;
    if (INPUT.mouseActive(input)) return;
    const released = mouseUI.released;
    if (!released && session.time >= mouseUI.hintUntil) return;

    const text = INPUT.lockRefused(input)
      ? HUD.MOUSE_HINT.refused
      : (released ? HUD.MOUSE_HINT.manual : HUD.MOUSE_HINT.capture);
    const k = HUD.hudScale(hudH);
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = (13 * k) + 'px "SF Mono", Consolas, monospace';
    // Outlined rather than plated: like the message log, this line lands over
    // whatever happens to be in the bottom of the view, which is often a lit
    // station wall.
    ctx.strokeStyle = HUD.HUD_COLOURS.plate;
    ctx.lineWidth = 3;
    ctx.strokeText(text, hudW / 2, hudH - 42 * k);
    ctx.fillStyle = HUD.HUD_COLOURS.ok;
    ctx.fillText(text, hudW / 2, hudH - 42 * k);
    ctx.restore();
  }

  function draw() {
    const state = hudState();
    hudCtx.clearRect(0, 0, hudW, hudH);

    // Which overlay this mode wants is `hudOverlayFor`'s decision, not this
    // chain's: a fall-through here is how the flight HUD ended up drawn behind
    // the station screen.
    const overlay = HUD.hudOverlayFor(session.mode);
    if (overlay === 'title') {
      drawTitle(hudCtx);
    } else if (overlay === 'death') {
      drawDeath(hudCtx);
    } else if (overlay === 'hyperspace') {
      drawHyperspace(hudCtx);
    } else if (overlay === 'flight') {
      HUD.drawHud(hudCtx, state);
      if (session.mode === MODE.FLIGHT) HUD.drawDockingGuide(hudCtx, state);
      drawTracers(hudCtx);
      drawMouseHint(hudCtx);
    }
    // 'none' - the station screen is a full-page overlay with its own status
    // readout, and nothing belongs behind it.
  }

  /**
   * CSS colour strings for tracers, cached by the hex they come from.
   *
   * `drawTracers` runs inside the frame, and building a `THREE.Color` per
   * tracer per frame was pure waste: the palette has exactly two entries
   * (`LASERS.pulse` and `LASERS.beam`), and the conversion to a hex string is
   * deterministic. Two entries, looked up forever.
   */
  const tracerColours = new Map();
  function tracerColour(hex) {
    let css = tracerColours.get(hex);
    if (css === undefined) {
      css = '#' + new THREE.Color(hex).getHexString();
      tracerColours.set(hex, css);
    }
    return css;
  }

  function drawTracers(ctx) {
    if (!session.tracers.length) return;
    const f = session.flight;
    const fwd = FLIGHT.forwardOf(f);
    const up = FLIGHT.upOf(f);
    const right = FLIGHT.rightOf(f);
    const basis = { forward: fwd, up: up, right: right };
    const camPos = { x: f.pos.x, y: f.pos.y, z: f.pos.z };
    ctx.save();
    for (const t of session.tracers) {
      const a = HUD.projectToScreen(t.from, camPos, basis, hudW, hudH, RENDER.CAMERA.fov);
      const b = HUD.projectToScreen(t.to, camPos, basis, hudW, hudH, RENDER.CAMERA.fov);
      if (!a || !b) continue;
      ctx.globalAlpha = Math.max(0, t.life / t.maxLife);
      ctx.strokeStyle = tracerColour(t.colour);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function drawTitle(ctx) {
    const cx = hudW / 2;
    const cy = hudH / 2;
    // The title screen is the first thing a player reads, and it is drawn at
    // fixed pixel sizes - so on a large display the controls are the smallest
    // text in the game at the moment they matter most.
    const k = HUD.hudScale(hudH);
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // A soft dark plate so the title reads over the rotating station.
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(hudW, hudH) * 0.6);
    grad.addColorStop(0, 'rgba(2,4,10,0.86)');
    grad.addColorStop(1, 'rgba(2,4,10,0.15)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, hudW, hudH);

    ctx.fillStyle = HUD.HUD_COLOURS.ink;
    ctx.font = 'bold ' + (54 * k) + 'px "SF Mono", Consolas, monospace';
    ctx.fillText('ELITE', cx, cy - 90 * k);
    ctx.fillStyle = HUD.HUD_COLOURS.inkDim;
    ctx.font = (20 * k) + 'px "SF Mono", Consolas, monospace';
    ctx.fillText('D E E P   S P A C E', cx, cy - 42 * k);

    const rank = PLAYER.rankOf(player.kills);
    ctx.fillStyle = HUD.HUD_COLOURS.warn;
    ctx.font = (16 * k) + 'px "SF Mono", Consolas, monospace';
    ctx.fillText('Commander ' + player.name + '  -  ' + String(rank).toUpperCase(), cx, cy + 10 * k);
    ctx.fillStyle = HUD.HUD_COLOURS.inkDim;
    ctx.font = (14 * k) + 'px "SF Mono", Consolas, monospace';
    ctx.fillText(player.cash.toFixed(1) + ' CR  -  '
      + HUD.countOf(session.visitedCount, 'system') + ' visited',
    cx, cy + 36 * k);

    // The launch prompt blinks, but the duty cycle is deliberately generous:
    // an even on/off split means a third of players look at the screen during
    // the dark half and see nothing telling them what to press.
    const blink = Math.sin(session.time * 3) > -0.75;
    if (blink) {
      ctx.fillStyle = HUD.HUD_COLOURS.ok;
      ctx.font = (18 * k) + 'px "SF Mono", Consolas, monospace';
      ctx.fillText('PRESS  M  TO LAUNCH', cx, cy + 92 * k);
    }
    ctx.fillStyle = HUD.HUD_COLOURS.inkDim;
    ctx.font = (13 * k) + 'px "SF Mono", Consolas, monospace';
    ctx.fillText(HUD.TITLE_CONTROLS[0], cx, cy + 132 * k);
    ctx.fillText(HUD.TITLE_CONTROLS[1], cx, cy + 154 * k);
    ctx.fillText('Press  R  at the title to start a new career (erases the save)',
      cx, cy + 184 * k);
    // The keyboard table above says nothing about the mouse, and the mouse is
    // the control most players reach for first. Shown only while the pointer is
    // free: once it is captured the line has been acted on and repeating it
    // would be one more thing competing with the station view.
    if (!INPUT.mouseActive(input)) {
      ctx.fillStyle = HUD.HUD_COLOURS.ok;
      ctx.fillText(HUD.MOUSE_HINT.capture, cx, cy + 212 * k);
    }
    ctx.restore();
  }

  function drawDeath(ctx) {
    ctx.save();
    ctx.fillStyle = 'rgba(40,4,4,0.72)';
    ctx.fillRect(0, 0, hudW, hudH);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = HUD.HUD_COLOURS.danger;
    ctx.font = 'bold 44px "SF Mono", Consolas, monospace';
    ctx.fillText('SHIP LOST', hudW / 2, hudH / 2 - 30);
    ctx.fillStyle = HUD.HUD_COLOURS.ink;
    ctx.font = '16px "SF Mono", Consolas, monospace';
    ctx.fillText('Commander ' + player.name + '  -  ' + String(PLAYER.rankOf(player.kills)).toUpperCase()
      + '  -  ' + HUD.countOf(player.kills, 'kill'), hudW / 2, hudH / 2 + 20);
    ctx.fillStyle = HUD.HUD_COLOURS.warn;
    ctx.fillText('Press  M  to be rescued at your last station', hudW / 2, hudH / 2 + 60);
    // The rescue launches straight into flight, so this is where the player
    // learns that the mouse comes back with the ship.
    if (!INPUT.mouseActive(input)) {
      ctx.fillStyle = HUD.HUD_COLOURS.inkDim;
      ctx.font = '13px "SF Mono", Consolas, monospace';
      ctx.fillText(HUD.MOUSE_HINT.capture, hudW / 2, hudH / 2 + 92);
    }
    ctx.restore();
  }

  function drawHyperspace(ctx) {
    // The tunnel: a ring of light that collapses to a point and flashes. It is
    // drawn on the *HUD* canvas rather than in 3D so it costs nothing and can
    // never fail to cover the screen.
    const t = Math.min(1, session.modeTime / HYPERSPACE_DURATION);
    const cx = hudW / 2;
    const cy = hudH / 2;
    const ease = t * t;      // accelerate into the jump
    ctx.save();
    ctx.fillStyle = 'rgba(2,3,10,' + (0.35 + ease * 0.65).toFixed(3) + ')';
    ctx.fillRect(0, 0, hudW, hudH);

    // Radial streaks.
    ctx.strokeStyle = 'rgba(159,232,255,' + (0.55 * (1 - t)).toFixed(3) + ')';
    ctx.lineWidth = 1.4;
    const count = 72;
    for (let i = 0; i < count; i += 1) {
      const a = (i / count) * Math.PI * 2 + session.time * 0.4;
      const inner = 40 + ease * 320;
      const outer = inner + 90 + ease * 700;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
      ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
      ctx.stroke();
    }

    ctx.fillStyle = 'rgba(232,246,255,' + (ease * ease).toFixed(3) + ')';
    ctx.fillRect(0, 0, hudW, hudH);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = HUD.HUD_COLOURS.inkDim;
    ctx.font = '16px "SF Mono", Consolas, monospace';
    ctx.fillText('WITCHSPACE', cx, hudH * 0.16);
    const target = session.jumpTarget === null ? null : galaxy.systems[session.jumpTarget];
    if (target) {
      ctx.fillStyle = HUD.HUD_COLOURS.ok;
      ctx.font = '20px "SF Mono", Consolas, monospace';
      ctx.fillText('-> ' + target.name, cx, hudH * 0.22);
    }
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Resize and the main loop
  // -------------------------------------------------------------------------

  function resize() {
    const w = (typeof window !== 'undefined' ? window.innerWidth : 1280);
    const h = (typeof window !== 'undefined' ? window.innerHeight : 720);
    hudW = w; hudH = h;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    hudCanvas.width = w;
    hudCanvas.height = h;
    hudCanvas.style.width = w + 'px';
    hudCanvas.style.height = h + 'px';
    renderer.resize(w, h);
  }

  let running = true;
  let rafId = null;

  function frame(now) {
    if (!running) return;
    const time = (now || 0) / 1000;
    if (!lastTime) lastTime = time;
    // Clamp the delta: a tab that was backgrounded for a minute would
    // otherwise teleport the ship through the station on the first frame back.
    let dt = Math.min(0.1, Math.max(0, time - lastTime));
    lastTime = time;
    if (dt === 0) dt = 1 / 60;

    update(dt);
    renderer.render(session.flight, time, dt);
    draw();

    if (typeof window !== 'undefined' && window.requestAnimationFrame) {
      rafId = window.requestAnimationFrame(frame);
    }
  }

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------

  enterSystem(player.currentSystem || 0, 'station');
  session.lastRankName = PLAYER.rankOf(player.kills);

  // Build the jump graph now rather than lazily on the first chart open. It is
  // a single O(n^2) pass over 64 systems (2,016 comparisons, well under a
  // millisecond) and paying for it at boot means the first `O` keypress is
  // instant instead of hitching.
  session.chartLinks = buildChartLinks();
  log(`chart: ${session.chartLinks.length} jump routes`);

  // The first system the player sees is their last save's system; arriving
  // "at the station" means the title screen has something to orbit.
  setMode(player.dockedAt !== null ? MODE.DOCKED : MODE.TITLE);
  if (session.mode === MODE.DOCKED) stationUi.open(stationState());

  resize();

  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('resize', resize);
  }
  // Any key or click on the title arms the audio context, because browsers only
  // allow it from a gesture and the title screen is the only guaranteed one.
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('keydown', armAudio, { once: true });
    window.addEventListener('mousedown', armAudio, { once: true });
  }

  log(`ready: ${session.system.name}, mode=${session.mode}, ${messages.length} messages`);

  // In a headless run there is no rAF, so the caller drives `step` instead.
  let loopStarted = false;
  function start() {
    if (loopStarted) return;
    loopStarted = true;
    if (typeof window !== 'undefined' && window.requestAnimationFrame) {
      rafId = window.requestAnimationFrame(frame);
    }
  }

  /**
   * The whole API the host gets. Kept small on purpose: `step` is what the
   * e2e test drives, and everything else is for a human poking at it in a
   * console.
   */
  return {
    // Host control.
    start: start,
    stop() { running = false; if (rafId) cancelAnimationFrame(rafId); },
    resize: resize,
    /**
     * Advance one frame with an explicit delta. Used by tests and the e2e run.
     *
     * `options.render` may be set to `false` to simulate without drawing. The
     * simulation is identical either way - only the GPU work is skipped - so a
     * soak test that is looking for a leak or a NaN can run thousands of frames
     * in the time a few drawn ones would take. Drawing is the default because a
     * caller asking for a frame almost always wants to see it.
     */
    step(dt, time, options) {
      const delta = typeof dt === 'number' ? dt : 1 / 60;
      const t = typeof time === 'number' ? time : session.time + delta;
      const drawFrame = !options || options.render !== false;
      session.time = t - delta;
      update(delta);
      if (drawFrame) {
        renderer.render(session.flight, t, delta);
        draw();
      }
    },

    // Inspection.
    get mode() { return session.mode; },
    get system() { return session.system; },
    get galaxy() { return galaxy; },
    get player() { return player; },
    get session() { return session; },
    get renderer() { return renderer; },
    get messages() { return messages; },
    get ui() { return stationUi; },

    // Direct actions, so a human (or a test) can drive the game without keys.
    enterSystem: enterSystem,
    undock: undock,
    dock: dock,
    jumpTo(i) { return beginJump(i); },
    canJump: canJump,
    setMode: setMode,
    say: say,
    save: saveGame,
    load() {
      const p = loadGame();
      if (p) player = p;
      return !!p;
    },
    marketRows: marketRows,
    stationState: stationState,
    chartState: chartState,
    hudState: hudState,
    /**
     * Take a contract from the current station's board, by id.
     *
     * The same function the station screen calls when the commander presses
     * Enter on a row, so a driver exercises the real path - including the
     * defended pocket the contract raises - rather than reimplementing it.
     */
    acceptContract(id) { return stationActions().acceptContract(id); },

    // The combat entry points, exposed under their own names so a driver can
    // exercise the *real* hit resolution rather than reimplementing it. These
    // are the same functions the trigger calls; there is no test-only branch.
    fireLaser: fireLaser,
    hurt: hurtPlayer,
    /** Point the ship's nose along a world-space direction. */
    faceToward(dir) { return FLIGHT.faceToward(session.flight, dir); },
    cycleTarget: cycleTarget,
    launchMissile: launchMissile,
    /** Resolve a direct hit, exactly as a laser strike would. */
    strike(entity, damage) {
      onPlayerHit(entity, damage, { x: 0, y: 0, z: 0 });
      return !!(entity && entity.dead);
    },

    /**
     * The element the pointer is locked to, and the input state behind it.
     *
     * A driver cannot otherwise tell a request that was refused from one that
     * was never made, and those two failures need opposite fixes. Reading the
     * game's own state is the only way to tell them apart.
     */
    debugPointer() {
      return {
        target: input.pointerTarget,
        sameAs: (el) => el === input.pointerTarget,
        lockFailures: input.lockFailures,
        relockIn: input.relockIn,
        locked: input.pointerLocked,
        mouseEnabled: input.mouseEnabled,
      };
    },

    /**
     * Give the pointer back, the way Escape does.
     *
     * A driver needs this to test the *re-acquisition* path: the game is
     * correct to refuse a request while it already holds the lock, so a check
     * that wants to see a request has to start from a state where it does not.
     * Reaching into `INPUT.releaseMouse` is the only way to get there without a
     * real Escape, and it arms the same cooldown a real Escape would - which is
     * itself the behaviour under test.
     */
    releasePointer() {
      INPUT.releaseMouse(input);
      return this.debugPointer();
    },
  };
}

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

/** The boot log the e2e test reads back. */
function bootLog() {
  let log;
  if (typeof globalThis !== 'undefined' && globalThis.__ELITE_BOOT_LOG__) {
    log = globalThis.__ELITE_BOOT_LOG__;
  } else {
    log = [];
    if (typeof globalThis !== 'undefined') globalThis.__ELITE_BOOT_LOG__ = log;
  }
  return function push(line) { log.push(String(line)); };
}

/**
 * Inject the small amount of CSS the game needs.
 *
 * Deliberately a string rather than a stylesheet file: this project builds to
 * a single self-contained HTML document, and a `<link>` to a file that does
 * not exist in the bundle is the classic way that goal gets quietly broken.
 */
function injectCss(host, canvas, hudCanvas) {
  if (typeof document === 'undefined') return;
  const id = 'elite-deep-css';
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = STATION_CSS + `
#app { position: fixed; inset: 0; overflow: hidden; background: #02030a; cursor: crosshair; }
#elite-world, #elite-hud { position: absolute; left: 0; top: 0; display: block; }
#elite-world { z-index: 1; }
#elite-hud { z-index: 2; pointer-events: none; }
.elite-screen { z-index: 30; }
.elite-msg { z-index: 40; }
`;
  document.head.appendChild(style);
  void canvas; void hudCanvas;
}

// ---------------------------------------------------------------------------
// Auto-boot
// ---------------------------------------------------------------------------

// Started by index.html. Guarded so importing this module in a test does not
// try to touch the DOM.
if (typeof document !== 'undefined' && document.getElementById && !globalThis.__ELITE_NO_AUTOBOOT__) {
  const ready = () => {
    const app = document.getElementById('app');
    if (!app) return;
    try {
      const game = boot(app);
      globalThis.__ELITE_GAME__ = game;
      game.start();
    } catch (err) {
      // A boot failure must be visible rather than a blank screen.
      const pre = document.createElement('pre');
      pre.style.cssText = 'color:#ff6a5a;padding:24px;font:13px Consolas,monospace;white-space:pre-wrap';
      pre.textContent = 'ELITE: DEEP SPACE failed to start.\n\n' + (err && err.stack ? err.stack : String(err));
      app.appendChild(pre);
      if (globalThis.__ELITE_BOOT_LOG__) globalThis.__ELITE_BOOT_LOG__.push('boot failed: ' + err);
      throw err;
    }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ready);
  } else {
    ready();
  }
}
