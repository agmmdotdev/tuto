/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const path = require("node:path");
const rscClient = require("next/dist/compiled/react-server-dom-webpack/client.node");
const reactDomServer = require("react-dom/server.edge");

const artifacts = new Map();
const maxArtifacts = 16;
let renderQueue = Promise.resolve();

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
      if (specifier.startsWith(".")) {
        const resolved = resolveRelativeModule(modulePath, specifier, artifact);
        if (!resolved)
          throw new Error(`Unable to resolve ${specifier} from ${modulePath}.`);
        return evaluate(resolved);
      }
      if (
        specifier === "react" ||
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

async function renderHtml(artifact, bodyBase64) {
  const flight = Buffer.from(bodyBase64, "base64");
  const modules = createClientModuleRuntime(artifact);
  const previousRequire = globalThis.__next_require__;
  const previousChunkLoad = globalThis.__next_chunk_load__;
  globalThis.__next_require__ = (id) => modules.require(id);
  globalThis.__next_chunk_load__ = async () => {};
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
    return new Response(
      await reactDomServer.renderToReadableStream(model),
    ).text();
  } finally {
    globalThis.__next_require__ = previousRequire;
    globalThis.__next_chunk_load__ = previousChunkLoad;
  }
}

async function handleMessage(message) {
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
    return { html: await renderHtml(artifact, message.bodyBase64) };
  }
  throw new Error(`Unknown Next SSR worker message: ${message.type}.`);
}

process.on("message", (message) => {
  if (!message || typeof message !== "object" || typeof message.id !== "string")
    return;
  renderQueue = renderQueue.then(async () => {
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
  });
});
