import * as THREE from 'three';

export interface LabelOptions {
  sub?: string;
  color?: string;
  height?: number;
  visible?: boolean;
}

/** Billboard text tag (dark plate, neon border). World-sized, so it scales with zoom. */
export function makeLabel(text: string, opts: LabelOptions = {}): THREE.Sprite {
  const color = opts.color ?? '#3dff8c';
  const title = text.length > 28 ? `${text.slice(0, 27)}…` : text;
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = '600 30px Consolas, monospace';
  const titleW = measure.measureText(title).width;
  measure.font = '20px Consolas, monospace';
  const subW = opts.sub ? measure.measureText(opts.sub).width : 0;

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(Math.max(titleW, subW) + 40);
  canvas.height = opts.sub ? 92 : 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(8,13,12,0.9)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, canvas.width - 3, canvas.height - 3);
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.font = '600 30px Consolas, monospace';
  ctx.fillText(title, 20, 32);
  if (opts.sub) {
    ctx.globalAlpha = 0.75;
    ctx.font = '20px Consolas, monospace';
    ctx.fillText(opts.sub, 20, 68);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
  const h = opts.height ?? 0.6;
  sprite.scale.set((h * canvas.width) / canvas.height, h, 1);
  sprite.renderOrder = 10;
  sprite.visible = opts.visible ?? true;
  return sprite;
}

export function disposeLabel(sprite: THREE.Sprite): void {
  sprite.material.map?.dispose();
  sprite.material.dispose();
}
