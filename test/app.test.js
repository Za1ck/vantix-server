import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createReadiness } from "../src/readiness.js";
import { SyncRepository } from "../src/sync.js";
import { configured, envelope, memoryPool } from "./fixtures.js";

async function serve(app, run) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test("setup mode is healthy but never pretends auth or sync works", async () => {
  const config = loadConfig({});
  const readiness = createReadiness(config, null, null);
  await serve(createApp({ config, readiness, auth: null, repository: null }), async base => {
    assert.equal((await fetch(base + "/healthz")).status, 200);
    const status = await (await fetch(base + "/api/status")).json();
    assert.equal(status.ready, false);
    assert.equal(status.registrationEnabled, false);
    assert.ok(status.issues.length);
    for (const route of ["/api/account", "/api/sync", "/api/auth/get-session"]) assert.equal((await fetch(base + route)).status, 503);
    assert.equal((await fetch(base + "/api/auth/sign-up/email", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 503);
  });
});

test("HTTP routes enforce verified identity, origin, header, limits and CAS", async () => {
  const config = loadConfig(configured);
  const auth = { api: { getSession: async ({ headers }) => {
    const user = headers.get("x-test-user");
    return { response: user ? { user: { id: user, emailVerified: user !== "unverified", name: user, email: `${user}@example.test` } } : null, headers: new Headers() };
  } }, handler: async () => new Response("{}", { headers: { "Content-Type": "application/json" } }) };
  const readiness = { check: async () => ({ ready: true, registrationEnabled: true, issues: [] }) };
  await serve(createApp({ config, auth, readiness, repository: new SyncRepository(memoryPool()) }), async base => {
    assert.equal((await fetch(base + "/api/account")).status, 401);
    assert.equal((await fetch(base + "/api/sync", { headers: { "x-test-user": "unverified" } })).status, 403);
    const account = await (await fetch(base + "/api/account", { headers: { "x-test-user": "alice" } })).json();
    assert.equal(account.apiVersion, 2);
    assert.equal(account.user.id, "alice");
    const headers = { "Origin": config.origin, "Content-Type": "application/json", "x-vantix-sync": "1", "x-test-user": "alice" };
    const put = (body, override = {}) => fetch(base + "/api/sync", { method: "PUT", headers: { ...headers, ...override }, body: JSON.stringify(body) });
    assert.equal((await put({ envelope, expectedRevision: 0 }, { Origin: "https://attacker.example" })).status, 403);
    assert.equal((await put({ envelope, expectedRevision: 0 }, { "x-vantix-sync": "" })).status, 403);
    assert.equal((await put({ envelope: {}, expectedRevision: 0 })).status, 400);
    assert.equal((await put({ envelope, expectedRevision: 0 })).status, 200);
    assert.equal((await put({ envelope, expectedRevision: 0 })).status, 409);
    const bob = await (await fetch(base + "/api/sync", { headers: { "x-test-user": "bob" } })).json();
    assert.deepEqual(bob, { envelope: null, revision: 0 });
    assert.equal((await fetch(base + "/api/unknown")).status, 404);
    const page = await fetch(base + "/reset-password?token=synthetic");
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
    assert.doesNotMatch(await page.text(), /synthetic/);
    assert.equal((await fetch(base + "/api/auth/sign-in/email", { method: "POST", headers, body: JSON.stringify({ password: "A".repeat(66_000) }) })).status, 413);
  });
});
