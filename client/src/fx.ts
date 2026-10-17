/** Post-processing and camera settings: schema, defaults, persistence. */

export interface FxSettings {
  /** Lens focal length in mm (35 mm equivalent). Long = flat/isometric, short = dramatic perspective. */
  focalLength: number;
  dofEnabled: boolean;
  /** 0–100: how quickly things blur as they move away from the focus distance. */
  dofAmount: number;
  /** Cap on the blur radius, as a fraction of the screen. */
  dofMaxBlur: number;
  /** Shifts the focus plane towards (−) or away from (+) the camera, in world units. */
  focusOffset: number;
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;
  exposure: number;
  vignette: number;
}

export const DEFAULT_FX: FxSettings = {
  focalLength: 900,
  dofEnabled: true,
  dofAmount: 28,
  dofMaxBlur: 0.012,
  focusOffset: 0,
  bloomStrength: 0.45,
  bloomRadius: 0.3,
  bloomThreshold: 0.6,
  exposure: 1.2,
  vignette: 0.35,
};

export interface FxControl {
  section: string;
  key: keyof FxSettings;
  label: string;
  hint?: string;
  type: 'range' | 'toggle';
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  digits?: number;
}

export const FX_CONTROLS: FxControl[] = [
  {
    section: 'Camera',
    key: 'focalLength',
    label: 'Focal length',
    hint: 'Long lenses flatten the view towards isometric; short lenses add perspective. The camera dollies to keep the framing.',
    type: 'range',
    min: 24,
    max: 1200,
    step: 1,
    unit: ' mm',
    digits: 0,
  },
  { section: 'Distance blur (depth of field)', key: 'dofEnabled', label: 'Enabled', type: 'toggle' },
  {
    section: 'Distance blur (depth of field)',
    key: 'dofAmount',
    label: 'Blur amount',
    hint: 'How fast things blur as they get farther from the focus distance.',
    type: 'range',
    min: 0,
    max: 100,
    step: 1,
    digits: 0,
  },
  {
    section: 'Distance blur (depth of field)',
    key: 'dofMaxBlur',
    label: 'Max blur',
    hint: 'Upper limit for the blur radius.',
    type: 'range',
    min: 0,
    max: 0.04,
    step: 0.001,
    digits: 3,
  },
  {
    section: 'Distance blur (depth of field)',
    key: 'focusOffset',
    label: 'Focus distance offset',
    hint: 'Focus follows what you orbit around. Move the focus plane nearer (−) or farther (+).',
    type: 'range',
    min: -40,
    max: 40,
    step: 0.5,
    unit: ' u',
    digits: 1,
  },
  { section: 'Bloom', key: 'bloomStrength', label: 'Strength', type: 'range', min: 0, max: 2, step: 0.01, digits: 2 },
  { section: 'Bloom', key: 'bloomRadius', label: 'Radius', type: 'range', min: 0, max: 1.5, step: 0.01, digits: 2 },
  { section: 'Bloom', key: 'bloomThreshold', label: 'Threshold', type: 'range', min: 0, max: 1.5, step: 0.01, digits: 2 },
  { section: 'Image', key: 'exposure', label: 'Exposure', type: 'range', min: 0.3, max: 2.5, step: 0.01, digits: 2 },
  { section: 'Image', key: 'vignette', label: 'Vignette', type: 'range', min: 0, max: 0.9, step: 0.01, digits: 2 },
];

const STORAGE_KEY = '3ddb.fx.v1';
type Listener = (settings: FxSettings) => void;

function sanitize(raw: unknown): FxSettings {
  const out: FxSettings = { ...DEFAULT_FX };
  if (typeof raw !== 'object' || raw === null) return out;
  const src = raw as Record<string, unknown>;
  for (const c of FX_CONTROLS) {
    const v = src[c.key];
    if (c.type === 'toggle') {
      if (typeof v === 'boolean') (out[c.key] as boolean) = v;
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      (out[c.key] as number) = Math.min(c.max!, Math.max(c.min!, v));
    }
  }
  return out;
}

/** Holds the live settings, tells listeners about changes, and remembers them in localStorage. */
export class FxStore {
  private current: FxSettings;
  private listeners: Listener[] = [];

  constructor() {
    let saved: unknown = null;
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    } catch {
      saved = null;
    }
    this.current = sanitize(saved);
  }

  get value(): FxSettings {
    return this.current;
  }

  onChange(fn: Listener): void {
    this.listeners.push(fn);
    fn(this.current);
  }

  set(patch: Partial<FxSettings>): void {
    this.current = sanitize({ ...this.current, ...patch });
    this.persist();
    for (const fn of this.listeners) fn(this.current);
  }

  reset(): void {
    this.current = { ...DEFAULT_FX };
    this.persist();
    for (const fn of this.listeners) fn(this.current);
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.current));
    } catch {
      // Storage can be unavailable (private mode); the settings still apply for this session.
    }
  }
}
