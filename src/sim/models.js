/**
 * Procedural ship and station geometry.
 *
 * The look is "retro-vector modernised", and that means three specific things
 * working together rather than a filter:
 *
 *   1. Faceted geometry - flat-shaded, low polygon counts. The original could
 *      only draw filled triangles, so ships are built from a handful of planes.
 *   2. Emissive edges - every hull carries a bright wireframe overlay. This is
 *      the actual vector lineage: the original drew edges and no fill, so the
 *      edges must be the part that reads at distance.
 *   3. Dark hulls - the fill exists to give the edges something to sit on and
 *      to catch light, not to be looked at. A bright hull would drown the
 *      edges and lose the whole aesthetic.
 *
 * Nose convention: all ships are modelled pointing along local +Z. The flight
 * model applies velocity along the local -Z axis for the *camera*, because the
 * camera looks down -Z, so a world-space ship must point at +Z to face forward.
 * Getting this backwards is the classic cause of "ships fly sideways" and the
 * tests in tests/geometry.test.js pin it.
 */
import * as THREE from 'three';
import * as R from '../logic/rng.js';

/**
 * Hull fill.
 *
 * Dark by design, but not as dark as it was. The colour-space trap bites here:
 * three r152+ reads a hex literal as sRGB and converts it into the linear
 * working space, so the bytes that reach the shader are not the bytes below.
 * Anything comparing these values must go through `getHexString()`.
 *
 * ## Why it was raised
 *
 * The fill was so dark that it stopped carrying anything, and the edge overlay
 * went back to being the whole picture - which is the exact regression the
 * distance fade was introduced to prevent. Measured on a pirate 500 units dead
 * ahead, over the pixels the ship actually covers (found by differencing a
 * frame with it against one without): mean luminance **18.2**, with **89 % of
 * its pixels darker than 35** and only 4 % above 110. In the frame it read as a
 * white outline with nothing inside it.
 *
 * Raised by 2.2x in *linear* albedo - which is why the bytes move by about
 * 1.5x, not 2.2x. The same factor and the same measurement apply to
 * `ROCK_TYPES`: the belt was a field of wireframe balls for the same reason,
 * and the four rock types the previous round introduced were indistinguishable
 * at any distance because only their outlines were visible.
 */
export const HULL_COLOUR = 0x364150;
/** The vector edge overlay. This is the silhouette the player actually reads. */
export const EDGE_COLOUR = 0x9fe8ff;

/** Edge tint for the escape capsule: hotter and redder than a cargo crate. */
export const CAPSULE_EDGE_COLOUR = 0xff5a4a;

/**
 * Default surface response for a hull: how rough, and how metallic.
 *
 * These are the two numbers that decide whether the fleet looks like painted
 * metal or like clay, so they are named rather than inlined at each call site.
 *
 * - `roughness` 0.42 gives a *broad* highlight rather than a mirror. A polished
 *   hull would show a sharp image of the sky, which on faceted low-poly geometry
 *   reads as noise; a rough one shows the sky as a broad sheen, which is what
 *   makes the shape turn.
 * - `metalness` 0.55 is a metal-painted composite, not a pure mirror. Pure
 *   metal (1.0) has no diffuse term at all, so the hull would go nearly black
 *   wherever the probe is dim - the opposite of the intended look. Half-metal
 *   keeps a diffuse body *and* a real specular reflection.
 */
export const HULL_ROUGHNESS = 0.42;
export const HULL_METALNESS = 0.55;

/**
 * Shared hull material. Flat shading is essential: smooth normals would make
 * the facets vanish and the shapes read as blobs.
 *
 * This is a `MeshStandardMaterial`, not the `MeshLambertMaterial` it used to
 * be. Lambert has no specular term and no metalness, so every surface returned
 * `albedo x (N.L)` and nothing else - which is why the station, the rocks and
 * the ships all collapsed into the same flat grey-brown despite having
 * different colours. There was only one variable in the whole fleet: how much
 * light happened to land on it.
 *
 * `MeshStandardMaterial` needs an environment to reflect. Without one, metal
 * renders **black** - see `src/sim/environment.js`, which supplies the probe and
 * is therefore a hard dependency of these materials, not an optional extra.
 *
 * The hull colour is still deliberately dark. This is a vector game: the bright
 * `EdgesGeometry` overlay draws the silhouette and the fill exists to catch
 * light. The difference now is that the fill catches it *believably* - a facet
 * turned toward the star shows a warm sheen, one turned away picks up the cool
 * zenith of the probe, and the band sweeps across the hull as it rolls.
 *
 * `side` defaults to `FrontSide`, which is the correct choice for a *closed*
 * solid: with `DoubleSide` the far wall is drawn as well as the near one and a
 * big hull (the station especially) reads as a see-through wireframe ball,
 * because nothing occludes the interior. Only the open triangle-fan ships still
 * ask for `DoubleSide`, and they pass it explicitly - see `shell`.
 */
