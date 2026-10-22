#!/usr/bin/env bash
# Prove that the package an app builder installs actually works.
#
# The unit tests import the runtime from the workspace, where every path
# resolves and nothing is packaged. This does what a consumer does: it packs
# the two tarballs a publish would upload, installs them into an empty
# project, and imports every entry point in both ESM and CJS.
#
# It needs the network, so it is not part of `pnpm test`.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "==> packing"
pnpm -C "$root" --filter not-another-harness pack --pack-destination "$work" >/dev/null
pnpm -C "$root" --filter nah-js pack --pack-destination "$work" >/dev/null

echo "==> installing into a clean project"
cd "$work"
npm init -y >/dev/null
npm install ./not-another-harness-*.tgz ./nah-js-*.tgz ai zod react >/dev/null

cat > check.mjs <<'EOF'
import * as runtime from "not-another-harness/js";
import * as client from "not-another-harness/js/client";
import * as facade from "nah-js";
import * as facadeClient from "nah-js/client";

const names = (m) => Object.keys(m).filter((k) => k !== "default").sort();
const runtimeNames = names(runtime);
const clientNames = names(client);

if (JSON.stringify(runtimeNames) !== JSON.stringify(names(facade))) {
	throw new Error("nah-js does not export what not-another-harness/js exports");
}
if (JSON.stringify(clientNames) !== JSON.stringify(names(facadeClient))) {
	throw new Error("nah-js/client does not export what not-another-harness/js/client exports");
}
if (runtimeNames.length === 0 || clientNames.length === 0) {
	throw new Error("an entry point exported nothing");
}
if (typeof runtime.createNahHandler !== "function") {
	throw new Error("createNahHandler is missing");
}
if (typeof client.useNahChat !== "function") {
	throw new Error("useNahChat is missing");
}
console.log(`ESM ok — ${runtimeNames.length} runtime exports, ${clientNames.length} client export`);
EOF

cat > check.cjs <<'EOF'
const runtime = require("not-another-harness/js");
const client = require("not-another-harness/js/client");
const facade = require("nah-js");
const facadeClient = require("nah-js/client");

const names = (m) => Object.keys(m).filter((k) => k !== "default").sort();
const runtimeNames = names(runtime);
const clientNames = names(client);

if (JSON.stringify(runtimeNames) !== JSON.stringify(names(facade))) {
	throw new Error("nah-js does not export what not-another-harness/js exports");
}
if (JSON.stringify(clientNames) !== JSON.stringify(names(facadeClient))) {
	throw new Error("nah-js/client does not export what not-another-harness/js/client exports");
}
if (runtimeNames.length === 0 || clientNames.length === 0) {
	throw new Error("an entry point exported nothing");
}
if (typeof runtime.createNahHandler !== "function") {
	throw new Error("createNahHandler is missing");
}
if (typeof client.useNahChat !== "function") {
	throw new Error("useNahChat is missing");
}
console.log(`CJS ok — ${runtimeNames.length} runtime exports, ${clientNames.length} client export`);
EOF

echo "==> importing"
node check.mjs
node check.cjs
echo "==> the packed runtime installs and imports"
