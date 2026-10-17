import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Collapses static single-material meshes under `root` into one mesh per material,
 * cutting thousands of furniture draw calls down to a handful. `root` must sit at the origin.
 */
export function mergeStatic(root: THREE.Object3D): void {
  root.updateMatrixWorld(true);
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const victims: THREE.Mesh[] = [];

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material) || mesh.userData.keep) return;
    const geom = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    const list = buckets.get(mesh.material) ?? [];
    list.push(geom);
    buckets.set(mesh.material, list);
    victims.push(mesh);
  });

  for (const mesh of victims) mesh.removeFromParent();
  for (const [material, geoms] of buckets) {
    const merged = mergeGeometries(geoms, false);
    geoms.forEach((g) => g.dispose());
    if (merged) root.add(new THREE.Mesh(merged, material));
  }
}
