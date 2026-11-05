// Keeps the build files of the last few UI builds next to the new one (deploy/ui.Dockerfile).
//
// A console opened before a deploy still asks for the files its own build named, such as a
// diagram library it loads only when a message holds one. Without them it got the page instead
// of the script and the diagram could not be drawn until the console was reloaded.
//
//   node ui-keep-assets.mjs <new dist/ui> <previous image's dist/ui> <version> [keep]
//
// Each build records its own files in <dist/ui>/.builds/<version>.json; the newest `keep`
// builds (this one included) are kept, and a file of theirs the new build lacks is copied
// from the previous image. An image from before this records nothing: its files count as
// one build, named "previous".
import fs from "node:fs";
import path from "node:path";

const [fresh, previous, version, keepArg = "5"] = process.argv.slice(2);
const keep = Math.max(1, Number(keepArg) || 5);
const builds = (root) => path.join(root, ".builds");
const files = (root) => (fs.existsSync(path.join(root, "assets")) ? fs.readdirSync(path.join(root, "assets")).sort() : []);

const mine = { version, at: Date.now(), assets: files(fresh) };
const earlier = [];
if (path.resolve(previous) !== path.resolve(fresh)) {
  if (fs.existsSync(builds(previous))) {
    for (const name of fs.readdirSync(builds(previous)).filter((n) => n.endsWith(".json"))) {
      try {
        const b = JSON.parse(fs.readFileSync(path.join(builds(previous), name), "utf8"));
        if (b && typeof b.version === "string" && Array.isArray(b.assets) && b.version !== version) earlier.push(b);
      } catch { /* an unreadable record keeps nothing */ }
    }
  } else if (files(previous).some((name) => !mine.assets.includes(name))) {
    // Built without a previous image, the "previous" stage is this build itself: nothing to keep.
    earlier.push({ version: "previous", at: 0, assets: files(previous) });
  }
}
const kept = [mine, ...earlier.sort((a, b) => b.at - a.at).slice(0, keep - 1)];

let copied = 0;
for (const b of kept.slice(1)) {
  for (const name of b.assets) {
    if (path.basename(name) !== name) continue;
    const from = path.join(previous, "assets", name);
    const to = path.join(fresh, "assets", name);
    if (fs.existsSync(to) || !fs.existsSync(from)) continue;
    fs.copyFileSync(from, to);
    copied += 1;
  }
}
fs.rmSync(builds(fresh), { recursive: true, force: true });
fs.mkdirSync(builds(fresh), { recursive: true });
for (const b of kept) fs.writeFileSync(path.join(builds(fresh), `${b.version.replace(/[^\w.-]/g, "_")}.json`), JSON.stringify(b));
console.log(`ui-keep-assets: ${version} keeps ${kept.length} build(s): ${kept.map((b) => b.version).join(", ")}; ${copied} earlier file(s) carried over`);
