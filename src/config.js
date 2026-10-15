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
  const db = {
    host: env.DB_HOST || "",
    port: Number(env.DB_PORT || 3306),
    user: env.DB_USER || "",
    database: env.DB_NAME || "",
    password: env.DB_PASSWORD || "",
    timezone: "Z",
    connectionLimit: 5,
    connectTimeout: 10_000,
    enableKeepAlive: true,
    multipleStatements: false,
    ssl: {
      rejectUnauthorized: true,
      verifyIdentity: true,
      minVersion: "TLSv1.2",
      ...(env.DB_SSL_CA ? { ca: env.DB_SSL_CA.replace(/\\n/g, "\n") } : {}),
    },
  };
  if (!db.password) issues.push("DB_PASSWORD mangler.");
  if (!db.host || !db.user || !Number.isInteger(db.port) || db.port < 1 || db.port > 65535 || !/^[a-zA-Z0-9_]+$/.test(db.database)) issues.push("DB_HOST, DB_PORT, DB_USER og DB_NAME skal være gyldige.");
  const resendKey = env.RESEND_API_KEY || "";
  const emailFrom = env.EMAIL_FROM || "";
  if (!resendKey.startsWith("re_") || resendKey.length < 12) issues.push("RESEND_API_KEY mangler eller er ugyldig.");
  if (!emailFrom || /[\r\n]/.test(emailFrom) || !/[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/.test(emailFrom)) issues.push("EMAIL_FROM skal være en godkendt afsenderadresse.");
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) issues.push("PORT er ugyldig.");
  return { origin, secret, db, resendKey, emailFrom, port: Number.isInteger(port) ? port : 3000, registrationEnabled: env.REGISTRATION_ENABLED !== "false", issues };
}
