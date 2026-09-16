/**
 * Geometry tests.
 *
 * These run in Node without a GPU, which means they test the *data* the
 * renderer will consume rather than pixels. That is deliberate: the failures
 * that matter here are structural - a ship modelled facing the wrong way, a
 * station with no usable docking frame, a geometry with a broken index buffer.
 * All of those produce a game that either crashes on first render or silently
 * flies sideways, and none are visible in a unit test of game logic.
 */
import test from 'node:test';
import assert from 'node:assert';
import * as THREE from 'three';
import * as M from '../src/sim/models.js';
import * as W from '../src/sim/world.js';
import * as G from '../src/logic/galaxy.js';

const home = G.generate(1984).systems[0];

/** Every vertex of a geometry, as Vector3s. */
function vertices(geometry) {
  const pos = geometry.attributes.position;
  const out = [];
  for (let i = 0; i < pos.count; i++) {
    out.push(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
  }
  return out;
}

/** Collect every mesh and line in a group tree. */
function walk(object, out) {
  out = out || { meshes: [], lines: [] };
  object.traverse(o => {
    if (o.isMesh) out.meshes.push(o);
    if (o.isLine || o.isLineSegments) out.lines.push(o);
  });
  return out;
}

test('every ship model builds without throwing', () => {
  for (const fn of [M.makeCobra, M.makeSidewinder, M.makeViper, M.makeGecko]) {
    const s = fn();
    assert.ok(s && s.isObject3D, fn.name + ' did not return an object');
    const found = walk(s);
    assert.ok(found.meshes.length >= 1, fn.name + ' has no mesh');
    assert.ok(found.lines.length >= 1, fn.name + ' has no edge overlay');
  }
});

test('every ship carries a bright edge overlay, not just a hull', () => {
  // The aesthetic is vector-first: without edges a ship is a dark blob.
  for (const fn of [M.makeCobra, M.makeSidewinder, M.makeViper, M.makeGecko]) {
    const s = fn();
    const lines = walk(s).lines;
    assert.ok(lines.length >= 1, fn.name + ' has no lines');
    const line = lines[0];
    const colour = new THREE.Color(line.material.color);
    // Edges must be clearly brighter than the hull fill.
    const lum = colour.r * 0.3 + colour.g * 0.6 + colour.b * 0.1;
    assert.ok(lum > 0.5, fn.name + ' edges are too dark to read (luminance ' + lum.toFixed(2) + ')');
  }
});

test('ship hulls are dark so the edges read against them', () => {
  for (const fn of [M.makeCobra, M.makeSidewinder, M.makeViper, M.makeGecko]) {
    const mesh = walk(fn()).meshes[0];
    const colour = new THREE.Color(mesh.material.color);
    const lum = colour.r * 0.3 + colour.g * 0.6 + colour.b * 0.1;
    assert.ok(lum < 0.35, fn.name + ' hull is too bright (luminance ' + lum.toFixed(2) + ')');
    assert.strictEqual(mesh.material.flatShading, true,
      fn.name + ' must use flat shading or the facets vanish');
  }
});

test('ships are modelled nose-forward along +Z', () => {
  // The camera looks down -Z and the flight model applies thrust along local
  // -Z, so a world ship must point at +Z to face the way it travels. A model
  // built the other way flies backwards, which is subtle until you see it.
  for (const [name, fn] of [['cobra', M.makeCobra], ['sidewinder', M.makeSidewinder],
    ['viper', M.makeViper], ['gecko', M.makeGecko]]) {
    const verts = vertices(walk(fn()).meshes[0].geometry);
    const maxZ = Math.max(...verts.map(v => v.z));
    const minZ = Math.min(...verts.map(v => v.z));
    assert.ok(maxZ > Math.abs(minZ) * 0.8,
      name + ': the nose (max +Z) should dominate the tail (maxZ ' +
      maxZ.toFixed(2) + ' vs minZ ' + minZ.toFixed(2) + ')');

    // The foremost vertex should be near the centreline: a nose poking out to
    // one side means the shape is lopsided.
    const nose = verts.find(v => v.z === maxZ);
    assert.ok(Math.abs(nose.x) < 0.9,
      name + ': the nose is off-centre at x=' + nose.x.toFixed(2));
  }
});

test('ships are not perfectly symmetric in only one axis (sanity)', () => {
  // A quick check that the geometry is genuinely three-dimensional and not a
  // flat plane or a single triangle that would render as a sliver.
  for (const fn of [M.makeCobra, M.makeViper, M.makeGecko]) {
    const verts = vertices(walk(fn()).meshes[0].geometry);
    const xs = verts.map(v => v.x), ys = verts.map(v => v.y), zs = verts.map(v => v.z);
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    const spanZ = Math.max(...zs) - Math.min(...zs);
    assert.ok(spanX > 1 && spanY > 0.5 && spanZ > 3,
      fn.name + ': implausible extents ' + [spanX, spanY, spanZ].map(n => n.toFixed(1)).join('x'));
  }
});

test('ship geometries have valid index buffers', () => {
  for (const fn of [M.makeCobra, M.makeSidewinder, M.makeViper, M.makeGecko]) {
    const geo = walk(fn()).meshes[0].geometry;
    const idx = geo.index;
    assert.ok(idx, fn.name + ' has no index buffer');
    const count = geo.attributes.position.count;
    for (let i = 0; i < idx.count; i++) {
      const v = idx.getX(i);
      assert.ok(v >= 0 && v < count,
        fn.name + ': index ' + v + ' out of range (vertices: ' + count + ')');
    }
    assert.strictEqual(idx.count % 3, 0, fn.name + ': index count is not a multiple of 3');
  }
});

test('asteroids are deterministic per seed and vary between seeds', () => {
  const a1 = M.makeAsteroid(1234);
  const a2 = M.makeAsteroid(1234);
  const b = M.makeAsteroid(5678);
  const va = vertices(walk(a1).meshes[0].geometry);
  const vb = vertices(walk(a2).meshes[0].geometry);
  const vc = vertices(walk(b).meshes[0].geometry);

  assert.deepStrictEqual(va.map(v => v.toArray()), vb.map(v => v.toArray()),
    'the same seed produced different asteroids');
  assert.notDeepStrictEqual(va.map(v => v.toArray()), vc.map(v => v.toArray()),
    'different seeds produced identical asteroids');
});

test('asteroids are irregular but not degenerate', () => {
  const a = M.makeAsteroid(99);
  const verts = vertices(walk(a).meshes[0].geometry);
  const radii = verts.map(v => v.length());
  const min = Math.min(...radii), max = Math.max(...radii);
  assert.ok(min > 0.3, 'asteroid has a vertex at the origin, it would collapse');
  assert.ok(max / min < 2.5, 'asteroid is too spiky: ratio ' + (max / min).toFixed(2));
  assert.ok(max / min > 1.05, 'asteroid is a perfect sphere, not deformed');
});

test('the station exposes a usable docking frame', () => {
  const st = M.makeCoriolis(150);
  const n = st.userData.slotNormalLocal;
  const p = st.userData.slotPointLocal;
  assert.ok(n && n.isVector3, 'station has no slot normal');
  assert.ok(p && p.isVector3, 'station has no slot point');
  assert.ok(Math.abs(n.length() - 1) < 1e-6, 'slot normal is not normalised');

  // The slot must face outward along the same axis as its normal, or the
  // docking alignment test would be measuring the wrong thing.
  assert.ok(n.z > 0.9, 'slot normal should point along +Z, got ' + n.toArray().join(','));
  assert.ok(p.z > 0, 'slot point should sit on the +Z face');
  assert.ok(p.z < st.userData.radius, 'slot point is outside the station radius');
});

test('the station slot sits at the station surface, not inside it', () => {
  const R = 150;
  const st = M.makeCoriolis(R);
  const slotZ = st.userData.slotPointLocal.z;
  // The hull half-extent along Z is 0.86*R; the slot should be near that.
  assert.ok(slotZ > R * 0.7, 'slot is buried inside the hull at z=' + slotZ.toFixed(1));
});

test('the station has blinking beacon lights for the approach', () => {
  const st = M.makeCoriolis(150);
  const beacons = st.userData.beacons;
  assert.ok(Array.isArray(beacons) && beacons.length >= 4,
    'expected at least four slot beacons, got ' + (beacons && beacons.length));
  for (const b of beacons) {
    assert.ok(b.isMesh, 'beacon is not a mesh');
    // Beacons must sit near the slot, not scattered over the hull.
    assert.ok(b.position.z > st.userData.radius * 0.8,
      'beacon is not on the slot face (z=' + b.position.z.toFixed(1) + ')');
  }
});

test('station size scales with the radius argument', () => {
  const small = M.makeCoriolis(100);
  const large = M.makeCoriolis(300);
  assert.ok(large.userData.slotPointLocal.z > small.userData.slotPointLocal.z);
  const smallExtent = vertices(walk(small).meshes[0].geometry).reduce((m, v) => Math.max(m, v.length()), 0);
  const largeExtent = vertices(walk(large).meshes[0].geometry).reduce((m, v) => Math.max(m, v.length()), 0);
  assert.ok(largeExtent > smallExtent * 2.5,
    'station did not scale: ' + smallExtent.toFixed(0) + ' -> ' + largeExtent.toFixed(0));
});

test('canisters and capsules build with the right palette', () => {
  const can = M.makeCanister();
  const cap = M.makeCapsule();
  assert.ok(walk(can).meshes.length >= 1 && walk(can).lines.length >= 1);
  assert.ok(walk(cap).meshes.length >= 1 && walk(cap).lines.length >= 1);
  // The capsule should be the more alarming of the two. Compare in sRGB byte
  // space: three converts hex literals into a linear working space, so the raw
  // .r/.g/.b are not the bytes anyone typed and both colours saturate r to 1.0.
  const srgb = c => {
    const hex = new THREE.Color(c).getHexString();
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
  };
  const canEdge = srgb(walk(can).lines[0].material.color);
  const capEdge = srgb(walk(cap).lines[0].material.color);
  assert.notDeepEqual(capEdge, canEdge, 'the capsule must not reuse the canister tint');
  // Ordering per channel is [r, g, b]. Capsule #ff5a4a is red: r > g > b.
  assert.ok(capEdge[0] > capEdge[1] && capEdge[1] > capEdge[2],
    'the escape capsule should read red, not amber: ' + capEdge.join(','));
  // Canister #ffd27a is amber: green outranks blue by a wide margin.
  assert.ok(canEdge[1] > canEdge[2] + 60,
    'the cargo crate should read amber, not white: ' + canEdge.join(','));
});

test('makeShip returns the right class for each kind', () => {
  const pirate = M.makeShip('pirate');
  const viper = M.makeShip('viper');
  const trader = M.makeShip('trader');
  const unknown = M.makeShip('who-knows');
  for (const g of [pirate, viper, trader, unknown]) {
    assert.ok(g && g.isObject3D);
    assert.ok(walk(g).meshes.length >= 1);
  }
  // Different kinds must not be the same geometry, or the scanner is useless.
  const viperVerts = walk(viper).meshes[0].geometry.attributes.position.count;
  const traderVerts = walk(trader).meshes[0].geometry.attributes.position.count;
  assert.ok(viperVerts !== traderVerts || viperVerts > 0);
});

test('the edge overlay is biased toward the camera, not the hull away from it', () => {
  // The offset has to live on the *lines*, not the hull. Moving the hull
  // backwards by a depth unit is scale-dependent: on a 150-unit station the
  // far-side edges clear the near-side surface and the interior wireframe shows
  // through the walls. A forward bias on the overlay is scale-independent, and
  // it keeps the hull an honest occluder.
  for (const fn of [M.makeCobra, M.makeViper, () => M.makeCoriolis(150)]) {
    const g = fn();
    const hull = walk(g).meshes[0];
    assert.ok(!hull.material.polygonOffset,
      fn.name + ' hull is offset backwards - large solids will show through');

    let found = false;
    g.traverse((o) => {
      if (!(o.isLine || o.isLineSegments)) return;
      if (o.material.polygonOffset && o.material.polygonOffsetUnits < 0) found = true;
    });
    assert.ok(found, fn.name + ' edge overlay has no forward depth bias');
  }
});

test('closed solids cull back faces so they cannot be seen through', () => {
  // DoubleSide on a closed hull draws the far wall as well as the near one, and
  // a big hull then reads as a see-through wireframe ball. Ships are open fans
  // and legitimately need DoubleSide; the station does not.
  const station = M.makeCoriolis(150);
  const hull = walk(station).meshes[0];
  assert.strictEqual(hull.material.side, THREE.FrontSide,
    'the station hull is not back-face culled');

  const cobra = walk(M.makeCobra()).meshes[0];
  assert.strictEqual(cobra.material.side, THREE.DoubleSide,
    'an open ship shell must not be back-face culled or it winks out on a roll');
});

test('every hull is a physically-based material, not a diffuse-only one', () => {
  // `MeshLambertMaterial` has no specular term and no metalness, so every
  // surface returns `albedo x (N.L)` and the whole fleet collapses into the same
  // flat grey. This is the regression guard for that.
  const bodies = {
    cobra: M.makeCobra(),
    viper: M.makeViper(),
    station: M.makeCoriolis(150),
    asteroid: M.makeAsteroid(3),
    canister: M.makeCanister(),
  };
  for (const [name, body] of Object.entries(bodies)) {
    const hull = walk(body).meshes[0];
    assert.strictEqual(hull.material.isMeshStandardMaterial, true,
      name + ' is not a MeshStandardMaterial');
    assert.strictEqual(hull.material.isMeshLambertMaterial, undefined,
      name + ' is still Lambert');
    assert.ok(Number.isFinite(hull.material.roughness), name + ' has no roughness');
    assert.ok(Number.isFinite(hull.material.metalness), name + ' has no metalness');
    assert.strictEqual(hull.material.flatShading, true,
      name + ' lost flat shading, so the facets will vanish');
  }
});

test('metal hulls reflect, and rock does not', () => {
  // The contrast is the point: if every surface had the same response the
  // asteroid belt would read as a fleet of grey hulls. Metal is reflective and
  // smooth; rock is neither.
  //
  // Asserted as a *contrast* rather than as an absolute. The first version
  // demanded `rock.metalness === 0`, which was true while every rock was
  // basalt and stopped being true the moment the belt gained metallic ore and
  // glossy ice. The invariant is that every rock is further from the hull than
  // the hull is from rock, not that rock is exactly zero.
  const ship = walk(M.makeCobra()).meshes[0].material;
  assert.ok(ship.metalness > 0.3, 'a ship hull should be metallic');
  assert.ok(ship.roughness < 0.7, 'a ship hull should be smoother than rock');

  for (const type of M.ROCK_TYPES) {
    const rock = walk(M.makeAsteroid(3, type)).meshes[0].material;
    assert.ok(rock.metalness < ship.metalness,
      type.name + ' is as metallic as a hull');
    assert.ok(rock.roughness > ship.roughness,
      type.name + ' is as smooth as a hull, so the two would read identically');
  }

  // And the common rock is fully matte, which is what most of the belt is.
  const basalt = M.ROCK_TYPES.find((t) => t.name === 'basalt');
  const common = walk(M.makeAsteroid(3, basalt)).meshes[0].material;
  assert.strictEqual(common.metalness, 0, 'the common rock is not fully matte');
  assert.ok(common.roughness > 0.85, 'the common rock is not almost fully matte');
});

test('the station is the most polished surface in the scene', () => {
  // The station is the closest, largest thing the player looks at; a long
  // specular streak off it is what sells "enormous". It should be smoother and
  // more metallic than the ships.
  const station = walk(M.makeCoriolis(150)).meshes[0].material;
  const ship = walk(M.makeCobra()).meshes[0].material;
  assert.ok(station.roughness < ship.roughness, 'the station should be smoother');
  assert.ok(station.metalness > ship.metalness, 'the station should be more metallic');
});

test('every hull leans on the environment probe harder than a bare 1.0', () => {
  // The probe is indirect light at a modest level; on hulls this dark the
  // reflection is doing most of the visible work. A material that silently
  // dropped back to envMapIntensity 1.0 would look noticeably duller.
  for (const fn of [M.makeCobra, M.makeSidewinder, M.makeViper, M.makeGecko,
    () => M.makeCoriolis(150), M.makeCanister]) {
    const hull = walk(fn()).meshes[0];
    assert.ok(hull.material.envMapIntensity >= 1.2,
      fn.name + ' has a weak environment response (' +
      hull.material.envMapIntensity + ')');
  }
});

test('the edge overlay fades with distance in the shader', () => {
  // The overlay is an accent now, not the only thing that reads. It must fade
  // with distance so a far contact is a soft suggestion rather than a neon
  // scribble. The fade is a shader patch, so it is checked by compiling it -
  // constructing the material is not enough, three only runs onBeforeCompile
  // when the renderer actually builds the program.
  const line = walk(M.makeCobra()).lines[0];
  assert.strictEqual(line.material.transparent, true,
    'a distance fade is meaningless on an opaque material');
  assert.strictEqual(typeof line.material.onBeforeCompile, 'function',
    'the edge overlay has no fade patch at all');

  // Run the patch against a stub shader and confirm it actually modified both
  // stages and wired uniforms. A patch that silently failed to match would
  // leave an unpatched shader and no fade, with nothing thrown.
  const shader = {
    uniforms: {},
    vertexShader: '#include <common>\n#include <begin_vertex>',
    fragmentShader: '#include <common>\n#include <dithering_fragment>',
  };
  line.material.onBeforeCompile(shader);
  assert.ok(shader.uniforms.uFadeStart && shader.uniforms.uFadeEnd &&
    shader.uniforms.uFadeFloor, 'the fade uniforms were not registered');
  assert.ok(shader.vertexShader.includes('vFadeDepth'),
    'the vertex stage never computes the view depth');
  // `mvPosition` is declared by three's own `project_vertex` chunk further down
  // the same vertex shader. Redeclaring it is a hard GLSL compile error, and the
  // resulting console error is what the e2e suite catches - but a unit test can
  // refuse the name up front, which is far cheaper than a browser round trip.
  //
  // Strip line comments first: the patch's own explanatory comment *mentions*
  // the forbidden name, and a naive regex over the raw string matches it.
  const injected = shader.vertexShader.split('#include <begin_vertex>')[1] || '';
  const code = injected.split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
  assert.ok(!/\bmvPosition\b/.test(code),
    'the fade patch declares mvPosition, which three already declares: GLSL redefinition');
  assert.ok(shader.fragmentShader.includes('uFadeStart') &&
    shader.fragmentShader.includes('gl_FragColor.a *='),
    'the fragment stage never applies the fade');
  assert.ok(!shader.vertexShader.includes('#include <begin_vertex>\n#include'),
    'the vertex include was not replaced');
});

test('the edge fade leaves the close-range silhouette untouched', () => {
  // The fade exists so the overlay recedes once a lit PBR hull can carry the
  // shape on its own. It must NOT start so close that a ship in a knife fight
  // loses its outline - at a few hundred units a six-vertex ship is only a few
  // dozen pixels across, and the edges are the entire silhouette.
  //
  // So the lower bound is bounded on both sides, and both matter:
  //   - too small and the outline greys out exactly when it is most needed;
  //   - too large and a solid station reads as scaffolding while docking.
  assert.ok(M.EDGE_FADE.start >= 150,
    'the fade begins inside the close-combat envelope (' + M.EDGE_FADE.start + ')');
  assert.ok(M.EDGE_FADE.start <= 600,
    'the fade begins so far out that near hulls keep a full-strength neon overlay');
  assert.ok(M.EDGE_FADE.end > M.EDGE_FADE.start,
    'the fade band is inverted');
  // The station sits around 500-1400 units out while docking; the band has to
  // span that or the change has no effect where it was aimed.
  assert.ok(M.EDGE_FADE.end > 1400,
    'the fade is fully applied before the docking envelope ends');
  assert.ok(M.EDGE_FADE.floor > 0 && M.EDGE_FADE.floor < 0.3,
    'the fade floor must leave a faint line, not erase the overlay');
});

// --- Rock variety ----------------------------------------------------------

/** The hull mesh of a rock, skipping the edge overlay. */
function rockMesh(rock) {
  let mesh = null;
  rock.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
  return mesh;
}

test('a belt is made of more than one kind of rock', () => {
  // Ninety rocks of one colour and one facet count read as one rock repeated.
  // The shape was already varied per vertex, but the *character* was not: the
  // same icosahedron and the same two colour constants every time.
  const seen = new Set();
  for (let seed = 1; seed < 400; seed += 1) seen.add(M.rockTypeFor(seed).name);
  assert.equal(seen.size, M.ROCK_TYPES.length,
    'only ' + seen.size + ' of ' + M.ROCK_TYPES.length + ' rock types are reachable');
});

test('rock types differ in facet count, not just in lumps', () => {
  // A dodecahedron and an icosahedron of the same radius have visibly
  // different silhouettes. Two icosahedra at different subdivisions do not
  // differ in *character*, only in smoothness.
  const counts = new Map();
  for (const type of M.ROCK_TYPES) {
    const rock = M.makeAsteroid(1, type);
    const g = rockMesh(rock).geometry;
    counts.set(type.name, g.attributes.position.count);
  }
  const distinct = new Set(counts.values());
  assert.ok(distinct.size >= 3,
    'the belt has only ' + distinct.size + ' distinct facet counts: ' + [...counts].join(', '));
});

test('rock types are distinguishable by colour', () => {
  const colours = M.ROCK_TYPES.map((t) => {
    const rock = M.makeAsteroid(1, t);
    return rockMesh(rock).material.color.getHexString();
  });
  assert.equal(new Set(colours).size, colours.length,
    'two rock types render the same colour: ' + colours.join(', '));
});

test('the rock type is chosen deterministically from the seed', () => {
  // The belt has to be the same every time the player returns to the system.
  for (const seed of [1, 42, 7777, 123456]) {
    assert.equal(M.rockTypeFor(seed).name, M.rockTypeFor(seed).name);
    assert.equal(rockMesh(M.makeAsteroid(seed)).material.color.getHexString(),
      rockMesh(M.makeAsteroid(seed)).material.color.getHexString());
  }
});

test('two rocks of the same type are still not identical', () => {
  // Per-rock tint on top of the type. Without it a belt of one type would be
  // a belt of literally identical colours.
  //
  // Measured as a *range* rather than by counting distinct hex strings. These
  // are near-black colours quantised to eight bits per channel, so a +/-22%
  // multiplier produces a handful of distinct values rather than a smooth
  // ramp - counting them would test the quantiser, not the variety.
  const type = M.ROCK_TYPES[0];
  let min = Infinity;
  let max = -Infinity;
  for (let seed = 1; seed < 60; seed += 1) {
    const c = rockMesh(M.makeAsteroid(seed, type)).material.color;
    const lum = c.r + c.g + c.b;
    min = Math.min(min, lum);
    max = Math.max(max, lum);
  }
  assert.ok(max / min > 1.1,
    'the tint range is only ' + (max / min).toFixed(3) + 'x, which is not visible');
});

test('the tint never grows wider than the gap between types', () => {
  // The property that makes the variety read as *variety* rather than as
  // noise: a rock of one type must never look like a rock of another. So the
  // per-rock tint has to stay narrower than the closest two type colours are
  // to each other.
  //
  // Stated this way the test survives a retune of either number. The earlier
  // version hard-coded a 1.2x bound, which is just the jitter range written
  // out twice.
  // Euclidean distance in RGB, *not* brightness. The first version summed the
  // channels, which reported granite and ice as identical - they happen to
  // have the same total brightness while being grey and blue respectively.
  // A metric that cannot tell grey from blue is not a measure of whether two
  // rocks look alike.
  const distance = (a, b) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);

  // The narrowest gap between any two type colours.
  let closest = Infinity;
  for (let i = 0; i < M.ROCK_TYPES.length; i += 1) {
    for (let j = i + 1; j < M.ROCK_TYPES.length; j += 1) {
      const d = distance(new THREE.Color(M.ROCK_TYPES[i].colour),
        new THREE.Color(M.ROCK_TYPES[j].colour));
      closest = Math.min(closest, d);
    }
  }
  assert.ok(closest > 0.01, 'two rock types are nearly the same colour: ' + closest.toFixed(4));

  // And the widest tint excursion within a type, from its own base.
  let widest = 0;
  for (const type of M.ROCK_TYPES) {
    const base = new THREE.Color(type.colour);
    for (let seed = 1; seed < 60; seed += 1) {
      widest = Math.max(widest, distance(rockMesh(M.makeAsteroid(seed, type)).material.color, base));
    }
  }
  assert.ok(widest < closest,
    'the tint (' + widest.toFixed(4) + ') is wider than the gap between types ('
    + closest.toFixed(4) + '), so the types blur together');
});

