import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import kernelManifest from "../lib/serverless-tanstack-start/kernel-manifest.generated.json" with { type: "json" };

const resultPattern =
  /__TUTO_TANSTACK_START_CORE_PREVIEW_RESULT_START__\n([\s\S]*?)\n__TUTO_TANSTACK_START_CORE_PREVIEW_RESULT_END__/;

function workspace(label) {
  return [
    {
      path: "index.html",
      content:
        '<div id="root"></div><script type="module" src="./src/main.tsx"></script>',
    },
    {
      path: "src/actions.ts",
      content: `import { createMiddleware, createServerFn } from '@tanstack/react-start';
const context = createMiddleware({ type: 'function' }).server(({ next }) =>
  next({ context: { source: 'shared-kernel' } }),
);
export const greet = createServerFn({ method: 'POST' })
  .middleware([context])
  .inputValidator((data) => ({ name: String(data.name).trim() }))
  .handler(async ({ context, data }) => ({ message: 'Hello ' + data.name, source: context.source }));`,
    },
    {
      path: "src/main.tsx",
      content: `import { createRoot } from 'react-dom/client';
import { greet } from './actions';
function App() { return <button onClick={() => greet({ data: { name: '${label}' } })}>${label}</button>; }
createRoot(document.getElementById('root')).render(<App />);`,
    },
  ];
}

function revision(files) {
  const canonicalFiles = files
    .map(({ content, path }) => ({ content, path }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return createHash("sha256")
    .update(`kernel:${kernelManifest.id}\n`)
    .update(JSON.stringify(canonicalFiles))
    .digest("hex");
}

function compile(files) {
  const child = spawnSync(
    process.execPath,
    ["lib/serverless-tanstack-start/core-preview-runner.generated.cjs"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      input: JSON.stringify({ files, revision: revision(files) }),
      maxBuffer: 20_000_000,
      timeout: 120_000,
    },
  );
  const match = child.stdout.match(resultPattern);
  if (!match) {
    throw new Error(
      child.stderr || child.stdout || "Missing kernel measurement.",
    );
  }
  const result = JSON.parse(match[1]);
  assert.equal(
    result.success,
    true,
    JSON.stringify(result.diagnostics, null, 2),
  );
  assert.equal(result.kernelId, kernelManifest.id);
  return result;
}

const first = compile(workspace("Aung"));
const edit = compile(workspace("Ada"));
const summary = {
  success: true,
  sharedKernel: {
    id: kernelManifest.id,
    clientBytes: kernelManifest.client.bytes,
    serverBytes: kernelManifest.server.bytes,
    totalBytes: kernelManifest.client.bytes + kernelManifest.server.bytes,
  },
  revisions: [first, edit].map((result) => ({
    clientBytes: result.buildMetrics.clientRevisionBytes,
    clientFrameworkInputs: result.buildMetrics.clientFrameworkInputs,
    compileMs: result.durationMs,
    revision: result.revision,
    serverBytes: result.buildMetrics.serverRevisionBytes,
    serverFrameworkInputs: result.buildMetrics.serverFrameworkInputs,
    totalBytes:
      result.buildMetrics.clientRevisionBytes +
      result.buildMetrics.serverRevisionBytes,
  })),
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
