/**
 * World: everything that exists in a star system besides the player.
 *
 * The design constraint that shapes this whole file is **scale**. Real space
 * is empty; a game needs things to fly toward. So distances are compressed
 * hard - a planet sits ~1800 units from the station, not 1.5 million km - and
 * sizes are deliberately exaggerated so a planet still reads as a disc from
 * the station. Every constant below is chosen for how it *looks*, not for
 * physical plausibility.
 *
 * Entity layout in a system (local coordinates, station at the origin):
 *
 *      station (0,0,0)          <- you always arrive here
 *      planet  (~1800 out)      <- a big sphere, mostly scenery to fly past
 *      star    (~9000 out)      <- pure backdrop; you cannot reach it
 *      asteroid belt (2200-3400) <- cover; solid, ramming one hurts, and the
 *                                     ore can be shot out of a rock with a laser.
 *      wormhole / sun glare     <- hazard zone, hostile traffic
 *
 * Traffic spawns procedurally in a shell around the station and despawns when
 * it drifts too far, so the player is never alone but never overrun.
 */
import * as THREE from 'three';
import * as R from '../logic/rng.js';
import * as F from '../logic/factions.js';
import * as C from '../logic/combat.js';
import { makeShip, makeCoriolis, makeAsteroid, makeCanister, makeCapsule, EDGE_COLOUR, FLAME } from './models.js';
import { disposeTree } from './dispose.js';

/** How far out things sit. All in world units. */
export const LAYOUT = {
  stationRadius: 150,
  planetDistance: 1800,
  planetRadius: 520,      // exaggerated: reads as a disc from the station
  starDistance: 9000,
  starRadius: 1400,       // pure backdrop, not reachable in a session
  beltInner: 2200,
  beltOuter: 3400,
  beltRocks: 90,
  beltRockRadius: 34,     // there are 90 of them; keep them affordable
  spawnShellInner: 420,
  spawnShellOuter: 1100,
  despawnDistance: 2600,
  trafficTarget: 7,       // systems in "safe" space feel populated
};

/**
 * A cleanup contract turns its target system into a defended pocket.
 *
 * The contract layer reports how many pirates are still owed there
 * (`MISSIONS.bountyPressure`); this is what the traffic layer does with that
 * number. Two levers, and both are chosen because they are *visible*:
 *
 *   maxExtra   - the pocket keeps this many hostiles of its own on top of the
 *                ordinary traffic, and keeps a floor of that many, so a calm
 *                system's spawn table - mostly traders - cannot quietly starve
 *                the contract. The floor is what makes a job completable in
 *                one visit: kill them and they are replaced until the count is
 *                met, which is also how the 1984 original behaved.
 *   spawnOuter - the pocket spawns in the inner part of the shell. They are
 *                waiting for the commander rather than scattered to the edge
 *                of the system, which is what makes a contract read as an
 *                event on launch instead of a chore.
 *
 * `maxExtra` is the largest contract the board ever posts (`MISSION
 * .bountyCount`), so the pocket is never bigger than the job. A test pins the
 * two constants together, because a pocket smaller than the job would make the
 * largest contracts take more than one visit for no stated reason.
 *
 * Deliberately *not* here: an aggression boost. Hostiles already spawn with
 * aggression above the fight threshold, so raising it further would be a
 * tunable that changes nothing - the "flag nobody sets" shape this project has
 * been bitten by twice already. A knob that cannot move the picture is worse
 * than no knob, because it reads as a mechanic.
 */
export const POCKET = {
  maxExtra: 6,
  spawnOuter: 760,
};

/** The player's ship is a Cobra in spirit. These are the world-space sizes. */
export const SHIP_SCALE = {
  pirate: 9, raider: 11, viper: 12, trader: 16, asteroid: 1, canister: 1,
};

/**
 * How NPCs behave under pressure.
 *
 * Two behaviours, both of which were missing in a way that made combat flat:
 * nobody ever broke off, and nobody ever joined in.
 */
export const MORALE = {
  /**
   * Hull fraction below which a ship stops attacking and runs.
   *
   * The state machine has had a `fleeing` branch since it was written and
   * nothing ever set the flag, so every NPC fought to the death - a pirate
   * with two hit points left would still turn into the guns. Breaking off is
   * what makes a wounded enemy read as *wounded*, and it gives the player the
   * choice of whether to chase.
   */
  breakOff: 0.3,
  /**
   * How far away a ship can be and still be drawn into a fight that is
   * already happening.
   *
   * Deliberately modest. Three pirates arriving at once is a different game
   * from one pirate, and this build is meant to be friendlier than 1984.
   */
  joinRadius: 620,
};

/** How far the docking slot check reaches. Generous - this is the friendly build. */
export const DOCKING = {
  maxDistance: 260,
  maxSpeed: 90,           // do not let a kamikaze dock
  maxOffset: 46,          // how far off the slot centre you may be
  maxAngle: 0.42,         // ~24 degrees of slack, in radians
  minAngle: 0,            // must be facing *into* the slot
  clearance: 62,          // inside this, you are committed

  /**
   * What the Docking Computer buys.
   *
   * The item is described as removing "the hardest part of flying", and the
   * hardest part is holding the ship inside a 46-unit corridor on a station
   * that is rotating at a quarter radian per second. So the computer does not
   * fly the ship for you - the automatic pass already does that, for everyone,
   * the moment the geometry says yes. What it changes is the *definition of
   * aligned*: a far wider corridor, a wider cone and a higher closing speed.
   *
   * That keeps the skill gate meaningful (without the computer you must
   * actually line up) while making the 2500 CR buy something real. Before
   * this, the item was read by no code at all - a pure credit sink.
   */
  assist: {
    maxOffset: 130,
    maxAngle: 0.9,        // ~52 degrees
    maxSpeed: 150,
    range: 460,
  },
};

/** The limits in force for one approach, given whether a computer is fitted. */
export function dockingLimits(assisted) {
  if (!assisted) {
    return {
      maxOffset: DOCKING.maxOffset,
      maxAngle: DOCKING.maxAngle,
      maxSpeed: DOCKING.maxSpeed,
      range: DOCKING.maxDistance,
    };
  }
  return {
    maxOffset: DOCKING.assist.maxOffset,
    maxAngle: DOCKING.assist.maxAngle,
    maxSpeed: DOCKING.assist.maxSpeed,
    range: DOCKING.assist.range,
  };
}