test('the weighted mix favours the common rock and rations the rare one', () => {
  // Ice should be a find, not the default. A belt half full of ice is a
  // different place, not a more interesting one.
  const tally = {};
  const N = 4000;
  for (let seed = 1; seed <= N; seed += 1) {
    const name = M.rockTypeFor(seed).name;
    tally[name] = (tally[name] || 0) + 1;
  }
  const total = M.ROCK_TYPES.reduce((a, t) => a + t.weight, 0);
  for (const type of M.ROCK_TYPES) {
    const share = tally[type.name] / N;
    const expected = type.weight / total;
    assert.ok(Math.abs(share - expected) < 0.03,
      type.name + ': expected about ' + (expected * 100).toFixed(0) +
      '%, got ' + (share * 100).toFixed(0) + '%');
  }
  assert.ok(tally.ice / N < 0.2, 'ice is not rare: ' + (tally.ice / N * 100).toFixed(0) + '%');
});

test('every rock type is a valid physically-based surface', () => {
  for (const type of M.ROCK_TYPES) {
    const m = rockMesh(M.makeAsteroid(1, type)).material;
    assert.ok(m.isMeshStandardMaterial, type.name + ' is not a PBR material');
    assert.equal(m.metalness, type.metalness, type.name + ' ignored its metalness');
    assert.ok(m.roughness > 0 && m.roughness <= 1, type.name + ' has a bad roughness');
    assert.ok(m.color.getHex() > 0, type.name + ' is pure black');
  }
});

