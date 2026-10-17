import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { FxSettings } from '../fx';

/** The shader multiplies (distance from focus) by this, in world units, to get a screen-space blur. */
const APERTURE_PER_AMOUNT = 1e-5;

export interface PostFx {
  render(): void;
  setSize(width: number, height: number): void;
  apply(settings: FxSettings): void;
  /** Call every frame with the camera → orbit-target distance so the focus follows what you look at. */
  setFocus(distance: number): void;
}

/** Scene → depth of field → bloom → tone mapping. */
export function createPostFx(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera): PostFx {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bokeh = new BokehPass(scene, camera, { focus: 1, aperture: 0, maxblur: 0.012 });
  composer.addPass(bokeh);
  // @types/three declares BokehPass.uniforms as a plain object.
  const uniforms = bokeh.uniforms as Record<'maxblur' | 'aperture' | 'focus', THREE.IUniform<number>>;

  const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.45, 0.3, 0.6);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  let settings: FxSettings | null = null;

  return {
    render: () => composer.render(),
    setSize: (w, h) => {
      composer.setSize(w, h);
      bloom.setSize(w, h);
    },
    apply: (s) => {
      settings = s;
      bokeh.enabled = s.dofEnabled && s.dofAmount > 0;
      uniforms.maxblur.value = s.dofMaxBlur;
      uniforms.aperture.value = s.dofAmount * APERTURE_PER_AMOUNT;
      bloom.strength = s.bloomStrength;
      bloom.radius = s.bloomRadius;
      bloom.threshold = s.bloomThreshold;
      renderer.toneMappingExposure = s.exposure;
      document.documentElement.style.setProperty('--vignette', String(s.vignette));
    },
    setFocus: (distance) => {
      uniforms.focus.value = distance + (settings?.focusOffset ?? 0);
    },
  };
}
