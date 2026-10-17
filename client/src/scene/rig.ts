import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { FLOOR_HALF } from './building';

/** 35 mm full-frame sensor height: focal length in mm maps to a real field of view. */
const SENSOR_HEIGHT_MM = 24;
const ELEVATION = THREE.MathUtils.degToRad(38);
const AZIMUTH = Math.PI / 4;
/** The near/far planes hug the orbit target; this is how far beyond it they reach. */
const DEPTH_MARGIN = 120;
const PAN_LIMIT = 40;

export const FOCAL_RANGE = { min: 24, max: 1200 } as const;

/**
 * Perspective camera with a real focal length. Long focal lengths approach the isometric look of the
 * reference; changing the focal length dollies the camera so the model keeps the same size on screen.
 */
export class CameraRig {
  readonly camera = new THREE.PerspectiveCamera(10, 1, 0.1, 5000);
  readonly controls: OrbitControls;
  private focal = 900;
  private lastAspect = 1;

  constructor(dom: HTMLElement) {
    this.controls = new OrbitControls(this.camera, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minPolarAngle = 0.15;
    this.controls.maxPolarAngle = Math.PI / 2.25;
    this.controls.zoomSpeed = 1.1;

    this.lastAspect = this.aspect();
    this.applyFov();
    this.resetView();
    dom.addEventListener('dblclick', () => this.resetView());
  }

  get focalLength(): number {
    return this.focal;
  }

  private aspect(): number {
    return window.innerWidth / window.innerHeight;
  }

  /** World height that must fit on screen at the orbit target (the whole floor plate, any aspect). */
  private viewHeight(aspect: number): number {
    const diag = FLOOR_HALF * 2 * Math.SQRT2;
    const projW = diag + 2;
    const projH = diag * Math.sin(ELEVATION) + 2.4 * Math.cos(ELEVATION) + 2;
    return Math.max(projH, projW / aspect) * 1.06;
  }

  private fitDistance(aspect = this.aspect()): number {
    return (this.viewHeight(aspect) * this.focal) / SENSOR_HEIGHT_MM;
  }

  /** Distance from the camera to what it orbits: this is where the depth-of-field focus goes. */
  distance(): number {
    return this.camera.position.distanceTo(this.controls.target);
  }

  private applyFov(): void {
    this.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(SENSOR_HEIGHT_MM / 2 / this.focal));
    this.camera.aspect = this.aspect();
    this.camera.updateProjectionMatrix();
  }

  private applyLimits(): void {
    const fit = this.fitDistance();
    this.controls.minDistance = fit * 0.12;
    this.controls.maxDistance = fit * 2.5;
  }

  private moveTo(distance: number): void {
    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() === 0) dir.set(1, 1, 1);
    this.camera.position.copy(this.controls.target).addScaledVector(dir.normalize(), distance);
  }

  setFocalLength(mm: number): void {
    const next = THREE.MathUtils.clamp(mm, FOCAL_RANGE.min, FOCAL_RANGE.max);
    if (next === this.focal) return;
    const zoom = this.distance() / this.fitDistance();
    this.focal = next;
    this.applyFov();
    this.applyLimits();
    this.moveTo(this.fitDistance() * zoom);
  }

  /** Window resized: keep the same relative zoom while the fit distance follows the new aspect ratio. */
  resize(): void {
    const zoom = this.distance() / this.fitDistance(this.lastAspect);
    this.lastAspect = this.aspect();
    this.applyFov();
    this.applyLimits();
    this.moveTo(this.fitDistance() * zoom);
  }

  /** Back to the reference angle, centered, whole plate in view. */
  resetView(): void {
    this.controls.target.set(0, 0, 0);
    this.camera.position.set(
      Math.cos(ELEVATION) * Math.sin(AZIMUTH),
      Math.sin(ELEVATION),
      Math.cos(ELEVATION) * Math.cos(AZIMUTH),
    );
    this.applyLimits();
    this.moveTo(this.fitDistance());
    this.controls.update();
  }

  /** Call once per frame. */
  update(): void {
    const t = this.controls.target;
    t.x = THREE.MathUtils.clamp(t.x, -PAN_LIMIT, PAN_LIMIT);
    t.y = THREE.MathUtils.clamp(t.y, -5, 15);
    t.z = THREE.MathUtils.clamp(t.z, -PAN_LIMIT, PAN_LIMIT);
    this.controls.update();

    const d = this.distance();
    const near = Math.max(0.2, d - DEPTH_MARGIN);
    const far = d + DEPTH_MARGIN;
    if (Math.abs(near - this.camera.near) > 0.01 || Math.abs(far - this.camera.far) > 0.01) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
  }
}