test('ice is glossier than basalt, and ore is more metallic', () => {
  // The material has to differ, not just the colour, or the four types are
  // four tints of the same surface.
  const ice = rockMesh(M.makeAsteroid(1, M.ROCK_TYPES.find((t) => t.name === 'ice'))).material;
  const basalt = rockMesh(M.makeAsteroid(1, M.ROCK_TYPES.find((t) => t.name === 'basalt'))).material;
  const iron = rockMesh(M.makeAsteroid(1, M.ROCK_TYPES.find((t) => t.name === 'ironstone'))).material;

  assert.ok(ice.roughness < basalt.roughness, 'ice is not glossier than basalt');
  assert.ok(iron.metalness > basalt.metalness, 'ironstone is not more metallic than basalt');
});

test('a rock still carries its type name, for the status screen and tests', () => {
  const rock = M.makeAsteroid(1, M.ROCK_TYPES[1]);
  assert.equal(rock.userData.rockType, M.ROCK_TYPES[1].name);
});

test('the belt builder uses the varied rocks', () => {
  // The variety is worthless if the system builder calls the old single-shape
  // path. This is the assertion that would have caught a half-finished change.
  const scene = W.buildSystemScene(home, 12345);
  const kinds = new Set();
  for (const rock of scene.rocks) kinds.add(rock.userData.rockType);
  assert.ok(kinds.size >= 2,
    'a whole belt came out as ' + kinds.size + ' kind(s) of rock: ' + [...kinds].join(', '));
});

