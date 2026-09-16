/**
 * Resource disposal.
 *
 * This module exists because three places in the project were walking the
 * scene graph to free geometry and materials, with three slightly different
 * implementations - and one of them ignored the `userData.shared` contract
 * that the other two honoured, which is exactly the divergence a shared
 * helper prevents.
 *
 * The leak it fixes: `world.js:prune` removed a despawned ship from the scene
 * without freeing anything. Each ship is built from its own geometry, so a
 * long session in one system climbed steadily. It was invisible in a short
 * test because a hyperspace jump clears the whole scene.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { disposeTree, markShared } from '../src/sim/dispose.js';

/** A tiny scene graph shaped like the real ones: a group, meshes, a material. */
function makeTree() {
  const group = new THREE.Group();
  const geometryA = new THREE.BufferGeometry();
  const geometryB = new THREE.BufferGeometry();
  const materialA = new THREE.MeshBasicMaterial();
  const materialB = new THREE.MeshBasicMaterial();
  group.add(new THREE.Mesh(geometryA, materialA));
  group.add(new THREE.Mesh(geometryB, materialB));
  return { group, geometryA, geometryB, materialA, materialB };
}

/** Count how many times `dispose` was called on a resource. */
function watch(resource) {
  const original = resource.dispose.bind(resource);
  let calls = 0;
  resource.dispose = () => { calls += 1; original(); };
  return () => calls;
}

test('disposeTree frees every geometry and material under the root', () => {
  const t = makeTree();
  const counts = [t.geometryA, t.geometryB, t.materialA, t.materialB].map(watch);

  const freed = disposeTree(t.group);

  assert.equal(freed, 4, 'expected two geometries and two materials');
  for (const c of counts) assert.equal(c(), 1, 'a resource was freed more or fewer than once');
});

test('disposeTree walks nested groups, not just direct children', () => {
  // The real trees are three or four levels deep: system root -> belt -> rock.
  const outer = new THREE.Group();
  const inner = new THREE.Group();
  const geometry = new THREE.BufferGeometry();
  const material = new THREE.MeshBasicMaterial();
  inner.add(new THREE.Mesh(geometry, material));
  outer.add(inner);

  const geoCount = watch(geometry);
  const matCount = watch(material);

  assert.equal(disposeTree(outer), 2);
  assert.equal(geoCount(), 1);
  assert.equal(matCount(), 1);
});

test('a shared resource is never freed from under its siblings', () => {
  // This is the contract the debris and exhaust pools depend on: one material
  // serves every fragment, so freeing it via one mesh would blank the rest.
  const shared = new THREE.MeshBasicMaterial();
  markShared(shared);
  const sharedGeometry = markShared(new THREE.BufferGeometry());

  const group = new THREE.Group();
  group.add(new THREE.Mesh(sharedGeometry, shared));
  group.add(new THREE.Mesh(sharedGeometry, shared));

  const geoCount = watch(sharedGeometry);
  const matCount = watch(shared);

  const freed = disposeTree(group);

  assert.equal(freed, 0, 'a shared resource must not be freed');
  assert.equal(geoCount(), 0, 'the shared geometry was freed');
  assert.equal(matCount(), 0, 'the shared material was freed');
});

test('a shared resource is skipped while its unshared neighbours are freed', () => {
  // The interesting case: a mixed tree. Getting this wrong in either direction
  // is a bug - leak the private resource, or blank the shared one.
  const shared = markShared(new THREE.MeshBasicMaterial());
  const privateMat = new THREE.MeshBasicMaterial();
  const privateGeo = new THREE.BufferGeometry();

  const group = new THREE.Group();
  group.add(new THREE.Mesh(privateGeo, shared));
  group.add(new THREE.Mesh(new THREE.BufferGeometry(), privateMat));

  const sharedCount = watch(shared);
  const privateMatCount = watch(privateMat);
  const privateGeoCount = watch(privateGeo);

  disposeTree(group);

  assert.equal(sharedCount(), 0, 'the shared material was freed');
  assert.equal(privateMatCount(), 1, 'the private material was not freed');
  assert.equal(privateGeoCount(), 1, 'the private geometry was not freed');
});

test('markShared tags a resource and tolerates null', () => {
  const m = new THREE.MeshBasicMaterial();
  assert.equal(markShared(m), m, 'markShared should return the resource for chaining');
  assert.equal(m.userData.shared, true);
  assert.doesNotThrow(() => markShared(null));
  assert.equal(markShared(undefined), undefined);
});

test('disposeTree tolerates the shapes a disposal path actually meets', () => {
  // Called unconditionally from a jump, a kill and a despawn, so it has to
  // survive null, a stub, and a plain object that is not an Object3D.
  assert.equal(disposeTree(null), 0);
  assert.equal(disposeTree(undefined), 0);
  assert.equal(disposeTree({}), 0);
  assert.equal(disposeTree({ traverse: null }), 0);
  // A leaf with no geometry or material.
  assert.equal(disposeTree(new THREE.Group()), 0);
});

test('a mesh with an array of materials frees all of them', () => {
  const materials = [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial()];
  const counts = materials.map(watch);
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), materials);

  const freed = disposeTree(mesh);

  assert.equal(freed, 3, 'one geometry and two materials');
  for (const c of counts) assert.equal(c(), 1);
});

test('disposeTree is idempotent enough not to throw when called twice', () => {
  // A double dispose is a no-op in three, but a crash here would take down a
  // frame. Cheap to pin.
  const t = makeTree();
  disposeTree(t.group);
  assert.doesNotThrow(() => disposeTree(t.group));
});

test('the default export mirrors the named ones', () => {
  assert.equal(typeof disposeTree, 'function');
  assert.equal(typeof markShared, 'function');
});
