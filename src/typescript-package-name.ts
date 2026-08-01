export const TYPESCRIPT_PACKAGE_NAME_PATTERN =
  /^(?:[a-z0-9][a-z0-9._-]*|@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)$/;

export const isTypeScriptPackageName = (value: string): boolean =>
  TYPESCRIPT_PACKAGE_NAME_PATTERN.test(value);