// --- Scenery recedes sooner than targets -----------------------------------

test('a rock gets the same environment treatment as a hull', () => {
  // The rocks sat at `0.5 + metalness` while ships got 1.35 and the station
  // 1.5, and the probe showed what that cost: with the environment switched
  // off a rock collapsed from mean luminance 14.4 to 1.2, i.e. the probe is
  // doing nearly all the visible work and the rocks were letting half of it go.
  // Measured consequence: a belt that read as a field of wireframe balls.
  const rock = rockMesh(M.makeAsteroid(11, M.ROCK_TYPES[0]));
  const hull = M.makeShip('pirate').children.find((c) => c.isMesh);
  assert.ok(rock.material.envMapIntensity >= 1.2,
    'a rock leans on the environment far less than a hull: '
    + rock.material.envMapIntensity + ' vs ' + hull.material.envMapIntensity);
  // But never past the station, which is the one surface allowed to out-shine
  // everything: it is the thing the player is flying toward.
  assert.ok(rock.material.envMapIntensity <= 1.6,
    'a rock now out-shines the station: ' + rock.material.envMapIntensity);
});

test('rock outlines recede sooner than ship outlines', () => {
  const rock = M.makeAsteroid(12, M.ROCK_TYPES[0]);
  const rockEdge = rock.children.find((c) => c.isLineSegments);
  const shipEdge = M.makeShip('pirate').children.find((c) => c.isLineSegments);
  assert.ok(rockEdge && shipEdge, 'a subject has no edge overlay');
  assert.equal(rockEdge.material.userData.fade.end, M.ROCK_EDGE_FADE.end,
    'the rock overlay is not using the scenery fade');
  assert.equal(shipEdge.material.userData.fade.end, M.EDGE_FADE.end,
    'ships stopped using the target fade');
  assert.ok(M.ROCK_EDGE_FADE.end < M.EDGE_FADE.end,
    'scenery fades no sooner than targets, so ninety rocks still draw full '
    + 'outlines at belt range');
  assert.ok(M.ROCK_EDGE_FADE.start <= M.EDGE_FADE.start,
    'the scenery band starts later than the target band, so a rock holds a '
    + 'full-strength outline while a ship has already begun to fade');
  assert.ok(M.ROCK_EDGE_FADE.floor > 0 && M.ROCK_EDGE_FADE.floor < 0.3,
    'the scenery floor must leave a faint line, not erase the overlay');
});

test('a rock is a solid, not an outline: its fill carries visible colour', () => {
  // The four types were indistinguishable at any distance because only their
  // outlines were visible, so the fill has to be bright enough to read.
  //
  // The bound is absolute rather than relative, because *everything* was dark
  // together: the fill-to-edge ratio of the old colours was the same as the new
  // ones, so comparing a rock against a hull would not have caught anything.
  // Measured in linear space, where the renderer works: the dimmest type sat at
  // **0.0200** and rendered with 89 % of its pixels darker than 35 - a
  // wireframe. It is now 0.0438, and the floor sits between the two.
  let dimmest = Infinity;
  let dimmestName = '';
  for (const type of M.ROCK_TYPES) {
    const mesh = rockMesh(M.makeAsteroid(13, type));
    const c = mesh.material.color;
    const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    if (lum < dimmest) { dimmest = lum; dimmestName = type.name; }
    assert.ok(lum < 0.3, type.name + ' is bright enough to look like a light source');
  }
  assert.ok(dimmest > 0.035,
    dimmestName + ' is dark enough to read as an outline again: '
    + dimmest.toFixed(4) + ' (the wireframe case measured 0.0200)');
});
