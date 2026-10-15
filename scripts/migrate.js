import { createDatabasePool } from "../src/database.js";
import { loadLocalEnvironment } from "../src/env.js";
import { loadConfig } from "../src/config.js";
import { initializeSchema } from "../src/schema.js";

loadLocalEnvironment();
const config = loadConfig();
if (config.migrationIssues.length) {
  console.error("Migration kræver DATABASE_URL_UNPOOLED: en gyldig direkte PostgreSQL-forbindelse uden -pooler. Sæt den sikkert som miljøvariabel.");
  process.exitCode = 1;
} else {
  const pool = createDatabasePool(config.migrationDb);
  try {
    const apply = process.argv.includes("--apply");
    const result = await initializeSchema(config, pool, apply);
    if (!apply) {
      console.log("Read-only plan. Review and back up your database before npm run db:migrate. No DROP/TRUNCATE/DELETE is performed.");
      console.log(result.sql);
    } else {
      console.log("Additive Vantix schema initialization complete. Existing unrelated tables were not modified.");
    }
  } catch {
    console.error("Migration stopped. Check TLS/database access, back up the database, and review existing Vantix table definitions. No database details are printed.");
    process.exitCode = 1;
  } finally { await pool.end(); }
}
