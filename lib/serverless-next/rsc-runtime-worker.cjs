/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const path = require("node:path");
const React = require("react");
const rsc = require("next/dist/compiled/react-server-dom-webpack/server.node");

const artifacts = new Map();
const maxArtifacts = 16;

function installArtifact(artifact) {
  artifacts.delete(artifact.generation);
  artifacts.set(artifact.generation, artifact);
  while (artifacts.size > maxArtifacts) {
    artifacts.delete(artifacts.keys().next().value);
  }
}

function resolveRelativeModule(importer, specifier, modules) {
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
  return candidates.find((candidate) => Object.hasOwn(modules, candidate));
}

function evaluateServerModules(artifact) {
  const evaluated = new Map();
  const evaluating = new Set();

  function evaluate(modulePath) {
    if (evaluated.has(modulePath)) return evaluated.get(modulePath).exports;
    if (evaluating.has(modulePath)) {
      throw new Error(`Circular server module dependency at ${modulePath}.`);
    }
    const compiled = artifact.serverModules[modulePath];
    if (!compiled)
      throw new Error(`Missing compiled server module: ${modulePath}.`);
    const loadedModule = { exports: {} };
    evaluated.set(modulePath, loadedModule);
    evaluating.add(modulePath);

    const localRequire = (specifier) => {
      if (specifier === "private-next-rsc-mod-ref-proxy") {
        return { createProxy: rsc.createClientModuleProxy };
      }
      if (specifier.startsWith(".")) {
        const resolved = resolveRelativeModule(
          modulePath,
          specifier,
          artifact.serverModules,
        );
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
        `Unsupported external server import ${specifier} from ${modulePath}.`,
      );
    };
    try {
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
    } finally {
      evaluating.delete(modulePath);
    }
  }

  return { evaluate };
}

async function readableStreamBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function renderFlight(artifact) {
  const modules = evaluateServerModules(artifact);
  const pageModule = modules.evaluate(artifact.entries.page);
  const Page = pageModule.default ?? pageModule;
  if (typeof Page !== "function") {
    throw new Error(
      `${artifact.entries.page} must default-export a component.`,
    );
  }
  let model = React.createElement(Page);
  if (artifact.entries.layout) {
    const layoutModule = modules.evaluate(artifact.entries.layout);
    const Layout = layoutModule.default ?? layoutModule;
    if (typeof Layout !== "function") {
      throw new Error(
        `${artifact.entries.layout} must default-export a component.`,
      );
    }
    model = React.createElement(Layout, null, model);
  } else {
    model = React.createElement(
      "html",
      null,
      React.createElement("body", null, model),
    );
  }
  const renderErrors = [];
  const stream = rsc.renderToReadableStream(
    model,
    artifact.clientReferenceManifest,
    {
      onError(error) {
        renderErrors.push(
          error instanceof Error ? error.message : String(error),
        );
      },
    },
  );
  const body = await readableStreamBuffer(stream);
  if (renderErrors.length > 0) throw new Error(renderErrors.join("\n"));
  return body.toString("base64");
}

process.on("message", async (message) => {
  if (!message || typeof message !== "object" || typeof message.id !== "string")
    return;
  try {
    if (message.type === "install") {
      installArtifact(message.artifact);
      process.send?.({ id: message.id, ok: true });
      return;
    }
    if (message.type === "render") {
      const artifact = artifacts.get(message.generation);
      if (!artifact)
        throw new Error(
          `Next generation ${message.generation} is not installed.`,
        );
      const bodyBase64 = await renderFlight(artifact);
      process.send?.({ bodyBase64, id: message.id, ok: true });
      return;
    }
    throw new Error(`Unknown Next RSC worker message: ${message.type}.`);
  } catch (error) {
    process.send?.({
      error:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      id: message.id,
      ok: false,
    });
  }
});
