import packageMetadata from "../package.json" with { type: "json" };

export const DEV_KIT_VERSION = packageMetadata.version;
export const VITE_PLUS_TESTED_VERSION = packageMetadata.devDependencies["vite-plus"];
export const VITE_PLUS_SUPPORTED_RANGE = packageMetadata.peerDependencies["vite-plus"];
