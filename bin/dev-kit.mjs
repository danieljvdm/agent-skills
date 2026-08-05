#!/usr/bin/env bun

import semver from "semver";

const MINIMUM_BUN_VERSION = "1.3.0";
const bunVersion = globalThis.Bun?.version;

if (bunVersion === undefined) {
  throw new Error(
    `Dev Kit requires the Bun runtime, version ${MINIMUM_BUN_VERSION} or newer. Install Bun and run \`dev-kit\` again.`,
  );
}
if (!semver.satisfies(bunVersion, `>=${MINIMUM_BUN_VERSION}`)) {
  throw new Error(`Dev Kit requires Bun ${MINIMUM_BUN_VERSION} or newer; found ${bunVersion}.`);
}

await import("../src/bin/dev-kit.ts");
