export type FeedTag = 'READ' | 'WRITE' | 'CALL' | 'LOCK' | 'CREATE' | 'DROP' | 'SQL' | 'ERR';

const TAG_COLORS: Record<FeedTag, string> = {
  READ: '#3dff8c',
  WRITE: '#ffd23d',
  CALL: '#3dd6ff',
  LOCK: '#ff5a5a',
  CREATE: '#9ff3ff',
  DROP: '#ff8a5a',
  SQL: '#ffffff',
  ERR: '#ff5a5a',
};

const MAX_LINES = 9;
const LINE_MS = 14_000;

/** Live log of what the profiler sees and what the user does. Built with textContent only. */
export class Feed {
  private root = document.createElement('div');

  constructor() {
    this.root.id = 'feed';
    document.body.appendChild(this.root);
  }

  add(tag: FeedTag, text: string): void {
    const line = document.createElement('div');
    line.className = 'feed-line';
    const label = document.createElement('span');
    label.className = 'feed-tag';
    label.textContent = tag;
    label.style.color = TAG_COLORS[tag];
    label.style.borderColor = TAG_COLORS[tag];
    const body = document.createElement('span');
    body.textContent = text.length > 90 ? `${text.slice(0, 89)}…` : text;
    line.append(label, body);
    this.root.append(line);
    while (this.root.childElementCount > MAX_LINES) this.root.firstElementChild?.remove();
    setTimeout(() => line.remove(), LINE_MS);
  }
}
