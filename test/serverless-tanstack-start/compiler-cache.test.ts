import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import {
  clearTanstackStartArtifactCache,
  type TanstackStartArtifact,
} from "../../lib/serverless-tanstack-start/artifact-cache";
import { setTanstackStartArtifactStoreForTests } from "../../lib/serverless-tanstack-start/artifact-store";
import { compileServerlessTanstackStartWorkspace } from "../../lib/serverless-tanstack-start/compiler";

afterEach(() => {
  clearTanstackStartArtifactCache();
  setTanstackStartArtifactStoreForTests(undefined);
});

function workspaceFiles() {
  return [
    {
      path: "index.html",
      content: '<script type="module" src="./src/main.ts"></script>',
      language: "html" as const,
    },
    {
      path: "src/actions.ts",
      content: `import { createServerFn } from '@tanstack/react-start';
export const greet = createServerFn({ method: 'POST' }).handler(async () => 'hello');`,
      language: "ts" as const,
    },
    {
      path: "src/main.ts",
      content: "import { greet } from './actions'; globalThis.greet = greet;",
      language: "ts" as const,
    },
  ];
}

test("a Start workspace compiles once per content revision", async () => {
  const files = workspaceFiles();

  const [first, shared] = await Promise.all([
    compileServerlessTanstackStartWorkspace(files),
    compileServerlessTanstackStartWorkspace(files),
  ]);
  const second = await compileServerlessTanstackStartWorkspace(
    [...files].reverse(),
  );

  assert.equal(first.success, true, JSON.stringify(first.diagnostics, null, 2));
  assert.equal(first.cacheStatus, "miss");
  assert.equal(shared.cacheStatus, "shared");
  assert.equal(shared.revision, first.revision);
  assert.match(first.revision, /^[a-f0-9]{64}$/);
  assert.match(first.html ?? "", new RegExp(`revision=${first.revision}`));
  assert.ok(
    first.buildMetrics.clientRevisionBytes <
      first.buildMetrics.sharedClientKernelBytes,
  );
  assert.ok(
    first.buildMetrics.serverRevisionBytes <
      first.buildMetrics.sharedServerKernelBytes,
  );
  assert.equal(first.buildMetrics.clientFrameworkInputs, 0);
  assert.equal(first.buildMetrics.serverFrameworkInputs, 0);
  assert.doesNotMatch(
    first.html ?? "",
    /body:JSON\.stringify\(\{id,payload,files:/,
  );
  assert.equal(second.success, true);
  assert.equal(second.cacheStatus, "hit");
  assert.equal(second.durationMs, 0);
  assert.equal(second.revision, first.revision);
  assert.equal(second.html, first.html);
});

test("a durable artifact prevents recompilation after a hot-cache miss", async () => {
  const durable = new Map<string, TanstackStartArtifact>();
  setTanstackStartArtifactStoreForTests({
    async get(revision) {
      return durable.get(revision) ?? null;
    },
    async put(artifact) {
      durable.set(artifact.revision, artifact);
    },
  });

  const first = await compileServerlessTanstackStartWorkspace(workspaceFiles());
  assert.equal(first.cacheStatus, "miss");
  assert.equal(durable.has(first.revision), true);

  clearTanstackStartArtifactCache();
  const restored =
    await compileServerlessTanstackStartWorkspace(workspaceFiles());
  assert.equal(restored.cacheStatus, "durable");
  assert.equal(restored.durationMs, 0);
  assert.equal(restored.revision, first.revision);
  assert.equal(restored.html, first.html);
});
