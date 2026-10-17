import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeTarget, parseConnectionString, resolveTarget, UsageError } from './connection';

test('postgres URL, including an encoded password and tls', () => {
  const t = parseConnectionString('postgres://app:p%40ss%2Fword@db.example.com:6543/sales?sslmode=require');
  assert.deepEqual(t, { kind: 'postgres', host: 'db.example.com', port: 6543, user: 'app', password: 'p@ss/word', database: 'sales', ssl: true });
});

test('postgresql scheme and no explicit port', () => {
  const t = parseConnectionString('postgresql://me@localhost/app');
  assert.equal(t.kind, 'postgres');
  assert.equal(t.port, undefined);
  assert.equal(t.password, undefined);
});

test('mysql and mariadb URLs both map to the mysql connector', () => {
  assert.equal(parseConnectionString('mysql://root:pw@127.0.0.1:3307/shop').kind, 'mysql');
  assert.equal(parseConnectionString('mariadb://root@localhost/shop').kind, 'mysql');
});

test('ipv6 host loses its brackets', () => {
  assert.equal(parseConnectionString('mysql://root@[::1]:3306/x').host, '::1');
});

test('mongodb URIs are kept whole (replica sets, srv, options)', () => {
  const t = parseConnectionString('mongodb://admin:s3cret@h1:27017,h2:27018/appdb?replicaSet=rs0&authSource=admin');
  assert.equal(t.kind, 'mongo');
  assert.equal(t.uri, 'mongodb://admin:s3cret@h1:27017,h2:27018/appdb?replicaSet=rs0&authSource=admin');
  assert.equal(t.host, 'h1');
  assert.equal(t.port, 27017);
  assert.equal(t.user, 'admin');
  assert.equal(t.database, 'appdb');
  assert.equal(parseConnectionString('mongodb+srv://u:p@cluster0.abc.mongodb.net/db').host, 'cluster0.abc.mongodb.net');
});

test('sql server: URL, JDBC and ADO.NET forms', () => {
  assert.deepEqual(parseConnectionString('mssql://sa:Pw1@localhost:1433/Sales'), {
    kind: 'mssql', host: 'localhost', port: 1433, user: 'sa', password: 'Pw1', database: 'Sales', ssl: undefined,
  });
  const jdbc = parseConnectionString('jdbc:sqlserver://srv:1444;databaseName=Sales;user=sa;password=Pw1;encrypt=true');
  assert.equal(jdbc.host, 'srv');
  assert.equal(jdbc.port, 1444);
  assert.equal(jdbc.database, 'Sales');
  assert.equal(jdbc.ssl, true);
  const ado = parseConnectionString('Server=tcp:srv.database.windows.net,1433;Initial Catalog=Sales;User ID=me;Password=Pw1;Encrypt=True;');
  assert.equal(ado.host, 'srv.database.windows.net');
  assert.equal(ado.port, 1433);
  assert.equal(ado.user, 'me');
  assert.equal(ado.ssl, true);
});

test('sql server named instances are refused with a hint', () => {
  assert.throws(() => parseConnectionString('Server=host\\SQLEXPRESS;User Id=sa;Password=x'), /named instances/);
});

test('libpq keyword string', () => {
  const t = parseConnectionString("host=localhost port=5433 dbname=app user=me password='a b' sslmode=require");
  assert.deepEqual(t, { kind: 'postgres', host: 'localhost', port: 5433, user: 'me', password: 'a b', database: 'app', ssl: true });
});

test('an out-of-range port is reported as such, not as a password problem', () => {
  assert.throws(() => parseConnectionString('postgres://u:p@h:99999/db'), /Invalid port 99999/);
});

test('rejects unknown schemes and garbage', () => {
  assert.throws(() => parseConnectionString('redis://localhost'), UsageError);
  assert.throws(() => parseConnectionString('not a connection string'), UsageError);
});

test('flags: defaults per database type', () => {
  assert.deepEqual(resolveTarget({ type: 'postgres', password: 'x' }), {
    kind: 'postgres', host: 'localhost', port: 5432, user: 'postgres', password: 'x', database: 'postgres',
  });
  const my = resolveTarget({ type: 'mariadb', server: '10.0.0.5', port: '3307', user: 'bob', password: 'pw', database: 'shop' })!;
  assert.deepEqual([my.kind, my.host, my.port, my.user, my.database], ['mysql', '10.0.0.5', 3307, 'bob', 'shop']);
  assert.equal(resolveTarget({ type: 'mssql' })!.user, 'sa');
});

test('flags: nothing asked means no preset', () => {
  assert.equal(resolveTarget({}), null);
});

test('flags: demo', () => {
  assert.deepEqual(resolveTarget({ type: 'demo' }), { kind: 'demo' });
});

test('--string with flag overrides keeps the password out of the URL', () => {
  const t = resolveTarget({ string: 'mysql://root@db.local/shop', password: 'secret', port: '3310' })!;
  assert.equal(t.password, 'secret');
  assert.equal(t.port, 3310);
  assert.equal(t.host, 'db.local');
});

test('--type must agree with the connection string', () => {
  assert.throws(() => resolveTarget({ type: 'mysql', string: 'postgres://u@h/db' }), /does not match/);
});

test('connection flags without --type are an error', () => {
  assert.throws(() => resolveTarget({ user: 'me' }), /--type is required/);
});

test('invalid ports and types', () => {
  assert.throws(() => resolveTarget({ type: 'mysql', port: '99999' }), /Invalid --port/);
  assert.throws(() => resolveTarget({ type: 'oracle' }), /Unknown --type/);
});

test('environment variables fill in the password and url', () => {
  assert.equal(resolveTarget({ type: 'mysql' }, { THREEDDB_PASSWORD: 'fromenv' })!.password, 'fromenv');
  assert.equal(resolveTarget({}, { THREEDDB_URL: 'postgres://u@h/db' })!.kind, 'postgres');
});

test('description never contains the password', () => {
  const t = resolveTarget({ type: 'mysql', user: 'root', password: 'hunter2', database: 'shop' })!;
  assert.ok(!describeTarget(t).includes('hunter2'));
  assert.equal(describeTarget(t), 'mysql/mariadb root@localhost:3306/shop');
});
