import * as esbuild from "https://deno.land/x/esbuild@v0.17.18/mod.js";
import { denoPlugins } from "https://deno.land/x/esbuild_deno_loader@0.7.0/mod.ts";
import { resolve } from "https://deno.land/std@0.177.0/path/mod.ts";

// Resolve `@coasys/ad4m-ldk` to its compiled lib in the workspace.
const ad4mLdkEntry = process.env.AD4M_LDK_ENTRY || "../ad4m/ad4m-ldk/js/lib/index.js";

// Project root — only resolve .js→.ts within our own source tree
const projectRoot = new URL(".", import.meta.url).pathname.replace(/\/$/, "");

// Resolve @noble/* packages from node_modules (via pnpm symlinks)
const nobleBasePath = resolve(projectRoot, "node_modules/@noble");

const ad4mLdkAliasPlugin = {
  name: "ad4m-ldk-alias",
  setup(build: any) {
    // Mark ad4m:host as external — resolved at runtime by the executor
    build.onResolve({ filter: /^ad4m:host$/ }, () => ({
      path: "ad4m:host",
      external: true,
    }));
    // Resolve @coasys/ad4m-ldk to the local workspace build
    build.onResolve({ filter: /^@coasys\/ad4m-ldk$/ }, () => ({
      path: resolve(projectRoot, ad4mLdkEntry),
      namespace: "file",
    }));
    // Resolve @noble/curves/* to node_modules
    build.onResolve({ filter: /^@noble\/curves/ }, (args: any) => {
      const subpath = args.path.replace("@noble/curves", "");
      let resolved: string;
      if (!subpath || subpath === "/") {
        resolved = resolve(nobleBasePath, "curves/secp256k1.js");
      } else {
        // e.g. @noble/curves/secp256k1 -> node_modules/@noble/curves/secp256k1.js
        const sub = subpath.endsWith(".js") ? subpath : subpath + ".js";
        resolved = resolve(nobleBasePath, "curves" + sub);
      }
      return { path: resolved, namespace: "file" };
    });
    // Resolve @noble/hashes/* to node_modules
    build.onResolve({ filter: /^@noble\/hashes/ }, (args: any) => {
      const subpath = args.path.replace("@noble/hashes", "");
      let resolved: string;
      if (!subpath || subpath === "/") {
        resolved = resolve(nobleBasePath, "hashes/index.js");
      } else {
        const sub = subpath.endsWith(".js") ? subpath : subpath + ".js";
        resolved = resolve(nobleBasePath, "hashes" + sub);
      }
      return { path: resolved, namespace: "file" };
    });
  },
};

// Plugin to resolve .js imports to .ts source files, but ONLY within
// our project directory. The ALDK lib/ ships compiled .js and must
// resolve as-is.
const tsResolverPlugin = {
  name: "ts-resolver",
  setup(build: any) {
    build.onResolve({ filter: /\.js$/ }, (args: any) => {
      if (args.namespace !== "file" || !args.path.startsWith(".")) return;
      // Only rewrite within our project tree, NOT inside node_modules
      const resolveDir = args.resolveDir || ".";
      if (!resolveDir.startsWith(projectRoot)) return;
      if (resolveDir.includes("node_modules")) return;
      const tsPath = args.path.replace(/\.js$/, ".ts");
      const resolved = resolve(resolveDir, tsPath);
      return { path: resolved, namespace: "file" };
    });
  },
};

const result = await esbuild.build({
  plugins: [
    ad4mLdkAliasPlugin,
    tsResolverPlugin,
    ...denoPlugins(),
  ],
  entryPoints: ["index.ts"],
  outfile: "build/bundle.js",
  bundle: true,
  platform: "node",
  target: "deno1.32.4",
  format: "esm",
  globalName: "nostr.link.language",
  charset: "ascii",
  legalComments: "inline",
});

console.log("Build result:", result);

esbuild.stop();
