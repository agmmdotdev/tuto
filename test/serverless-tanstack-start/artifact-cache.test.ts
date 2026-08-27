import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import {
  clearTanstackStartArtifactCache,
  createWorkspaceRevision,
  getTanstackStartArtifact,
  inspectTanstackStartArtifactCache,
  putTanstackStartArtifact,
  type TanstackStartArtifact,
} from "../../lib/serverless-tanstack-start/artifact-cache";

function artifact(revision: string): TanstackStartArtifact {
  return {
    buildMetrics: {
      clientFrameworkInputs: 0,
      clientRevisionBytes: 1,
      serverFrameworkInputs: 0,
      serverRevisionBytes: 1,
      sharedClientKernelBytes: 1,
      sharedServerKernelBytes: 1,
    },
    diagnostics: [],
    durationMs: 1,
    html: `<p>${revision}</p>`,
    kernelId: "test-kernel",
    revision,
    serverBundle: `globalThis.revision=${JSON.stringify(revision)}`,
    serverFnIds: [revision],
    success: true,
  };
}

afterEach(() => {
  clearTanstackStartArtifactCache();
  delete process.env.TUTO_TANSTACK_ARTIFACT_CACHE_MAX_ENTRIES;
});

test("workspace revisions are stable across file ordering and path separators", () => {
  const first = createWorkspaceRevision([
    { path: "src\\main.ts", content: "main", language: "ts" },
    { path: "index.html", content: "html", language: "html" },
  ]);
  const second = createWorkspaceRevision([
    { path: "index.html", content: "html", language: "html" },
    { path: "src/main.ts", content: "main", language: "ts" },
  ]);

  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
});

test("artifact cache is bounded and promotes reads in LRU order", () => {
  process.env.TUTO_TANSTACK_ARTIFACT_CACHE_MAX_ENTRIES = "2";
  putTanstackStartArtifact(artifact("a"));
  putTanstackStartArtifact(artifact("b"));
  assert.equal(getTanstackStartArtifact("a")?.revision, "a");
  putTanstackStartArtifact(artifact("c"));

  assert.equal(getTanstackStartArtifact("b"), null);
  assert.equal(getTanstackStartArtifact("a")?.revision, "a");
  assert.equal(getTanstackStartArtifact("c")?.revision, "c");
  assert.deepEqual(inspectTanstackStartArtifactCache().revisions, ["a", "c"]);
});
