import test from "node:test";
import assert from "node:assert/strict";
import { validEnvelope, validSyncPayload, SyncRepository } from "../src/sync.js";

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
