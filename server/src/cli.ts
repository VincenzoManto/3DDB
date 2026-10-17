import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { exitCleanlyOn, startServer } from './app';
import { describeTarget, resolveTarget, TYPE_NAMES, UsageError } from './cli/connection';

const HELP = `3d-db — watch a database as a living 3D datacenter

Usage
  npx 3d-db --type <type> --server <host> --port <port> --user <user> --password <password> [--database <name>]
  npx 3d-db --string "<connection string>"
  npx 3d-db                       open the UI and pick a database there (or try the built-in demo)

Connection
  --type <type>          ${TYPE_NAMES}
  --server, --host <h>   database host (default: localhost)
  --port <n>             database port (default: the type's standard port)
  --user <name>          user (default: postgres / root / sa, by type)
  --password <secret>    password (see "Passwords" below)
  --database, --db <n>   database to start from
  --string, --url <s>    a connection string instead of the flags above:
                           postgres://user:pass@host:5432/db      mysql://user:pass@host:3306/db
                           mariadb://user:pass@host/db            mssql://user:pass@host:1433/db
                           Server=host,1433;Database=db;User Id=u;Password=p;   (SQL Server)
                           mongodb://user:pass@host:27017/db      mongodb+srv://user:pass@cluster/db
                         Flags given together with --string override its parts.
  --ssl                  use TLS (certificates are not verified)
  --capture              MySQL/MariaDB with performance_schema off: capture every statement
                         through the general log right away (restored on exit; needs SUPER)

Passwords
  A password on the command line is visible to other users of the machine and stays in your shell
  history. Safer options:  --ask-password (prompt)   or   THREEDDB_PASSWORD=...   or   THREEDDB_URL=...

Server
  --ui-port <n>          port for the web UI (default: 4000, or the next free one)
  --bind <address>       interface to listen on (default: 127.0.0.1). The UI has no login:
                         only bind to other addresses on networks you trust.
  --no-open              do not open the browser
  -h, --help             show this help
  -v, --version          show the version

Examples
  npx 3d-db --type postgres --server localhost --port 5432 --user postgres --ask-password
  npx 3d-db --type mariadb --user root --password "" --capture
  npx 3d-db --string "mongodb://localhost:27017/shop"
  npx 3d-db --type demo
`;

const OPTIONS = {
  type: { type: 'string' },
  server: { type: 'string' },
  host: { type: 'string' },
  port: { type: 'string' },
  user: { type: 'string' },
  password: { type: 'string' },
  database: { type: 'string' },
  db: { type: 'string' },
  string: { type: 'string' },
  url: { type: 'string' },
  ssl: { type: 'boolean' },
  capture: { type: 'boolean' },
  'ask-password': { type: 'boolean' },
  'ui-port': { type: 'string' },
  bind: { type: 'string' },
  'no-open': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

function fail(message: string, code = 2): never {
  console.error(`3d-db: ${message}\nRun "3d-db --help" for usage.`);
  process.exit(code);
}

function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new UsageError('--ask-password needs an interactive terminal; use THREEDDB_PASSWORD instead.');
  process.stdout.write(question);
  return new Promise((resolve) => {
    let typed = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(typed);
          return;
        }
        if (ch === '\u0003') process.exit(130);
        typed = ch === '\u007f' || ch === '\b' ? typed.slice(0, -1) : typed + ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

async function main(): Promise<void> {
  if (Number(process.versions.node.split('.')[0]) < 18) fail(`Node.js 18 or newer is required (this is ${process.versions.node}).`, 1);

  let parsed;
  try {
    parsed = parseArgs({ args: process.argv.slice(2), options: OPTIONS, allowPositionals: true });
  } catch (err) {
    fail((err as Error).message);
  }
  const { values, positionals } = parsed;

  if (values.help) {
    console.log(HELP);
    return;
  }
  if (values.version) {
    console.log((createRequire(import.meta.url)('../package.json') as { version: string }).version);
    return;
  }
  if (positionals.length > 1) fail(`Unexpected argument "${positionals[1]}".`);

  let target;
  try {
    const password = values['ask-password'] ? await promptHidden('Password: ') : values.password;
    target = resolveTarget(
      {
        type: values.type,
        server: values.server ?? values.host,
        port: values.port,
        user: values.user,
        password,
        database: values.database ?? values.db,
        string: values.string ?? values.url ?? positionals[0],
        ssl: values.ssl,
      },
      process.env,
    );
  } catch (err) {
    if (err instanceof UsageError) fail(err.message);
    throw err;
  }

  const staticDir = fileURLToPath(new URL('../public', import.meta.url));
  if (!existsSync(join(staticDir, 'index.html'))) {
    fail('The web UI files are missing from this installation (public/index.html). Reinstall the package.', 1);
  }

  const uiPortGiven = values['ui-port'] !== undefined;
  const uiPort = uiPortGiven ? Number(values['ui-port']) : 4000;
  if (!Number.isInteger(uiPort) || uiPort < 1 || uiPort > 65535) fail(`Invalid --ui-port "${values['ui-port']}".`);

  const running = await startServer({
    port: uiPort,
    bind: values.bind,
    staticDir,
    autoPort: !uiPortGiven,
    warmDemo: !target || target.kind === 'demo',
    preset: target ? { target, label: describeTarget(target), capture: Boolean(values.capture) } : null,
  }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') fail(`Port ${uiPort} is already in use. Pick another with --ui-port.`, 1);
    throw err;
  });

  const version = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
  console.log(`\n  3d-db ${version}`);
  console.log(`  UI        ${running.url}`);
  console.log(`  Database  ${target ? describeTarget(target) : 'choose one in the UI'}`);
  if (values.bind && !['127.0.0.1', 'localhost', '::1'].includes(values.bind)) {
    console.log('  Warning   listening beyond this machine: the UI has no login.');
  }
  console.log('  Press Ctrl+C to stop.\n');

  exitCleanlyOn(running);
  if (!values['no-open']) openBrowser(running.url);
}

main().catch((err: Error) => {
  console.error(`3d-db: ${err.message}`);
  process.exit(1);
});
