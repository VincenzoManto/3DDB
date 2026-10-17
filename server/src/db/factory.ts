import type { DbKind } from '../../../shared/types';
import { getSharedMicroDb } from './microdb';
import { MongoConnector } from './mongo';
import { MsSqlConnector } from './mssql';
import { MySqlConnector } from './mysql';
import { PostgresConnector } from './postgres';
import type { DbConnector } from './types';

export function createConnector(kind: DbKind): DbConnector {
  switch (kind) {
    case 'postgres':
      return new PostgresConnector();
    case 'mysql':
      return new MySqlConnector();
    case 'mssql':
      return new MsSqlConnector();
    case 'mongo':
      return new MongoConnector();
    case 'demo':
      return getSharedMicroDb();
  }
}
