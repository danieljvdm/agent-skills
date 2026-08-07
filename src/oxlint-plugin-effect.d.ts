interface EffectOxlintRule {
  readonly meta: {
    readonly type: "problem" | "suggestion";
    readonly docs: { readonly description: string };
    readonly fixable?: "code";
    readonly messages: Readonly<Record<string, string>>;
  };
  readonly create: (context: {
    readonly sourceCode: {
      getDeclaredVariables(node: unknown): ReadonlyArray<{
        readonly name: string;
        readonly references: ReadonlyArray<{ readonly identifier: unknown }>;
        readonly scope: { readonly set: ReadonlyMap<string, unknown> };
      }>;
    };
    report(descriptor: {
      node: unknown;
      messageId: string;
      fix?: (fixer: {
        insertTextAfter(node: unknown, text: string): unknown;
        replaceText(node: unknown, text: string): unknown;
      }) => unknown;
    }): void;
  }) => Readonly<Record<string, (node: unknown) => void>>;
}

declare const effectOxlintPlugin: {
  readonly meta: { readonly name: "dev-kit-effect" };
  readonly rules: Readonly<Record<string, EffectOxlintRule>>;
};

export default effectOxlintPlugin;
