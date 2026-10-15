import test from "node:test";
import assert from "node:assert/strict";
import { validEnvelope, validSyncPayload, SyncRepository, VAULT_DDL } from "../src/sync.js";

import { envelope, memoryPool } from "./fixtures.js";

test("vault accepts canonical exact-format encrypted payloads only", () => {
  assert.equal(Boolean(validEnvelope(envelope)), true);
  for (const value of [null, [], { ...envelope, password: "plaintext" }, { ...envelope, salt: "bad" }, { ...envelope, ciphertext: "A===" }, { ...envelope, kdf: "unsafe" }]) assert.equal(Boolean(validEnvelope(value)), false);
  assert.equal(Boolean(validSyncPayload({ envelope, expectedRevision: 0 })), true);
  for (const expectedRevision of [-1, "0", 0.5, Number.MAX_SAFE_INTEGER]) assert.equal(Boolean(validSyncPayload({ envelope, expectedRevision })), false);
});

test("atomic revision CAS and user isolation", async () => {
  const repository = new SyncRepository(memoryPool());
  assert.deepEqual(await repository.get("alice"), { envelope: null, revision: 0 });
  const writes = await Promise.all([repository.put("alice", envelope, 0), repository.put("alice", envelope, 0)]);
  assert.equal(writes.filter(Boolean).length, 1);
  assert.equal(await repository.put("alice", envelope, 0), null);
  assert.equal((await repository.get("alice")).revision, 1);
  assert.deepEqual(await repository.get("bob"), { envelope: null, revision: 0 });
  assert.equal(await repository.put("bob", envelope, 1), null);
  assert.equal((await repository.put("bob", envelope, 0)).revision, 1);
  assert.equal((await repository.put("alice", envelope, 1)).revision, 2);
});

test("Postgres queries parameterize identity/payload and reject unsafe stored bigint revisions", async () => {
  const queries = [];
  const pool = { query: async (sql, values) => {
    queries.push({ sql, values });
    if (sql.startsWith("SELECT")) return { rows: [{ envelope: JSON.stringify(envelope), revision: "9007199254740992", updated_at: "1" }] };
    return { rows: [{ revision: "1" }], rowCount: 1 };
  } };
  const repository = new SyncRepository(pool);
  const identity = "synthetic' OR 1=1 --";
  await repository.put(identity, envelope, 0);
  assert.match(queries[0].sql, /ON CONFLICT \(user_id\) DO NOTHING RETURNING/);
  assert.doesNotMatch(queries[0].sql, /synthetic/);
  assert.equal(queries[0].values[0], identity);
  await assert.rejects(repository.get(identity), /Invalid stored/);
  await assert.rejects(repository.put(identity, envelope, Number.MAX_SAFE_INTEGER), /Invalid encrypted/);
  assert.match(VAULT_DDL, /user_id UUID/);
  assert.match(VAULT_DDL, /REFERENCES public\.vantix_user\(id\)/);
  assert.match(VAULT_DDL, /revision >= 1/);
  assert.doesNotMatch(VAULT_DDL, /UNSIGNED|MEDIUMTEXT|ENGINE/);
});
