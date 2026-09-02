import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";

type CompatibilityStatus =
  | "verified"
  | "partial"
  | "not-verified"
  | "out-of-scope";

type CompatibilityMatrix = {
  features: Array<{
    evidence: Array<{ file: string; test: string }>;
    id: string;
    status: CompatibilityStatus;
    upstreamSource: string;
  }>;
  runtime: {
    reactRouter: string;
    reactStart: string;
    startPluginCore: string;
    startServerCore: string;
    viteRsc: string;
  };
  schemaVersion: number;
  upstream: { commit: string };
};

const root = process.cwd();
const matrixPath = path.join(
  root,
  "lib/serverless-tanstack-start/tanstack-start-compatibility.json",
);
const markdownPath = path.join(
  root,
  "lib/serverless-tanstack-start/TANSTACK_START_COMPATIBILITY.md",
);

test("the TanStack Start compatibility matrix has current executable evidence", () => {
  const matrix = JSON.parse(
    fs.readFileSync(matrixPath, "utf8"),
  ) as CompatibilityMatrix;
  const markdown = fs.readFileSync(markdownPath, "utf8");
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  ) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  assert.equal(matrix.schemaVersion, 1);
  assert.match(matrix.upstream.commit, /^[a-f0-9]{40}$/);
  assert.equal(
    matrix.runtime.reactStart,
    packageJson.dependencies["@tanstack/react-start"],
  );
  assert.equal(
    matrix.runtime.reactRouter,
    packageJson.dependencies["@tanstack/react-router"],
  );
  assert.equal(
    matrix.runtime.startPluginCore,
    packageJson.dependencies["@tanstack/start-plugin-core"],
  );
  assert.equal(
    matrix.runtime.startServerCore,
    packageJson.dependencies["@tanstack/start-server-core"],
  );
  assert.equal(
    matrix.runtime.viteRsc,
    packageJson.devDependencies["@vitejs/plugin-rsc"],
  );

  const ids = new Set<string>();
  const allowedStatuses = new Set<CompatibilityStatus>([
    "verified",
    "partial",
    "not-verified",
    "out-of-scope",
  ]);

  for (const feature of matrix.features) {
    assert.ok(!ids.has(feature.id), `duplicate feature id: ${feature.id}`);
    ids.add(feature.id);
    assert.ok(
      allowedStatuses.has(feature.status),
      `invalid status for ${feature.id}: ${feature.status}`,
    );
    assert.ok(feature.upstreamSource, `missing upstream source: ${feature.id}`);
    const markdownRow = markdown
      .split("\n")
      .find((line) => line.startsWith("| `" + feature.id + "` |"));
    assert.ok(markdownRow, `Markdown row is missing: ${feature.id}`);
    assert.ok(
      markdownRow.includes(`| **${feature.status}** |`),
      `Markdown status is stale: ${feature.id}`,
    );

    if (feature.status === "verified") {
      assert.ok(
        feature.evidence.length > 0,
        `verified feature has no evidence: ${feature.id}`,
      );
    }

    for (const evidence of feature.evidence) {
      const evidencePath = path.join(root, evidence.file);
      assert.ok(fs.existsSync(evidencePath), `missing evidence: ${evidence.file}`);
      assert.ok(
        fs.readFileSync(evidencePath, "utf8").includes(evidence.test),
        `missing test title in ${evidence.file}: ${evidence.test}`,
      );
    }
  }
});