/** A fast, allocation-light distance helper. */
export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Squared distance, for hot comparisons that do not need the root. */
export function dist2(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Build the static scenery for one system. Deterministic from the system seed,
 * so leaving and returning yields the same planet and the same belt.
 *
 * Returns a THREE.Group plus the metadata the rest of the game needs: where
 * the station is, what to point the compass at, and which entities are rocks
 * worth mining.
 */
export function buildSystemScene(system, seed) {
  const root = new THREE.Group();
  root.name = 'system:' + system.name;
  const range = R.mulberry32((seed ^ (system.index * 2654435761)) >>> 0);

  // --- Station ------------------------------------------------------------
  const station = makeCoriolis(LAYOUT.stationRadius);
  station.name = system.name + ' Station';
  // The station spins about its slot axis, which is what makes docking a
  // skill rather than a formality.
  station.userData.spinRate = 0.22 + range() * 0.12;
  root.add(station);

  // --- Planet -------------------------------------------------------------
  // Placed on a deterministic bearing so different systems look different.
  const bearing = range() * Math.PI * 2;
  const elevation = (range() - 0.5) * 0.5;
  const planetPos = new THREE.Vector3(
    Math.cos(bearing) * LAYOUT.planetDistance,
    Math.sin(elevation) * LAYOUT.planetDistance * 0.25,
    Math.sin(bearing) * LAYOUT.planetDistance,
  );
  const planet = makePlanet(system, range);
  planet.position.copy(planetPos);
  root.add(planet);

  // --- Star ---------------------------------------------------------------
  // Backdrop only. It is far enough away that it never changes size, which is
  // exactly what a sun should look like from inside a system.
  const star = makeStar(system, range);
  const starBearing = bearing + Math.PI * (0.6 + range() * 0.8);
  star.position.set(
    Math.cos(starBearing) * LAYOUT.starDistance,
    (range() - 0.5) * 1800,
    Math.sin(starBearing) * LAYOUT.starDistance,
  );
  root.add(star);

  // --- Asteroid belt ------------------------------------------------------
  // Placed with rejection sampling against a minimum gap. Ninety rocks of
  // radius ~20-57 thrown uniformly into an annulus *will* intersect, and two
  // rocks occupying the same space is both a collision nightmare and visibly
  // broken. Whatever the sampler fails to place in its budget is simply not
  // placed, so the belt is dense where it can be and never overlapping.
  const belt = new THREE.Group();
  belt.name = 'belt';
  const rocks = [];
  const minGap = 18;
  let attempts = 0;
  while (rocks.length < LAYOUT.beltRocks && attempts < LAYOUT.beltRocks * 40) {
    attempts += 1;
    const a = range() * Math.PI * 2;
    const rad = LAYOUT.beltInner + range() * (LAYOUT.beltOuter - LAYOUT.beltInner);
    const y = (range() - 0.5) * 220;
    const pos = { x: Math.cos(a) * rad, y, z: Math.sin(a) * rad };
    const s = LAYOUT.beltRockRadius * (0.6 + range() * 1.1);

    let clear = true;
    for (const other of rocks) {
      if (dist(pos, other.position) < s + other.userData.radius + minGap) { clear = false; break; }
    }
    if (!clear) continue;

    const rock = makeAsteroid((seed + rocks.length * 7919) >>> 0);
    rock.scale.setScalar(s);
    rock.position.set(pos.x, pos.y, pos.z);
    rock.rotation.set(range() * 6.28, range() * 6.28, range() * 6.28);
    rock.userData.kind = 'asteroid';
    rock.userData.hp = C.SHIP_HP.asteroid;
    rock.userData.radius = s;
    rock.userData.cargo = pickRockCargo(system, range);
    rock.userData.spin = {
      x: (range() - 0.5) * 0.3, y: (range() - 0.5) * 0.3, z: (range() - 0.5) * 0.3,
    };
    belt.add(rock);
    rocks.push(rock);
  }
  root.add(belt);

  // --- Atmosphere ---------------------------------------------------------
  // A very subtle haze so the starfield is not pure black behind everything.
  // Three's fog is distance-based and cheap; it also does the useful job of
  // hiding pop-in when ships spawn at the edge of the shell.
  const haze = new THREE.FogExp2(0x05070d, 0.00016);

  return {
    root,
    station,
    planet,
    star,
    belt,
    rocks,
    haze,
    sunLight: makeSunLight(system, range),
    planetLight: makePlanetLight(planetPos),
    spawnRadius: LAYOUT.spawnShellInner,
    capacity: LAYOUT.trafficTarget + Math.round(F.dangerOf(system.gov, system.faction, system.condition) * 4),
  };
}

/** Pick what a rock gives up when mined. Determined by the system profile. */
function pickRockCargo(system, range) {
  const profile = system.profile || {};
  const minerals = Object.keys(profile.produces || {}).filter(
    k => k === 'minerals' || k === 'metals' || k === 'gemStones' || k === 'gold' || k === 'platinum',
  );
  if (minerals.length && range() < 0.7) {
    return R.pick(range, minerals);
  }
  return 'minerals';
}

/**
 * A planet: procedural fBm terrain, polar caps, cloud layer and an atmospheric
 * limb.
 *
 * The whole surface is generated on the CPU from a hash of the vertex
 * *direction*, not its position. That matters: the sphere is a unit direction
 * field, so sampling noise in 3D along the direction gives terrain that is
 * continuous across the whole surface with no seam at the poles or the
 * date line - the classic failure of sampling in spherical coordinates.
 *
 * Noise is seeded from the system index through its **own** PRNG stream. It
 * must not draw from the shared `range`, because `makePlanet` runs before the
 * star and the belt: consuming a different number of values here would shift
 * every later object in the scene and silently reroll existing systems.
 *
 * Geometry is higher-resolution than the rest of the game on purpose. A planet
 * is the one object the player stares at for seconds at a time, and the earlier
 * `Icosahedron(…, 3)` reads as a faceted ball rather than a world.
 */
function makePlanet(system, range) {
  const group = new THREE.Group();
  group.name = 'planet';

  const palette = PLANET_PALETTES[system.index % PLANET_PALETTES.length];
  const seed = 0x51ed2701 ^ (system.index * 2654435761);

  // Detail 5 on an icosahedron is 10242 vertices / 20480 triangles. That is
  // cheap for one object, and it is the resolution at which a coastline reads
  // as a coastline instead of a polygon.
  const geo = new THREE.IcosahedronGeometry(LAYOUT.planetRadius, 5);
  const pos = geo.attributes.position;

  // Per-vertex scratch, reused so the loop allocates nothing.
  const v = new THREE.Vector3();
  const noiseScale = 2.6;
  const relief = [];

  for (let i = 0; i < pos.count; i += 1) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();

    // Continents (low frequency) + mountains (ridged, higher frequency).
    // `fbm3` normalised to [-1,1]; `ridged3` to [0,1] and biased to sharp
    // crests, which is what makes mountain chains rather than blobs.
    const continent = R.fbm3(seed, v.x * noiseScale, v.y * noiseScale, v.z * noiseScale, 5);
    const mountain = R.ridged3(seed + 991, v.x * 6.2, v.y * 6.2, v.z * 6.2, 4);

    // Sea level at 0: negative is ocean (flat, no mountains), positive is land.
    let height = continent * 0.62;
    if (height > 0) height += mountain * 0.10 * Math.min(1, height * 3.5);

    relief.push(height);
    const r = LAYOUT.planetRadius * (1 + height * 0.055);
    pos.setXYZ(i, v.x * r, v.y * r, v.z * r);
  }
  geo.computeVertexNormals();

  // Vertex colours: ocean depth -> coast -> lowland -> highland -> snow.
  // Doing this in a vertex attribute rather than a texture keeps the whole
  // thing procedural with no asset, and the mesh is dense enough that the
  // bands read as smooth.
  const colours = new Float32Array(pos.count * 3);
  const ocean = new THREE.Color(palette.ocean);
  const shore = new THREE.Color(palette.shore);
  const land = new THREE.Color(palette.land);
  const high = new THREE.Color(palette.high);
  const snow = new THREE.Color(0xf0f6ff);
  const c = new THREE.Color();

  for (let i = 0; i < pos.count; i += 1) {
    const h = relief[i];
    const lat = Math.abs(pos.getY(i)) / LAYOUT.planetRadius;   // 0 equator, 1 pole

    if (h < 0) {
      // Deeper water is darker; `h` bottoms out near -0.62.
      c.copy(ocean).multiplyScalar(0.55 + 0.45 * Math.min(1, (h + 0.62) / 0.62));
    } else {
      if (h < 0.03) c.copy(shore);
      else if (h < 0.22) c.lerpColors(shore, land, (h - 0.03) / 0.19);
      else c.lerpColors(land, high, Math.min(1, (h - 0.22) / 0.25));
    }

    // Ice caps: the threshold tightens toward the equator so a cold world has
    // wide caps and a warm one has almost none. Also snow on high ground.
    const capEdge = palette.capExtent;
    if (lat > capEdge) {
      const t = Math.min(1, (lat - capEdge) / (1 - capEdge) * 1.8);
      c.lerp(snow, t * 0.92);
    } else if (h > 0.3) {
      c.lerp(snow, Math.min(1, (h - 0.3) / 0.18) * 0.75);
    }

    colours[i * 3] = c.r;
    colours[i * 3 + 1] = c.g;
    colours[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));

  const body = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
    vertexColors: true,
    flatShading: false,
  }));
  group.add(body);

  // --- Clouds -------------------------------------------------------------
  // A slightly larger shell with its own noise: broken cloud cover, not a
  // blanket. The mask is deliberately stingy - a planet whose surface is
  // entirely hidden reads as a gas giant, and the terrain generated above is
  // the whole point.
  //
  // Detail 5 here, not 4: the per-vertex mask can only be as fine as the
  // triangles carrying it, and at detail 4 the icosahedron's original faces
  // are large enough that the noise lands as a handful of grey blobs instead
  // of swirls. The extra 7k vertices cost nothing for a single object.
  const cloudGeo = new THREE.IcosahedronGeometry(LAYOUT.planetRadius * 1.014, 5);
  const cpos = cloudGeo.attributes.position;
  const calpha = new Float32Array(cpos.count);
  const cloudColour = new THREE.Color(palette.cloud);
  const ccol = new Float32Array(cpos.count * 3);
  for (let i = 0; i < cpos.count; i += 1) {
    const cv = new THREE.Vector3(cpos.getX(i), cpos.getY(i), cpos.getZ(i)).normalize();
    // Two octave-scales blended: a broad band that decides *where* cloud is,
    // and a finer one that breaks it up. One alone is either a uniform haze or
    // confetti. Stretched along the equator so belts streak with the rotation.
    // Frequencies are high enough that the swirls stay smaller than the disc
    // when seen from across the system - at lower ones they read as a few grey
    // blotches covering the terrain the surface shader worked to draw.
    const broad = R.fbm3(seed + 5501, cv.x * 2.1, cv.y * 4.4, cv.z * 2.1, 3);
    const fine = R.fbm3(seed + 8821, cv.x * 6.8, cv.y * 13.0, cv.z * 6.8, 4);
    const n = broad * 0.6 + fine * 0.4;
    // Take only the upper tail, and square it: sparse cover with real gaps
    // between the swirls.
    const t = Math.max(0, (n - 0.04) / 0.44);
    calpha[i] = Math.min(1, t * t);
    ccol[i * 3] = cloudColour.r;
    ccol[i * 3 + 1] = cloudColour.g;
    ccol[i * 3 + 2] = cloudColour.b;
  }
  cloudGeo.setAttribute('color', new THREE.BufferAttribute(ccol, 3));
  // Alpha rides inside the vertex colour rather than a texture: a black vertex
  // adds nothing under additive blending, so the mask needs no alpha map and
  // no shader patch.
  for (let i = 0; i < cpos.count; i += 1) {
    const a = calpha[i];
    ccol[i * 3] *= a; ccol[i * 3 + 1] *= a; ccol[i * 3 + 2] *= a;
  }
  cloudGeo.attributes.color.needsUpdate = true;
  const cbody = new THREE.Mesh(cloudGeo, new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.42,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }));
  cbody.name = 'planet:clouds';
  group.add(cbody);

  // --- Atmosphere ---------------------------------------------------------
  // A rim shell: bright at the silhouette, fading to nothing across the disc.
  // Shares `radialGlowMaterial` with the star layers - the falloff is the same
  // maths, and having one implementation means the two cannot drift apart.
  //
  // `BackSide` so only the far hemisphere is drawn (the near one would sit
  // between the camera and the surface). The exponent is a touch under the
  // star's: an atmosphere is a broad thin wash, not a tight hot ring.
  const atmoShell = LAYOUT.planetRadius * 1.055;
  const atmo = new THREE.Mesh(
    new THREE.IcosahedronGeometry(atmoShell, 4),
    radialGlowMaterial(palette.atmo, atmoShell, 2.2, 0.42),
  );
  atmo.name = 'planet:atmo';
  group.add(atmo);

  if (palette.ring) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(LAYOUT.planetRadius * 1.45, LAYOUT.planetRadius * 2.3, 72, 1),
      new THREE.MeshBasicMaterial({
        color: palette.ring, side: THREE.DoubleSide, transparent: true, opacity: 0.28,
      }),
    );
    ring.rotation.x = Math.PI * 0.5 - 0.28;
    group.add(ring);
  }

  group.rotation.z = (system.index % 17) * 0.11;
  group.userData.body = body;
  group.userData.clouds = cbody;
  group.userData.atmo = atmo;
  group.userData.relief = relief;
  return group;
}

