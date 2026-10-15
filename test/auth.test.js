import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { authOptions } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { configured } from "./fixtures.js";
import { createApp } from "../src/app.js";

test("real Better Auth verification, secure session, reset revocation and persistent rate limiting", async () => {
  const config = loadConfig(configured);
  const database = new DatabaseSync(":memory:");
  const mails = [];
  const options = authOptions(config, database, async mail => { mails.push(mail); });
  const plan = await getMigrations(options);
  assert.ok(plan.toBeCreated.every(item => item.table.startsWith("vantix_")));
  await plan.runMigrations();
  const auth = betterAuth(options);
  const request = (route, body, cookie = "", ip = "192.0.2.1") => auth.handler(new Request(config.origin + "/api/auth" + route, {
    method: body ? "POST" : "GET",
    headers: { Origin: config.origin, "Content-Type": "application/json", "x-vantix-client-ip": ip, ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }));
  const credentials = { email: "person@example.test", password: "synthetic-test-password-123" };
  const signup = await request("/sign-up/email", { ...credentials, name: "Test User", callbackURL: config.origin + "/unexpected" });
  assert.equal(signup.status, 200);
  assert.equal(mails.length, 1);
  assert.match(mails[0].text, /callbackURL=https%3A%2F%2Fvantix\.example%2Fverified/);
  assert.doesNotMatch(mails[0].text, /attacker/);
  const unverified = await request("/sign-in/email", credentials);
  assert.equal(unverified.status, 403);
  const verifyUrl = mails[0].text.match(/https:\/\/[^\s]+/)[0];
  assert.equal((await auth.handler(new Request(verifyUrl))).status, 302);
  const signin = await request("/sign-in/email", credentials);
  assert.equal(signin.status, 200);
  const setCookie = signin.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Secure/i);
  assert.match(setCookie, /SameSite=Lax/i);
  const cookie = setCookie.split(";")[0];
  const session = await (await request("/get-session", null, cookie)).json();
  assert.equal(session.user.emailVerified, true);
  assert.equal(session.user.email, credentials.email);
  assert.equal((await request("/request-password-reset", { email: credentials.email, redirectTo: config.origin + "/unexpected" })).status, 200);
  const resetMail = mails.at(-1);
  assert.match(resetMail.text, /reset-password/);
  assert.doesNotMatch(resetMail.text, /attacker/);
  const resetUrl = resetMail.text.match(/https:\/\/[^\s]+/)[0];
  const redirect = await auth.handler(new Request(resetUrl));
  assert.equal(redirect.status, 302);
  const location = new URL(redirect.headers.get("location"));
  assert.equal(location.pathname, "/reset-password");
  const token = location.searchParams.get("token");
  assert.ok(token);
  assert.equal((await request("/reset-password", { token, newPassword: "changed-synthetic-password-456" })).status, 200);
  assert.equal(await (await request("/get-session", null, cookie)).json(), null);
  const signinAgain = await request("/sign-in/email", { ...credentials, password: "changed-synthetic-password-456" }, "", "192.0.2.2");
  assert.equal(signinAgain.status, 200);
  const logoutCookie = signinAgain.headers.get("set-cookie").split(";")[0];
  const signout = await request("/sign-out", {}, logoutCookie);
  assert.equal(signout.status, 200);
  assert.match(signout.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal(await (await request("/get-session", null, logoutCookie)).json(), null);
  let limited;
  for (let i = 0; i < 6; i++) limited = await request("/sign-in/email", { ...credentials, password: "wrong-password-000" }, "", "192.0.2.33");
  assert.equal(limited.status, 429);
  assert.ok(database.prepare("SELECT COUNT(*) AS count FROM vantix_rate_limit").get().count > 0);
  database.close();
});

test("Express forwards request bodies/cookies to the real public auth handler", async () => {
  const config = loadConfig(configured);
  const database = new DatabaseSync(":memory:");
  const options = authOptions(config, database, async () => {});
  await (await getMigrations(options)).runMigrations();
  const auth = betterAuth(options);
  const app = createApp({ config, auth, readiness: { check: async () => ({ ready: true, issues: [] }) } });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const signup = await fetch(base + "/api/auth/sign-up/email", { method: "POST", headers: { Origin: config.origin, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Local Test", email: "local@example.test", password: "local-test-password-123" }) });
    assert.equal(signup.status, 200);
    const account = await fetch(base + "/api/account");
    assert.equal(account.status, 401);
    assert.equal((await account.json()).error, "Sign in required");
    assert.equal((await fetch(base + "/api/auth/sign-in/email", { method: "POST", headers: { Origin: "https://attacker.example", "Content-Type": "application/json" }, body: "{}" })).status, 403);
  } finally {
    await new Promise(resolve => server.close(resolve));
    database.close();
  }
});
