import type { ConnectionTarget, DbKind, ScanResult } from '../../../shared/types';

type RealKind = Exclude<DbKind, 'demo'>;

const KIND_LABELS: Record<DbKind, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mssql: 'SQL Server',
  mongo: 'MongoDB',
  demo: 'Built-in demo',
};

const DEFAULTS: Record<RealKind, { port: number; user: string; database: string; dbHint: string }> = {
  postgres: { port: 5432, user: 'postgres', database: 'postgres', dbHint: 'database' },
  mysql: { port: 3306, user: 'root', database: '', dbHint: 'database (optional)' },
  mssql: { port: 1433, user: 'sa', database: 'master', dbHint: 'database' },
  mongo: { port: 27017, user: '', database: 'admin', dbHint: 'authSource' },
};

export class ConnectionPanel {
  private el: HTMLDivElement;
  private listEl: HTMLDivElement;
  private form: HTMLFormElement;
  private fields: Record<'kind' | 'host' | 'port' | 'user' | 'password' | 'database', HTMLInputElement | HTMLSelectElement>;

  constructor(
    private onConnect: (target: ConnectionTarget) => void,
    private onScan: () => void,
  ) {
    this.el = document.createElement('div');
    this.el.id = 'connection-panel';
    this.el.className = 'panel';

    const title = document.createElement('h1');
    title.textContent = '> Connect a database';
    title.addEventListener('click', () => this.el.classList.toggle('collapsed'));

    this.listEl = document.createElement('div');
    this.listEl.id = 'conn-list';

    const scan = document.createElement('button');
    scan.id = 'scan-btn';
    scan.textContent = 'Scan local ports';
    scan.addEventListener('click', () => this.onScan());

    this.form = document.createElement('form');
    this.form.id = 'conn-form';
    this.form.hidden = true;
    const kind = document.createElement('select');
    for (const k of Object.keys(DEFAULTS) as RealKind[]) {
      const opt = document.createElement('option');
      opt.value = k;
      opt.textContent = KIND_LABELS[k];
      kind.append(opt);
    }
    kind.addEventListener('change', () => this.applyDefaults(kind.value as RealKind));
    const input = (name: string, type = 'text', placeholder = '') => {
      const i = document.createElement('input');
      i.name = name;
      i.type = type;
      i.placeholder = placeholder;
      i.autocomplete = type === 'password' ? 'current-password' : 'off';
      return i;
    };
    this.fields = {
      kind,
      host: input('host', 'text', 'host'),
      port: input('port', 'number', 'port'),
      user: input('user', 'text', 'user'),
      password: input('password', 'password', 'password'),
      database: input('database', 'text', 'database'),
    };
    const hostRow = document.createElement('div');
    hostRow.className = 'form-row';
    hostRow.append(this.fields.host, this.fields.port);
    const actions = document.createElement('div');
    actions.className = 'form-row';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = 'Connect';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'secondary';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => (this.form.hidden = true));
    actions.append(submit, cancel);
    this.form.append(kind, hostRow, this.fields.user, this.fields.password, this.fields.database, actions);
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.onConnect({
        kind: this.fields.kind.value as RealKind,
        host: this.fields.host.value || 'localhost',
        port: Number(this.fields.port.value) || undefined,
        user: this.fields.user.value || undefined,
        password: this.fields.password.value || undefined,
        database: this.fields.database.value || undefined,
      });
    });

    this.el.append(title, this.listEl, this.form, scan);
    document.body.appendChild(this.el);
    this.renderOptions([]);
  }

  private applyDefaults(kind: RealKind, port?: number): void {
    const d = DEFAULTS[kind];
    this.fields.kind.value = kind;
    this.fields.port.value = String(port ?? d.port);
    this.fields.user.value = d.user;
    this.fields.database.value = d.database;
    this.fields.database.setAttribute('placeholder', d.dbHint);
  }

  private openForm(kind: RealKind, port?: number): void {
    this.applyDefaults(kind, port);
    this.fields.host.value = 'localhost';
    this.fields.password.value = '';
    this.form.hidden = false;
    this.fields.password.focus();
  }

  showScanResults(results: ScanResult[]): void {
    this.renderOptions(results);
  }

  private renderOptions(results: ScanResult[]): void {
    this.listEl.replaceChildren();
    this.addOption('demo', 'Try the demo data', true, () => this.onConnect({ kind: 'demo' }));
    for (const r of results) {
      if (r.kind === 'demo') continue;
      this.addOption(r.kind, `${KIND_LABELS[r.kind]} :${r.port}`, r.reachable, () => this.openForm(r.kind as RealKind, r.port));
    }
    this.addOption('postgres', 'Manual connection…', false, () => this.openForm('postgres'), 'manual');
  }

  private addOption(kind: DbKind, label: string, reachable: boolean, handler: () => void, extra = ''): void {
    const row = document.createElement('div');
    row.className = `conn-option ${reachable ? 'reachable' : ''} ${kind === 'demo' ? 'demo' : ''} ${extra}`;
    const left = document.createElement('span');
    const dot = document.createElement('span');
    dot.className = 'dot';
    left.append(dot, document.createTextNode(label));
    const right = document.createElement('span');
    right.textContent = extra === 'manual' ? '›' : reachable ? 'OK' : '--';
    row.append(left, right);
    row.addEventListener('click', handler);
    this.listEl.appendChild(row);
  }

  collapse(): void {
    this.el.classList.add('collapsed');
    this.form.hidden = true;
  }

  expand(): void {
    this.el.classList.remove('collapsed');
  }
}
