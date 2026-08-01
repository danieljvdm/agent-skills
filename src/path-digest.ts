import { Crypto, Effect, Encoding, FileSystem, Path, PlatformError, Schema } from "effect";

import { observeSymbolicLink } from "./node-symbolic-link.ts";

export const DigestSchema = Schema.String.check(
  Schema.isPattern(/^sha256:[0-9a-f]{64}$/),
);
export type Digest = typeof DigestSchema.Type;

export type ObservedPath =
  | { readonly kind: "missing" }
  | { readonly kind: "file" | "directory" | "symlink"; readonly digest: Digest };

export class PathInspectionError extends Schema.TaggedErrorClass<PathInspectionError>()(
  "PathInspectionError",
  {
    path: Schema.String,
    operation: Schema.String,
    cause: Schema.Unknown,
  },
) {
  override get message() {
    return `could not ${this.operation} managed path ${this.path}`;
  }
}

const textEncoder = new TextEncoder();

const frame = (value: string | Uint8Array): Uint8Array => {
  const bytes = typeof value === "string" ? textEncoder.encode(value) : value;
  const framed = new Uint8Array(4 + bytes.length);
  new DataView(framed.buffer).setUint32(0, bytes.length);
  framed.set(bytes, 4);
  return framed;
};

const concatenate = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const combined = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return combined;
};

const compareUtf8 = (left: string, right: string): number => {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
};

const digestFrames = Effect.fn("digestPathFrames")(function* (
  values: ReadonlyArray<string | Uint8Array>,
) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto.digest("SHA-256", concatenate(values.map(frame)));
  return `sha256:${Encoding.encodeHex(digest)}`;
});

const digestFileSystemPath = Effect.fn("digestFileSystemPath")(function* (
  absolutePath: string,
): Effect.fn.Return<ObservedPath, PlatformError.PlatformError | PathInspectionError, FileSystem.FileSystem | Path.Path | Crypto.Crypto> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const symbolicLink = yield* observeSymbolicLink(absolutePath);

  if (symbolicLink.kind === "missing") return { kind: "missing" };
  if (symbolicLink.kind === "symlink") {
    return {
      kind: "symlink",
      digest: yield* digestFrames(["symlink-v1", symbolicLink.target]),
    };
  }

  const info = yield* fs.stat(absolutePath).pipe(
    Effect.catch((error) =>
      error.reason._tag === "NotFound" ? Effect.void : Effect.fail(error),
    ),
  );
  if (info === undefined) return { kind: "missing" };

  if (info.type === "File") {
    return {
      kind: "file",
      digest: yield* digestFrames([
        "file-v1",
        String(info.mode & 0o777),
        yield* fs.readFile(absolutePath),
      ]),
    };
  }

  if (info.type === "Directory") {
    const entries = (yield* fs.readDirectory(absolutePath)).sort(compareUtf8);
    const frames: Array<string | Uint8Array> = ["directory-v1"];
    for (const entry of entries) {
      const childPath = path.join(absolutePath, entry);
      const child = yield* digestFileSystemPath(childPath);
      if (child.kind === "missing") {
        return yield* new PathInspectionError({
          path: childPath,
          operation: "inspect a stable directory tree",
          cause: "path disappeared during inspection",
        });
      }
      frames.push(entry, child.kind, child.digest);
    }
    return { kind: "directory", digest: yield* digestFrames(frames) };
  }

  return yield* new PathInspectionError({
    path: absolutePath,
    operation: "inspect unsupported filesystem entry",
    cause: info.type,
  });
});

export const observePath = Effect.fn("observeManagedPath")(function* (absolutePath: string) {
  return yield* digestFileSystemPath(absolutePath).pipe(
    Effect.mapError((cause) =>
      cause instanceof PathInspectionError
        ? cause
        : new PathInspectionError({ path: absolutePath, operation: "inspect", cause }),
    ),
  );
});

export const digestText = Effect.fn("digestText")(function* (value: string) {
  return yield* digestFrames(["text-v1", value]);
});

export const digestSymlinkTarget = Effect.fn("digestSymlinkTarget")(function* (target: string) {
  return yield* digestFrames(["symlink-v1", target]);
});
