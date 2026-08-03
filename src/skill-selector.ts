import { isTypeScriptPackageName } from "./typescript-package-name.ts";

/** An immediate Agent Skill directory name. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const PACKAGE_SKILL_SELECTOR_PATTERN = /^(?<package>[^#]+)#(?<skill>[^#]+)$/;

export type StaticSkillSelector = {
  readonly type: "static";
  readonly name: string;
};

export type PackageSkillSelector = {
  readonly type: "package";
  readonly package: string;
  readonly skill: string;
};

export type SkillSelector = StaticSkillSelector | PackageSkillSelector;

/**
 * The JSON-schema-compatible pattern for static selectors and exact package
 * selectors. Package names intentionally use the same rules as package-backed
 * skill sources.
 */
export const SKILL_SELECTOR_PATTERN =
  /^(?:[a-z0-9]+(?:-[a-z0-9]+)*|(?:[a-z0-9][a-z0-9._-]*|@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)#[a-z0-9]+(?:-[a-z0-9]+)*)$/;

export const isSkillName = (value: string): boolean => SKILL_NAME_PATTERN.test(value);

export const isSkillSelector = (value: string): boolean => parseSkillSelector(value) !== undefined;

/** Parse an exact, canonical manifest skill selector. */
export const parseSkillSelector = (value: string): SkillSelector | undefined => {
  if (isSkillName(value)) return { type: "static", name: value };

  const match = PACKAGE_SKILL_SELECTOR_PATTERN.exec(value);
  const packageName = match?.groups?.package;
  const skill = match?.groups?.skill;
  if (packageName === undefined || skill === undefined ||
    !isTypeScriptPackageName(packageName) || !isSkillName(skill)) {
    return undefined;
  }
  return { type: "package", package: packageName, skill };
};

/** Render a parsed selector in its only accepted manifest form. */
export const formatSkillSelector = (selector: SkillSelector): string =>
  selector.type === "static" ? selector.name : `${selector.package}#${selector.skill}`;
