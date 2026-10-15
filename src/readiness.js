import { getMigrations } from "better-auth/db/migration";

export function createReadiness(config, pool, options) {
  let state = { ready: false, registrationEnabled: false, issues: [...config.issues, ...(!config.issues.length ? ["Databasen kontrolleres."] : [])] };
  let pending;
  let checkedAt = 0;
  const check = async (force = false) => {
    if (pending) return pending;
    if (!force && Date.now() - checkedAt < 30_000) return state;
    pending = (async () => {
      const issues = [...config.issues];
      if (!issues.length) {
        let connection;
        try {
          connection = await pool.getConnection();
          const [tls] = await connection.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
          if (!tls[0]?.Value) throw new Error("TLS unavailable");
          const plan = await getMigrations(options);
          if (plan.toBeCreated.length || plan.toBeAdded.length || plan.toBeAddedIndexes.length || plan.unsafeChanges.length || plan.schemaProblems.length) issues.push("Databaseskemaet skal oprettes eller gennemgås med npm run db:plan.");
          await connection.query("SELECT user_id, envelope, revision, updated_at FROM vantix_encrypted_vault LIMIT 0");
        } catch {
          issues.push("Sikker databaseforbindelse eller Vantix-skema er ikke klar. Kontrollér TLS, adgang og migration.");
        } finally { connection?.release(); }
      }
      checkedAt = Date.now();
      state = { ready: issues.length === 0, registrationEnabled: issues.length === 0 && config.registrationEnabled, issues };
      return state;
    })();
    try { return await pending; } finally { pending = undefined; }
  };
  return { check, snapshot: () => state };
}
