import fs from "node:fs";
import path from "node:path";

// assets/fonts/*.ttf -> lib/fonts.ts (base64 gomulu). Boylece serverless
// bundle'da __dirname / fs / asset-tracing'e gerek kalmaz (pdfkit registerFont
// Buffer kabul eder). Yeniden uret: npm run gen-fonts
const root = process.cwd();
const dir = path.join(root, "assets", "fonts");
const reg = fs.readFileSync(path.join(dir, "DejaVuSans.ttf")).toString("base64");
const bold = fs.readFileSync(path.join(dir, "DejaVuSans-Bold.ttf")).toString("base64");

const out =
  "// Otomatik uretildi (scripts/gen-fonts.ts). DejaVu Sans base64 gomulu.\n" +
  "// Serverless FS/__dirname bagimsiz; Turkce karakter guvenli. Yeniden uret:\n" +
  "//   npm run gen-fonts\n" +
  `export const regular: Buffer = Buffer.from("${reg}", "base64");\n` +
  `export const bold: Buffer = Buffer.from("${bold}", "base64");\n`;

fs.writeFileSync(path.join(root, "lib", "fonts.ts"), out);
console.log(
  `lib/fonts.ts yazildi (regular ${reg.length}, bold ${bold.length} base64 char).`,
);
