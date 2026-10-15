import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

import { configured } from "./fixtures.js";

test("configuration requires secrets without storing any usable defaults", () => {
  const config = loadConfig({});
  assert.equal(config.secret, "");
  assert.equal(config.db, null);
  assert.equal(config.migrationDb, null);
  assert.ok(config.issues.length >= 4);
});

test("database configuration always verifies TLS chain AND hostname", () => {
  const config = loadConfig({ ...configured, POSTGRES_SSL_CA: "first\\nsecond" });
  assert.deepEqual(config.issues, []);
  assert.equal(config.db.ssl.rejectUnauthorized, true);
  assert.equal(config.db.ssl.servername, "ep-synthetic-pooler.example");
  assert.equal(config.db.ssl.minVersion, "TLSv1.2");
  assert.equal(config.db.ssl.ca, "first\nsecond");
  assert.equal(config.db.max, 5);
  assert.equal(new URL(config.db.connectionString).search, "");
  assert.equal(config.migrationDb.ssl.servername, "ep-synthetic.example");
});

test("PostgreSQL runtime and direct migration URLs are validated separately", () => {
  for (const DATABASE_URL of ["", "mysql://a:b@example.test/db", "postgresql://a@example.test/db", "postgresql://a:b@example.test/", "postgresql://a:b@example.test/db/nested", "postgresql://a:b@example.test/db#fragment"]) {
    assert.ok(loadConfig({ ...configured, DATABASE_URL }).databaseIssues.length);
  }
  const onlyRuntime = loadConfig({ ...configured, DATABASE_URL_UNPOOLED: "" });
  assert.deepEqual(onlyRuntime.issues, []);
  assert.ok(onlyRuntime.migrationIssues.length);
  const pooledMigration = loadConfig({ ...configured, DATABASE_URL_UNPOOLED: configured.DATABASE_URL });
  assert.equal(pooledMigration.migrationDb, null);
  const forced = loadConfig({ ...configured, DATABASE_URL: configured.DATABASE_URL + "&sslmode=disable&sslcert=unsafe&host=attacker.example" });
  assert.deepEqual(forced.issues, []);
  assert.equal(new URL(forced.db.connectionString).search, "");
  assert.equal(forced.db.ssl.rejectUnauthorized, true);
  assert.equal(forced.db.ssl.servername, "ep-synthetic-pooler.example");
});

test("only exact HTTPS origins accepted; credentials and paths rejected", () => {
  for (const origin of ["http://example.test", "https://user:pass@example.test", "https://example.test/path", "https://example.test?query=1"]) {
    assert.ok(loadConfig({ ...configured, BETTER_AUTH_URL: origin }).issues.length);
  }
  assert.equal(loadConfig({ ...configured, BETTER_AUTH_URL: "", RENDER_EXTERNAL_URL: "https://vantix.onrender.com" }).origin, "https://vantix.onrender.com");
});
