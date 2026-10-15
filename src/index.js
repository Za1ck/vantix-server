import { createDatabasePool } from "./database.js";
import { loadLocalEnvironment } from "./env.js";
import { loadConfig } from "./config.js";
import { authOptions, createAuth, createMailer } from "./auth.js";
import { createApp } from "./app.js";
import { createReadiness } from "./readiness.js";
import { SyncRepository } from "./sync.js";

loadLocalEnvironment();
const config = loadConfig();
// A public setup-mode service can start without secrets. Authentication never falls back.
const pool = config.issues.length ? null : createDatabasePool(config.db);
const mailer = createMailer(config);
const auth = pool ? createAuth(config, pool, mailer) : null;
const readiness = createReadiness(config, pool, authOptions(config, pool, mailer));
const app = createApp({ config, auth, readiness, repository: pool ? new SyncRepository(pool) : null });
const server = app.listen(config.port, "0.0.0.0", () => {
  console.log("Vantix account service listening.");
  void readiness.check(true);
});
server.headersTimeout = 15_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;
let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  server.close(async () => { await pool?.end(); process.exit(0); });
  setTimeout(() => process.exit(1), 20_000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
