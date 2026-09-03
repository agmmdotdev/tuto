/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const path = require("node:path");
require("./secure-node-compat.cjs");
const {
  createInputStreamRegistry,
  createOutputStreamRegistry,
} = require("./stream-runtime.cjs");
const React = require("react");
const rscClient = require("next/dist/compiled/react-server-dom-webpack/client.node.js");
const reactDomServer = require("react-dom/server.edge");

const artifacts = new Map();
const maxArtifacts = 16;
let renderQueue = Promise.resolve();
const inputStreams = createInputStreamRegistry();
const outputStreams = createOutputStreamRegistry();

function currentPreviewUrl() {
  return new URL(globalThis.__TUTO_NEXT_URL__ || "/", "http://next.local");
}

const navigationModule = Object.freeze({
  usePathname() {
    return currentPreviewUrl().pathname;
  },
  useRouter() {
    return React.useMemo(
      () => ({
        back() {},
        forward() {},
        async prefetch() {},
        push() {},
        refresh() {},
        replace() {},
      }),
      [],
    );
  },
  useSearchParams() {
    return currentPreviewUrl().searchParams;
  },
});

const Link = React.forwardRef(function Link({ children, href, ...props }, ref) {
  delete props.replace;
  return React.createElement(
    "a",
    { ...props, href: href instanceof URL ? href.href : String(href), ref },
    children,
  );
});

function runtimeError(message, digest) {
  const error = new Error(message || "The Server Component render failed.");
  if (digest) error.digest = digest;
  return error;
}

function ErrorFallback({ digest, errorComponent: ErrorComponent, message }) {
  const error = React.useMemo(
    () => runtimeError(message, digest),
    [digest, message],
  );
  return React.createElement(ErrorComponent, { error, reset() {} });
}

class SegmentErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    return this.state.error
      ? React.createElement(this.props.errorComponent, {
          error: this.state.error,
          reset() {},
        })
      : this.props.children;
  }
}

const runtimeModule = Object.freeze({
  ErrorFallback,
  Link,
  SegmentErrorBoundary,
});
const linkModule = Object.freeze({ __esModule: true, default: Link });

function installArtifact(artifact) {
  artifacts.delete(artifact.generation);
  artifacts.set(artifact.generation, artifact);
  while (artifacts.size > maxArtifacts) {
    artifacts.delete(artifacts.keys().next().value);
  }
}

function resolveRelativeModule(importer, specifier, artifact) {
  const base = path.posix.normalize(
    path.posix.join(path.posix.dirname(importer), specifier),
  );
  const candidates = [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    `${base}.jsx`,
    `${base}.js`,
    path.posix.join(base, "index.tsx"),
    path.posix.join(base, "index.ts"),
    path.posix.join(base, "index.jsx"),
    path.posix.join(base, "index.js"),
  ];
  return candidates.find((candidate) =>
    Object.hasOwn(artifact.clientModules, candidate),
  );
}

function resolveRelativeStyle(importer, specifier, artifact) {
  const base = path.posix.normalize(
    path.posix.join(path.posix.dirname(importer), specifier),
  );
  return [base, `${base}.css`].find((candidate) =>
    Object.hasOwn(artifact.styles, candidate),
  );
}

function createClientModuleRuntime(artifact) {
  const byId = new Map(
    Object.values(artifact.clientModules).map((clientModule) => [
      clientModule.id,
      clientModule.path,
    ]),
  );
  const evaluated = new Map();

  function evaluate(modulePath) {
    const existing = evaluated.get(modulePath);
    if (existing) return existing.exports;
    const compiled = artifact.clientModules[modulePath];
    if (!compiled)
      throw new Error(`Missing compiled client module: ${modulePath}.`);
    const loadedModule = { exports: {} };
    evaluated.set(modulePath, loadedModule);
    const localRequire = (specifier) => {
      if (specifier === "private-next-rsc-action-client-wrapper") {
        return {
          callServer() {
            throw new Error("Server Actions cannot run during SSR.");
          },
          createServerReference: rscClient.createServerReference,
          findSourceMapURL() {
            return undefined;
          },
        };
      }
      if (specifier.startsWith(".")) {
        const stylePath = resolveRelativeStyle(modulePath, specifier, artifact);
        if (stylePath) return artifact.styles[stylePath].exports;
        const resolved = resolveRelativeModule(modulePath, specifier, artifact);
        if (!resolved)
          throw new Error(`Unable to resolve ${specifier} from ${modulePath}.`);
        return evaluate(resolved);
      }
      if (specifier === "next/link") return linkModule;
      if (specifier === "next/navigation") return navigationModule;
      if (
        specifier === "react" ||
        specifier === "react-dom" ||
        specifier === "react/jsx-runtime" ||
        specifier === "react/jsx-dev-runtime" ||
        specifier.startsWith("@swc/helpers/")
      ) {
        return require(specifier);
      }
      throw new Error(
        `Unsupported external client import ${specifier} from ${modulePath}.`,
      );
    };
    const execute = new Function(
      "exports",
      "require",
      "module",
      "__filename",
      "__dirname",
      compiled.code,
    );
    execute(
      loadedModule.exports,
      localRequire,
      loadedModule,
      compiled.canonicalPath,
      path.posix.dirname(compiled.canonicalPath),
    );
    return loadedModule.exports;
  }

  return {
    require(id) {
      if (id === "tuto-next-runtime") return runtimeModule;
      const modulePath = byId.get(id);
      if (!modulePath) throw new Error(`Unknown Next client module ID: ${id}.`);
      return evaluate(modulePath);
    },
  };
}

