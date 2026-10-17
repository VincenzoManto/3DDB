export interface HudSection {
  label: string;
  items: string[];
}

export interface HudContent {
  kicker: string;
  title: string;
  color?: string;
  rows: Array<[string, string]>;
  sections?: HudSection[];
  code?: string;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Side panel with live details of the selected object. Built with textContent only (names come from the DB). */
export class Hud {
  private root: HTMLDivElement;
  onClose: () => void = () => {};

  constructor() {
    this.root = el('div', 'panel');
    this.root.id = 'hud-panel';
    document.body.appendChild(this.root);
  }

  show(c: HudContent): void {
    this.root.replaceChildren();
    this.root.classList.add('visible');
    if (c.color) this.root.style.setProperty('--accent', c.color);
    else this.root.style.removeProperty('--accent');

    const head = el('div', 'hud-head');
    const titles = el('div');
    titles.append(el('div', 'hud-kicker', c.kicker), el('h2', undefined, c.title));
    const close = el('button', 'hud-close', '×');
    close.title = 'Close';
    close.addEventListener('click', () => this.onClose());
    head.append(titles, close);
    this.root.append(head);

    for (const [k, v] of c.rows) {
      const row = el('div', 'hud-row');
      row.append(el('span', undefined, k), el('span', undefined, v));
      this.root.append(row);
    }
    if (c.code) this.root.append(el('pre', 'hud-code', c.code));
    for (const s of c.sections ?? []) {
      if (!s.items.length) continue;
      this.root.append(el('div', 'hud-section', s.label));
      const list = el('ul', 'hud-list');
      for (const item of s.items.slice(0, 12)) list.append(el('li', undefined, item));
      if (s.items.length > 12) list.append(el('li', 'hud-more', `+${s.items.length - 12} altri`));
      this.root.append(list);
    }
  }

  hide(): void {
    this.root.classList.remove('visible');
    this.root.replaceChildren();
  }
}
