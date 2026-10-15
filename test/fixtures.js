export const configured = {
  BETTER_AUTH_URL: "https://vantix.example", BETTER_AUTH_SECRET: "test-only-secret-with-over-32-characters-long",
  DATABASE_URL: "postgresql://test_user:synthetic-test-only@ep-synthetic-pooler.example/test_database?sslmode=require&channel_binding=require",
  DATABASE_URL_UNPOOLED: "postgresql://test_user:synthetic-test-only@ep-synthetic.example/test_database?sslmode=require&channel_binding=require",
  RESEND_API_KEY: "re_test_only_synthetic", EMAIL_FROM: "Vantix <accounts@example.test>",
};
export const envelope = {
  version: 1, kdf: "scrypt-32768-8-1", salt: Buffer.alloc(32, 1).toString("base64"),
  iv: Buffer.alloc(12, 2).toString("base64"), tag: Buffer.alloc(16, 3).toString("base64"), ciphertext: Buffer.from("encrypted-synthetic-data").toString("base64"),
};
export function memoryPool() {
  const rows = new Map();
  return {
    rows,
    async query(sql, parameters) {
      if (sql.startsWith("SELECT")) return { rows: rows.has(parameters[0]) ? [structuredClone(rows.get(parameters[0]))] : [], rowCount: rows.has(parameters[0]) ? 1 : 0 };
      if (sql.startsWith("INSERT")) {
        const [userId, value, revision, updatedAt] = parameters;
        if (rows.has(userId)) return { rows: [], rowCount: 0 };
        rows.set(userId, { envelope: value, revision, updated_at: updatedAt });
        return { rows: [{ revision }], rowCount: 1 };
      }
      const [value, revision, updatedAt, userId, expected] = parameters;
      const row = rows.get(userId);
      if (!row || row.revision !== expected) return { rows: [], rowCount: 0 };
      rows.set(userId, { envelope: value, revision, updated_at: updatedAt });
      return { rows: [{ revision }], rowCount: 1 };
    },
  };
}
