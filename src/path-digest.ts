import {
  Crypto,
  Effect,
  Encoding,
  FileSystem,
  Path,
  type PlatformError,
  Schema as S,
} from "effect";

import { observeSymbolicLink } from "./node-symbolic-link.ts";

export const DigestSchema = S.String.check(S.isPattern(/^sha256:[0-9a-f]{64}$/));
export type Digest = typeof DigestSchema.Type;

export type ObservedPath =
  | { readonly kind: "missing" }
  | { readonly kind: "file" | "directory" | "symlink"; readonly digest: Digest };

export class PathInspectionError extends S.TaggedErrorClass<PathInspectionError>()(
  "PathInspectionError",
  {
    path: S.String,
    operation: S.String,
    cause: S.Unknown,
  },
) {
  override get message() {
    return `could not ${this.operation} managed path ${this.path}`;
  }
}

const textEncoder = new TextEncoder();

// Git preserves only the executable distinction for regular files. Canonicalizing
// the remaining bits keeps digests stable across checkout and copy umasks.
const canonicalFileMode = (mode: number): number => ((mode & 0o111) === 0 ? 0o644 : 0o755);
const rawFileMode = (mode: number): number => mode & 0o777;

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
  fileMode: (mode: number) => number,
): Effect.fn.Return<
  ObservedPath,
  PlatformError.PlatformError | PathInspectionError,
  FileSystem.FileSystem | Path.Path | Crypto.Crypto
> {
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

  const info = yield* fs
    .stat(absolutePath)
    .pipe(
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
        String(fileMode(info.mode)),
        yield* fs.readFile(absolutePath),
      ]),
    };
  }

  if (info.type === "Directory") {
    const entries = (yield* fs.readDirectory(absolutePath)).sort(compareUtf8);
    const frames: Array<string | Uint8Array> = ["directory-v1"];

    for (const entry of entries) {
      const childPath = path.join(absolutePath, entry);
      const child = yield* digestFileSystemPath(childPath, fileMode);

      if (child.kind === "missing") {
        return yield* PathInspectionError.make({
          path: childPath,
          operation: "inspect a stable directory tree",
          cause: "path disappeared during inspection",
        });
      }
      frames.push(entry, child.kind, child.digest);
    }

    return { kind: "directory", digest: yield* digestFrames(frames) };
  }

  return yield* PathInspectionError.make({
    path: absolutePath,
    operation: "inspect unsupported filesystem entry",
    cause: info.type,
  });
});

export const observePath = Effect.fn("observeManagedPath")(function* (absolutePath: string) {
  return yield* digestFileSystemPath(absolutePath, canonicalFileMode).pipe(
    Effect.mapError((cause) =>
      S.is(PathInspectionError)(cause)
        ? cause
        : PathInspectionError.make({ path: absolutePath, operation: "inspect", cause }),
    ),
  );
});

export const observePathWithRawModes = Effect.fn("observeManagedPathWithRawModes")(function* (
  absolutePath: string,
) {
  return yield* digestFileSystemPath(absolutePath, rawFileMode).pipe(
    Effect.mapError((cause) =>
      S.is(PathInspectionError)(cause)
        ? cause
        : PathInspectionError.make({ path: absolutePath, operation: "inspect", cause }),
    ),
  );
});

export const digestText = Effect.fn("digestText")(function* (value: string) {
  return yield* digestFrames(["text-v1", value]);
});

export const digestFileContent = Effect.fn("digestFileContent")(function* (
  value: string,
  mode = 0o644,
) {
  return yield* digestFrames(["file-v1", String(canonicalFileMode(mode)), value]);
});

export const digestSymlinkTarget = Effect.fn("digestSymlinkTarget")(function* (target: string) {
  return yield* digestFrames(["symlink-v1", target]);
});
