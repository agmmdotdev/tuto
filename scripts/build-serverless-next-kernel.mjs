import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { build } from "esbuild";

const runtimeRequire = createRequire(import.meta.url);
const outputPath = path.resolve(
  "lib/serverless-next/client-kernel.generated.js",
);
const manifestPath = path.resolve(
  "lib/serverless-next/client-kernel-manifest.generated.json",
);
const entry = `
import * as React from "react";
import * as ReactJsxRuntime from "react/jsx-runtime";
import * as ReactDom from "react-dom";
import * as ReactDomClient from "react-dom/client";
import * as RscClient from "next/dist/compiled/react-server-dom-webpack/client.browser";

const actionClient = Object.freeze({
  callServer(actionId, args) {
    const call = globalThis.__TUTO_NEXT_CALL_SERVER__;
    if (typeof call !== "function") {
      throw new Error("The Tuto Next Server Action transport is not initialized.");
    }
    return call(actionId, args);
  },
  createServerReference(actionId, _callServer, ...metadata) {
    return RscClient.createServerReference(
      actionId,
      actionClient.callServer,
      ...metadata,
    );
  },
  findSourceMapURL() {
    return undefined;
  },
});

function currentPreviewUrl() {
  return new URL(globalThis.__TUTO_NEXT_URL__ || "/", "http://next.local");
}

function navigate(kind, href) {
  const target = href === undefined ? currentPreviewUrl() : new URL(String(href), currentPreviewUrl());
  if (target.origin !== "http://next.local") return false;
  const navigation = globalThis.__TUTO_NEXT_NAVIGATE__;
  if (typeof navigation !== "function") return false;
  navigation(kind, target.pathname + target.search + target.hash);
  return true;
}

const navigationModule = Object.freeze({
  usePathname() {
    return currentPreviewUrl().pathname;
  },
  useRouter() {
    return React.useMemo(() => ({
      back: () => navigate("back"),
      forward: () => navigate("forward"),
      prefetch: async () => {},
      push: (href) => navigate("push", href),
      refresh: () => navigate("refresh"),
      replace: (href) => navigate("replace", href),
    }), []);
  },
  useSearchParams() {
    return currentPreviewUrl().searchParams;
  },
});

const Link = React.forwardRef(function Link(
  { children, href, onClick, replace = false, target, ...props },
  ref,
) {
  const value = href instanceof URL ? href.href : String(href);
  return React.createElement("a", {
    ...props,
    href: value,
    onClick(event) {
      onClick?.(event);
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        (target && target !== "_self")
      ) return;
      if (navigate(replace ? "replace" : "push", value)) event.preventDefault();
    },
    ref,
    target,
  }, children);
});

function runtimeError(message, digest) {
  const error = new Error(message || "The Server Component render failed.");
  if (digest) error.digest = digest;
  return error;
}

function ErrorFallback({ digest, errorComponent: ErrorComponent, message }) {
  const error = React.useMemo(() => runtimeError(message, digest), [digest, message]);
  const reset = React.useCallback(() => navigate("refresh"), []);
  return React.createElement(ErrorComponent, { error, reset });
}

class SegmentErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.reset = () => {
      navigate("refresh");
      this.setState({ error: null });
    };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    return this.state.error
      ? React.createElement(this.props.errorComponent, {
          error: this.state.error,
          reset: this.reset,
        })
      : this.props.children;
  }
}

const runtimeModule = Object.freeze({ ErrorFallback, Link, SegmentErrorBoundary });
const linkModule = Object.freeze({ __esModule: true, default: Link });

globalThis.__TUTO_NEXT_CLIENT_MODULES__["tuto-next-runtime"] = runtimeModule;

globalThis.__TUTO_NEXT_CLIENT_KERNEL__ = Object.freeze({
  actionClient,
  modules: Object.freeze({
    "next/link": linkModule,
    "next/navigation": navigationModule,
    react: React,
    "react/jsx-runtime": ReactJsxRuntime,
    "react-dom": ReactDom,
  }),
  reactDomClient: ReactDomClient,
  rscClient: RscClient,
});
`;

const result = await build({
  banner: {
    js: `/* eslint-disable */
globalThis.__TUTO_NEXT_CLIENT_MODULES__ ||= Object.create(null);
globalThis.__webpack_require__ ||= ((id) => globalThis.__TUTO_NEXT_CLIENT_MODULES__[id]);
globalThis.__webpack_require__.u ||= ((id) => String(id));
globalThis.__webpack_chunk_load__ ||= (async () => {});`,
  },
  bundle: true,
  define: { "process.env.NODE_ENV": '"production"' },
  format: "iife",
  logLevel: "warning",
  minify: true,
  outfile: outputPath,
  platform: "browser",
  stdin: {
    contents: entry,
    loader: "js",
    resolveDir: process.cwd(),
    sourcefile: "tuto-next-client-kernel.js",
  },
  target: "es2022",
  write: false,
});

const code = result.outputFiles[0].text;
const id = createHash("sha256").update(code).digest("hex").slice(0, 20);
await writeFile(outputPath, code);
await writeFile(
  manifestPath,
  `${JSON.stringify(
    {
      bytes: Buffer.byteLength(code),
      file: path.basename(outputPath),
      id,
      next: runtimeRequire("next/package.json").version,
      react: runtimeRequire("react/package.json").version,
      reactDom: runtimeRequire("react-dom/package.json").version,
    },
    null,
    2,
  )}\n`,
);
console.log(
  JSON.stringify({
    bytes: Buffer.byteLength(code),
    hash: id,
    output: path.relative(process.cwd(), outputPath),
  }),
);
