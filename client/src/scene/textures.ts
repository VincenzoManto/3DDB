import * as THREE from 'three';

export type Hue = 'green' | 'blue';

function makeCanvas(w: number, h: number) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return { canvas, ctx: canvas.getContext('2d')! };
}

function finish(canvas: HTMLCanvasElement, repeat = false): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
  }
  return t;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export function floorTexture(base = '#2b3033', line = '#1f2326'): THREE.CanvasTexture {
  const { canvas, ctx } = makeCanvas(256, 256);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1500; i++) {
    const v = Math.floor(rand(30, 60));
    ctx.fillStyle = `rgba(${v},${v + 4},${v + 6},0.25)`;
    ctx.fillRect(rand(0, 256), rand(0, 256), 2, 2);
  }
  ctx.strokeStyle = line;
  ctx.lineWidth = 3;
  for (let p = 0; p <= 256; p += 64) {
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, 256);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, p);
    ctx.lineTo(256, p);
    ctx.stroke();
  }
  return finish(canvas, true);
}

export function gratingTexture(): THREE.CanvasTexture {
  const { canvas, ctx } = makeCanvas(256, 256);
  ctx.fillStyle = '#202528';
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = '#16191b';
  for (let y = 4; y < 256; y += 8) {
    for (let x = 4; x < 256; x += 8) ctx.fillRect(x, y, 3, 3);
  }
  ctx.strokeStyle = '#121416';
  ctx.lineWidth = 3;
  for (let p = 0; p <= 256; p += 128) {
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, 256);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, p);
    ctx.lineTo(256, p);
    ctx.stroke();
  }
  return finish(canvas, true);
}

const screenCache = new Map<string, THREE.CanvasTexture>();

/** Dashboard-style screen content: bar panels, line charts, text rows or a radar. */
export function screenTexture(variant: number, hue: Hue = 'green'): THREE.CanvasTexture {
  const key = `${hue}-${variant % 4}`;
  const cached = screenCache.get(key);
  if (cached) return cached;

  const { canvas, ctx } = makeCanvas(256, 160);
  const c = hue === 'green' ? [61, 255, 140] : [90, 160, 255];
  const col = (a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  ctx.fillStyle = hue === 'green' ? '#06190f' : '#071226';
  ctx.fillRect(0, 0, 256, 160);
  ctx.strokeStyle = col(0.9);
  ctx.lineWidth = 3;
  ctx.strokeRect(2, 2, 252, 156);

  switch (variant % 4) {
    case 0:
      for (let gx = 0; gx < 3; gx++) {
        for (let gy = 0; gy < 2; gy++) {
          const x = 12 + gx * 80;
          const y = 12 + gy * 72;
          ctx.strokeStyle = col(0.5);
          ctx.lineWidth = 2;
          ctx.strokeRect(x, y, 70, 62);
          for (let b = 0; b < 5; b++) {
            const h = rand(10, 50);
            ctx.fillStyle = col(rand(0.5, 0.95));
            ctx.fillRect(x + 6 + b * 12, y + 58 - h, 8, h);
          }
        }
      }
      break;
    case 1:
      for (let l = 0; l < 3; l++) {
        ctx.strokeStyle = col(0.95 - l * 0.25);
        ctx.lineWidth = 3;
        ctx.beginPath();
        let y = rand(40, 120);
        ctx.moveTo(10, y);
        for (let x = 10; x <= 246; x += 12) {
          y = Math.max(16, Math.min(148, y + rand(-18, 18)));
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      break;
    case 2:
      for (let r = 0; r < 10; r++) {
        ctx.fillStyle = col(rand(0.4, 0.95));
        ctx.fillRect(12, 14 + r * 14, rand(60, 220), 6);
      }
      break;
    default:
      ctx.strokeStyle = col(0.7);
      ctx.lineWidth = 2;
      for (let r = 20; r <= 70; r += 25) {
        ctx.beginPath();
        ctx.arc(128, 80, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      for (let i = 0; i < 40; i++) {
        ctx.fillStyle = col(rand(0.5, 1));
        ctx.fillRect(rand(20, 236), rand(16, 144), 4, 4);
      }
  }

  const t = finish(canvas);
  screenCache.set(key, t);
  return t;
}

export interface RackTextures {
  map: THREE.CanvasTexture;
  led: THREE.CanvasTexture;
}

const rackCache: RackTextures[] = [];

/** Server cabinet front: diffuse map plus a matching emissive LED mask (white LEDs, tinted by material emissive). */
export function rackTextures(variant: number): RackTextures {
  while (rackCache.length < 4) rackCache.push(makeRack());
  return rackCache[variant % 4];
}

function makeRack(): RackTextures {
  const W = 64;
  const H = 256;
  const a = makeCanvas(W, H);
  const b = makeCanvas(W, H);
  a.ctx.fillStyle = '#15191b';
  a.ctx.fillRect(0, 0, W, H);
  b.ctx.fillStyle = '#000';
  b.ctx.fillRect(0, 0, W, H);

  a.ctx.fillStyle = '#0b0d0e';
  a.ctx.fillRect(0, 0, 4, H);
  a.ctx.fillRect(W - 4, 0, 4, H);
  a.ctx.fillRect(0, 0, W, 6);
  a.ctx.fillRect(0, H - 6, W, 6);

  let y = 8;
  while (y < H - 12) {
    const uh = Math.random() < 0.7 ? 9 : 18;
    a.ctx.fillStyle = Math.random() < 0.2 ? '#101315' : '#1c2124';
    a.ctx.fillRect(6, y, W - 12, uh - 2);
    a.ctx.fillStyle = '#121517';
    for (let vx = 30; vx < W - 10; vx += 4) a.ctx.fillRect(vx, y + 2, 2, uh - 6);

    const n = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      if (Math.random() < 0.25) continue;
      const lx = 9 + i * 5;
      const ly = y + 3;
      a.ctx.fillStyle = '#8a9a92';
      a.ctx.fillRect(lx, ly, 3, 3);
      b.ctx.fillStyle = Math.random() < 0.85 ? '#ffffff' : '#9a9a9a';
      b.ctx.fillRect(lx, ly, 3, 3);
    }
    if (Math.random() < 0.3) {
      b.ctx.fillStyle = '#bbbbbb';
      b.ctx.fillRect(30, y + uh / 2 - 1, rand(8, 20), 2);
    }
    y += uh;
  }

  const map = finish(a.canvas);
  const led = finish(b.canvas);
  map.magFilter = THREE.NearestFilter;
  led.magFilter = THREE.NearestFilter;
  return { map, led };
}
