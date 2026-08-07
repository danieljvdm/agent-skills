import { recommendedOxfmtConfig } from "./oxfmt.js";
import { recommendedOxlintConfig } from "./oxlint.js";
import { devKitToolIgnorePatterns } from "./tool-ignore-patterns.js";

export { devKitToolIgnorePatterns } from "./tool-ignore-patterns.js";

const shellQuote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;

const validateWorkspacePackage = (packageDir) => {
  const segments = packageDir.split(/[\\/]/);

  if (
    packageDir.trim().length === 0 ||
    packageDir === "." ||
    packageDir === "./" ||
    packageDir === ".\\" ||
    packageDir.startsWith("/") ||
    packageDir.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(packageDir) ||
    segments.includes("..")
  ) {
    throw new Error(`workspace package must be a project-relative subdirectory: ${packageDir}`);
  }
};

const createTypecheckTask = (options) => {
  if (options?.strategy !== "workspace") {
    const command = options?.command ?? "tsc --noEmit";

    if (command.trim().length === 0) throw new Error("typecheck command must not be empty");

    return command;
  }
  const concurrency = options.concurrency ?? 4;

  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error("workspace typecheck concurrency must be between 1 and 32");
  }
  if (options.packages.length === 0) {
    throw new Error("workspace typechecking requires at least one package directory");
  }
  const packages = [...new Set(options.packages)];

  if (packages.length !== options.packages.length) {
    throw new Error("workspace typecheck packages must be unique");
  }
  for (const packageDir of packages) validateWorkspacePackage(packageDir);
  const filters = packages
    .map((packageDir) => `--filter ${shellQuote(`./${packageDir}`)}`)
    .join(" ");

  return {
    command: `vp run --cache --concurrency-limit ${concurrency} ${filters} --fail-if-no-match typecheck`,
    cache: false,
  };
};

/** Build composable quality defaults for a project-owned Vite+ config. */
export const createRecommendedVitePlusConfig = (options = {}) => {
  const ignorePatterns = [...devKitToolIgnorePatterns, ...(options.ignorePatterns ?? [])];

  return {
    staged: {
      "*": "vp check --fix",
    },
    fmt: {
      ...recommendedOxfmtConfig,
      ignorePatterns,
    },
    lint: {
      ...recommendedOxlintConfig,
      ignorePatterns,
    },
    run: {
      tasks: {
        check: ["vp fmt --check", "vp lint", "vp test", "vp run typecheck"],
        typecheck: createTypecheckTask(options.typecheck),
      },
    },
  };
};
