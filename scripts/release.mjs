// Release build with the version stamped on the app icon (macOS).
//
//   npm run release
//
// 1. Reads the version from src-tauri/tauri.conf.json.
// 2. Takes the 1024px icon out of the committed icon.icns and stamps the version on it
//    (scripts/watermark-icon.swift).
// 3. Generates the icon set from that into src-tauri/target/release-icon/ (committed icons stay clean).
// 4. Runs `tauri build` with the bundle icons pointed at the stamped set.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const tauriDir = path.join(root, "src-tauri");
const { version } = JSON.parse(fs.readFileSync(path.join(tauriDir, "tauri.conf.json"), "utf8"));
const work = path.join(tauriDir, "target", "release-icon");
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });

// cargo may come from mise rather than the shell's PATH.
const env = { ...process.env };
try {
  execFileSync("cargo", ["--version"], { stdio: "ignore", env });
} catch {
  const rust = execFileSync("mise", ["where", "rust"], { encoding: "utf8" }).trim();
  env.PATH = `${path.join(rust, "bin")}:${env.PATH}`;
}

console.log(`\n== release ${version}: stamping icon`);
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
run("iconutil", ["-c", "iconset", path.join(tauriDir, "icons", "icon.icns"), "-o", path.join(work, "master.iconset")]);
const stamped = path.join(work, "icon.png");
run("swift", [path.join(root, "scripts", "watermark-icon.swift"), path.join(work, "master.iconset", "icon_512x512@2x.png"), stamped, version]);

console.log(`\n== release ${version}: generating icon set`);
const icons = path.join(work, "icons");
run("npx", ["tauri", "icon", stamped, "-o", icons]);
// Only macOS is bundled; drop the mobile assets tauri icon also emits.
for (const d of ["android", "ios"]) fs.rmSync(path.join(icons, d), { recursive: true, force: true });

console.log(`\n== release ${version}: building`);
// Same icon list as tauri.conf.json, relative to src-tauri, pointed at the stamped set.
const bundleIcons = ["32x32.png", "128x128.png", "128x128@2x.png", "icon.icns", "icon.ico"].map((f) =>
  path.relative(tauriDir, path.join(icons, f)),
);
run("npx", ["tauri", "build", "--config", JSON.stringify({ bundle: { icon: bundleIcons } })], { env });

const app = path.join(tauriDir, "target", "release", "bundle", "macos");
console.log(`\n== release ${version}: done -> ${app}`);
