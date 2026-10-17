import type { ExecResult } from '../../../shared/types';

interface Preset {
  label: string;
  sql: string;
  tone: 'read' | 'write' | 'ddl';
}

/** One click each; every one of them visibly changes the scene. */
const PRESETS: Preset[] = [
  { label: 'SELECT customer', tone: 'read', sql: 'SELECT * FROM shop.customers WHERE id = 42' },
  { label: 'INSERT order', tone: 'write', sql: "INSERT INTO shop.orders (payload, ref) VALUES ('console', 7)" },
  { label: 'UPDATE product', tone: 'write', sql: "UPDATE shop.products SET payload = 'on sale' WHERE id = 7" },
  { label: 'DELETE event', tone: 'write', sql: 'DELETE FROM analytics.events WHERE id = (SELECT min(id) FROM analytics.events)' },
  { label: 'CALL place_order', tone: 'write', sql: 'CALL shop.place_order(7)' },
  { label: 'CREATE INDEX', tone: 'ddl', sql: 'CREATE INDEX idx_orders_payload ON shop.orders (payload)' },
  { label: 'DROP INDEX', tone: 'ddl', sql: 'DROP INDEX IF EXISTS shop.idx_orders_payload' },
  { label: 'CREATE TABLE', tone: 'ddl', sql: 'CREATE TABLE shop.wishlist (id serial PRIMARY KEY, payload text, ref int)' },
  { label: 'DROP TABLE', tone: 'ddl', sql: 'DROP TABLE IF EXISTS shop.wishlist' },
  {
    label: 'CREATE DATABASE',
    tone: 'ddl',
    sql: 'CREATE SCHEMA warehouse; CREATE TABLE warehouse.stock (id serial PRIMARY KEY, payload text, ref int); CREATE INDEX idx_stock_ref ON warehouse.stock (ref)',
  },
  { label: 'DROP DATABASE', tone: 'ddl', sql: 'DROP SCHEMA IF EXISTS warehouse CASCADE' },
  { label: 'CREATE USER', tone: 'ddl', sql: 'CREATE ROLE intern LOGIN' },
  { label: 'DROP USER', tone: 'ddl', sql: 'DROP ROLE IF EXISTS intern' },
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** SQL console for the sandboxed demo database: type SQL or click a preset and watch the scene react. */
export class SqlConsole {
  private root = el('div', 'panel');
  private toggle = el('button', 'console-toggle', 'SQL ▸');
  private body = el('div', 'console-body');
  private input = el('textarea', 'console-input');
  private result = el('div', 'console-result');

  constructor(private run: (sql: string) => void) {
    this.root.id = 'sql-console';
    this.root.style.display = 'none';

    const presets = el('div', 'console-presets');
    for (const p of PRESETS) {
      const chip = el('button', `console-chip ${p.tone}`, p.label);
      chip.title = p.sql;
      chip.addEventListener('click', () => {
        this.input.value = p.sql;
        this.run(p.sql);
      });
      presets.append(chip);
    }

    this.input.rows = 2;
    this.input.spellcheck = false;
    this.input.placeholder = 'SQL (Ctrl+Enter to run), e.g. SELECT * FROM shop.orders LIMIT 5';
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.submit();
      }
    });
    const runBtn = el('button', 'console-run', 'Run');
    runBtn.addEventListener('click', () => this.submit());
    const row = el('div', 'console-row');
    row.append(this.input, runBtn);

    this.body.append(presets, row, this.result);
    this.toggle.addEventListener('click', () => {
      const open = this.root.classList.toggle('open');
      this.toggle.textContent = open ? 'SQL ▾' : 'SQL ▸';
    });
    this.root.append(this.toggle, this.body);
    document.body.appendChild(this.root);
  }

  private submit(): void {
    const sql = this.input.value.trim();
    if (sql) this.run(sql);
  }

  setEnabled(on: boolean): void {
    this.root.style.display = on ? '' : 'none';
  }

  showResult(r: ExecResult): void {
    this.result.replaceChildren();
    this.result.className = `console-result ${r.ok ? 'ok' : 'err'}`;
    this.result.append(el('div', 'console-msg', `${r.ok ? '✓' : '✗'} ${r.message} · ${r.ms} ms`));
    if (r.columns && r.rows?.length) {
      const table = el('table', 'console-table');
      const head = el('tr');
      for (const c of r.columns) head.append(el('th', undefined, c));
      table.append(head);
      for (const row of r.rows) {
        const tr = el('tr');
        for (const v of row) tr.append(el('td', undefined, v));
        table.append(tr);
      }
      const wrap = el('div', 'console-scroll');
      wrap.append(table);
      this.result.append(wrap);
    }
  }
}
