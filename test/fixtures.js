export const configured = {
  BETTER_AUTH_URL: "https://vantix.example", BETTER_AUTH_SECRET: "test-only-secret-with-over-32-characters-long",
  DB_HOST: "mysql.example", DB_PORT: "3306", DB_NAME: "test_database", DB_USER: "test_user", DB_PASSWORD: "synthetic-test-only",
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
    async execute(sql, parameters) {
      if (sql.startsWith("SELECT")) return [[...(rows.has(parameters[0]) ? [structuredClone(rows.get(parameters[0]))] : [])]];
      if (sql.startsWith("INSERT")) {
        const [userId, value, revision, updatedAt] = parameters;
        if (rows.has(userId)) throw Object.assign(new Error("synthetic duplicate"), { code: "ER_DUP_ENTRY" });
        rows.set(userId, { envelope: value, revision, updated_at: updatedAt });
        return [{ affectedRows: 1 }];
      }
      const [value, revision, updatedAt, userId, expected] = parameters;
      const row = rows.get(userId);
      if (!row || row.revision !== expected) return [{ affectedRows: 0 }];
      rows.set(userId, { envelope: value, revision, updated_at: updatedAt });
      return [{ affectedRows: 1 }];
    },
  };
}