export function hullMaterial(colour, side, overrides) {
  const mat = new THREE.MeshStandardMaterial({
    color: colour === undefined ? HULL_COLOUR : colour,
    roughness: HULL_ROUGHNESS,
    metalness: HULL_METALNESS,
    flatShading: true,
    side: side === undefined ? THREE.FrontSide : side,
    // `envMapIntensity` slightly above 1 leans on the probe a little harder than
    // a strict physical reading would. On a fleet this dark the reflection is
    // doing most of the visible work, so it is deliberately boosted - the same
    // cheat as the star's HDR overdrive, for the same reason.
    envMapIntensity: 1.35,
    // No polygon offset here - see `edgeLines`. Biasing the hull back to keep
    // the wireframe from z-fighting is the wrong trade: on a large solid it
    // lets the far-side edges punch through the near-side surface.
  });
  // A few bodies are not metal at all (rock) or are differently finished (a
  // painted canister). Rather than a second factory, they override the two
  // numbers that carry the surface response.
  if (overrides) Object.assign(mat, overrides);
  return mat;
}

/**
 * The default edge-fade band, in world units.
 *
 * The lower bound is the interesting number. It used to start at 900, which on a
 * PBR hull turned out to be too far out: the station is typically 500-1400 units
 * away while docking, and at those distances a lit `MeshStandardMaterial` hull is
 * already perfectly legible, so the overlay arrived at full strength exactly
 * where it was no longer needed and made a solid object read as scaffolding.
 *
 * Starting the fade at 260 keeps the overlay at full strength through the
 * genuinely hard cases - a contact a few hundred units out, where a six-vertex
 * ship is a few dozen pixels across and the edges *are* the silhouette - and
 * lets it recede as the filled hull takes over.
 */
export const EDGE_FADE = { start: 260, end: 3400, floor: 0.14 };

/**
 * The same fade, for scenery.
 *
 * Rocks are not targets. The wide band above exists because a six-vertex ship
 * filling a third of the screen needs its facets spelled out, and because a
 * contact a few hundred units out has to stay legible - at 500 units a ship is
 * about forty pixels across and the outline genuinely is the silhouette. A rock
 * needs neither: it is something the commander flies past, and ninety of them
 * drawing near-full-strength outlines is what made the belt read as a field of
 * wireframe balls.
 *
 * So the band is much tighter. Measured opacity at the fade's own scale: ~0.86
 * at 300 units (a rock you are about to hit still reads as a solid), ~0.60 at
 * 600, ~0.38 at 800, and the 0.14 floor from 1200 out - by which point the lit
 * face carries it and the outline is a suggestion rather than the whole
 * picture. The band ends where the belt begins, which is the point.
 */
export const ROCK_EDGE_FADE = { start: 150, end: 1200, floor: 0.14 };

/**
 * Edge overlay for a geometry.
 *
 * Pulled toward the camera with a negative polygon offset so it sits on top of
 * the hull it outlines without z-fighting. The offset belongs *here* rather than
 * on the hull: pushing the hull backwards makes the far-side edges clear the
 * near-side surface on a large solid, so a 150-unit station draws its own
 * interior wireframe through its walls. Nudging the lines forward by a fixed
 * depth bias is scale-independent and keeps the hull a solid occluder.
 *
 * The bias is intentionally small. A generous offset would lift the *far* side
 * of the hull over the near side again, which is the same artefact by another
 * route; one depth unit is enough to beat float error at the camera's
 * near/far ratio without moving the line a visible distance.
 *
 * ## Distance fade
 *
 * The second half of "the outline moves to where it belongs": the overlay is
 * now an *accent*, not the only thing that reads. It fades with distance, so a
 * far-off contact is a soft suggestion of a shape rather than a bright neon
 * scribble, and the filled hull carries the silhouette. Near the camera the
 * line comes back to full strength and does what it is genuinely needed for -
 * making a six-vertex ship legible when it fills a third of the screen and its
 * facets are otherwise ambiguous under a moving light.
 *
 * This is done in the shader rather than by swapping materials on a distance
 * trigger, because a per-frame material swap on 90 rocks and a dozen ships is
 * both a churn and a visible pop. `onBeforeCompile` costs one varying and one
 * `mix` in the fragment shader.
 *
 * `fadeStart`/`fadeEnd` are in world units. The band is wide and deliberately
 * starts well beyond the station's 150-unit radius: nothing the player is
 * actively flying around should be faded at all.
 */
