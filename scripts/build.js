import { readdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
let count = 0;
function check(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) check(file);
    else if (entry.name.endsWith(".js")) {
      const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
      if (result.status !== 0) {
        console.error(`Syntax check failed: ${relative(root, file)}`);
        process.exit(1);
      }
      count++;
    }
  }
}
for (const directory of ["src", "scripts", "test"]) check(resolve(root, directory));
console.log(`JavaScript syntax checks passed (${count} files).`);
