import test from "node:test";
import assert from "node:assert/strict";
import { assertSecureConnection, createDatabasePool } from "../src/database.js";
import { createReadiness } from "../src/readiness.js";
import { loadConfig } from "../src/config.js";
import { configured } from "./fixtures.js";
import { initializeSchema, validateVaultSchema, validateAdditiveAuthSql } from "../src/schema.js";

test("database TLS requires authenticated client transport and TLS 1.2+", async () => {
  const client = stream => ({ connection: { stream }, query: async () => { throw new Error("Transport validation must use the actual TLS socket"); } });
  const secure = { encrypted: true, authorized: true, getProtocol: () => "TLSv1.3" };
  await assertSecureConnection(client(secure));
  await assertSecureConnection(client({ ...secure, getProtocol: () => "TLSv1.2" }));
  for (const stream of [{ ...secure, encrypted: false }, { ...secure, authorized: false }, { ...secure, getProtocol: () => "TLSv1.1" }, { ...secure, getProtocol: () => null }, {}, { encrypted: true, authorized: true }]) {
    await assert.rejects(assertSecureConnection(client(stream)), /TLS required/);
  }
});

test("proxy-terminated verified TLS does not rely on internal backend pg_stat_ssl", async () => {
  let queried = false;
  const client = {
    connection: { stream: { encrypted: true, authorized: true, getProtocol: () => "TLSv1.3" } },
    query: async () => { queried = true; return { rows: [{ ssl: false }] }; },
  };
  await assertSecureConnection(client);
  assert.equal(queried, false);
});

