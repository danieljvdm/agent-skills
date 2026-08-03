/** A package-relative path that has the same containment meaning on every platform. */
export const isPortablePackageSkillPath = (value: string): boolean =>
  value.length > 0 &&
  !value.startsWith("/") &&
  !value.includes("\\") &&
  !value.includes(":") &&
  ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  }) &&
  value.split("/").every((segment) =>
    segment.length > 0 && segment !== "." && segment !== ".."
  );
