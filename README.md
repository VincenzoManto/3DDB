# 3DDB

<video src="docs/video.mp4"></video>

```bash
npx 3ddb --type demo
npx 3ddb --type postgres --server localhost --user postgres --ask-password
npx 3ddb --string "mongodb://localhost:27017/shop"
```

Run `npx 3ddb --help` for every option. Requires Node 18.17+.

A real-time 3D visualizer for databases (PostgreSQL, MySQL / MariaDB, SQL Server, MongoDB), drawn as an isometric server floor. The DBMS catalog and profiler become a living datacenter: zones, racks, index slabs, workstations, people and offices.

## Quick start

```bash
npm install
npm run dev
```

- Backend: `http://localhost:4000`
- Frontend: `http://localhost:5173` (or the next free port)

Click **"Try the demo data"**: an embedded Postgres (PGlite, WASM, nothing to install) starts with 3 databases, 18 tables, 31 indexes (a few deliberately never used), real procedures and functions, and 14 users in 5 roles working at the same time, plus `you`, whom you drive from the SQL console. Catalog, indexes and roles come from Postgres's real catalog; the demo's profiler counters are simulated because PGlite has no statistics collector.

## What is what

| In the scene | In the database |
| --- | --- |
| Zone of the central hall (sign `DB …`) | Database |
| Rack | Table / collection. Width = log(rows), height = log(bytes) |
| Rack lights | Reads + writes per second; amber = locks held, red = sessions waiting |
| Rack pulse (kick + flash + floor ring + packet on the strip) | One query on the table: green = read, yellow = write, cyan = schema change |
| Slabs on top of a rack | The table's indexes: gold = primary key, violet = unique, blue = plain, grey = never scanned. They light up when used |
| Workstation in the control room (green) | Stored procedure |
| Workstation in the ops / analytics rooms (cyan) | Function |
| Glowing arcs workstation → rack | A routine call reaching the tables its code touches |
| Person | User (login). Visor color = role; a dark visor means not connected |
| Office with a `ROLE …` sign | Role / group; the cage holds the superusers |
| A person walking to a rack or workstation | Active session on that table / routine; a red `LOCK` tag = waiting on a lock |

Click anything (rack, index slab, workstation, person, role sign, database sign) for live details and dependency links.

## Every action on the database has an effect

- **Queries**: every read/write seen by the profiler makes the table's rack pulse. Each second's counters are spread over the poll interval so queries show up one by one (up to 12 pulses per table per poll). Reads count scans (≈ queries); writes count rows, so they are compressed with a square root.
- **Schema changes**: every second the poller reads a digest of the catalog. When it changes, the whole topology is re-read at once: a created table rises from the floor with a cyan ring, a dropped one dissolves in red, a new routine lights its workstation, a new database becomes a zone, a new user or role shows up in its office.
- **Feed** (bottom right): schema created/dropped, other users' statements as they start (READ / WRITE / CALL / LOCK), and yours. It lists the latest statement per user per poll; the rack pulses show every query.
- **SQL console** (demo only, bottom center): type SQL or click a preset (SELECT, INSERT, UPDATE, DELETE, CALL, CREATE/DROP of index, table, database and user). It runs as the user `you`, who walks to the rack. On real databases the console is disabled: the app never writes to your database.

## FX settings

The **⚙ FX** button (top center) opens the settings page. Everything applies live and is remembered in the browser.

- **Focal length** (24–1200 mm): the camera is a real perspective camera. Long lenses flatten the view towards the isometric look of the reference (900 mm by default); short lenses add perspective. Changing it dollies the camera so the model keeps the same size on screen.
- **Distance blur (depth of field)**: blur amount, maximum blur and a focus-distance offset. Focus follows whatever you orbit around, so things nearer or farther blur.
- **Bloom** (strength, radius, threshold), **exposure** and **vignette**.

Double-click the scene to reset the view.

## Where the data comes from

| DBMS | Catalog | Profiler |
| --- | --- | --- |
| PostgreSQL | `pg_database`, `pg_stat_user_tables`, `pg_index` + `pg_class` + `pg_am`, `pg_proc` (SQL / PL/pgSQL bodies), `pg_roles`, `pg_auth_members` | `pg_stat_user_tables` (scans and tuples), `pg_stat_user_indexes`, `pg_locks`, `pg_stat_user_functions`, `pg_stat_activity` |
| MySQL / MariaDB | `information_schema.schemata/tables/statistics/routines`, `mysql.innodb_index_stats`, `mysql.user`, `mysql.role_edges` (MySQL) or `mysql.roles_mapping` (MariaDB) | `performance_schema` (`table_io_waits_summary_by_table`, `…_by_index_usage`, `events_statements_summary_by_program`, `data_locks`), `INNODB_LOCKS` on MariaDB, `processlist`; or the general log, see below |
| SQL Server | `sys.databases`, `sys.tables`, `sys.indexes` + `sys.index_columns`, `sys.objects` + `sys.sql_modules`, `sys.server_principals` | `sys.dm_db_index_usage_stats` (per table and per index), `dm_exec_procedure_stats`, `dm_exec_function_stats`, `dm_tran_locks`, `dm_exec_sessions/requests` |
| MongoDB | `listDatabases`, `$collStats`, `listIndexes`, `system.js`, `usersInfo`, `rolesInfo` | `top`, `$indexStats`, `$currentOp`, `dbStats` |

Cumulative counters are read every second (`POLL_MS` to change it) and turned into per-second rates and events. The catalog is re-read immediately when its digest changes, and anyway every 12 polls to refresh row counts and sizes. Some views need privileges (e.g. `pg_read_all_stats`, `VIEW SERVER STATE`, `performance_schema` enabled). When one is missing, that part stays empty without breaking the rest. On PostgreSQL, function statistics need `track_functions = 'pl'`; otherwise calls are inferred from active sessions.

### MySQL / MariaDB without `performance_schema`

MariaDB ships with `performance_schema` **off** (XAMPP included), and MySQL can be configured that way too. Without it the server exposes no per-table activity, only long-running queries. When that happens the app shows a banner with two ways out:

1. **Enable query capture** (one click, opt-in): temporarily turns on the server's *general log* (`SET GLOBAL general_log`, needs the `SUPER` privilege) and reads every statement from `mysql.general_log`. You get exact per-statement pulses, users and routine calls. Index usage is not available in this mode. The previous log settings are restored when you disconnect or stop the server (if the app is killed abruptly, run `SET GLOBAL general_log = 'OFF'` yourself).
2. Set `performance_schema=ON` in the server config (`my.ini`) and restart it. Then no capture is needed. MariaDB has no per-routine summary in `performance_schema`, so routine calls there are only visible through capture or running sessions.

## Connecting a real database

**"Scan local ports"** looks for DBMSs on `localhost` (5432, 3306, 1433, 27017). Click the one found, or **"Manual connection…"**, enter the credentials and press Connect.

## Project layout

```
server/   Express + WebSocket, per-DBMS connectors (catalog + profiler), poller, PGlite demo
client/   Vite + Three.js: building, rack hall, routine workstations, people, effects, HUD, FX settings
shared/   TypeScript types shared by the WebSocket messages
```

## Scripts

- `npm run dev`: start backend and frontend together
- `npm run dev:server` / `npm run dev:client`: start them separately
- `npm run build`: production build of both workspaces