test("idle pool connection failures never print secret-bearing provider errors", async () => {
  const pool = createDatabasePool(loadConfig(configured).db);
  const original = console.error;
  const messages = [];
  console.error = (...args) => messages.push(args.join(" "));
  try { pool.emit("error", new Error("synthetic secret postgres://private@host/db")); }
  finally { console.error = original; await pool.end(); }
  assert.equal(messages.length, 1);
  assert.doesNotMatch(messages[0], /synthetic secret|postgres:\/\//);
});

test("readiness fails closed on unverified TLS and caches a failure without DDL", async () => {
  let connections = 0;
  let releases = 0;
  const pool = { connect: async () => {
    connections++;
    return { connection: { stream: { encrypted: true, authorized: false } }, release: () => { releases++; }, query: async () => { throw new Error("Queries must not run over unauthenticated TLS"); } };
  } };
  const readiness = createReadiness(loadConfig(configured), pool, null);
  assert.equal((await readiness.check()).ready, false);
  assert.equal((await readiness.check()).ready, false);
  assert.equal(connections, 1);
  assert.equal(releases, 1);
  await readiness.check(true);
  assert.equal(connections, 2);
});

test("schema initialization refuses runtime pooled connections before connecting", async () => {
  const config = loadConfig(configured);
  const pool = { options: config.db, connect: () => { throw new Error("Must not connect"); } };
  await assert.rejects(initializeSchema(config, pool, true), /configured direct migration pool/);
  await assert.rejects(initializeSchema({ ...config, migrationDb: null }, pool), /configured direct migration pool/);
});

function schemaFixture(change = () => {}) {
  const metadata = {
    relation: [{ relkind: "r" }],
    columns: [{ name: "user_id", type: "uuid", not_null: true }, { name: "envelope", type: "text", not_null: true }, { name: "revision", type: "int8", not_null: true }, { name: "updated_at", type: "int8", not_null: true }],
    constraints: [
      { type: "p", validated: true, columns: ["user_id"] },
      { type: "f", validated: true, columns: ["user_id"], target_schema: "public", target_table: "vantix_user", target_columns: ["id"], delete_action: "c" },
      { type: "c", validated: true, expression: "((revision >= 1) AND (revision <= '9007199254740991'::bigint))" },
      { type: "c", validated: true, expression: "((updated_at >= 0) AND (updated_at <= '9007199254740991'::bigint))" },
    ],
  };
  for (const column of metadata.columns) column.type_schema = "pg_catalog";
  change(metadata);
  return { query: async sql => {
    assert.match(sql, /^SELECT/);
    assert.doesNotMatch(sql, /\b(?:ALTER|DROP|CREATE|DELETE|UPDATE|INSERT)\b/);
    return { rows: sql.includes("constraint_entry") ? metadata.constraints : sql.includes("attribute.attname AS name") ? metadata.columns : metadata.relation };
  } };
}

test("vault metadata guard checks UUID/types, NOT NULL, primary key, validated FK and bigint bounds read-only", async () => {
  assert.equal(await validateVaultSchema(schemaFixture()), true);
  for (const change of [
    schema => { schema.relation[0].relkind = "v"; },
    schema => { schema.columns[0].type = "text"; },
    schema => { schema.columns[0].type_schema = "untrusted"; },
    schema => { schema.columns[1].not_null = false; },
    schema => { schema.columns[2].type = "int4"; },
    schema => { schema.columns.pop(); },
    schema => { schema.constraints[0].columns = ["envelope"]; },
    schema => { schema.constraints[1].target_table = "unrelated_user"; },
    schema => { schema.constraints[1].target_schema = "other"; },
    schema => { schema.constraints[1].validated = false; },
    schema => { schema.constraints[1].delete_action = "a"; },
    schema => { schema.constraints[2].validated = false; },
    schema => { schema.constraints[2].expression = "revision >= 1 OR true"; },
    schema => { schema.constraints[3].expression = "updated_at >= 0"; },
  ]) await assert.rejects(validateVaultSchema(schemaFixture(change)), /schema needs manual review/);
});

test("only schema initialization may accept a missing vault table", async () => {
  const database = schemaFixture(schema => { schema.relation = []; });
  assert.equal(await validateVaultSchema(database, { allowMissing: true }), false);
  await assert.rejects(validateVaultSchema(database), /schema needs manual review/);
});

test("migration refuses an incompatible existing vault before any DDL", async () => {
  const config = loadConfig(configured);
  const metadata = schemaFixture(schema => { schema.constraints = []; });
  const queries = [];
  let released = false;
  const connection = {
    connection: { stream: { encrypted: true, authorized: true, getProtocol: () => "TLSv1.3" } },
    release: () => { released = true; },
    query: async sql => {
      queries.push(sql);
      if (sql.includes("current_schema")) return { rows: [{ schema: "public" }] };
      return metadata.query(sql);
    },
  };
  await assert.rejects(initializeSchema({ ...config }, { options: config.migrationDb, connect: async () => connection }, true), /schema needs manual review/);
  assert.equal(released, true);
  assert.ok(queries.every(sql => sql.startsWith("SELECT")));
});

test("additive SQL guard accepts generated PostgreSQL UUID foreign-key cascades and indexes", () => {
  assert.doesNotThrow(() => validateAdditiveAuthSql(`create table "vantix_user" ("id" uuid default pg_catalog.gen_random_uuid() primary key, "name" text not null);
    create table "vantix_session" ("id" uuid default pg_catalog.gen_random_uuid() primary key, "userId" uuid not null references "vantix_user" ("id") on delete cascade);
    create index "vantix_session_userId_idx" on "vantix_session" ("userId");
    create unique index "vantix_user_email_idx" on "public"."vantix_user" ("name");`));
  assert.doesNotThrow(() => validateAdditiveAuthSql(";"));
  assert.doesNotThrow(() => validateAdditiveAuthSql(`create table "vantix_example" ("name" text default 'semi;colon and ''quoted'' text');`));
});

test("additive SQL guard refuses standalone destructive statements, unrelated targets and trailing injection", () => {
  for (const sql of [
    'DROP TABLE "vantix_user";', 'DELETE FROM "vantix_user";', 'TRUNCATE "vantix_user";',
    'UPDATE "vantix_user" SET name = \'other\';', 'INSERT INTO "vantix_user" VALUES (1);',
    'ALTER TABLE "vantix_user" ADD COLUMN other text;', 'CREATE TABLE "unrelated" (id text);',
    'CREATE INDEX "vantix_other_idx" ON "unrelated" (id);',
    'CREATE TABLE "vantix_user" (id text); DROP TABLE "vantix_user";',
    'CREATE TABLE "vantix_user" (id text) AS SELECT 1;',
    'CREATE TABLE "vantix_user" (id text) INHERITS (unrelated);',
    'CREATE TABLE "vantix_user" (id text; DROP TABLE other);',
    'CREATE TABLE "vantix_user" (id text) /*comment*/;',
    'CREATE TABLE "vantix_user" (id text default $$unsafe$$);',
  ]) assert.throws(() => validateAdditiveAuthSql(sql), /Only additive/);
});
