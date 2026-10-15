const fields = ["version", "kdf", "salt", "iv", "tag", "ciphertext"];

function validBase64(value, size, maxSize = size) {
  if (typeof value !== "string" || !value || value.length > 1_500_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length >= size && decoded.length <= maxSize && decoded.toString("base64") === value;
}

export function validEnvelope(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key)) &&
    value.version === 1 && value.kdf === "scrypt-32768-8-1" &&
    validBase64(value.salt, 32) && validBase64(value.iv, 12) && validBase64(value.tag, 16) && validBase64(value.ciphertext, 1, 1_125_000);
}

export function validSyncPayload(body) {
  return body && typeof body === "object" && !Array.isArray(body) && validEnvelope(body.envelope) &&
    Number.isSafeInteger(body.expectedRevision) && body.expectedRevision >= 0 && body.expectedRevision < Number.MAX_SAFE_INTEGER;
}

export class SyncRepository {
  constructor(pool) { this.pool = pool; }

  async get(userId) {
    const [rows] = await this.pool.execute("SELECT envelope, revision, updated_at FROM vantix_encrypted_vault WHERE user_id = ? LIMIT 1", [userId]);
    if (!rows.length) return { envelope: null, revision: 0 };
    const row = rows[0];
    return { envelope: JSON.parse(row.envelope), revision: Number(row.revision), updatedAt: Number(row.updated_at) };
  }

  async put(userId, envelope, expectedRevision) {
    const revision = expectedRevision + 1;
    const updatedAt = Date.now();
    if (expectedRevision === 0) {
      try {
        await this.pool.execute("INSERT INTO vantix_encrypted_vault (user_id, envelope, revision, updated_at) VALUES (?, ?, ?, ?)", [userId, JSON.stringify(envelope), revision, updatedAt]);
      } catch (error) { if (error.code === "ER_DUP_ENTRY") return null; throw error; }
    } else {
      const [result] = await this.pool.execute("UPDATE vantix_encrypted_vault SET envelope = ?, revision = ?, updated_at = ? WHERE user_id = ? AND revision = ?", [JSON.stringify(envelope), revision, updatedAt, userId, expectedRevision]);
      if (result.affectedRows !== 1) return null;
    }
    return { revision, updatedAt };
  }
}

export const VAULT_DDL = `CREATE TABLE IF NOT EXISTS vantix_encrypted_vault (
  user_id VARCHAR(36) NOT NULL PRIMARY KEY,
  envelope MEDIUMTEXT NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  updated_at BIGINT UNSIGNED NOT NULL,
  CONSTRAINT vantix_vault_user_fk FOREIGN KEY (user_id) REFERENCES vantix_user(id) ON DELETE CASCADE
) ENGINE=InnoDB`;