function bufferReadableStream(buffer) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(buffer);
      controller.close();
    },
  });
}

async function renderHtml(artifact, bodyBase64, formState, url) {
  const flight = Buffer.from(bodyBase64, "base64");
  const modules = createClientModuleRuntime(artifact);
  const previousRequire = globalThis.__next_require__;
  const previousChunkLoad = globalThis.__next_chunk_load__;
  const previousUrl = globalThis.__TUTO_NEXT_URL__;
  globalThis.__next_require__ = (id) => modules.require(id);
  globalThis.__next_chunk_load__ = async () => {};
  globalThis.__TUTO_NEXT_URL__ = url;
  try {
    const model = await rscClient.createFromReadableStream(
      bufferReadableStream(flight),
      {
        serverConsumerManifest: {
          moduleLoading: null,
          moduleMap: null,
          serverModuleMap: null,
        },
      },
    );
    const stream = await reactDomServer.renderToReadableStream(model, {
      formState,
    });
    const decoder = new TextDecoder();
    let html = "";
    for await (const chunk of stream) {
      html += decoder.decode(chunk, { stream: true });
    }
    return html + decoder.decode();
  } finally {
    globalThis.__next_require__ = previousRequire;
    globalThis.__next_chunk_load__ = previousChunkLoad;
    globalThis.__TUTO_NEXT_URL__ = previousUrl;
  }
}

function promisedReadableStream(streamPromise) {
  let readerPromise;
  const reader = () => {
    readerPromise ??= streamPromise.then((stream) => stream.getReader());
    return readerPromise;
  };
  return new ReadableStream({
    async pull(controller) {
      try {
        const result = await (await reader()).read();
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await (await reader()).cancel(reason);
    },
  });
}

async function renderHtmlReadableStream(artifact, flightStream, formState, url) {
  const modules = createClientModuleRuntime(artifact);
  const previousRequire = globalThis.__next_require__;
  const previousChunkLoad = globalThis.__next_chunk_load__;
  const previousUrl = globalThis.__TUTO_NEXT_URL__;
  globalThis.__next_require__ = (id) => modules.require(id);
  globalThis.__next_chunk_load__ = async () => {};
  globalThis.__TUTO_NEXT_URL__ = url;
  let finalized = false;
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    globalThis.__next_require__ = previousRequire;
    globalThis.__next_chunk_load__ = previousChunkLoad;
    globalThis.__TUTO_NEXT_URL__ = previousUrl;
  };
  try {
    const model = await rscClient.createFromReadableStream(flightStream, {
      serverConsumerManifest: {
        moduleLoading: null,
        moduleMap: null,
        serverModuleMap: null,
      },
    });
    const source = await reactDomServer.renderToReadableStream(model, {
      formState,
    });
    const reader = source.getReader();
    return new ReadableStream({
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) {
            finalize();
            controller.close();
          } else {
            controller.enqueue(result.value);
          }
        } catch (error) {
          finalize();
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          finalize();
        }
      },
    });
  } catch (error) {
    finalize();
    throw error;
  }
}

function startHtmlStream(artifact, formState, url) {
  const input = inputStreams.open();
  const html = promisedReadableStream(
    renderHtmlReadableStream(artifact, input.stream, formState, url),
  );
  const output = outputStreams.register(html);
  return {
    inputStreamId: input.id,
    streamId: output.id,
  };
}

async function handleMessage(message) {
  if (message.type === "stream-pull") {
    return outputStreams.pull(message.streamId);
  }
  if (message.type === "stream-cancel") {
    return outputStreams.cancel(message.streamId, message.reason);
  }
  if (message.type === "stream-write") {
    return inputStreams.write(
      message.inputStreamId,
      message.streamChunkBase64,
      message.streamDone,
    );
  }
  if (message.type === "stream-error") {
    return inputStreams.error(message.inputStreamId, message.error);
  }
  if (message.type === "install") {
    installArtifact(message.artifact);
    return {};
  }
  if (message.type === "render") {
    const artifact = artifacts.get(message.generation);
    if (!artifact)
      throw new Error(
        `Next generation ${message.generation} is not installed.`,
      );
    return {
      html: await renderHtml(
        artifact,
        message.bodyBase64,
        message.formState,
        message.url,
      ),
    };
  }
  if (message.type === "render-stream") {
    const artifact = artifacts.get(message.generation);
    if (!artifact)
      throw new Error(
        `Next generation ${message.generation} is not installed.`,
      );
    return startHtmlStream(artifact, message.formState, message.url);
  }
  throw new Error(`Unknown Next SSR worker message: ${message.type}.`);
}

module.exports = { handleMessage };

if (process.connected) {
  process.on("message", (message) => {
    if (
      !message ||
      typeof message !== "object" ||
      typeof message.id !== "string"
    )
      return;
    const respond = async () => {
      try {
        process.send?.({
          ...(await handleMessage(message)),
          id: message.id,
          ok: true,
        });
      } catch (error) {
        process.send?.({
          error:
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
          id: message.id,
          ok: false,
        });
      }
    };
    if (
      message.type === "stream-pull" ||
      message.type === "stream-cancel" ||
      message.type === "stream-write" ||
      message.type === "stream-error"
    ) {
      void respond();
    } else {
      renderQueue = renderQueue.then(respond);
    }
  });
}
