#!/usr/bin/env node
// Pin @cteno/sdk-<target>@<own version> as optionalDependencies of the given
// package.json (publish time only; see .github/workflows/publish.yml).
import { readFileSync, writeFileSync } from 'node:fs';
import { TARGETS } from './pack-platform.mjs';
const file = process.argv[2];
const pkg = JSON.parse(readFileSync(file, 'utf8'));
// Only the platforms this release actually publishes (package.json cteno.platforms).
// Pinning a platform package that is not on npm makes `npm install @cteno/sdk` fail.
const platforms = pkg.cteno?.platforms ?? Object.keys(TARGETS);
for (const t of platforms) if (!TARGETS[t]) throw new Error(`unknown platform ${t} in cteno.platforms`);
pkg.optionalDependencies = Object.fromEntries(platforms.map(t => [`@cteno/sdk-${t}`, pkg.version]));
writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
console.log(`pinned ${Object.keys(pkg.optionalDependencies).join(', ')} @ ${pkg.version}`);
