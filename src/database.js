import pg from "pg";

export function createDatabasePool(options) {
  const pool = new pg.Pool(options);
  // An idle socket can fail after a compute suspends. Never log connection URLs.
  pool.on("error", () => console.error("Vantix: database connection interrupted; a subsequent request may reconnect."));
  return pool;
}

export async function assertSecureConnection(client) {
  const stream = client.connection?.stream;
  // Neon terminates the client's verified TLS at its proxy. pg_stat_ssl reports
  // the separate proxy-to-Postgres hop, not the confidentiality/authentication
  // of this socket; it is therefore not a valid client-transport readiness test.
  // Pool policy still requires CA validation, hostname verification and TLS 1.2+.
  const protocol = stream?.getProtocol?.();
  if (stream?.encrypted !== true || stream?.authorized !== true || !["TLSv1.2", "TLSv1.3"].includes(protocol)) {
    throw new Error("Verified database TLS required");
  }
}
