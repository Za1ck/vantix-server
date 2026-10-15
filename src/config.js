function databaseOptions(value, env, direct = false) {
  try {
    const url = new URL(value || "");
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username || !url.password ||
        !url.pathname.slice(1) || url.pathname.slice(1).includes("/") || url.hash ||
        (url.port && (!Number.isInteger(Number(url.port)) || Number(url.port) < 1 || Number(url.port) > 65535)) ||
        (direct && url.hostname.includes("-pooler"))) throw new Error();
    // pg-connection-string can let URL query parameters override TLS and even host.
    // Only the explicitly validated authority/database are used; policy stays here.
    url.search = "";
    return {
      connectionString: url.toString(),
      max: direct ? 2 : 5,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 20_000,
      query_timeout: 25_000,
      application_name: direct ? "vantix-schema" : "vantix-account",
      enableChannelBinding: true,
      ssl: {
        rejectUnauthorized: true,
        servername: url.hostname,
        minVersion: "TLSv1.2",
        ...(env.POSTGRES_SSL_CA ? { ca: env.POSTGRES_SSL_CA.replace(/\\n/g, "\n") } : {}),
      },
    };
  } catch { return null; }
}

export function loadConfig(env = process.env) {
  const issues = [];
  let origin = "";
  try {
    const url = new URL(env.BETTER_AUTH_URL || env.RENDER_EXTERNAL_URL || "");
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
    origin = url.origin;
  } catch { issues.push("BETTER_AUTH_URL skal være serverens præcise HTTPS-origin."); }
  const secret = env.BETTER_AUTH_SECRET || "";
  if (secret.length < 32) issues.push("BETTER_AUTH_SECRET mangler eller er for kort.");
  const db = databaseOptions(env.DATABASE_URL, env);
  const migrationDb = databaseOptions(env.DATABASE_URL_UNPOOLED, env, true);
  const databaseIssues = db ? [] : ["DATABASE_URL skal være en gyldig PostgreSQL-forbindelse med bruger, adgangskode og databasenavn."];
  const migrationIssues = migrationDb ? [] : ["DATABASE_URL_UNPOOLED skal være en gyldig direkte PostgreSQL-forbindelse uden -pooler i værtsnavnet."];
  issues.push(...databaseIssues);
  const resendKey = env.RESEND_API_KEY || "";
  const emailFrom = env.EMAIL_FROM || "";
  if (!resendKey.startsWith("re_") || resendKey.length < 12) issues.push("RESEND_API_KEY mangler eller er ugyldig.");
  if (!emailFrom || /[\r\n]/.test(emailFrom) || !/[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/.test(emailFrom)) issues.push("EMAIL_FROM skal være en godkendt afsenderadresse.");
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) issues.push("PORT er ugyldig.");
  return { origin, secret, db, migrationDb, databaseIssues, migrationIssues, resendKey, emailFrom, port: Number.isInteger(port) ? port : 3000, registrationEnabled: env.REGISTRATION_ENABLED !== "false", issues };
}
