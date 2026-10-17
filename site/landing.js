// Landing page behaviour: hero scene state, copy-to-clipboard, install tabs, ticker, scroll reveals.

const hero = document.querySelector('.hero');
const statusText = document.getElementById('status-text');
const frame = document.getElementById('scene');

/* ── Hero: the demo iframe tells us when Postgres is seeded and the floor is live. ── */

window.addEventListener('message', (e) => {
  if (e.source !== frame.contentWindow || e.data !== '3d-db:ready') return;
  hero.classList.add('ready');
  statusText.textContent = 'Live · Postgres running in this tab';
});

const release = document.getElementById('release');
document.getElementById('take-control').addEventListener('click', () => {
  hero.classList.add('live');
  hero.scrollIntoView({ behavior: 'smooth' });
  frame.focus();
});
const leave = () => hero.classList.remove('live');
release.addEventListener('click', leave);
window.addEventListener('keydown', (e) => e.key === 'Escape' && leave());

const topBar = document.querySelector('.top');
const onScroll = () => topBar.classList.toggle('scrolled', window.scrollY > window.innerHeight * 0.85);
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

/* ── Copy ── */

const toast = document.getElementById('toast');
let toastTimer = 0;
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast.textContent = `Copied · ${text.length > 42 ? `${text.slice(0, 40)}…` : text}`;
  } catch {
    toast.textContent = 'Copy failed, select the text instead';
  }
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1800);
}
document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-copy]');
  if (target) copy(target.dataset.copy);
});

/* ── Install terminal ── */

// `#` lines are comments, `$` lines are commands, `>` lines are output.
const TABS = {
  demo: [
    '# Embedded Postgres, 14 simulated users, 18 tables. Nothing to install.',
    '$ npx 3d-db --type demo',
    '> 3d-db ready on <b>http://127.0.0.1:4000</b>',
    '# Or start empty and pick a database from the UI',
    '$ npx 3d-db',
  ],
  postgres: [
    '# Prompt for the password so it never lands in shell history',
    '$ npx 3d-db --type postgres --server localhost --user postgres --ask-password',
    '# Connection string',
    '$ npx 3d-db --string "postgres://user:pass@host:5432/app"',
    '# Managed or self-signed TLS',
    '$ npx 3d-db --type postgres --server db.example.com --ssl --ask-password',
    '# Per-function stats need track_functions = \'pl\'; pg_read_all_stats shows other users\' sessions.',
  ],
  mysql: [
    '# MySQL or MariaDB, both through the same connector',
    '$ npx 3d-db --type mariadb --user root --password ""',
    '# performance_schema off (XAMPP, stock MariaDB)? Capture via the general log, restored on exit',
    '$ npx 3d-db --type mariadb --user root --ask-password --capture',
    '$ npx 3d-db --string "mysql://user:pass@host:3306/shop"',
  ],
  mssql: [
    '$ npx 3d-db --type sqlserver --server localhost --user sa --ask-password',
    '# ADO.NET style strings work as is',
    '$ npx 3d-db --string "Server=host,1433;Database=app;User Id=u;Password=p;"',
    '# Session and lock views need VIEW SERVER STATE',
  ],
  mongo: [
    '$ npx 3d-db --string "mongodb://localhost:27017/shop"',
    '# Atlas and replica sets',
    '$ npx 3d-db --string "mongodb+srv://user:pass@cluster0.example.net/app"',
    '# Keep the URL out of your history',
    '$ THREEDDB_URL="mongodb://…" npx 3d-db',
  ],
};

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function highlight(cmd) {
  return esc(cmd)
    .replace(/(&quot;|")(.*?)\1/g, '<span class="st">"$2"</span>')
    .replace(/(^|\s)(--?[a-z-]+)/g, '$1<span class="fl">$2</span>');
}

const term = document.getElementById('term');
function renderTab(name) {
  term.innerHTML = TABS[name]
    .map((line) => {
      const body = line.slice(2);
      if (line[0] === '#') return `<div class="term-line comment"># ${esc(body)}</div>`;
      if (line[0] === '>') return `<div class="term-line out">${body}</div>`;
      return `<div class="term-line cmdline" data-copy="${esc(body).replace(/"/g, '&quot;')}"><code>${highlight(body)}</code><span class="copyhint">copy</span></div>`;
    })
    .join('');
}
const tabs = [...document.querySelectorAll('#tabs [role="tab"]')];
tabs.forEach((tab) =>
  tab.addEventListener('click', () => {
    tabs.forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    renderTab(tab.dataset.tab);
  }),
);
renderTab('demo');

/* ── Ticker: statements the demo's simulated users actually run ── */

const STATEMENTS = [
  ['call', 'alice', 'CALL shop.place_order(1182)'],
  ['read', 'carol', 'SELECT analytics.conversion_rate()'],
  ['write', 'bob', "UPDATE shop.customers SET payload = 'touched' WHERE id = 204"],
  ['read', 'erin', 'SELECT * FROM shop.products WHERE id = 77'],
  ['call', 'grace', 'CALL auth.rotate_tokens()'],
  ['lock', 'heidi', 'CALL shop.ship_order(2931)'],
  ['read', 'frank', 'SELECT * FROM auth.audit_log ORDER BY id DESC LIMIT 50'],
  ['write', 'admin', 'DELETE FROM analytics.events WHERE id = 1640'],
  ['call', 'svc_etl', 'CALL analytics.rollup_daily()'],
  ['read', 'dave', 'SELECT shop.order_total(512)'],
  ['call', 'svc_api', 'CALL auth.login(88)'],
  ['read', 'ivan', 'SELECT count(*) FROM analytics.events'],
];
const TAG = { read: 'READ', write: 'WRITE', call: 'CALL', lock: 'LOCK' };
const items = STATEMENTS.map(([op, user, sql]) => `<span><b class="${op}">${TAG[op]}</b>${user}  ${esc(sql)}</span>`).join('');
document.getElementById('ticker').innerHTML = items + items;

/* ── Scroll reveals, staggered per group ── */

const io = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('in');
      io.unobserve(entry.target);
    }
  },
  { rootMargin: '0px 0px -12% 0px' },
);
document.querySelectorAll('.reveal').forEach((el) => {
  const siblings = [...el.parentElement.children].filter((c) => c.classList.contains('reveal'));
  el.style.setProperty('--d', `${Math.min(siblings.indexOf(el), 6) * 0.06}s`);
  io.observe(el);
});
