import { createPool } from "mysql2/promise";
import { getMigrations } from "better-auth/db/migration";
import { loadConfig } from "../src/config.js";
import { authOptions } from "../src/auth.js";
import { VAULT_DDL } from "../src/sync.js";

const config = loadConfig();
const databaseIssues = config.issues.filter(item => /DB_|Database/.test(item));
if (databaseIssues.length) {
  console.error("Migration kræver gyldige DB_HOST, DB_PORT, DB_USER, DB_NAME og DB_PASSWORD. Sæt dem sikkert som miljøvariabler.");
  process.exitCode = 1;
} else {
  const pool = createPool(config.db);
  try {
    const plan = await getMigrations(authOptions(config, pool, async () => {}));
    const names = [...plan.toBeCreated, ...plan.toBeAdded, ...plan.toBeAddedIndexes].map(item => item.table);
    if (names.some(name => !name.startsWith("vantix_")) || plan.toBeAdded.length || plan.unsafeChanges.length || plan.schemaProblems.length) throw new Error("Existing tables need manual review; this CLI creates Vantix tables/indexes only.");
    const sql = await plan.compileMigrations();
    if (!process.argv.includes("--apply")) {
      console.log("Read-only plan. Review and back up your database before npm run db:migrate. No DROP/TRUNCATE/DELETE is performed.");
      console.log(sql);
      console.log(VAULT_DDL + ";");
    } else {
      await plan.runMigrations();
      await pool.query(VAULT_DDL);
      console.log("Additive Vantix schema initialization complete. Existing unrelated tables were not modified.");
    }
  } catch {
    console.error("Migration stopped. Check TLS/database access, back up the database, and review existing Vantix table definitions. No database details are printed.");
    process.exitCode = 1;
  } finally { await pool.end(); }
}
