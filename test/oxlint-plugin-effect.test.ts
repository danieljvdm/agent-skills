import effectOxlintPlugin from "@danieljvdm/dev-kit/oxlint-plugin-effect";
import { describe, expect, it } from "vitest";

const reportsFor = (ruleName: string, visitor: string, node: unknown) => {
  const reports: Array<{ messageId: string }> = [];
  const rule = effectOxlintPlugin.rules[ruleName];
  const visit = rule?.create({
    report: (report) => reports.push(report),
    sourceCode: { getDeclaredVariables: () => [] },
  })[visitor];

  visit?.(node);

  return reports.map(({ messageId }) => messageId);
};

describe("Effect Oxlint plugin", () => {
  it("exports every reusable Egte Effect policy", () => {
    expect(Object.keys(effectOxlintPlugin.rules).sort()).toEqual([
      "no-async-workflow",
      "no-effect-run",
      "no-promise-atom-mode",
      "no-sync-boundary-decode",
      "no-unsafe-promise",
      "no-untyped-throw",
      "prefer-schema-alias",
    ]);
  });

  it("requires Schema imports from effect to use the S alias", () => {
    expect(
      reportsFor("prefer-schema-alias", "ImportDeclaration", {
        type: "ImportDeclaration",
        source: { type: "Literal", value: "effect" },
        specifiers: [
          {
            type: "ImportSpecifier",
            imported: { type: "Identifier", name: "Schema" },
            local: { type: "Identifier", name: "Schema" },
          },
        ],
      }),
    ).toEqual(["preferSchemaAlias"]);

    expect(
      reportsFor("prefer-schema-alias", "ImportDeclaration", {
        type: "ImportDeclaration",
        source: { type: "Literal", value: "effect" },
        specifiers: [
          {
            type: "ImportSpecifier",
            imported: { type: "Identifier", name: "Schema" },
            local: { type: "Identifier", name: "S" },
          },
        ],
      }),
    ).toEqual([]);
  });

  it("reports Effect runtime execution", () => {
    expect(
      reportsFor("no-effect-run", "MemberExpression", {
        type: "MemberExpression",
        computed: false,
        object: { type: "Identifier", name: "Effect" },
        property: { type: "Identifier", name: "runPromise" },
      }),
    ).toEqual(["noEffectRun"]);
  });

  it("allows Promise capture inside an Effect.tryPromise try thunk", () => {
    expect(
      reportsFor("no-async-workflow", "ArrowFunctionExpression", {
        type: "ArrowFunctionExpression",
        async: true,
        parent: {
          type: "Property",
          key: { type: "Identifier", name: "try" },
        },
      }),
    ).toEqual([]);
  });

  it("reports unsafe Promise boundaries and synchronous boundary decoding", () => {
    expect(
      reportsFor("no-unsafe-promise", "NewExpression", {
        type: "NewExpression",
        callee: { type: "Identifier", name: "Promise" },
      }),
    ).toEqual(["noPromiseConstructor"]);
    expect(
      reportsFor("no-sync-boundary-decode", "MemberExpression", {
        type: "MemberExpression",
        computed: false,
        object: { type: "Identifier", name: "Schema" },
        property: { type: "Identifier", name: "decodeUnknownSync" },
      }),
    ).toEqual(["noSyncBoundaryDecode"]);
  });
});
