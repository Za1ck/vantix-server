import { getMigrations } from "better-auth/db/migration";
import { authOptions } from "./auth.js";
import { assertSecureConnection } from "./database.js";
import { VAULT_DDL } from "./sync.js";

export function validateAdditiveAuthSql(sql) {
  const statements = [];
  let current = "";
  let quote = "";
  let depth = 0;
  let closedAt = -1;
  const invalid = () => { throw new Error("Only additive Vantix table/index initialization is allowed"); };
  const finish = () => {
    if (current.trim()) statements.push({ sql: current.trim(), closingSuffix: current.slice(closedAt + 1).trim() });
    current = "";
    closedAt = -1;
  };
  for (let index = 0; index < sql.length; index++) {
    const character = sql[index];
    if (quote) {
      current += character;
      if (character === quote) {
        if (sql[index + 1] === quote) current += sql[++index];
        else quote = "";
      }
      continue;
    }
    if ((character === "-" && sql[index + 1] === "-") || (character === "/" && sql[index + 1] === "*") || character === "$" || character === "`") invalid();
    if (character === "'" || character === '"') quote = character;
    if (character === "(") depth++;
    if (character === ")") {
      if (--depth < 0) invalid();
      if (depth === 0 && closedAt === -1) closedAt = current.length;
    }
    if (character === ";") {
      if (depth !== 0) invalid();
      finish();
    } else current += character;
  }
  if (quote || depth !== 0) invalid();
  finish();
  const table = '(?:(?:"public"|public)\\s*\\.\\s*)?(?:"vantix_[a-z_]+"|vantix_[a-z_]+)';
  const indexName = '(?:"vantix_[a-zA-Z0-9_]+"|vantix_[a-zA-Z0-9_]+)';
  const tableStatement = new RegExp(`^create\\s+table\\s+${table}\\s*\\(`, "i");
  const indexStatement = new RegExp(`^create\\s+(?:unique\\s+)?index\\s+${indexName}\\s+on\\s+${table}\\s*\\(`, "i");
  for (const statement of statements) {
    if (statement.closingSuffix || (!tableStatement.test(statement.sql) && !indexStatement.test(statement.sql))) invalid();
  }
}

function checkExpression(expression) {
  // Recognize the exact interval constraints emitted by VAULT_DDL, including
  // PostgreSQL's canonical casts/parentheses. Unknown definitions need review.
  return String(expression || "").toLowerCase().replace(/::(?:pg_catalog\.)?(?:bigint|integer|numeric)/g, "").replace(/[\s()'"]/g, "");
}

export async function validateVaultSchema(database, { allowMissing = false } = {}) {
  const relation = await database.query(`SELECT relation.relkind
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public' AND relation.relname = 'vantix_encrypted_vault'`);
  if (!relation.rows.length && allowMissing) return false;
  const incompatible = () => { throw new Error("Existing encrypted vault schema needs manual review"); };
  if (relation.rows.length !== 1 || relation.rows[0].relkind !== "r") incompatible();
  const columns = await database.query(`SELECT attribute.attname AS name, type.typname AS type,
      attribute.attnotnull AS not_null, type_namespace.nspname AS type_schema
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_type AS type ON type.oid = attribute.atttypid
    JOIN pg_catalog.pg_namespace AS type_namespace ON type_namespace.oid = type.typnamespace
    WHERE attribute.attrelid = 'public.vantix_encrypted_vault'::regclass
      AND attribute.attnum > 0 AND NOT attribute.attisdropped`);
  const expected = { user_id: "uuid", envelope: "text", revision: "int8", updated_at: "int8" };
  if (columns.rows.length !== Object.keys(expected).length || columns.rows.some(column => expected[column.name] !== column.type || column.not_null !== true || column.type_schema !== "pg_catalog")) incompatible();
  const constraints = await database.query(`SELECT constraint_entry.contype AS type,
      constraint_entry.convalidated AS validated, constraint_entry.confdeltype AS delete_action,
      target_namespace.nspname AS target_schema, target_relation.relname AS target_table,
      ARRAY(SELECT attribute.attname::text
        FROM unnest(constraint_entry.conkey) WITH ORDINALITY AS key(attnum, position)
        JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = constraint_entry.conrelid AND attribute.attnum = key.attnum
        ORDER BY key.position) AS columns,
      ARRAY(SELECT attribute.attname::text
        FROM unnest(constraint_entry.confkey) WITH ORDINALITY AS key(attnum, position)
        JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = constraint_entry.confrelid AND attribute.attnum = key.attnum
        ORDER BY key.position) AS target_columns,
      pg_catalog.pg_get_expr(constraint_entry.conbin, constraint_entry.conrelid) AS expression
    FROM pg_catalog.pg_constraint AS constraint_entry
    LEFT JOIN pg_catalog.pg_class AS target_relation ON target_relation.oid = constraint_entry.confrelid
    LEFT JOIN pg_catalog.pg_namespace AS target_namespace ON target_namespace.oid = target_relation.relnamespace
    WHERE constraint_entry.conrelid = 'public.vantix_encrypted_vault'::regclass`);
  const singleColumn = (value, name) => Array.isArray(value) && value.length === 1 && value[0] === name;
  const keys = constraints.rows;
  if (!keys.some(key => key.type === "p" && key.validated === true && singleColumn(key.columns, "user_id"))) incompatible();
  if (!keys.some(key => key.type === "f" && key.validated === true && key.delete_action === "c" &&
      singleColumn(key.columns, "user_id") && key.target_schema === "public" && key.target_table === "vantix_user" && singleColumn(key.target_columns, "id"))) incompatible();
  const checks = new Set(keys.filter(key => key.type === "c" && key.validated === true).map(key => checkExpression(key.expression)));
  if (!checks.has("revision>=1andrevision<=9007199254740991") || !checks.has("updated_at>=0andupdated_at<=9007199254740991")) incompatible();
  return true;
}

export async function initializeSchema(config, pool, apply = false) {
  if (typeof apply !== "boolean" || config.migrationIssues?.length || !config.migrationDb ||
      pool.options?.connectionString !== config.migrationDb.connectionString) throw new Error("Schema initialization requires the configured direct migration pool");
  const connection = await pool.connect();
  try {
    await assertSecureConnection(connection);
    const current = await connection.query("SELECT current_schema() AS schema");
    if (current.rows[0]?.schema !== "public") throw new Error("Vantix schema must be public");
    await validateVaultSchema(connection, { allowMissing: true });
  } finally { connection.release(); }
  const plan = await getMigrations(authOptions(config, pool, async () => {}));
  const names = [...plan.toBeCreated, ...plan.toBeAdded, ...plan.toBeAddedIndexes].map(item => item.table);
  if (names.some(name => !/^vantix_[a-z_]+$/.test(name)) || plan.toBeAdded.length || plan.unsafeChanges.length || plan.schemaProblems.length) {
    throw new Error("Existing tables need manual review; this CLI creates Vantix tables/indexes only.");
  }
  const authSql = await plan.compileMigrations();
  // Validate complete statement types/targets, not keywords inside CREATE TABLE:
  // foreign keys legitimately contain ON DELETE CASCADE.
  validateAdditiveAuthSql(authSql);
  if (apply) {
    await plan.runMigrations();
    await pool.query(VAULT_DDL);
    await validateVaultSchema(pool);
  }
  return { sql: `${authSql}\n\n${VAULT_DDL};`, applied: apply, tables: names };
}
