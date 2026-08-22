import kitPackage from "../package.json" with { type: "json" };

// The package manifest is the version authority. A static JSON import keeps
// source and installed-package execution bound to those exact bytes, while
// bundlers such as esbuild inline the dependency value into a host bundle.
// Never derive this path from import.meta.url at runtime: after single-file
// bundling that URL belongs to the host adapter, not to this package.
export const KIT_VERSION = kitPackage.version;
