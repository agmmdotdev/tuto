import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { performance } from "node:perf_hooks";

const cwd = new URL("./fixture/.next/standalone/", import.meta.url).pathname;
const port = await reservePort();
const serverStartedAt = performance.now();
const child = spawn(process.execPath, ["server.js"], {
  cwd,
  env: {
    ...process.env,
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    NEXT_TELEMETRY_DISABLED: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

try {
  await waitForPort(port);
  const serverReadyMs = elapsed(serverStartedAt);
  const pagesStartedAt = performance.now();
  const pages = await fetchText(port, "/");
  const pagesMs = elapsed(pagesStartedAt);
  const rscStartedAt = performance.now();
  const rsc = await fetchText(port, "/rsc");
  const rscMs = elapsed(rscStartedAt);
  const actionField = /name=["'](\$ACTION_ID_[^"']+)["']/.exec(rsc.body)?.[1];
  assert(actionField);

  const form = new FormData();
  form.set(actionField, "");
  form.set("message", "server-action-worked");
  const actionStartedAt = performance.now();
  const actionResponse = await fetch(`http://127.0.0.1:${port}/rsc`, {
    method: "POST",
    body: form,
    redirect: "follow",
    headers: { origin: `http://127.0.0.1:${port}` },
  });
  const actionBody = await actionResponse.text();
  const actionMs = elapsed(actionStartedAt);

  const result = {
    pages: { status: pages.status, marker: pages.body.includes("cold-v1") },
    rsc: { status: rsc.status, marker: rsc.body.includes("rsc-v2-student-edit") },
    action: {
      status: actionResponse.status,
      marker: actionBody.includes("action-v2-server-action-worked"),
      finalUrl: actionResponse.url,
    },
    timings: { serverReadyMs, pagesMs, rscMs, actionMs },
  };
  assert.deepEqual(result.pages, { status: 200, marker: true });
  assert.deepEqual(result.rsc, { status: 200, marker: true });
  assert.equal(result.action.status, 200);
  assert.equal(result.action.marker, true);
  console.log(JSON.stringify(result, null, 2));
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

async function fetchText(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: response.status, body: await response.text() };
}

async function waitForPort(port) {
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
  throw new Error("Timed out waiting for the native standalone server");
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
