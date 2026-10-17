import * as THREE from 'three';
import { COLORS } from './palette';

export interface SceneBundle {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
}

/** Renderer, background and lights. The camera lives in CameraRig. */
export function createScene(container: HTMLElement): SceneBundle {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COLORS.bg);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  container.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xdfe8e4, 0x1a1f1d, 1.35));
  const key = new THREE.DirectionalLight(0xffffff, 1.0);
  key.position.set(8, 20, 14);
  scene.add(key);

  return { scene, renderer };
}