const PLANET_PALETTES = [
  { body: 0x2a4a6a, limb: 0x8fd0ff, ring: null,
    ocean: 0x123a5c, shore: 0x4a7a8a, land: 0x3a6a3a, high: 0x8a7a5a,
    cloud: 0xdfeeff, atmo: 0x6fa8ff, capExtent: 0.80 },
  { body: 0x5a3a24, limb: 0xffb070, ring: 0xd8a060,
    ocean: 0x4a2a12, shore: 0xa0703a, land: 0x8a5a2a, high: 0xc0a070,
    cloud: 0xffe0b0, atmo: 0xff9a50, capExtent: 0.88 },
  { body: 0x254a34, limb: 0x9fe8b0, ring: null,
    ocean: 0x0a3a2a, shore: 0x3a7a5a, land: 0x2a6a3a, high: 0x7a9a6a,
    cloud: 0xd0ffe0, atmo: 0x5fe0a0, capExtent: 0.78 },
  { body: 0x4a2a4a, limb: 0xd0a0ff, ring: 0xb080d0,
    ocean: 0x2a1040, shore: 0x6a4a8a, land: 0x5a3a6a, high: 0xa08ac0,
    cloud: 0xe8d8ff, atmo: 0xb080ff, capExtent: 0.84 },
  { body: 0x3a3f4a, limb: 0xc8d8e8, ring: null,
    ocean: 0x1a2028, shore: 0x4a525c, land: 0x3a424c, high: 0x6a7480,
    cloud: 0xc8d8e8, atmo: 0x8aa0c0, capExtent: 0.72 },
  { body: 0x6a2a2a, limb: 0xff9080, ring: null,
    ocean: 0x3a1010, shore: 0x8a4a3a, land: 0x7a3a2a, high: 0xc08a6a,
    cloud: 0xffc0a0, atmo: 0xff7050, capExtent: 0.90 },
];

/**
 * A star, built as layered shells instead of the flat disc-plus-glow it used to be.
 *
 * Real stellar structure, cheaply:
 *
 *   1. **Photosphere** - the visible surface, with granulation so it is not a
 *      flat wash.
 *   2. **Chromosphere** - a thin, hot shell just above the surface.
 *   3. **Corona** - a wide shell whose brightness falls off with distance from
 *      the disc, additive so it bleeds into the starfield behind it.
 *
 * All three are `HDR_BOOST` times brighter than a normal material. That is not
 * a taste choice: the renderer runs ACES tone mapping and a bloom pass with a
 * `threshold` of 0.62, so a surface clamped to 1.0 renders as a dull grey disc
 * with no bloom at all. Overdriving the colour is what makes the star actually
 * *emit*.
 *
 * There is deliberately no huge outer flare shell. A shell at five times the
 * star radius covers most of the screen with additive haze, drowning the
 * starfield and every nebula behind it - the star stops being a light source
 * and becomes fog. The corona's own falloff does the job at a sane radius.
 *
 * The tint comes from the system's spectral class (`starColor`, written by the
 * galaxy generator). Getting that wrong is invisible to a test but very visible
 * on screen, where every star would come out the same neutral white.
 */
function makeStar(system, range) {
  const group = new THREE.Group();
  group.name = 'star';
  const tint = new THREE.Color(system.starColor || 0xfff0c0);

  // Layer 1: photosphere. Bright enough to bloom, granulated so it has texture.
  const coreGeo = new THREE.IcosahedronGeometry(LAYOUT.starRadius, 4);
  const cpos = coreGeo.attributes.position;
  const ccol = new Float32Array(cpos.count * 3);
  // Tinted white-hot: a star's surface is far hotter than its own colour
  // suggests, and letting it drift to the pure tint makes every star a dull
  // amber ball.
  const hot = tint.clone().lerp(new THREE.Color(0xffffff), 0.55).multiplyScalar(HDR_BOOST);
  for (let i = 0; i < cpos.count; i += 1) {
    const nx = cpos.getX(i) / LAYOUT.starRadius;
    const ny = cpos.getY(i) / LAYOUT.starRadius;
    const nz = cpos.getZ(i) / LAYOUT.starRadius;
    // Granulation: fine noise so the disc has structure rather than being a
    // single flat fill. Kept shallow - the surface should shimmer, not mottle.
    const granule = R.noise3(0x7a12, nx * 11, ny * 11, nz * 11);
    const t = 0.90 + granule * 0.10;
    ccol[i * 3] = hot.r * t; ccol[i * 3 + 1] = hot.g * t; ccol[i * 3 + 2] = hot.b * t;
  }
  coreGeo.setAttribute('color', new THREE.BufferAttribute(ccol, 3));
  const core = new THREE.Mesh(coreGeo, new THREE.MeshBasicMaterial({
    vertexColors: true,
    fog: false,
  }));
  core.name = 'star:photosphere';
  group.add(core);

  // Layer 2: chromosphere - a thin saturated shell hugging the surface. Tight
  // falloff so it reads as a hot rim, not a second disc.
  const chromoShell = LAYOUT.starRadius * 1.07;
  const chromo = new THREE.Mesh(
    new THREE.IcosahedronGeometry(chromoShell, 3),
    radialGlowMaterial(tint.clone().multiplyScalar(HDR_BOOST * 1.1), chromoShell, 6.0, 1.0),
  );
  chromo.name = 'star:chromosphere';
  group.add(chromo);

  // Layer 3: the corona. Broad and soft, dying off well before the shell edge
  // so the glow has no visible boundary. The exponent is high and the strength
  // low on purpose - a star seen from inside a system is a small hard disc with
  // a modest halo, not a screen-wide wash. Too much here and the nebula, the
  // planet and half the starfield behind it all vanish into fog.
  const coronaShell = LAYOUT.starRadius * 1.9;
  const corona = new THREE.Mesh(
    new THREE.IcosahedronGeometry(coronaShell, 3),
    radialGlowMaterial(tint.clone().multiplyScalar(HDR_BOOST * 0.30), coronaShell, 5.5, 0.34),
  );
  corona.name = 'star:corona';
  group.add(corona);

  return group;
}