export function edgeLines(geometry, colour, fade) {
  const edges = new THREE.EdgesGeometry(geometry, 24);
  const mat = new THREE.LineBasicMaterial({
    color: colour === undefined ? EDGE_COLOUR : colour,
    transparent: true,
    opacity: 0.9,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });

  const start = fade && fade.start !== undefined ? fade.start : EDGE_FADE.start;
  const end = fade && fade.end !== undefined ? fade.end : EDGE_FADE.end;
  const floor = fade && fade.floor !== undefined ? fade.floor : EDGE_FADE.floor;

  // The band is recorded on the material as well as compiled into the shader.
  // The uniforms only exist once `onBeforeCompile` has run, which needs a real
  // GL context, so without this a test could not tell a rock's overlay from a
  // ship's - and "scenery recedes sooner than targets" is exactly the kind of
  // claim that quietly stops being true.
  mat.userData.fade = { start: start, end: end, floor: floor };

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFadeStart = { value: start };
    shader.uniforms.uFadeEnd = { value: end };
    shader.uniforms.uFadeFloor = { value: floor };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vFadeDepth;')
      .replace('#include <begin_vertex>',
        `#include <begin_vertex>
         // View-space depth of this vertex. The name must NOT be mvPosition:
         // three's own project_vertex chunk declares exactly that variable
         // later in the same shader, and redeclaring it is a hard GLSL compile
         // error ("redefinition"). A unit test cannot see this - only building
         // the program can - which is why the e2e console check caught it.
         vec4 fadeViewPos = modelViewMatrix * vec4(position, 1.0);
         vFadeDepth = -fadeViewPos.z;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\nvarying float vFadeDepth;\nuniform float uFadeStart;\nuniform float uFadeEnd;\nuniform float uFadeFloor;')
      .replace('#include <dithering_fragment>',
        `#include <dithering_fragment>
         float fadeT = clamp((vFadeDepth - uFadeStart) / max(1.0, uFadeEnd - uFadeStart), 0.0, 1.0);
         // Smoothstep rather than a linear ramp: a linear fade is visible as a
         // hard band where it begins and ends on a long hull like the station.
         fadeT = fadeT * fadeT * (3.0 - 2.0 * fadeT);
         gl_FragColor.a *= mix(1.0, uFadeFloor, fadeT);`);
  };

  const lines = new THREE.LineSegments(edges, mat);
  lines.renderOrder = 2;
  return lines;
}

/**
 * Hull + edges as one group. The unit of every ship in the game.
 *
 * The ships are open triangle fans with no bottom, so they stay `DoubleSide`:
 * cull the back faces and a hard roll makes the hull wink out for a frame.
 * The station is a closed solid and does not go through here.
 */
/**
 * A ship's engine flame: an additive cone at the tail that reads as thrust.
 *
 * ## Why a cone and not a sprite
 *
 * A billboard sprite always faces the camera, so it would keep facing you when
 * you overtake a ship and see it from the front - and a flame visible from the
 * front is nonsense. A cone is oriented in ship space: it points out of the
 * tail along local -Z, so it foreshortens to nothing as you come round to the
 * nose. The shape does the work and no per-frame billboard maths is needed.
 *
 * ## Why the length is a `userData` handle
 *
 * The flame has to respond to thrust, and thrust lives in the flight/logic
 * layer, not here. Rather than have `models.js` reach into the AI, the group is
 * returned with `userData.flame` pointing at it, and the traffic loop scales
 * `scale.z` between `FLAME.idle` and `FLAME.burn`. Idle is deliberately not
 * zero: a drifting ship still glows, and a completely dark tail reads as a
 * wreck rather than a vessel.
 *
 * `side: BackSide` is the small trick that makes it cheap. A cone drawn
 * `FrontSide` shows its near wall; drawn `BackSide` the far wall is visible
 * through the near one and the two additively, which reads as a hot core
 * without a second mesh.
 */
export function makeFlame() {
  // A cone whose apex is at the tail and whose base points backwards, so the
  // wide end is the far, cooler part - the opposite of a solid, which is what
  // the eye expects from exhaust.
  const geo = new THREE.ConeGeometry(FLAME.radius, FLAME.length, 8, 1, true);
  // Cone points +Y by default; turn it to point along -Z (out of the tail).
  geo.rotateX(-Math.PI / 2);
  // Move the origin to the apex so scaling `z` grows the flame *backwards*
  // from the nozzle rather than out of both ends.
  geo.translate(0, 0, -FLAME.length / 2);

  const mat = new THREE.MeshBasicMaterial({
    color: FLAME.colour,
    transparent: true,
    opacity: FLAME.opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.BackSide,
    fog: false,
  });

  const flame = new THREE.Mesh(geo, mat);
  flame.name = 'flame';
  flame.renderOrder = 3;
  return flame;
}

/** Tuning for the engine flame. `length` is in the ship's own local units. */
export const FLAME = {
  radius: 0.42,
  length: 2.6,
  colour: 0x7fd4ff,
  opacity: 0.62,
  // Scale along local Z. Idle keeps a pilot light; burn is full thrust.
  idle: 0.18,
  burn: 1.0,
};

export function shell(geometry, hullCol, edgeCol, overrides) {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(geometry, hullMaterial(hullCol, THREE.DoubleSide, overrides));
  mesh.renderOrder = 1;
  group.add(mesh);
  group.add(edgeLines(geometry, edgeCol));
  return group;
}

/**
 * Hull + edges + engine flame. Every NPC ship is built through this.
 *
 * The flame is attached at the tail of the *geometry's own bounding box*, not at
 * a hardcoded z, so it sits right for every hull shape without per-model tuning.
 */
export function shipShell(geometry, hullCol, edgeCol) {
  const group = shell(geometry, hullCol, edgeCol);
  const flame = makeFlame();
  // Sit the nozzle on the hull's own rearmost vertex. The hulls are hand-built
  // at wildly different scales (a Sidewinder's tail is ~1.2 units back, a
  // Cobra's ~6), so a hardcoded offset that looks right on one fires out of the
  // cockpit on another. Note this is the MINIMUM z: the nose convention is +Z,
  // so the tail lives at the -Z end of the bounding box.
  group.add(flame);
  flame.position.z = hullTailZ(geometry);
  group.userData.flame = flame;
  group.userData.flameRest = FLAME.idle;
  flame.scale.z = FLAME.idle;
  return group;
}

/** Rearmost vertex of a hull, i.e. the least z. Nose convention is +Z. */
export function hullTailZ(geometry) {
  const pos = geometry.attributes && geometry.attributes.position;
  if (!pos) return 0;
  let min = Infinity;
  for (let i = 0; i < pos.count; i += 1) min = Math.min(min, pos.getZ(i));
  if (!Number.isFinite(min)) return 0;
  return min;
}

/**
 * Cobra Mk III - the player ship, and the silhouette everyone recognises.
 * A flattened wedge with a raised dorsal spine and two swept wings.
 */
export function makeCobra() {
  const g = new THREE.BufferGeometry();
  // Vertices: nose, two rear corners, dorsal ridge, wingtips, belly.
  const v = new Float32Array([
    // nose
    0, 0.0, 5.2,
    // rear top centre
    0, 0.9, -3.4,
    // rear left, rear right
    -2.0, -0.5, -3.6, 2.0, -0.5, -3.6,
    // dorsal ridge mid
    0, 1.5, -0.6,
    // wingtips (swept back and down)
    -4.6, -0.9, -3.0, 4.6, -0.9, -3.0,
    // belly centre
    0, -1.1, -1.0,
  ]);
  const idx = [
    // upper front hull
    0, 4, 1,
    // left upper
    0, 1, 4,
    // upper left wing
    0, 4, 5, 4, 1, 5,
    // upper right wing
    0, 6, 4, 4, 6, 1,
    // lower left
    0, 7, 2, 0, 5, 7, 5, 2, 7,
    // lower right
    0, 3, 7, 0, 7, 6, 6, 7, 3,
    // rear faces
    1, 2, 5, 1, 5, 6, 1, 6, 3, 1, 3, 2,
    // belly rear
    2, 3, 7,
  ];
  g.setAttribute('position', new THREE.BufferAttribute(v, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return shipShell(g);
}

/**
 * Sidewinder - the small, cheap, irritating interceptor. Pyramid with fins.
 * Used for light pirates: fast, weak, comes in numbers.
 */
export function makeSidewinder() {
  const g = new THREE.BufferGeometry();
  const v = new Float32Array([
    0, 0, 3.4,          // nose
    -1.6, -0.7, -2.4, 1.6, -0.7, -2.4,   // rear lower
    0, 1.1, -2.2,       // rear top
    -3.0, -0.2, -1.4, 3.0, -0.2, -1.4,   // fins
  ]);
  const idx = [
    0, 1, 3, 0, 3, 2,
    0, 1, 2,
    0, 4, 1, 0, 2, 5,
    1, 4, 3, 3, 4, 1,
    2, 3, 5, 5, 3, 2,
    1, 2, 3,
  ];
  g.setAttribute('position', new THREE.BufferAttribute(v, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return shipShell(g);
}

/**
 * Viper - the police interceptor. Deliberately the most angular and hostile
 * silhouette in the game, because it is the ship you least want to see.
 */
export function makeViper() {
  const g = new THREE.BufferGeometry();
  const v = new Float32Array([
    0, 0.1, 6.0,         // long nose
    -1.5, 0.6, 0.0, 1.5, 0.6, 0.0,    // mid top
    -2.2, -0.8, -2.2, 2.2, -0.8, -2.2, // mid lower
    0, 1.4, -3.2,        // rear top
    -3.6, 0.0, -3.4, 3.6, 0.0, -3.4,  // rear wings
    0, -1.0, -3.0,       // rear belly
  ]);
  const idx = [
    0, 1, 2,
    0, 3, 1, 0, 2, 4,
    0, 4, 5, 0, 4, 6,
    0, 1, 5, 0, 5, 3, 0, 4, 2, 0, 2, 6,
    1, 3, 7, 1, 7, 4, 4, 7, 5,
    2, 4, 8, 2, 8, 3, 8, 4, 6,
    3, 8, 5, 5, 8, 4,
    4, 5, 6, 6, 5, 3,
    3, 8, 7, 7, 8, 4,
  ];
  g.setAttribute('position', new THREE.BufferAttribute(v, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return shipShell(g);
}

/**
 * Gecko - the trader. Chunky, wingless, non-threatening: it should look like
 * cargo with an engine, because that is what it is.
 */
export function makeGecko() {
  const g = new THREE.BufferGeometry();
  const v = new Float32Array([
    0, 0, 4.6,           // 0 nose
    -2.2, 0, 1.2, 2.2, 0, 1.2,      // 1,2 forward sides
    -2.4, 1.2, -2.0, 2.4, 1.2, -2.0, // 3,4 rear top corners
    -2.4, -1.2, -2.0, 2.4, -1.2, -2.0, // 5,6 rear bottom corners
    0, 0, -4.2,          // 7 tail
  ]);
  const idx = [
    // nose fan, top face (0-1-3-2 is the only planar quad on this hull)
    0, 1, 3, 0, 3, 2,
    // top rear deck, split by the tail point
    3, 1, 4, 4, 1, 2,
    3, 4, 7,
    // starboard flank (2 -> 4 -> 6 -> tail)
    2, 6, 7, 2, 7, 4,
    // port flank mirrored
    1, 3, 7, 1, 7, 5,
    // underbelly deck
    6, 4, 7, 5, 6, 7,
    // belly fan from the nose down to the underside
    0, 6, 2,
    0, 1, 5, 0, 5, 6,
  ];
  g.setAttribute('position', new THREE.BufferAttribute(v, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return shipShell(g);
}

/** Cargo canister. A painted metal drum, scooped up for profit. */
export function makeCanister() {
  const g = new THREE.CylinderGeometry(0.9, 0.9, 2.2, 8, 1);
  g.rotateX(Math.PI / 2);
  return shell(g, 0x40472f, 0xffd27a, { roughness: 0.38, metalness: 0.6 });
}

/** Escape capsule. Bright and obvious, because it is your last chance. */
export function makeCapsule() {
  const g = new THREE.CapsuleGeometry(0.7, 1.2, 4, 8);
  g.rotateX(Math.PI / 2);
  return shell(g, 0x563232, CAPSULE_EDGE_COLOUR);
}

/**
 * Asteroid. Deterministically deformed from a seed so the same rock looks the
 * same every time you visit, and so a field is never a row of clones.
 *
 * Rock is the one surface in the game that is emphatically *not* metal, so it
 * gets its own material rather than the shared hull one: high roughness (a rock
 * scatters light in every direction, it has no sheen) and zero metalness. That
 * contrast is what stops the belt reading as a fleet of grey hulls - up close
 * the rocks are matte and the ships are slick, and the eye separates them at a
 * glance instead of having to look at the edge overlay.
 */
/**
 * The kinds of rock a belt is made of.
 *
 * Ninety rocks of one colour, one facet count and one silhouette read as *one
 * rock repeated*, which is what the belt looked like. The shape was already
 * varied - every vertex gets its own radial offset - but the character was
 * not, because every rock was built from the same icosahedron with the same
 * two colour constants.
 *
 * Three things vary now, and they are the three the eye actually uses:
 *
 *   facet count  a twelve-vertex icosahedron is chunky and angular, a
 *                twenty-vertex dodecahedron has wide pentagon faces, and a
 *                subdivided icosahedron is comparatively smooth
 *   colour       basalt, ironstone, granite and ice are distinguishable at a
 *                glance, and the belt stops reading as one material. The four
 *                are spread deliberately: the first set had granite and ice
 *                almost the same colour, close enough that the per-rock tint
 *                could push one into the other's territory
 *   surface      ice is glossy and metallic ore is not, so a rock catches the
 *                star differently depending on what it is made of
 *
 * `weight` is the share of the belt each type takes. Ice is deliberately rare:
 * a belt half full of ice is a different place, not a more interesting one.
 */
export const ROCK_TYPES = [
  {
    name: 'basalt', shape: 'icosa', detail: 1, weight: 38,
    colour: 0x413a32, edge: 0x8a7a66, roughness: 0.95, metalness: 0.0,
  },
  {
    name: 'ironstone', shape: 'dodeca', detail: 0, weight: 24,
    colour: 0x654b3a, edge: 0xa8845c, roughness: 0.78, metalness: 0.3,
  },
  {
    name: 'granite', shape: 'icosa', detail: 0, weight: 26,
    colour: 0x6c6c6c, edge: 0x9a9a9a, roughness: 0.88, metalness: 0.06,
  },
  {
    name: 'ice', shape: 'icosa', detail: 1, weight: 12,
    colour: 0x37536c, edge: 0x9fd8ee, roughness: 0.4, metalness: 0.08,
  },
];

/**
 * Pick a rock type from a seed, by weight. Deterministic.
 *
 * Uses the project's `mulberry32` rather than a hand-rolled step. The first
 * version advanced a linear congruential generator exactly once and took the
 * top bits, which for consecutive seeds lands in only two of the four buckets
 * - the belt came out basalt and granite, and the other two types were
 * unreachable. A single LCG step is not a hash.
 */
export function rockTypeFor(seed) {
  const roll = R.mulberry32((seed >>> 0) || 1)()
    * ROCK_TYPES.reduce((a, t) => a + t.weight, 0);
  let acc = 0;
  for (const type of ROCK_TYPES) {
    acc += type.weight;
    if (roll < acc) return type;
  }
  return ROCK_TYPES[0];
}

/** The base mesh for a type. Different facet counts, not just different lumps. */
function rockGeometryFor(type) {
  if (type.shape === 'dodeca') return new THREE.DodecahedronGeometry(1, type.detail);
  return new THREE.IcosahedronGeometry(1, type.detail);
}

export function makeAsteroid(seed, typeOverride) {
  const type = typeOverride || rockTypeFor(seed);
  const g = rockGeometryFor(type);
  const pos = g.attributes.position;
  const next = R.mulberry32((seed >>> 0) || 1);
  const offsets = new Array(pos.count).fill(0).map(() => 0.72 + next() * 0.6);
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(
      i,
      pos.getX(i) * offsets[i],
      pos.getY(i) * offsets[i],
      pos.getZ(i) * offsets[i]
    );
  }
  g.computeVertexNormals();

  // A per-rock tint on top of the type, so two basalt rocks side by side are
  // not literally the same colour. The range is wide enough to see and narrow
  // enough that the type stays readable: a belt of ninety wildly different
  // greys is not more interesting than a belt of one grey, just noisier.
  //
  // Note that the visible spread is smaller than the numbers suggest. These
  // are dark colours and the result is quantised to eight bits per channel, so
  // a sixteen percent multiplier on a near-black is a handful of distinct
  // values, not a continuous ramp. The test measures the range rather than
  // counting hex strings.
  const jitter = 0.84 + next() * 0.32;
  const colour = new THREE.Color(type.colour).multiplyScalar(jitter);

  const group = new THREE.Group();
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
    color: colour,
    roughness: Math.min(1, type.roughness * (0.92 + next() * 0.16)),
    metalness: type.metalness,
    flatShading: true,
    side: THREE.DoubleSide,
    // Same treatment as a hull, which the rocks never got. They sat at
    // `0.5 + metalness` while ships got 1.35 and the station 1.5, and the
    // probe showed what that cost: with the environment switched off, a rock
    // collapsed from mean luminance 14.4 to 1.2 - the probe is doing nearly all
    // the visible work, and the rocks were letting half of it go. Measured
    // consequence: a belt of wireframe balls, and four rock types that were
    // indistinguishable because only their outlines were visible.
    envMapIntensity: 1.35 + type.metalness * 0.5,
  }));
  mesh.renderOrder = 1;
  group.userData.rockType = type.name;
  group.add(mesh);
  // Scenery outlines recede sooner than target outlines. A rock is something
  // the commander flies past; a ship is something they have to see and shoot,
  // and a ship keeps the wider band. At belt range (800-1500 units) a rock now
  // drops to a few per cent opacity, so the lit face carries it instead of a
  // scribble of lines.
  group.add(edgeLines(g, type.edge, ROCK_EDGE_FADE));
  return group;
}

/**
 * Coriolis station - the docking target.
 *
 * A truncated cube, matching the original's shape, with one crucial addition:
 * the docking slot is a real object on the surface with a known normal, so the
 * docking check can test alignment against geometry rather than hardcode a
 * direction. `userData` carries the slot's local-space frame.
 */
export function makeCoriolis(radius) {
  const R = radius || 150;
  const group = new THREE.Group();

  // Truncated cube: the octahedron-ish solid the original used, built by
  // cutting the corners off a cube. Approximated with a low-detail
  // icosahedron scaled to a cube-ish silhouette is wrong; do it properly with
  // a box plus cut corners via a small custom vertex set.
  const g = new THREE.BufferGeometry();
  const o = R * 0.42;   // half-width of the octagon faces
  const h = R * 0.86;   // distance to the cut corners
  const v = new Float32Array([
    // top face (octagon approximated by 4 points + centre handled by tris)
    o, h, 0, 0, h, o, -o, h, 0, 0, h, -o,
    // bottom face
    o, -h, 0, 0, -h, o, -o, -h, 0, 0, -h, -o,
    // middle ring: 8 points
    o, o, h, o, -o, h, -o, -o, h, -o, o, h,     // +z face corners
    h, o, o, h, -o, o, h, -o, -o, h, o, -o,     // +x face corners
    o, o, -h, o, -o, -h, -o, -o, -h, -o, o, -h, // -z face corners
    -h, o, o, -h, -o, o, -h, -o, -o, -h, o, -o, // -x face corners
  ]);
  // Connect ring to faces with quads as two triangles each.
  const idx = [];
  const top = [0, 1, 2, 3];
  const bot = [4, 5, 6, 7];
  const ring = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
  // ring order: +z(4), +x(4), -z(4), -x(4) - build side quads around the ring
  for (let i = 0; i < 16; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % 16];
    // top skirt
    const ta = top[Math.floor(i / 4)];
    const tb = top[Math.floor(((i + 1) % 16) / 4) % 4];
    idx.push(a, b, ta, b, tb, ta);
    // bottom skirt
    const ba = bot[Math.floor(i / 4)];
    const bb = bot[Math.floor(((i + 1) % 16) / 4) % 4];
    idx.push(b, a, ba, ba, bb, b);
  }
  // caps
  idx.push(top[0], top[1], top[3], top[1], top[2], top[3]);
  idx.push(bot[3], bot[1], bot[0], bot[3], bot[2], bot[1]);

  g.setAttribute('position', new THREE.BufferAttribute(v, 3));
  g.setIndex(idx);
  g.computeVertexNormals();

  const hull = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
    color: 0x3a4250,
    // The station is the biggest, closest surface in the game, and the one the
    // player stares at while docking. It is deliberately smoother and more
    // metallic than the ships: a station is a polished structure, and letting it
    // catch a long specular streak from the star is what makes the approach
    // read as "I am flying toward something enormous".
    roughness: 0.34,
    metalness: 0.68,
    flatShading: true,
    envMapIntensity: 1.5,
    // Closed solid: front faces only. DoubleSide here draws the far wall
    // through the near one and the station reads as a glass ball.
    side: THREE.FrontSide,
    // No polygon offset: the hull must stay an honest occluder so it hides its
    // own far-side edges. The overlay is biased forward instead, in edgeLines.
  }));
  group.add(hull);
  group.add(edgeLines(g, 0xbcd4e6));

  // Docking slot: a dark rectangle on the +Z face, with the frame recorded so
  // the docking logic can align against it rather than against a hardcoded
  // direction.
  const slotW = R * 0.44;
  const slotH = R * 0.075;
  const slotZ = R * 0.87;
  const slot = new THREE.Mesh(
    new THREE.PlaneGeometry(slotW, slotH),
    new THREE.MeshBasicMaterial({ color: 0x05070c, side: THREE.DoubleSide })
  );
  slot.position.set(0, 0, slotZ + 0.4);
  group.add(slot);

  // Approach rails: two short lines running out along +Z from the slot edges.
  // They read at distance and tell a commander which way to point before the
  // slot itself is visible. Line geometry is built in slot-space and then
  // positioned per side, avoiding the offset-in-geometry trap.
  const railPoints = [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, R * 0.3),
  ];
  const railGeo = new THREE.BufferGeometry().setFromPoints(railPoints);
  for (const sx of [-1, 1]) {
    const rail = new THREE.Line(
      railGeo,
      new THREE.LineBasicMaterial({ color: 0x61ff8a, transparent: true, opacity: 0.7 })
    );
    rail.position.set(sx * slotW * 0.5, 0, slotZ + 0.6);
    group.add(rail);
  }

  // Four blinking entry lights around the slot mouth.
  const lightGeo = new THREE.SphereGeometry(Math.max(2, R * 0.022), 6, 4);
  const lights = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const dot = new THREE.Mesh(lightGeo, new THREE.MeshBasicMaterial({ color: 0x61ff8a }));
      dot.position.set(sx * slotW * 0.55, sy * slotH * 1.7, slotZ + 0.6);
      group.add(dot);
      lights.push(dot);
    }
  }

  group.userData.slotNormalLocal = new THREE.Vector3(0, 0, 1);
  group.userData.slotPointLocal = new THREE.Vector3(0, 0, slotZ);
  group.userData.radius = R;
  group.userData.beacons = lights;
  return group;
}

/** Factory by kind, so world.js does not need a switch of its own. */
export function makeShip(kind) {
  switch (kind) {
    case 'viper': return makeViper();
    case 'trader': return makeGecko();
    case 'raider': return makeViper();
    case 'pirate':
    default: return makeSidewinder();
  }
}

export default {
  HULL_COLOUR, EDGE_COLOUR, CAPSULE_EDGE_COLOUR, ROCK_EDGE_FADE,
  HULL_ROUGHNESS, HULL_METALNESS, EDGE_FADE, FLAME, ROCK_TYPES,
  rockTypeFor,
  hullMaterial, edgeLines, shell, shipShell, makeFlame, hullTailZ,
  makeCobra, makeSidewinder, makeViper, makeGecko,
  makeCanister, makeCapsule, makeAsteroid, makeCoriolis, makeShip,
};
