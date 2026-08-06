/**
 * Tool-owned paths that should not be linted or formatted.
 *
 * Skill copies remain tracked project inputs, while symlinked harness targets
 * and local Dev Kit state may duplicate or contain third-party source. Keep
 * these exclusions in tool configuration rather than `.gitignore`.
 */
export const devKitToolIgnorePatterns = [
  ".agents/**",
  ".claude/**",
  ".dev-kit/**",
  ".opencode/**",
  ".repos/**",
  ".vite-hooks/_/**",
] as const;
