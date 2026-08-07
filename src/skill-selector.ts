import { isTypeScriptPackageName } from "./typescript-package-name.ts";

/** An immediate Agent Skill directory name. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const PACKAGE_SKILL_SELECTOR_PATTERN = /^(?<package>[^#]+)#(?<skill>[^#]+)$/;

type StaticSkillSelector = {
  readonly type: "static";
  readonly name: string;
};

type PackageSkillSelector = {
  readonly type: "package";
  readonly package: string;
  readonly skill: string;
};

type SkillSelector = StaticSkillSelector | PackageSkillSelector;

/**
 * The JSON-schema-compatible pattern for static selectors and exact package
 * selectors. Package names intentionally use the same rules as package-backed
 * skill sources.
 */
export const SKILL_SELECTOR_PATTERN =
  /^(?:[a-z0-9]+(?:-[a-z0-9]+)*|(?:[a-z0-9][a-z0-9._-]*|@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)#[a-z0-9]+(?:-[a-z0-9]+)*)$/;

export const isSkillName = (value: string): boolean => SKILL_NAME_PATTERN.test(value);

/**
 * The package-qualified directory name for an installed package skill. The npm
 * package name keeps its identity in the flattened output: `@` is dropped,
 * every other non-alphanumeric run becomes one dash, and the bare skill name
 * is appended. `@tanstack/table-core#core` installs as
 * `tanstack-table-core-core`.
 */
export const packageSkillInstallName = (packageName: string, skillName: string): string =>
  `${packageName.replaceAll("@", "")}-${skillName}`
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Parse an exact, canonical manifest skill selector. */
export const parseSkillSelector = (value: string): SkillSelector | undefined => {
  if (isSkillName(value)) return { type: "static", name: value };

  const match = PACKAGE_SKILL_SELECTOR_PATTERN.exec(value);
  const packageName = match?.groups?.package;
  const skill = match?.groups?.skill;

  if (
    packageName === undefined ||
    skill === undefined ||
    !isTypeScriptPackageName(packageName) ||
    !isSkillName(skill)
  ) {
    return undefined;
  }

  return { type: "package", package: packageName, skill };
};
