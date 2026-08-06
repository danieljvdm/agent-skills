import {
  createRecommendedVitePlusConfig as createPackagedConfig,
  devKitToolIgnorePatterns,
} from "@danieljvdm/dev-kit/vite-plus";
import { describe, expect, it } from "vitest";

import { createRecommendedVitePlusConfig as createSourceConfig } from "../src/vite-plus.ts";

describe("recommended Vite+ config", () => {
  it("composes quality tasks and matching tool ignores", () => {
    const config = createPackagedConfig();

    expect(config).toMatchObject({
      staged: { "*": "vp check --fix" },
      fmt: { ignorePatterns: devKitToolIgnorePatterns },
      lint: { ignorePatterns: devKitToolIgnorePatterns },
      run: {
        tasks: {
          check: ["vp fmt --check", "vp lint", "vp test", "vp run typecheck"],
          typecheck: "tsc --noEmit",
        },
      },
    });
  });

  it("appends project-owned generated paths to lint and format", () => {
    const config = createPackagedConfig({
      ignorePatterns: ["apps/web/src/routeTree.gen.ts", "apps/api/worker-configuration.d.ts"],
    });

    expect(config.fmt?.ignorePatterns).toEqual([
      ...devKitToolIgnorePatterns,
      "apps/web/src/routeTree.gen.ts",
      "apps/api/worker-configuration.d.ts",
    ]);
    expect(config.lint?.ignorePatterns).toEqual(config.fmt?.ignorePatterns);
  });

  it("renders validated workspace typechecking", () => {
    const config = createPackagedConfig({
      typecheck: {
        strategy: "workspace",
        concurrency: 6,
        packages: ["packages/core", "apps/web's"],
      },
    });

    expect(config.run?.tasks?.typecheck).toEqual({
      command:
        "vp run --cache --concurrency-limit 6 --filter './packages/core' --filter './apps/web'\"'\"'s' --fail-if-no-match typecheck",
      cache: false,
    });
    expect(() =>
      createPackagedConfig({
        typecheck: { strategy: "workspace", packages: ["../outside"] },
      }),
    ).toThrow(/project-relative subdirectory/);
    expect(() =>
      createPackagedConfig({
        typecheck: { strategy: "workspace", packages: ["."] },
      }),
    ).toThrow(/project-relative subdirectory/);
    expect(() =>
      createPackagedConfig({
        typecheck: { strategy: "workspace", packages: ["packages/core", "packages/core"] },
      }),
    ).toThrow(/must be unique/);
  });

  it("returns fresh values and keeps the runtime export aligned", () => {
    const first = createPackagedConfig();
    const second = createPackagedConfig();

    expect(first).toEqual(createSourceConfig());
    expect(first).not.toBe(second);
    expect(first.fmt?.ignorePatterns).not.toBe(second.fmt?.ignorePatterns);
  });
});
