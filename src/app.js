import express from "express";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { fileURLToPath } from "node:url";
import { validSyncPayload } from "./sync.js";

const publicDirectory = fileURLToPath(new URL("../public/", import.meta.url));

export function createApp({ config, auth, readiness, repository }) {
  const app = express();
  app.disable("x-powered-by");
  // Render terminates TLS and supplies one final, trusted reverse-proxy hop.
  // Do not expose the Node origin directly or change to trust-proxy=true.
  app.set("trust proxy", 1);
  app.use((req, res, next) => {
    res.set({
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Strict-Transport-Security": "max-age=31536000",
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    });
    req.headers["x-vantix-client-ip"] = req.ip;
    next();
  });
  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  app.get("/api/status", async (_req, res) => res.json(await readiness.check()));
  app.use("/assets", express.static(publicDirectory, { dotfiles: "deny", index: false, etag: false }));
  app.get("/reset-password", (_req, res) => res.sendFile("reset.html", { root: publicDirectory }));
  app.get(["/", "/verified"], (_req, res) => res.sendFile("index.html", { root: publicDirectory }));

  app.use("/api", async (req, res, next) => {
    const status = await readiness.check();
    if (!status.ready || !auth) return res.status(503).json({ error: "Vantix-kontotjenesten er ikke konfigureret endnu.", code: "SERVICE_NOT_READY" });
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.get("origin") !== config.origin) return res.status(403).json({ error: "Invalid origin" });
    next();
  });

  app.all("/api/auth/*splat", (req, res, next) => {
    if (!["GET", "HEAD"].includes(req.method)) {
      const length = Number(req.get("content-length"));
      if (!req.get("content-length") || !Number.isSafeInteger(length) || length < 0) return res.status(411).json({ error: "Content-Length required" });
      if (length > 65_536) return res.status(413).json({ error: "Payload too large" });
    }
    // Password operations always use the public handler, preserving its DB-backed limits.
    return toNodeHandler(auth)(req, res, next);
  });

  app.use(express.json({ limit: 1_600_000, strict: true }));
  const authenticated = async (req, res, next) => {
    const result = await auth.api.getSession({ headers: fromNodeHeaders(req.headers), returnHeaders: true });
    const session = result.response;
    for (const cookie of result.headers.getSetCookie()) res.append("Set-Cookie", cookie);
    if (!session?.user) return res.status(401).json({ error: "Sign in required" });
    if (!session.user.emailVerified) return res.status(403).json({ error: "Bekræft din e-mailadresse først.", code: "EMAIL_NOT_VERIFIED" });
    req.vantixUser = session.user;
    next();
  };
  app.get("/api/account", authenticated, (req, res) => res.json({ user: { id: req.vantixUser.id, displayName: req.vantixUser.name, email: req.vantixUser.email }, apiVersion: 2 }));
  app.get("/api/sync", authenticated, async (req, res) => res.json(await repository.get(req.vantixUser.id)));
  app.put("/api/sync", authenticated, async (req, res) => {
    if (req.get("x-vantix-sync") !== "1" || !req.is("application/json")) return res.status(403).json({ error: "Invalid request" });
    if (!validSyncPayload(req.body)) return res.status(400).json({ error: "Invalid encrypted envelope" });
    const result = await repository.put(req.vantixUser.id, req.body.envelope, req.body.expectedRevision);
    return result ? res.json(result) : res.status(409).json({ error: "Sync conflict. Download the latest version first." });
  });
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return res.end();
    if (error.type === "entity.too.large") return res.status(413).json({ error: "Payload too large" });
    if (error instanceof SyntaxError) return res.status(400).json({ error: "Invalid JSON" });
    // Never log request URLs (verification/reset tokens), bodies, SQL parameters or provider responses.
    console.error("Vantix: request failed.");
    return res.status(503).json({ error: "Kontotjenesten kunne ikke fuldføre anmodningen. Prøv igen senere." });
  });
  return app;
}