/**
 * How far past 1.0 the star's colours are pushed.
 *
 * The post chain is ACES tone mapping plus a bloom pass gated at 0.62. A
 * colour at exactly 1.0 passes through tone mapping as roughly 0.8 and stays
 * under the bloom threshold, so the star renders as a flat grey disc. Pushing
 * the values up is what makes it white-hot with a halo.
 *
 * Kept close to 2 rather than higher: past that the photosphere clips to pure
 * white and the star loses its spectral tint entirely, so every star in the
 * galaxy looks the same regardless of class.
 */
const HDR_BOOST = 2.2;

/**
 * An additive shell whose brightness fades radially away from the disc centre.
 *
 * Shared by every star layer. The falloff is computed in the fragment shader
 * from the view-space radial distance, which - unlike a fresnel term on the
 * normal - stays perfectly smooth on a `BackSide` sphere regardless of how few
 * triangles it has. `pow` controls how fast the light dies off: a small
 * exponent gives a broad soft halo, a large one a tight bright ring.
 */
function radialGlowMaterial(colour, shellRadius, falloff, strength) {
  const mat = new THREE.MeshBasicMaterial({
    color: colour,
    transparent: true,
    opacity: strength,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uShellRadius = { value: shellRadius };
    shader.uniforms.uFalloff = { value: falloff };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGlowPos;')
      .replace('#include <begin_vertex>',
        `#include <begin_vertex>
         vGlowPos = (modelViewMatrix * vec4(position, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\nvarying vec3 vGlowPos;\nuniform float uShellRadius;\nuniform float uFalloff;')
      .replace('#include <opaque_fragment>',
        `float gr = length(vGlowPos.xy) / uShellRadius;
         float glow = pow(clamp(1.0 - gr, 0.0, 1.0), uFalloff);
         gl_FragColor = vec4(diffuse, 1.0) * glow * diffuseColor.a;
         #include <opaque_fragment>`);
  };
  return mat;
}

/** The system's star, as a directional light. */
function makeSunLight(system, range) {
  // Intensity is above 1 because the hull fill is deliberately very dark (see
  // models.HULL_COLOUR). This is what gives each facet a readable gradient
  // without washing the dark side out to grey.
  const light = new THREE.DirectionalLight(system.starColor || 0xfff4d8, 2.35);
  const a = range() * Math.PI * 2;
  light.position.set(Math.cos(a) * 3000, 900, Math.sin(a) * 3000);
  light.target.position.set(0, 0, 0);
  return light;
}

/** A dim fill light near the planet, so the dark side is not pure black. */
function makePlanetLight(planetPos) {
  const light = new THREE.PointLight(0x4a6a9a, 260, 0, 1.4);
  light.position.copy(planetPos);
  return light;
}

/**
 * The traffic layer: spawning, despawning, and per-frame AI.
 *
 * Kept as a class-like closure rather than a THREE extension because it owns
 * plain data (AI state, timers) that has nothing to do with rendering, and
 * because a plain object serialises.
 */
export function createTraffic(scene, system, seed, options) {
  const opts = options || {};
  const rand = R.mulberry32((seed ^ 0x9e3779b9) >>> 0);
  // The system's baseline danger, adjusted by what the commander has done
  // here. `memoryDangerDelta` is negative for a system whose lanes they have
  // cleared and positive for one whose patrols they have killed - which is
  // what makes clearing pirates a lasting deed rather than a one-off bounty.
  const danger = Math.max(0, Math.min(1,
    F.dangerOf(system.gov, system.faction, system.condition) + (opts.dangerDelta || 0)));
  const hostility = F.hostilityOf(system.faction, system.gov);
  // Traffic density moves too: a cleared system attracts shipping, a raided
  // one empties. Expressed as a fraction of the target so the absolute numbers
  // stay tied to the layout rather than to this module.
  const trafficScale = Math.max(0.3, Math.min(1.6, 1 + (opts.trafficDelta || 0)));
  // How many extra hostiles an open cleanup contract keeps here. The contract
  // layer says what is owed; this layer decides what that means for traffic.
  // Mutable, because a contract can be taken and completed mid-visit.
  let pocket = Math.max(0, Math.min(POCKET.maxExtra, Math.round(opts.bounty || 0)));
  const ships = [];

  /**
   * Spawn one ship somewhere in a shell around the station. Kinds are weighted
   * by how dangerous and how factional the system is: an anarchy is pirates, a
   * corporate state is traders and the occasional patrol.
   *
   * `pocketShip` forces a hostile and pulls it into the inner part of the
   * shell. It consumes no extra randomness on the ordinary path, so the spawn
   * stream for a system without a contract is bit-for-bit what it always was.
   */
  function spawn(preferredKind, pocketShip) {
    const roll = rand();
    let kind = preferredKind;
    if (!kind && pocketShip) kind = roll < 0.7 ? 'pirate' : 'raider';
    if (!kind) {
      if (roll < 0.18 + danger * 0.42) kind = 'pirate';
      else if (roll < 0.30 + danger * 0.45) kind = 'raider';
      else if (roll < 0.46 + danger * 0.2) kind = 'viper';
      else kind = 'trader';
    }

    const mesh = makeShip(kind);
    const scale = SHIP_SCALE[kind] || 10;
    mesh.scale.setScalar(scale);

    // Place on a shell, biased toward the player's hemisphere so you actually
    // meet something without hunting for it. The pocket is the inner half of
    // that shell: they know somebody has been hired, and they are waiting.
    const a = rand() * Math.PI * 2;
    const b = (rand() - 0.5) * 1.2;
    const shellOuter = pocketShip ? POCKET.spawnOuter : LAYOUT.spawnShellOuter;
    const r = LAYOUT.spawnShellInner + rand() * (shellOuter - LAYOUT.spawnShellInner);
    mesh.position.set(
      Math.cos(a) * Math.cos(b) * r,
      Math.sin(b) * r,
      Math.sin(a) * Math.cos(b) * r,
    );

    const isHostile = kind === 'pirate' || kind === 'raider';
    const bounty = C.bountyFor(kind, danger);

    const entity = {
      mesh,
      kind,
      hostile: isHostile,
      // Part of a contract's defended pocket rather than ordinary traffic.
      // Kept as a field so a test can count the pocket without re-deriving it.
      pocket: !!pocketShip,
      // Traders only turn on you if you have been shooting their friends, or
      // if the system is lawless enough that everyone is a predator.
      aggression: isHostile ? 0.55 + danger * 0.45 : danger * 0.25,
      hp: C.SHIP_HP[kind] || 54,
      maxHp: C.SHIP_HP[kind] || 54,
      velocity: { x: 0, y: 0, z: 0 },
      // A stable personality per ship, so they do not all behave identically.
      speed: (isHostile ? 92 : 66) * (0.85 + rand() * 0.3),
      turnRate: 0.55 + rand() * 0.5,
      // Combat timer: how long before this one is willing to shoot again.
      canFire: rand() * 1.5,
      // Missiles. Raiders carry more than pirates, and traders never do:
      // a hauler shooting at you is a different game.
      missiles: kind === 'raider' ? 2 : kind === 'pirate' ? 1 : 0,
      missileCooldown: 4 + rand() * 8,
      target: null,
      // Where it is heading when not fighting: station, belt or the ring out.
      waypoint: null,
      wanderTimer: rand() * 6,
      bounty,
      standingFaction: system.faction,
      // Cargo dropped on death, for the scoop.
      cargo: isHostile ? null : tradeCargo(system, rand),
      faction: system.faction,
    };

    // Give it an initial heading roughly tangential to the station, so traffic
    // crosses the view instead of flying straight at the player.
    mesh.lookAt(0, 0, 0);
    mesh.rotateY(Math.PI * 0.5 + (rand() - 0.5) * 1.4);
    mesh.rotateX((rand() - 0.5) * 0.4);

    shipSpeed(entity, entity.speed);
    scene.add(mesh);
    ships.push(entity);
    return entity;
  }

  /**
   * Is this entity a hull that counts against the traffic cap?
   *
   * Cargo canisters and escape capsules share the `ships` list so that one set
   * of scans - collision, raycast, prune, dispose - covers them. They are not
   * traffic, though, and counting them would mean a commander who scoops a few
   * wrecks quietly starves the system of ships: `topUp` measures `ships.length`
   * against `cap`, so every canister would hold a slot the traffic never fills.
   */
  function isTraffic(s) {
    return s.kind !== 'canister' && s.kind !== 'capsule';
  }

  /** Restock toward capacity. Called on a timer, not every frame. */
  function topUp() {
    const cap = Math.max(1, Math.round(
      (LAYOUT.trafficTarget + Math.round(danger * 4)) * trafficScale)) + pocket;
    // Counted over the pocket's *own* ships, not over hostiles in general.
    // Counting all hostiles conflated the two: in a calm system the ordinary
    // table's one pirate already ate into the floor, and in a dangerous one the
    // pocket and the system's own traffic stacked into a wall. Measured before
    // the change: a pocket of 4 in a danger-0 system produced 7 hostiles.
    let own = 0;
    let live = 0;
    for (const s of ships) {
      if (s.pocket) own += 1;
      if (isTraffic(s)) live += 1;
    }
    let guard = 0;
    while (live < cap && guard < cap + 4) {
      // While a cleanup contract is open the pocket keeps a floor of its own
      // hostiles. Without it a lawful system's spawn table - mostly traders -
      // would quietly starve the contract, and the commander would have to
      // leave and come back to find anyone to shoot.
      const wantHostile = own < pocket;
      spawn(null, wantHostile);
      if (wantHostile) own += 1;
      live += 1;
      guard += 1;
    }
  }

  /**
   * Set how many extra hostiles the defended pocket holds, and restock.
   *
   * Called when a cleanup contract is taken or finished, because such a
   * contract names the system the commander is standing in: waiting for the
   * ordinary restock timer would mean the job begins with an empty sky and the
   * promise is not kept until several minutes in. Passing 0 lowers the pocket,
   * so a cleared system goes back to being an ordinary one.
   */
  function setPocket(n) {
    pocket = Math.max(0, Math.min(POCKET.maxExtra, Math.round(n || 0)));
    topUp();
    return pocket;
  }

  /**
   * Adopt a wreck's dropped cargo, or an escape capsule, into the traffic list.
   *
   * This is what makes "shoot it down and scoop the wreck" a real mechanic
   * instead of a promise in a comment. `dropCargo` has always built a complete
   * entity - mesh, radius, spin, zero velocity - and returned it in an array,
   * and the kill handler has always thrown that return value away. Nothing put
   * the canister anywhere the collision scan looked, so scooping could never
   * fire, and the mesh stayed in the scene for ever: not traffic, so `prune`
   * and `dispose` never saw it either. Each kill leaked a mesh, a geometry and
   * a material, and the leak survived a jump, because a jump only clears the
   * system group.
   *
   * They go in `ships` rather than a list of their own so that every existing
   * scan covers them without a second code path: the collision loop that calls
   * `scoop`, the laser raycast, `prune`'s despawn sphere, and `dispose` on a
   * jump. `isTraffic` keeps them out of the cap so they cannot starve the
   * system of real ships.
   */
  function addWreckage(list) {
    const added = [];
    for (const entity of list || []) {
      if (!entity || !entity.mesh) continue;
      // A canister drifts rather than flies, and the traffic step does not
      // branch on kind - every entity in this list is steered and integrated.
      // So each field that step reads has to be a number, or it goes to NaN.
      //
      // Measured, not assumed: adopting `dropCargo`'s entity with only `speed`
      // filled in still produced a canister at `NaN,NaN,NaN` within two seconds.
      // `turnRate` was the culprit - `steerToward` computes `s.turnRate * dt`,
      // `undefined * dt` is NaN, and `slerp(want, NaN)` writes NaN straight into
      // the quaternion, from which `noseOf` and then the position follow. Both
      // fields are read unconditionally, so both are made explicit here.
      if (typeof entity.speed !== 'number') entity.speed = 0;
      if (typeof entity.turnRate !== 'number') entity.turnRate = 0;
      if (!entity.velocity) entity.velocity = { x: 0, y: 0, z: 0 };
      // The rest of what the step reads is guarded by short-circuit today
      // (`missiles > 0`, `state === 'engage'`, the waypoint branch), but
      // "false because NaN" is one refactor away from "NaN because refactor".
      // A drifting wreck neither shoots nor launches nor patrols, stated
      // plainly rather than implied by missing fields.
      if (typeof entity.missiles !== 'number') entity.missiles = 0;
      if (typeof entity.missileCooldown !== 'number') entity.missileCooldown = 0;
      if (typeof entity.canFire !== 'number') entity.canFire = Infinity;
      if (typeof entity.wanderTimer !== 'number') entity.wanderTimer = 6;
      ships.push(entity);
      added.push(entity);
    }
    return added;
  }

  /** Remove ships that drifted beyond the despawn sphere, or were destroyed. */
  function prune() {
    let removed = 0;
    for (let i = ships.length - 1; i >= 0; i -= 1) {
      const s = ships[i];
      if (s.dead) {
        ships.splice(i, 1);
        removed += 1;
        continue;
      }
      // Wreckage is exempt from the distance rule. The shell exists to recycle
      // *traffic* that has drifted out of play, and a canister is not traffic:
      // it is a reward deliberately left where the player can reach it, and it
      // does not move. Applying the rule to it silently deleted ore dropped in
      // the outer belt - `despawnDistance` is 2600 while the belt spans
      // 2200-3400, so roughly the outer third of the belt dropped cargo that was
      // culled on the very next prune, before it could ever be scooped. Found by
      // firing at a rock in the belt; the rock broke, the canister appeared, and
      // it was gone a frame later.
      if (!s.canister && !s.capsule) {
        const d = Math.hypot(s.mesh.position.x, s.mesh.position.y, s.mesh.position.z);
        if (d > LAYOUT.despawnDistance) {
          scene.remove(s.mesh);
          // Free the hull, the edge overlay and the engine flame with it. Each
          // ship is built from its own geometry (`makeShip` allocates fresh), so
          // skipping this leaks a handful of buffers and materials per despawn -
          // which is a steady climb over a long session in one system, invisible
          // in a short test because a hyperspace jump clears the whole scene.
          disposeTree(s.mesh);
          ships.splice(i, 1);
          removed += 1;
        }
      }
    }
    return removed;
  }

  /**
   * Remove and free every ship.
   *
   * The ships live in the renderer's scene, not in the system group, so
   * replacing the traffic object on a jump does not take them with it.
   * Measured before this existed: **104 frozen ships in the scene after twelve
   * jumps**, none of them simulated any more, all of them still drawn, and
   * their hulls, edge overlays and flames never freed. They also sat exactly
   * where the new system's traffic sits - 420 to 1100 units from the station -
   * so they read as traffic that had stopped moving rather than as a leak.
   */
  function dispose() {
    for (const s of ships) {
      scene.remove(s.mesh);
      disposeTree(s.mesh);
    }
    ships.length = 0;
  }

  return {
    ships,
    get danger() { return danger; },
    get hostility() { return hostility; },
    get trafficScale() { return trafficScale; },
    /** Extra hostiles the defended pocket keeps, 0 when no contract is open. */
    get pocket() { return pocket; },
    /**
     * The traffic's own seeded stream, so the AI is reproducible.
     *
     * `stepTraffic` used `Math.random()` for patrol waypoints, missile and gun
     * cooldowns, which breaks the rule this project states at the top of
     * `rng.js` - never use it for anything observable twice - and made the AI
     * unreproducible. The visible symptom was a *flaky test*: the engine-flame
     * test measures the nose swinging, and a patrolling ship picks a random
     * waypoint whenever its wander timer expires, so the same test passed five
     * times in isolation and failed once in a full run.
     */
    rand,
    spawn, topUp, prune, setPocket, dispose, addWreckage,
    seed,
  };
}

/** Give a ship its initial velocity along its own nose. */
function shipSpeed(entity, speed) {
  const q = entity.mesh.quaternion;
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  entity.velocity.x = fwd.x * speed;
  entity.velocity.y = fwd.y * speed;
  entity.velocity.z = fwd.z * speed;
}

/** Choose a plausible cargo for a trader, drawn from what the system imports. */
function tradeCargo(system, rand) {
  const consumes = Object.keys((system.profile && system.profile.consumes) || {});
  if (!consumes.length) return null;
  return R.pick(rand, consumes);
}

/**
 * One frame of NPC behaviour.
 *
 * The AI is deliberately simple and readable. There are three states and the
 * transitions are distance- and aggression-driven:
 *
 *   patrol  - fly a lazy circuit, drifting toward the belt or the station
 *   engage  - turn to face the player and close
 *   break   - after taking damage, fly past and come round again (a "pass")
 *
 * A pass-based model rather than a permanent tail is the single most important
 * choice here. It gives the player breathing room to shoot back, it matches the
 * original's duel rhythm, and it makes the heat mechanic meaningful because
 * combat comes in bursts rather than one long stream.
 */
export function stepTraffic(traffic, playerState, playerPos, dt, hooks) {
  const { ships, danger } = traffic;
  // The traffic's own seeded stream where it has one. Everything random in this
  // function used `Math.random()`, which made the AI unreproducible and made
  // tests that depend on it flaky - see the note on `rand` in `createTraffic`.
  // The fallback keeps hand-built traffic objects in tests working.
  const rand = traffic.rand || Math.random;
  const hostilePatrols = !!(playerState && playerState.hostilePatrols);

  // Is a fight already happening nearby? One pass to find it, so the answer is
  // the same for every ship in the frame rather than depending on iteration
  // order.
  // Is a fight already happening nearby? One pass to find it, so the answer is
  // the same for every ship in the frame rather than depending on iteration
  // order.
  let packLeader = null;
  for (const s of ships) {
    if (s.dead || s.fleeing) continue;
    if (s.kind !== 'pirate' && s.kind !== 'raider') continue;
    if (s.state !== 'engage') continue;
    if (Math.hypot(s.mesh.position.x - playerPos.x, s.mesh.position.y - playerPos.y,
      s.mesh.position.z - playerPos.z) < MORALE.joinRadius) {
      packLeader = s;
      break;
    }
  }

  for (const s of ships) {
    if (s.dead) continue;

    // A patrol in a system where the commander is hunted does not wait to be
    // provoked. Applied here rather than at spawn time because standing and
    // the wanted list change *during* a visit - a patrol that was neutral when
    // it spawned must turn the moment the commander earns their hostility.
    if (hostilePatrols && s.kind === 'viper' && !s.hostile) {
      s.hostile = true;
      s.aggression = Math.max(s.aggression, 0.9);
    }

    const toPlayer = {
      x: playerPos.x - s.mesh.position.x,
      y: playerPos.y - s.mesh.position.y,
      z: playerPos.z - s.mesh.position.z,
    };
    const distance = Math.hypot(toPlayer.x, toPlayer.y, toPlayer.z) || 1;

    // --- Morale ----------------------------------------------------------
    // A badly damaged ship stops attacking and runs. Once set it stays set:
    // there is no repairing in space, so a ship that has broken off has
    // nothing to come back for.
    if (!s.fleeing && s.maxHp > 0 && s.hp / s.maxHp < MORALE.breakOff && s.kind !== 'asteroid') {
      s.fleeing = true;
    }

    // --- State selection -------------------------------------------------
    // Engage only if it actually wants a fight and you are close enough to be
    // worth the trip. Morale outranks everything: a wounded ship disengages
    // even if it is still angry.
    //
    // `joined` is the pack response: a fight already in progress within
    // `joinRadius` draws in other raiders. Without it three pirates in range
    // take turns duelling you one at a time while the other two fly their
    // patrol, which reads as a bug rather than as mercy.
    const joined = packLeader && s !== packLeader
      && (s.kind === 'pirate' || s.kind === 'raider')
      && distance < MORALE.joinRadius;
    const wantsFight = s.aggression > 0.5 || (s.hostile && danger > 0.35) || joined;
    const inRange = distance < 900;
    if (!s.state) s.state = 'patrol';
    if (s.fleeing) s.state = 'flee';
    else if (wantsFight && inRange) s.state = 'engage';
    else s.state = 'patrol';

    let aimPoint;

    if (s.state === 'engage') {
      aimPoint = interceptPoint(s, playerPos, playerState);
      // Do not ram: hold a stand-off distance and slide sideways.
      const standoff = 160;
      if (distance < standoff) {
        aimPoint = {
          x: aimPoint.x + (s.mesh.position.x - playerPos.x) * 0.6,
          y: aimPoint.y + (s.mesh.position.y - playerPos.y) * 0.6,
          z: aimPoint.z + (s.mesh.position.z - playerPos.z) * 0.6,
        };
      }
    } else if (s.state === 'flee') {
      // Away from the commander, and far enough that the heading is a real
      // one rather than a wobble. A fleeing ship that still circles the
      // station is not fleeing, it is loitering.
      const away = {
        x: s.mesh.position.x - playerPos.x,
        y: s.mesh.position.y - playerPos.y,
        z: s.mesh.position.z - playerPos.z,
      };
      const len = Math.hypot(away.x, away.y, away.z) || 1;
      aimPoint = {
        x: s.mesh.position.x + (away.x / len) * 900,
        y: s.mesh.position.y + (away.y / len) * 900,
        z: s.mesh.position.z + (away.z / len) * 900,
      };
    } else {
      aimPoint = patrolPoint(s, dt, danger, rand);
    }

    steerToward(s, aimPoint, dt);
    integrateEntity(s, dt);

    // --- Missiles --------------------------------------------------------
    // A missile is the one attack the player has to *answer* rather than
    // absorb, so it is rationed: a cooldown, a small magazine, and a launch
    // window that a jinking pilot can stay out of. Fired only from a real
    // firing position - behind the target's tail is where it hurts, but these
    // ships do not have the patience to set that up, so the requirement is
    // simply a decent lock.
    s.missileCooldown -= dt;
    if (s.missiles > 0 && s.state === 'engage' && !s.fleeing
      && s.missileCooldown <= 0 && distance > 260 && distance < 760
      && hooks.onEnemyMissile) {
      const nx = toPlayer.x / distance, ny = toPlayer.y / distance, nz = toPlayer.z / distance;
      const fwd = noseOf(s);
      const lock = fwd.x * nx + fwd.y * ny + fwd.z * nz;
      // A sloppier lock than the gun needs: a missile that homes does not have
      // to be pointed at the target, and demanding the gun's 0.985 would mean
      // it almost never fires.
      if (lock > 0.93) {
        s.missiles -= 1;
        s.missileCooldown = 9 + rand() * 9;
        hooks.onEnemyMissile(s, {
          damage: C.ENEMY_MISSILE_DAMAGE,
          speed: C.ENEMY_MISSILE_SPEED,
          turn: C.ENEMY_MISSILE_TURN,
          life: C.ENEMY_MISSILE_LIFE,
          radius: C.ENEMY_MISSILE_RADIUS,
        });
      }
    }

    // --- Shooting --------------------------------------------------------
    s.canFire -= dt;
    const playerFacingUs = true; // the caller decides if we are in the cone
    if (s.state === 'engage' && s.canFire <= 0 && distance < C.FIRE_RANGE && playerFacingUs) {
      const nx = toPlayer.x / distance, ny = toPlayer.y / distance, nz = toPlayer.z / distance;
      const fwd = noseOf(s);
      const cone = fwd.x * nx + fwd.y * ny + fwd.z * nz;
      if (cone > 0.985) {
        // Aim is imperfect on purpose. A perfect NPC would be unbeatable and
        // joyless; this is what makes the dogfight survivable.
        const spread = 0.014 + (s.hostile ? 0 : 0.01);
        const jitter = () => (rand() - 0.5) * spread;
        hooks.onEnemyShot(s, {
          x: nx + jitter(), y: ny + jitter(), z: nz + jitter(),
          damage: s.hostile ? 5 : 3,
        });
        s.canFire = 0.75 + rand() * 0.9;
      } else {
        s.canFire = 0.2;
      }
    }

    // Spin rocks and canisters.
    if (s.spin) {
      s.mesh.rotation.x += s.spin.x * dt;
      s.mesh.rotation.y += s.spin.y * dt;
      s.mesh.rotation.z += s.spin.z * dt;
    } else {
      // Only ships have engines; rocks and canisters fall through to the spin
      // branch above and never reach here.
      syncFlame(s, dt);
    }
  }

  return ships;
}

/**
 * Tie an NPC's engine flame to how hard it is actually working.
 *
 * The flame is driven from the *turn* rather than the throttle, because these
 * ships have no throttle: `integrateEntity` always pulls their velocity toward
 * `speed * nose`, so the only time the hull is genuinely accelerating is when
 * the nose is swinging. That makes turn rate the honest signal, and it produces
 * the right read for free - a ship banking into an attack flares its exhaust, a
 * ship cruising straight keeps a pilot light.
 *
 * `flameRest` is a neutral resting length so that a ship which never turns is
 * not left dead. It is also the value the tests pin, so the multiplier can be
 * checked without simulating a dogfight.
 */
function syncFlame(s, dt) {
  const group = s.mesh;
  const flame = group.userData && group.userData.flame;
  if (!flame) return;
  const c = FLAME;

  // Angular displacement since the last frame, in radians. `_lastNose` is
  // per-entity and created lazily so old saves and test fixtures stay valid.
  const nose = noseOf(s);
  if (!s._lastNose) {
    s._lastNose = nose;
    s._flameScale = c.idle;
    flame.scale.z = c.idle;
    return;
  }
  const dot = Math.max(-1, Math.min(1,
    nose.x * s._lastNose.x + nose.y * s._lastNose.y + nose.z * s._lastNose.z));
  const turn = Math.acos(dot) / Math.max(dt, 1e-4);   // rad/s
  s._lastNose = nose;

  // `turn` is 0 when flying straight and grows with the bank. Map it onto the
  // idle..burn band; 1.6 rad/s is a hard turn for every ship in the game.
  const work = Math.min(1, turn / 1.6);
  const target = c.idle + (c.burn - c.idle) * work;

  // Smooth both ways. A hard snap on a jinking ship strobes; the time constant
  // is short enough that a deliberate bank still reads as immediate.
  const k = Math.min(1, 6 * dt);
  s._flameScale = (s._flameScale === undefined ? target : s._flameScale + (target - s._flameScale) * k);
  flame.scale.z = s._flameScale;
}

/** Where the ship should aim to hit the player, leading the target. */
function interceptPoint(s, playerPos, playerState) {
  const nx = playerPos.x - s.mesh.position.x;
  const ny = playerPos.y - s.mesh.position.y;
  const nz = playerPos.z - s.mesh.position.z;
  const d = Math.hypot(nx, ny, nz) || 1;
  // Lead the target by the time it takes a shot to arrive, damped so the aim
  // does not oscillate when the player jinks.
  const t = Math.min(0.6, d / 520) * 0.7;
  const v = (playerState && playerState.vel) || { x: 0, y: 0, z: 0 };
  return {
    x: playerPos.x + v.x * t,
    y: playerPos.y + v.y * t,
    z: playerPos.z + v.z * t,
  };
}

/** A slow circuit between the station, the belt and open space. */
function patrolPoint(s, dt, danger, rand) {
  s.wanderTimer -= dt;
  if (s.wanderTimer <= 0 || !s.waypoint) {
    s.wanderTimer = 6 + rand() * 9;
    const a = rand() * Math.PI * 2;
    const r = 600 + rand() * 1800;
    s.waypoint = { x: Math.cos(a) * r, y: (rand() - 0.5) * 500, z: Math.sin(a) * r };
  }
  return s.waypoint;
}

/**
 * Rotate an entity's nose toward a point, at a bounded rate.
 *
 * Built as an explicit basis rather than via `Matrix4.lookAt`, because lookAt
 * aims the matrix's -Z at the target while our ships model their nose on +Z.
 * Composing a correction onto that is the kind of fix that works until someone
 * adds a roll, so the frame is constructed directly instead: the target
 * direction *is* the nose axis, and nothing is rotated afterwards.
 */
function steerToward(s, point, dt) {
  const pos = s.mesh.position;
  const dx = point.x - pos.x, dy = point.y - pos.y, dz = point.z - pos.z;
  const len = Math.hypot(dx, dy, dz) || 1;
  const z = { x: dx / len, y: dy / len, z: dz / len };

  // Pick a reference up that is not parallel to the nose, then orthogonalise.
  let ref = { x: 0, y: 1, z: 0 };
  if (Math.abs(z.y) > 0.995) ref = { x: 0, y: 0, z: 1 };
  let x = {
    x: ref.y * z.z - ref.z * z.y,
    y: ref.z * z.x - ref.x * z.z,
    z: ref.x * z.y - ref.y * z.x,
  };
  const xl = Math.hypot(x.x, x.y, x.z) || 1;
  x = { x: x.x / xl, y: x.y / xl, z: x.z / xl };
  const y = {
    x: z.y * x.z - z.z * x.y,
    y: z.z * x.x - z.x * x.z,
    z: z.x * x.y - z.y * x.x,
  };

  const m = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(x.x, x.y, x.z),
    new THREE.Vector3(y.x, y.y, y.z),
    new THREE.Vector3(z.x, z.y, z.z),
  );
  const want = new THREE.Quaternion().setFromRotationMatrix(m);

  const t = Math.min(1, s.turnRate * dt);
  s.mesh.quaternion.slerp(want, t);
  s.mesh.quaternion.normalize();
}

/** Move an entity along its own nose at its own speed. */
function integrateEntity(s, dt) {
  const fwd = noseOf(s);
  const targetV = { x: fwd.x * s.speed, y: fwd.y * s.speed, z: fwd.z * s.speed };
  const t = Math.min(1, 2.0 * dt);
  s.velocity.x += (targetV.x - s.velocity.x) * t;
  s.velocity.y += (targetV.y - s.velocity.y) * t;
  s.velocity.z += (targetV.z - s.velocity.z) * t;
  s.mesh.position.x += s.velocity.x * dt;
  s.mesh.position.y += s.velocity.y * dt;
  s.mesh.position.z += s.velocity.z * dt;
}

/** World-space nose direction of an entity. */
export function noseOf(s) {
  const q = s.mesh.quaternion;
  return {
    x: 2 * (q.x * q.z + q.w * q.y),
    y: 2 * (q.y * q.z - q.w * q.x),
    z: 1 - 2 * (q.x * q.x + q.y * q.y),
  };
}

/**
 * Hitscan along a ray against a list of entities and rocks.
 *
 * Returns the nearest hit, or null. A ray-sphere test is exactly right here:
 * ships are convex enough that a bounding sphere is a fair approximation, and
 * cheap enough that we can run it for every laser shot without thinking.
 */
export function raycast(origin, dir, targets, maxDist) {
  let best = null;
  let bestT = maxDist === undefined ? Infinity : maxDist;

  const ox = origin.x, oy = origin.y, oz = origin.z;
  const dx = dir.x, dy = dir.y, dz = dir.z;
  const dl = Math.hypot(dx, dy, dz) || 1;
  const nx = dx / dl, ny = dy / dl, nz = dz / dl;

  for (const t of targets) {
    if (t.dead) continue;
    const m = t.mesh || t;
    if (!m || !m.position) continue;
    const radius = t.radius || m.userData.radius || entityRadius(t);
    if (!radius) continue;

    const px = m.position.x - ox;
    const py = m.position.y - oy;
    const pz = m.position.z - oz;
    // Project the centre onto the ray.
    const proj = px * nx + py * ny + pz * nz;
    if (proj < 0 || proj > bestT) continue;
    // Perpendicular distance from the ray to the centre.
    const cx = px - nx * proj, cy = py - ny * proj, cz = pz - nz * proj;
    const perp2 = cx * cx + cy * cy + cz * cz;
    if (perp2 > radius * radius) continue;

    // Back off to the near intersection so the impact point is on the surface.
    const back = Math.sqrt(radius * radius - perp2);
    const hitT = Math.max(0, proj - back);
    if (hitT < bestT) {
      bestT = hitT;
      best = {
        target: t,
        distance: hitT,
        point: { x: ox + nx * hitT, y: oy + ny * hitT, z: oz + nz * hitT },
        normal: { x: -nx, y: -ny, z: -nz },
      };
    }
  }
  return best;
}

/** Best-effort bounding radius for an entity that did not declare one. */
export function entityRadius(t) {
  if (t.kind && SHIP_SCALE[t.kind]) return SHIP_SCALE[t.kind] * 0.7;
  const m = t.mesh;
  if (!m) return 8;
  if (m.userData.radius) return m.userData.radius;
  const s = m.scale.x || 1;
  return 8 * s;
}

/**
 * Docking check. The player must be close, slow, roughly lined up with the
 * slot, and facing *into* the station (the slot normal points outward, so the
 * approach direction must oppose it).
 *
 * Returns a structured verdict so the HUD can coach the player instead of
 * just refusing: "too fast", "line up with the slot", and so on.
 */
export function checkDocking(station, pos, vel, quat, options) {
  const limits = dockingLimits(!!(options && options.assisted));
  const s = station.userData;
  const slotNormalLocal = s.slotNormalLocal;
  const slotPointLocal = s.slotPointLocal;
  const R0 = s.radius || LAYOUT.stationRadius;

  // Bring the slot into world space using the station's current rotation.
  const slotPoint = toWorld(station, slotPointLocal);
  const slotNormal = new THREE.Vector3(
    slotNormalLocal.x, slotNormalLocal.y, slotNormalLocal.z,
  ).applyQuaternion(station.quaternion).normalize();

  const d = dist(pos, slotPoint);
  const speed = Math.hypot(vel.x, vel.y, vel.z);

  // How far off the slot axis are we, laterally?
  const toShip = { x: pos.x - slotPoint.x, y: pos.y - slotPoint.y, z: pos.z - slotPoint.z };
  const along = toShip.x * slotNormal.x + toShip.y * slotNormal.y + toShip.z * slotNormal.z;
  const lateral = Math.hypot(
    toShip.x - slotNormal.x * along,
    toShip.y - slotNormal.y * along,
    toShip.z - slotNormal.z * along,
  );

  // Nose direction, and the direction we *should* be facing (into the slot:
  // opposite the outward normal).
  const nose = {
    x: 2 * (quat.x * quat.z + quat.w * quat.y),
    y: 2 * (quat.y * quat.z - quat.w * quat.x),
    z: 1 - 2 * (quat.x * quat.x + quat.y * quat.y),
  };
  const dot = -(nose.x * slotNormal.x + nose.y * slotNormal.y + nose.z * slotNormal.z);
  const angle = Math.acos(Math.max(-1, Math.min(1, dot)));

  const inside = d < R0 * 1.6;
  // Every verdict carries the limits that produced it, so the HUD can coach
  // against the envelope actually in force rather than the stock one.
  const verdict = { distance: d, lateral, angle, speed, limits, assisted: limits !== null && !!(options && options.assisted) };

  if (!inside) return Object.assign(verdict, { ok: false, reason: 'out-of-range' });
  if (speed > limits.maxSpeed) return Object.assign(verdict, { ok: false, reason: 'too-fast' });
  if (lateral > limits.maxOffset) return Object.assign(verdict, { ok: false, reason: 'off-axis' });
  // Attitude. `angle` is measured from "nose pointing into the slot", so 0 is
  // perfect and pi is flying directly out of it. Accept only the cone around 0.
  // Written as a range test rather than `angle > maxAngle` because the
  // reversed case lands on exactly pi and a strict `<` would let it through.
  if (angle > limits.maxAngle) {
    return Object.assign(verdict, { ok: false, reason: 'bad-attitude' });
  }
  if (d > DOCKING.clearance && d > limits.range) {
    return Object.assign(verdict, { ok: false, reason: 'out-of-range' });
  }
  return Object.assign(verdict, { ok: true, reason: 'docking' });
}

/** Apply a station's transform to a local point. */
function toWorld(object, local) {
  const v = new THREE.Vector3(local.x, local.y, local.z);
  v.applyQuaternion(object.quaternion);
  v.add(object.position);
  return { x: v.x, y: v.y, z: v.z };
}

/**
 * Where should the hyperspace exit put the player? Just outside the station,
 * on the slot side, so the station is immediately visible and the docking
 * approach is obvious. Arriving in deep space with nothing in view is the
 * single worst thing a game like this can do.
 */
export function arrivalPose(station) {
  const s = station.userData;
  const normal = new THREE.Vector3(s.slotNormalLocal.x, s.slotNormalLocal.y, s.slotNormalLocal.z)
    .applyQuaternion(station.quaternion).normalize();
  const out = (s.radius || LAYOUT.stationRadius) * 2.4;
  return {
    position: {
      x: station.position.x + normal.x * out,
      y: station.position.y + normal.y * out,
      z: station.position.z + normal.z * out,
    },
    // Face the station.
    facing: { x: -normal.x, y: -normal.y, z: -normal.z },
  };
}

/** Drop the money cargo from a destroyed ship, as a scoopable canister. */
export function dropCargo(scene, position, commodityId, seed) {
  const rand = R.mulberry32((seed ^ Math.floor(position.x * 1000)) >>> 0);
  const n = 1 + Math.floor(rand() * 2);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const can = makeCanister();
    can.scale.setScalar(1);
    can.position.set(
      position.x + (rand() - 0.5) * 24,
      position.y + (rand() - 0.5) * 24,
      position.z + (rand() - 0.5) * 24,
    );
    can.userData.kind = 'canister';
    can.userData.commodity = commodityId;
    can.userData.radius = 1.6;
    can.userData.spin = { x: (rand() - 0.5) * 2, y: (rand() - 0.5) * 2, z: (rand() - 0.5) * 2 };
    scene.add(can);
    out.push({
      mesh: can, kind: 'canister', hp: C.SHIP_HP.canister,
      hostile: false, aggression: 0, speed: 0,
      velocity: { x: 0, y: 0, z: 0 },
      commodity: commodityId, radius: 1.6,
      spin: can.userData.spin, canister: true,
    });
  }
  return out;
}

