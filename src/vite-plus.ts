import { recommendedOxfmtConfig } from "./oxfmt.ts";
import { recommendedOxlintConfig } from "./oxlint.ts";
import { devKitToolIgnorePatterns } from "./tool-ignore-patterns.ts";

export { devKitToolIgnorePatterns } from "./tool-ignore-patterns.ts";

export type VitePlusTypecheckOptions =
  | {
      readonly strategy?: "single-project";
      readonly command?: string;
    }
  | {
      readonly strategy: "workspace";
      readonly packages: ReadonlyArray<string>;
      readonly concurrency?: number;
    };

export type RecommendedVitePlusConfigOptions = {
  /** Additional project-owned generated or vendored paths. */
  readonly ignorePatterns?: ReadonlyArray<string>;
  readonly typecheck?: VitePlusTypecheckOptions;
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

const validateWorkspacePackage = (packageDir: string): void => {
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

const createTypecheckTask = (options: VitePlusTypecheckOptions | undefined) => {
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

/**
 * Build Dev Kit's recommended Vite+ quality defaults without owning the
 * consuming repository's `vite.config.ts`. Spread the result before local
 * project configuration.
 */
export const createRecommendedVitePlusConfig = (options: RecommendedVitePlusConfigOptions = {}) => {
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
      extends: [recommendedOxlintConfig],
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
