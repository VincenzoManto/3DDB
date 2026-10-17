import type { Metrics, SessionInfo, Topology } from '../../../shared/types';

const ENGINE_LABEL: Record<string, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mssql: 'SQL Server',
  mongo: 'MongoDB',
  demo: 'Demo',
};

const KEY: Array<[string, string, string]> = [
  ['▦', 'zone', 'database'],
  ['▮', 'rack', 'table · width = rows, height = bytes · pulses on every query'],
  ['▬', 'slab', 'index on the rack · gold = PK, violet = unique, blue = plain, grey = never used'],
  ['▣', 'workstation', 'stored procedure (green) / function (cyan)'],
  ['●', 'person', 'user · color = role · dark visor = not connected'],
  ['⌂', 'office', 'role · the cage = superuser'],
];

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Live census of the connected server plus the visual legend. */
export class Legend {
  private root = el('div', 'panel');
  private stats = el('div', 'legend-stats');
  private server = el('div', 'legend-server');

  constructor() {
    this.root.id = 'legend';
    const key = el('div', 'legend-key');
    for (const [glyph, name, meaning] of KEY) {
      const row = el('div', 'legend-row');
      row.append(el('span', 'legend-glyph', glyph), el('span', 'legend-name', name), el('span', undefined, meaning));
      key.append(row);
    }
    const toggle = el('button', 'legend-toggle', 'legend');
    toggle.addEventListener('click', () => this.root.classList.toggle('open'));
    this.root.append(this.server, this.stats, toggle, key);
    this.root.style.display = 'none';
    document.body.appendChild(this.root);
  }

  update(topology: Topology, sessions: SessionInfo[], hiddenUsers: number, metrics: Metrics): void {
    this.root.style.display = '';
    this.server.textContent = `${ENGINE_LABEL[topology.engine] ?? topology.engine} · ${topology.server}`;
    const procs = topology.routines.filter((r) => r.kind === 'procedure').length;
    const active = sessions.filter((s) => s.state !== 'idle').length;
    const waiting = sessions.filter((s) => s.state === 'waiting').length;
    const unused = topology.indexes.filter((i) => !i.primary && metrics.indexes[i.id]?.scans === 0).length;
    const cells: Array<[string, string | number, boolean?]> = [
      ['databases', topology.databases.length],
      ['tables', topology.tables.length],
      ['indexes', topology.indexes.length],
      ['unused indexes', unused, unused > 0],
      ['procedures', procs],
      ['functions', topology.routines.length - procs],
      ['users', topology.users.length + (hiddenUsers ? ` (+${hiddenUsers} not shown)` : '')],
      ['roles', topology.roles.length],
      ['active sessions', active],
      ['waiting on locks', waiting, waiting > 0],
    ];
    this.stats.replaceChildren(
      ...cells.map(([label, value, warn]) => {
        const cell = el('div', `legend-cell${warn ? ' warn' : ''}`);
        cell.append(el('b', undefined, String(value)), el('span', undefined, label));
        return cell;
      }),
    );
  }
}
