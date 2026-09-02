import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const ROOT = new URL(".", import.meta.url).pathname;
const FIXTURE = join(ROOT, "cache-runtime-fixture");
const STANDALONE = join(FIXTURE, ".next", "standalone");
const port = await reservePort();
const logs = [];
const child = spawn(process.execPath, [join(STANDALONE, "server.js")], {
  cwd: STANDALONE,
  env: {
    ...process.env,
    HOSTNAME: "127.0.0.1",
    NEXT_PRIVATE_DEBUG_CACHE: "1",
    NEXT_TELEMETRY_DISABLED: "1",
    PORT: String(port),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => logs.push(String(chunk)));
child.stderr.on("data", (chunk) => logs.push(String(chunk)));

const result = { responses: {}, timings: {}, cacheDebugLines: [] };

try {
  await waitForPort(port);

  result.responses.first = await timedGet("first");
  assert.deepEqual(extractSnapshot(result.responses.first.body), {
    value: 0,
    cacheExecutions: 1,
  });

  result.responses.second = await timedGet("second");
  assert.deepEqual(extractSnapshot(result.responses.second.body), {
    value: 0,
    cacheExecutions: 1,
  });

  const actionField = /name=["'](\$ACTION_ID_[^"']+)["']/.exec(
    result.responses.second.body,
  )?.[1];
  assert(actionField, "Server Action form identifier was not rendered");
  const form = new FormData();
  form.set(actionField, "");
  const actionStartedAt = performance.now();
  const actionResponse = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    body: form,
    headers: { origin: `http://127.0.0.1:${port}` },
  });
  const actionBody = await actionResponse.text();
  result.timings.actionMs = elapsed(actionStartedAt);
  result.responses.action = summarize(actionResponse, actionBody);
  assert.equal(actionResponse.status, 200);
  assert.deepEqual(extractSnapshot(actionBody), {
    value: 1,
    cacheExecutions: 2,
  });

  result.responses.afterAction = await timedGet("afterAction");
  assert.deepEqual(extractSnapshot(result.responses.afterAction.body), {
    value: 1,
    cacheExecutions: 3,
  });

  result.responses.afterActionHit = await timedGet("afterActionHit");
  assert.deepEqual(extractSnapshot(result.responses.afterActionHit.body), {
    value: 1,
    cacheExecutions: 3,
  });
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

result.cacheDebugLines = logs
  .join("")
  .split("\n")
  .filter((line) => line.includes("DefaultCacheHandler:"));

const serializableResult = {
  ...result,
  responses: Object.fromEntries(
    Object.entries(result.responses).map(([name, { body, ...response }]) => [
      name,
      { ...response, bytes: Buffer.byteLength(body), snapshot: extractSnapshot(body) },
    ]),
  ),
};

writeFileSync(
  join(ROOT, "cache-runtime-results.json"),
  `${JSON.stringify(serializableResult, null, 2)}\n`,
);
console.log(JSON.stringify(serializableResult, null, 2));

async function timedGet(name) {
  const startedAt = performance.now();
  const response = await fetch(`http://127.0.0.1:${port}/`);
  const body = await response.text();
  result.timings[`${name}Ms`] = elapsed(startedAt);
  assert.equal(response.status, 200);
  return summarize(response, body);
}

function summarize(response, body) {
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body,
  };
}

function extractSnapshot(body) {
  const value = /data-cache-value="(\d+)"/.exec(body)?.[1];
  const cacheExecutions = /data-cache-executions="(\d+)"/.exec(body)?.[1];
  assert(value !== undefined, "Cache value was not rendered");
  assert(cacheExecutions !== undefined, "Cache execution count was not rendered");
  return { value: Number(value), cacheExecutions: Number(cacheExecutions) };
}

async function waitForPort() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => {
          socket.end();
          resolve();
        });
        socket.once("error", reject);
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error("Timed out waiting for cache probe server");
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

function elapsed(startedAt) {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}
