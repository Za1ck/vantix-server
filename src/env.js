import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

export function loadLocalEnvironment(directory = process.cwd()) {
  const preferred = resolve(directory, ".env");
  const fallback = resolve(directory, ".env.local");
  const path = existsSync(preferred) ? preferred : existsSync(fallback) ? fallback : null;
  // Node's loader preserves variables already injected by Render/the process.
  if (path) loadEnvFile(path);
  return path;
}
