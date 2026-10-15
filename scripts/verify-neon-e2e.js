import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import path from "node:path";
import https from "node:https";
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { createDatabasePool, assertSecureConnection } from "../src/database.js";
import { createAuth, authOptions } from "../src/auth.js";
import { createApp } from "../src/app.js";
import { createReadiness } from "../src/readiness.js";
import { SyncRepository } from "../src/sync.js";

// This is deliberately opt-in and cannot load the production .env/.env.local.
// The owner creates and later deletes the isolated Neon branch, not this script.
let stage = "test-only branch safeguards";
let active;
let checks = 0;
const pass = label => { checks++; console.log(`PASS ${label}`); };

function branchName(value) {
  if (!value) return "";
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : parsed?.name || parsed?.branch?.name || "";
  } catch { return value; }
}

function seal(plaintext, key, salt) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("VantixVault:1"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    version: 1, kdf: "scrypt-32768-8-1", salt: salt.toString("base64"),
    iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64"),
  };
}

function open(envelope, key) {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAAD(Buffer.from("VantixVault:1"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

class CookieJar {
  values = new Map();
  capture(headers) {
    for (const line of headers["set-cookie"] || []) {
      const [pair] = line.split(";");
      const separator = pair.indexOf("=");
      if (separator < 1) continue;
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (!value || /(?:^|;)\s*Max-Age=0(?:;|$)/i.test(line)) this.values.delete(name);
      else this.values.set(name, value);
    }
  }
  header() { return [...this.values].map(([name, value]) => `${name}=${value}`).join("; "); }
}

async function startRuntime(env, tls, secret, mails, port = 0) {
  let app;
  const server = https.createServer({ key: tls.key, cert: tls.cert, minVersion: "TLSv1.2" }, (req, res) => {
    if (app) app(req, res);
    else { res.writeHead(503); res.end(); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const origin = `https://127.0.0.1:${server.address().port}`;
  const config = loadConfig({
    ...env, BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: secret,
    RESEND_API_KEY: "re_fixture_only_no_external_delivery", EMAIL_FROM: "Vantix Test <no-reply@example.test>",
    REGISTRATION_ENABLED: "true", PORT: String(server.address().port),
  });
  let pool;
  try {
    assert.equal(config.issues.length, 0);
    pool = createDatabasePool(config.db);
    const mailer = async mail => { mails.push(mail); };
    const auth = createAuth(config, pool, mailer);
    const readiness = createReadiness(config, pool, authOptions(config, pool, mailer));
    app = createApp({ config, auth, readiness, repository: new SyncRepository(pool) });
    return { server, pool, readiness, origin, port: server.address().port };
  } catch (error) {
    await new Promise(resolve => server.close(resolve));
    await pool?.end();
    throw error;
  }
}

async function stopRuntime(runtime) {
  if (!runtime) return;
  await new Promise(resolve => runtime.server.close(resolve));
  await runtime.pool.end();
}

function request(runtime, ca, route, { method = "GET", body, jar, cookie, headers = {} } = {}) {
  const target = new URL(route, runtime.origin);
  assert.equal(target.origin, runtime.origin);
  const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = https.request(target, {
      method, ca, minVersion: "TLSv1.2", rejectUnauthorized: true, agent: false,
      headers: {
        Origin: runtime.origin, ...(encoded ? { "Content-Type": "application/json", "Content-Length": encoded.length } : {}),
        ...((cookie || jar?.header()) ? { Cookie: cookie || jar.header() } : {}), ...headers,
      },
    }, res => {
      const chunks = [];
      let size = 0;
      res.on("data", chunk => {
        size += chunk.length;
        if (size > 2_000_000) req.destroy(new Error("Response exceeds fixture limit"));
        else chunks.push(chunk);
      });
      res.once("error", reject);
      res.once("end", () => {
        jar?.capture(res.headers);
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try { json = JSON.parse(text); } catch { /* HTML verification/reset callback is expected. */ }
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.setTimeout(35_000, () => req.destroy(new Error("Fixture request timed out")));
    req.once("error", reject);
    if (encoded) req.write(encoded);
    req.end();
  });
}

async function capturedLink(mails, email, pathname) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const mail = [...mails].reverse().find(item => item.to === email && item.text.includes(pathname));
    if (mail) {
      const link = mail.text.match(/https:\/\/[^\s]+/)?.[0];
      assert.ok(link);
      return new URL(link);
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Expected in-memory mail was not captured");
}

try {
  const selectedFile = process.env.VANTIX_E2E_ENV_FILE;
  assert.ok(selectedFile && path.basename(selectedFile) === ".env.neon-test");
  const env = parseEnv(await readFile(path.resolve(selectedFile), "utf8"));
  const declaredBranch = process.env.VANTIX_E2E_BRANCH_NAME || "";
  assert.match(declaredBranch, /^vantix-migration-test-[a-zA-Z0-9-]+$/);
  const metadataBranch = branchName(env.NEON_BRANCH || env.NEON_BRANCH_NAME);
  // CLI versions can expose a branch ID instead of a name; an actual name
  // must agree with the owner's explicit test-branch selection.
  if (metadataBranch && !metadataBranch.startsWith("br-")) assert.equal(metadataBranch, declaredBranch);
  assert.ok(env.DATABASE_URL && env.DATABASE_URL_UNPOOLED);
  const pooled = new URL(env.DATABASE_URL);
  const direct = new URL(env.DATABASE_URL_UNPOOLED);
  assert.ok(pooled.hostname.endsWith(".neon.tech") && direct.hostname.endsWith(".neon.tech"));
  assert.equal(pooled.hostname.replace("-pooler.", "."), direct.hostname);
  assert.equal(pooled.pathname, direct.pathname);
  assert.ok(process.env.VANTIX_TEST_TLS_DIR);
  const tls = {
    cert: await readFile(path.join(process.env.VANTIX_TEST_TLS_DIR, "cert.pem")),
    key: await readFile(path.join(process.env.VANTIX_TEST_TLS_DIR, "key.pem")),
  };
  pass("isolated Neon test branch selected; no production env loaded");

  stage = "verified PostgreSQL TLS and readiness";
  const secret = randomBytes(64).toString("base64url");
  const mails = [];
  active = await startRuntime(env, tls, secret, mails);
  const client = await active.pool.connect();
  try { await assertSecureConnection(client); } finally { client.release(); }
  assert.equal((await active.readiness.check(true)).ready, true);
  const status = await request(active, tls.cert, "/api/status");
  assert.equal(status.status, 200);
  assert.equal(status.json.ready, true);
  assert.equal(status.json.registrationEnabled, true);
  pass("trusted PostgreSQL TLS and HTTPS readiness ready=true");

  const suffix = randomBytes(8).toString("hex");
  const userA = { name: "Synthetic Neon A", email: `vantix-a-${suffix}@example.test`, password: randomBytes(32).toString("base64url") };
  const userB = { name: "Synthetic Neon B", email: `vantix-b-${suffix}@example.test`, password: randomBytes(32).toString("base64url") };
  const jarA = new CookieJar();
  const jarB = new CookieJar();
  stage = "PostgreSQL signup and verification gate";
  for (const user of [userA, userB]) {
    const signup = await request(active, tls.cert, "/api/auth/sign-up/email", { method: "POST", body: user });
    assert.equal(signup.status, 200);
  }
  const unverified = await request(active, tls.cert, "/api/auth/sign-in/email", { method: "POST", body: { email: userA.email, password: userA.password } });
  assert.equal(unverified.status, 403);
  for (const user of [userA, userB]) {
    const link = await capturedLink(mails, user.email, "/verify-email");
    assert.equal(link.origin, active.origin);
    const verification = await request(active, tls.cert, link.pathname + link.search);
    assert.equal(verification.status, 302);
    const callback = new URL(verification.headers.location, active.origin);
    assert.equal(callback.origin, active.origin);
    assert.equal(callback.pathname, "/verified");
    assert.equal((await request(active, tls.cert, callback.pathname + callback.search)).status, 200);
  }
  pass("real PostgreSQL signup, unverified-login rejection and email verification");

  stage = "verified login and secure HTTP session cookies";
  for (const [user, jar] of [[userA, jarA], [userB, jarB]]) {
    const signin = await request(active, tls.cert, "/api/auth/sign-in/email", { method: "POST", body: { email: user.email, password: user.password }, jar });
    assert.equal(signin.status, 200);
    const cookies = (signin.headers["set-cookie"] || []).join(";");
    assert.match(cookies, /HttpOnly/i);
    assert.match(cookies, /Secure/i);
    assert.match(cookies, /SameSite=Lax/i);
    const account = await request(active, tls.cert, "/api/account", { jar });
    assert.equal(account.status, 200);
    assert.equal(account.json.user.email, user.email);
  }
  pass("verified login, persisted sessions and Secure/HttpOnly/SameSite cookies");

  stage = "encrypted PostgreSQL vault CAS and account isolation";
  const salt = randomBytes(32);
  const key = scryptSync(randomBytes(32), salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const plaintext = JSON.stringify({ version: 1, entries: [], fixture: randomBytes(24).toString("hex") });
  const envelope = seal(plaintext, key, salt);
  const initial = await request(active, tls.cert, "/api/sync", { jar: jarA });
  assert.equal(initial.status, 200);
  assert.equal(initial.json.revision, 0);
  assert.equal(initial.json.envelope, null);
  const put = (jar, expectedRevision, nextEnvelope = envelope) => request(active, tls.cert, "/api/sync", {
    method: "PUT", jar, headers: { "x-vantix-sync": "1" }, body: { envelope: nextEnvelope, expectedRevision },
  });
  const first = await put(jarA, 0);
  assert.equal(first.status, 200);
  assert.equal(first.json.revision, 1);
  assert.equal((await put(jarA, 0)).status, 409);
  const downloaded = await request(active, tls.cert, "/api/sync", { jar: jarA });
  assert.equal(downloaded.status, 200);
  assert.deepEqual(downloaded.json.envelope, envelope);
  assert.equal(open(downloaded.json.envelope, key), plaintext);
  const isolated = await request(active, tls.cert, "/api/sync", { jar: jarB });
  assert.equal(isolated.status, 200);
  assert.equal(isolated.json.revision, 0);
  assert.equal(isolated.json.envelope, null);
  const secondEnvelope = seal(plaintext + "\n", key, salt);
  assert.equal((await put(jarA, 1, secondEnvelope)).json.revision, 2);
  assert.equal((await put(jarA, 1)).status, 409);
  pass("encrypted vault insert/read/update, stale-write 409 and per-user isolation");

  stage = "concurrent PostgreSQL compare-and-swap";
  const concurrentEnvelopes = [seal(plaintext + "\nconcurrent-a", key, salt), seal(plaintext + "\nconcurrent-b", key, salt)];
  const concurrent = await Promise.all(concurrentEnvelopes.map(value => put(jarA, 2, value)));
  assert.deepEqual(concurrent.map(item => item.status).sort(), [200, 409]);
  const winningIndex = concurrent.findIndex(item => item.status === 200);
  const winningEnvelope = concurrentEnvelopes[winningIndex];
  const winningPlaintext = plaintext + (winningIndex === 0 ? "\nconcurrent-a" : "\nconcurrent-b");
  const afterConcurrency = await request(active, tls.cert, "/api/sync", { jar: jarA });
  assert.equal(afterConcurrency.status, 200);
  assert.equal(afterConcurrency.json.revision, 3);
  assert.deepEqual(afterConcurrency.json.envelope, winningEnvelope);
  pass("simultaneous same-revision writes produce exactly one 200 and one 409");

  stage = "database-backed login rate limit before restart";
  // Express's one trusted proxy hop is simulated only in this isolated HTTPS
  // fixture. Keep limiter traffic separate from the main test users' address.
  const limiterHeaders = { "X-Forwarded-For": "192.0.2.84" };
  const limiterCredentials = { email: `vantix-rate-${suffix}@example.test`, password: randomBytes(32).toString("base64url") };
  for (let attempt = 0; attempt < 5; attempt++) {
    const refused = await request(active, tls.cert, "/api/auth/sign-in/email", { method: "POST", body: limiterCredentials, headers: limiterHeaders });
    assert.equal(refused.status, 401);
  }

  stage = "PostgreSQL persistence after HTTPS app and pool restart";
  const fixedPort = active.port;
  await stopRuntime(active);
  active = undefined;
  active = await startRuntime(env, tls, secret, mails, fixedPort);
  assert.equal((await active.readiness.check(true)).ready, true);
  const accountAfterRestart = await request(active, tls.cert, "/api/account", { jar: jarA });
  assert.equal(accountAfterRestart.status, 200);
  const persisted = await request(active, tls.cert, "/api/sync", { jar: jarA });
  assert.equal(persisted.status, 200);
  assert.equal(persisted.json.revision, 3);
  assert.deepEqual(persisted.json.envelope, winningEnvelope);
  assert.equal(open(persisted.json.envelope, key), winningPlaintext);
  pass("sessions and encrypted vault survive real HTTPS app/connection-pool restart");

  stage = "database-backed rate limit survives restart";
  const limited = await request(active, tls.cert, "/api/auth/sign-in/email", { method: "POST", body: limiterCredentials, headers: limiterHeaders });
  assert.equal(limited.status, 429);
  pass("PostgreSQL-backed login rate limit survives app/connection-pool restart");

  stage = "password reset revocation and logout";
  const oldCookie = jarA.header();
  const resetRequest = await request(active, tls.cert, "/api/auth/request-password-reset", { method: "POST", body: { email: userA.email } });
  assert.equal(resetRequest.status, 200);
  const resetLink = await capturedLink(mails, userA.email, "/reset-password/");
  assert.equal(resetLink.origin, active.origin);
  const resetRedirect = await request(active, tls.cert, resetLink.pathname + resetLink.search);
  assert.equal(resetRedirect.status, 302);
  const resetTarget = new URL(resetRedirect.headers.location, active.origin);
  assert.equal(resetTarget.origin, active.origin);
  assert.equal(resetTarget.pathname, "/reset-password");
  const token = resetTarget.searchParams.get("token");
  assert.ok(token);
  const newPassword = randomBytes(32).toString("base64url");
  assert.equal((await request(active, tls.cert, "/api/auth/reset-password", { method: "POST", body: { token, newPassword } })).status, 200);
  assert.equal((await request(active, tls.cert, "/api/account", { cookie: oldCookie })).status, 401);
  const newJar = new CookieJar();
  assert.equal((await request(active, tls.cert, "/api/auth/sign-in/email", { method: "POST", body: { email: userA.email, password: newPassword }, jar: newJar })).status, 200);
  const loggedInCookie = newJar.header();
  const logout = await request(active, tls.cert, "/api/auth/sign-out", { method: "POST", body: {}, jar: newJar });
  assert.equal(logout.status, 200);
  assert.equal(newJar.header(), "");
  assert.equal((await request(active, tls.cert, "/api/account", { cookie: loggedInCookie })).status, 401);
  pass("password reset revokes old session; logout revokes new session");
  console.log(JSON.stringify({ status: "PASS", checks, database: "real Neon PostgreSQL test branch", transport: "verified TLS", mailDelivery: "in-memory fixture only", productionDataTouched: false }));
} catch {
  // Do not print provider errors, request URLs, mail contents or assertion diffs.
  console.error(`FAIL Neon E2E stage: ${stage}. Sensitive details intentionally omitted.`);
  process.exitCode = 1;
} finally {
  await stopRuntime(active);
}
