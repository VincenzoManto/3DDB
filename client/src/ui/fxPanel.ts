import { FX_CONTROLS, type FxControl, type FxSettings, type FxStore } from '../fx';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

interface Row {
  control: FxControl;
  input: HTMLInputElement;
  value: HTMLElement;
}

/** The FX settings page: a drawer with live sliders for camera, depth of field, bloom and image. */
export class FxPanel {
  private root = el('div', 'panel');
  private button = el('button', 'fx-toggle', '⚙ FX');
  private rows: Row[] = [];

  constructor(private store: FxStore) {
    this.root.id = 'fx-panel';

    const head = el('div', 'fx-head');
    head.append(el('h2', undefined, 'FX settings'));
    const close = el('button', 'fx-close', '×');
    close.title = 'Close';
    close.addEventListener('click', () => this.setOpen(false));
    head.append(close);
    this.root.append(head);

    let section = '';
    let group: HTMLElement | null = null;
    for (const control of FX_CONTROLS) {
      if (control.section !== section) {
        section = control.section;
        group = el('div', 'fx-group');
        group.append(el('div', 'fx-section', section));
        this.root.append(group);
      }
      group!.append(this.buildRow(control));
    }

    const reset = el('button', 'fx-reset', 'Reset to defaults');
    reset.addEventListener('click', () => this.store.reset());
    this.root.append(reset);
    this.root.append(el('div', 'fx-note', 'Settings are saved in this browser.'));

    this.button.title = 'Camera and post-processing settings';
    this.button.addEventListener('click', () => this.setOpen(!this.root.classList.contains('open')));
    document.body.append(this.button, this.root);

    this.store.onChange((s) => this.sync(s));
  }

  private setOpen(open: boolean): void {
    this.root.classList.toggle('open', open);
    this.button.classList.toggle('active', open);
  }

  private buildRow(control: FxControl): HTMLElement {
    const row = el('div', 'fx-row');
    const top = el('div', 'fx-row-top');
    const label = el('label', undefined, control.label);
    const value = el('span', 'fx-value');
    const input = el('input');

    if (control.type === 'toggle') {
      input.type = 'checkbox';
      input.addEventListener('change', () => this.store.set({ [control.key]: input.checked } as Partial<FxSettings>));
      top.append(label, input);
    } else {
      input.type = 'range';
      input.min = String(control.min);
      input.max = String(control.max);
      input.step = String(control.step);
      input.addEventListener('input', () => this.store.set({ [control.key]: Number(input.value) } as Partial<FxSettings>));
      top.append(label, value);
    }
    row.append(top);
    if (control.type === 'range') row.append(input);
    if (control.hint) row.append(el('div', 'fx-hint', control.hint));
    this.rows.push({ control, input, value });
    return row;
  }

  private sync(s: FxSettings): void {
    for (const { control, input, value } of this.rows) {
      const v = s[control.key];
      if (control.type === 'toggle') {
        input.checked = Boolean(v);
      } else {
        input.value = String(v);
        value.textContent = `${(v as number).toFixed(control.digits ?? 0)}${control.unit ?? ''}`;
      }
    }
  }
}
