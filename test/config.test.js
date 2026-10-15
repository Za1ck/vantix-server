import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

import { configured } from "./fixtures.js";

test("configuration requires secrets without storing any usable defaults", () => {
  const config = loadConfig({});
  assert.equal(config.secret, "");
  assert.equal(config.db.password, "");
  assert.equal(config.db.host, "");
  assert.ok(config.issues.length >= 5);
});

test("database configuration always verifies TLS chain AND hostname", () => {
  const config = loadConfig({ ...configured, DB_SSL_CA: "first\\nsecond" });
  assert.deepEqual(config.issues, []);
  assert.equal(config.db.ssl.rejectUnauthorized, true);
  assert.equal(config.db.ssl.verifyIdentity, true);
  assert.equal(config.db.ssl.minVersion, "TLSv1.2");
  assert.equal(config.db.ssl.ca, "first\nsecond");
  assert.equal(config.db.multipleStatements, false);
  assert.equal(config.db.timezone, "Z");
});

test("only exact HTTPS origins accepted; credentials and paths rejected", () => {
  for (const origin of ["http://example.test", "https://user:pass@example.test", "https://example.test/path", "https://example.test?query=1"]) {
    assert.ok(loadConfig({ ...configured, BETTER_AUTH_URL: origin }).issues.length);
  }
  assert.equal(loadConfig({ ...configured, BETTER_AUTH_URL: "", RENDER_EXTERNAL_URL: "https://vantix.onrender.com" }).origin, "https://vantix.onrender.com");
});
