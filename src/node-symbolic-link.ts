import { Effect, FileSystem, type PlatformError } from "effect";

export type SymbolicLinkObservation =
  | { readonly kind: "missing" | "not-symlink" }
  | { readonly kind: "symlink"; readonly target: string };

// Effect's Node FileSystem adapter maps readlink(2) EINVAL to Unknown. Keep
// that runtime-specific normalization at this narrow adapter boundary.
const isNotSymbolicLink = (error: PlatformError.PlatformError): boolean => {
  if (error.reason._tag !== "Unknown") return false;
  const cause = error.reason.cause;

  return cause instanceof Error && "code" in cause && cause.code === "EINVAL";
};

export const observeSymbolicLink = Effect.fn("observeSymbolicLink")(function* (
  absolutePath: string,
) {
  const fs = yield* FileSystem.FileSystem;

  return yield* fs.readLink(absolutePath).pipe(
    Effect.map((target): SymbolicLinkObservation => ({ kind: "symlink", target })),
    Effect.catch((error) => {
      if (error.reason._tag === "NotFound") {
        return Effect.succeed<SymbolicLinkObservation>({ kind: "missing" });
      }
      if (isNotSymbolicLink(error)) {
        return Effect.succeed<SymbolicLinkObservation>({ kind: "not-symlink" });
      }

      return Effect.fail(error);
    }),
  );
});
