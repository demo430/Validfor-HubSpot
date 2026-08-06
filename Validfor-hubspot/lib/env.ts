import fs from "node:fs";
import path from "node:path";

// Minimal .env.local yukleyici (bagimliliksiz). Vercel'de env vars zaten
// process.env'de olur; bu yalnizca yerel scriptler/test icindir.
export function loadEnv(file?: string): boolean {
  const target = file ?? path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(target)) return false;
  const text = fs.readFileSync(target, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = val;
  }
  return true;
}
