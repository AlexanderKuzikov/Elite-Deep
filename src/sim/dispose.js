/**
 * Releasing GPU resources.
 *
 * Three's `Object3D` has no recursive dispose. Everything that removes a
 * subtree - a hyperspace jump, a destroyed ship, a ship that drifted past the
 * despawn sphere - has to walk it by hand, and three separate places in this
 * project were doing that with three slightly different implementations. One
 * of them silently ignored the `userData.shared` contract that the others
 * honoured, which is exactly the kind of divergence that a shared helper
 * exists to prevent.
 *
 * ## The `shared` contract
 *
 * Anything whose geometry or material is deliberately reused across many
 * objects - the debris fragments, the exhaust puffs, the sky's glow texture -
 * marks itself with `userData.shared = true` at creation. Freeing one of those
 * from under its siblings would blank every other user, so this helper skips
 * them. A shared resource is the property of whatever pool owns it, and that
 * pool is responsible for freeing it when the pool itself goes away.
 *
 * This is not a micro-optimisation. The exhaust pool alone would free one
 * material ninety times a second if it were not guarded.
 */

/**
 * Free every geometry and material under `root`.
 *
 * Tolerates `null`, a stub, or anything without `traverse`, so a disposal path
 * can call it unconditionally - the same posture as `disposeSky`.
 *
 * Returns the number of resources actually freed, which is what makes the
 * behaviour testable: a caller that expected to free something and freed
 * nothing has a bug, and that is invisible without a count.
 */
export function disposeTree(root) {
  if (!root || typeof root.traverse !== 'function') return 0;
  let freed = 0;
  root.traverse((object) => {
    // An InstancedMesh keeps its per-instance transforms and colours in
    // buffers that belong to the *object*, not to its geometry, so freeing the
    // geometry is not enough. Three only releases them when the mesh's own
    // `dispose` event fires (`WebGLObjects.onInstancedMeshDispose`), which is
    // easy to miss because it is the one resource in the project that is not
    // reachable from `geometry` or `material`.
    if (typeof object.dispose === 'function' && object.isInstancedMesh) {
      object.dispose();
      freed += 1;
    }
    if (isDisposable(object.geometry)) {
      object.geometry.dispose();
      freed += 1;
    }
    if (object.material) {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (isDisposable(material)) {
          material.dispose();
          freed += 1;
        }
      }
    }
  });
  return freed;
}

/**
 * Should this resource be freed?
 *
 * Two conditions, both load-bearing. It has to actually have a `dispose` (the
 * stub path builds objects without real materials), and it must not be shared.
 */
function isDisposable(resource) {
  if (!resource || typeof resource.dispose !== 'function') return false;
  if (resource.userData && resource.userData.shared) return false;
  return true;
}

/** Mark a geometry or material as owned by a pool rather than by one mesh. */
export function markShared(resource) {
  if (resource) resource.userData = { shared: true };
  return resource;
}

export default { disposeTree, markShared };