/** Drop an escape capsule, which is worth rescuing (and some people want dead). */
export function dropCapsule(scene, position, seed) {
  const rand = R.mulberry32((seed ^ Math.floor(position.z * 1000)) >>> 0);
  const cap = makeCapsule();
  cap.position.set(position.x, position.y, position.z);
  cap.userData.kind = 'capsule';
  cap.userData.radius = 2.2;
  cap.userData.spin = { x: (rand() - 0.5) * 0.8, y: (rand() - 0.5) * 0.8, z: 0 };
  scene.add(cap);
  return {
    mesh: cap, kind: 'capsule', hp: 2, hostile: false, aggression: 0, speed: 12,
    velocity: { x: 0, y: 0, z: 0 }, radius: 2.2,
    spin: cap.userData.spin, capsule: true,
  };
}

/** The station spins. Called from the frame loop. */
export function spinStation(station, dt) {
  const rate = station.userData.spinRate || 0.2;
  // Rotate about the slot axis, which is the station's local +Z.
  station.rotateZ(rate * dt);

  if (station.userData.beacons) {
    // Blink phase comes from an accumulated clock on the station, not from
    // wall time. Wall time would be wrong twice over: it ignores pausing, and
    // it makes this function untestable outside a browser.
    station.userData.blinkClock = (station.userData.blinkClock || 0) + dt;
    const t = station.userData.blinkClock;
    for (let i = 0; i < station.userData.beacons.length; i += 1) {
      const b = station.userData.beacons[i];
      // Staggered blink so they read as a sequence, like a real approach aid.
      const phase = t * 2.4 + i * (Math.PI / 2);
      b.intensity = 0.35 + 0.65 * Math.max(0, Math.sin(phase));
    }
  }
}

/** Group of lights that follow the player, so nothing ever goes fully black. */
export function makeCockpitLight() {
  const light = new THREE.HemisphereLight(0x6a86b0, 0x14181f, 0.72);
  return light;
}

export default {
  LAYOUT, DOCKING, SHIP_SCALE, POCKET, MORALE,
  dist, dist2,
  buildSystemScene, createTraffic, stepTraffic,
  raycast, entityRadius, noseOf,
  checkDocking, arrivalPose,
  dropCargo, dropCapsule, spinStation, makeCockpitLight,
};
