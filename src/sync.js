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
    const { rows } = await this.pool.query("SELECT envelope, revision, updated_at FROM public.vantix_encrypted_vault WHERE user_id = $1 LIMIT 1", [userId]);
    if (!rows.length) return { envelope: null, revision: 0 };
    const row = rows[0];
    const revision = Number(row.revision);
    const updatedAt = Number(row.updated_at);
    const envelope = JSON.parse(row.envelope);
    if (!Number.isSafeInteger(revision) || revision < 1 || !Number.isSafeInteger(updatedAt) || updatedAt < 0 || !validEnvelope(envelope)) throw new Error("Invalid stored encrypted vault");
    return { envelope, revision, updatedAt };
  }

  async put(userId, envelope, expectedRevision) {
    if (!validSyncPayload({ envelope, expectedRevision })) throw new Error("Invalid encrypted vault update");
    const revision = expectedRevision + 1;
    const updatedAt = Date.now();
    if (expectedRevision === 0) {
      const result = await this.pool.query("INSERT INTO public.vantix_encrypted_vault (user_id, envelope, revision, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id) DO NOTHING RETURNING revision", [userId, JSON.stringify(envelope), revision, updatedAt]);
      if (result.rowCount !== 1) return null;
    } else {
      const result = await this.pool.query("UPDATE public.vantix_encrypted_vault SET envelope = $1, revision = $2, updated_at = $3 WHERE user_id = $4 AND revision = $5 RETURNING revision", [JSON.stringify(envelope), revision, updatedAt, userId, expectedRevision]);
      if (result.rowCount !== 1) return null;
    }
    return { revision, updatedAt };
  }
}

export const VAULT_DDL = `CREATE TABLE IF NOT EXISTS public.vantix_encrypted_vault (
  user_id UUID NOT NULL PRIMARY KEY,
  envelope TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision >= 1 AND revision <= 9007199254740991),
  updated_at BIGINT NOT NULL CHECK (updated_at >= 0 AND updated_at <= 9007199254740991),
  CONSTRAINT vantix_vault_user_fk FOREIGN KEY (user_id) REFERENCES public.vantix_user(id) ON DELETE CASCADE
)`;
