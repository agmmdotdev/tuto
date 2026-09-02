import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";

const ROOT = new URL(".", import.meta.url).pathname;
const FIXTURE = join(ROOT, "fixture");
const STANDALONE = join(FIXTURE, ".next", "standalone");
const port = await reservePort();
const startedAt = performance.now();
const child = spawn(
  process.execPath,
  [join(STANDALONE, "server.js")],
  {
    cwd: STANDALONE,
    env: {
      ...process.env,
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

const report = { responses: {}, timings: {} };
try {
  await waitForPort(port);
  report.timings.serverReadyMs = elapsed(startedAt);

  await testGet("home", "/", (response) => {
    assert(response.body.includes("Tuto compiler probe home"));
    assert(response.body.includes("data-server-component=\"greeting\""));
    assert(response.body.includes("data-client-component=\"counter\""));
  });

  await testGet("rscFlight", "/", (response) => {
    assert(response.body.includes("Tuto compiler probe home"));
  }, { RSC: "1" });

  await testGet("dynamicRoute", "/posts/compiler-42", (response) => {
    assert(response.body.includes("Dynamic post: <!-- -->compiler-42"));
  });

  await testGet("studentCreatedRoute", "/new-route", (response) => {
    assert(response.body.includes("Student-created route"));
  });

  await testGet("appRouteGet", "/api/hello?query=tuto", (response) => {
    assert.deepEqual(JSON.parse(response.body), {
      kind: "app-route-get",
      query: "tuto",
    });
  });

  const appPostStartedAt = performance.now();
  const appPost = await fetch(`http://127.0.0.1:${port}/api/hello`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lesson: "route-handler" }),
  });
  const appPostBody = await appPost.text();
  report.timings.appRoutePostMs = elapsed(appPostStartedAt);
  report.responses.appRoutePost = summarize(appPost, appPostBody);
  assert.equal(appPost.status, 200);
  assert.deepEqual(JSON.parse(appPostBody), {
    kind: "app-route-post",
    body: { lesson: "route-handler" },
  });

  await testGet("pagesApi", "/api/legacy", (response) => {
    assert.deepEqual(JSON.parse(response.body), {
      kind: "pages-api",
      method: "GET",
    });
  });

  const home = await fetchText("/");
  const actionField = /name=["'](\$ACTION_ID_[^"']+)["']/.exec(home.body)?.[1];
  assert(actionField, "Server Action form identifier was not rendered");
  const form = new FormData();
  form.set(actionField, "");
  form.set("title", "compiler-action-worked");
  const actionStartedAt = performance.now();
  const actionResponse = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    body: form,
    redirect: "follow",
    headers: { origin: `http://127.0.0.1:${port}` },
  });
  const actionBody = await actionResponse.text();
  report.timings.serverActionMs = elapsed(actionStartedAt);
  report.responses.serverAction = {
    ...summarize(actionResponse, actionBody),
    finalUrl: actionResponse.url,
    actionField,
  };
  assert.equal(actionResponse.status, 200);
  assert(actionBody.includes("Server Action result: <!-- -->compiler-action-worked"));

  const newRoute = await fetchText("/new-route");
  const newActionField = /name=["'](\$ACTION_ID_[^"']+)["']/.exec(newRoute.body)?.[1];
  assert(newActionField, "New route Server Action identifier was not rendered");
  const newActionForm = new FormData();
  newActionForm.set(newActionField, "");
  newActionForm.set("title", "new-action-worked");
  const newActionStartedAt = performance.now();
  const newActionResponse = await fetch(`http://127.0.0.1:${port}/new-route`, {
    method: "POST",
    body: newActionForm,
    redirect: "follow",
    headers: { origin: `http://127.0.0.1:${port}` },
  });
  const newActionBody = await newActionResponse.text();
  report.timings.studentCreatedActionMs = elapsed(newActionStartedAt);
  report.responses.studentCreatedAction = {
    ...summarize(newActionResponse, newActionBody),
    finalUrl: newActionResponse.url,
    actionField: newActionField,
  };
  assert.equal(newActionResponse.status, 200);
  assert(newActionBody.includes("Server Action result: <!-- -->archived-new-action-worked"));

  for (const [name, response] of Object.entries(report.responses)) {
    assert.equal(response.middlewareHeader, "hit", `${name} missed middleware`);
  }
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

writeFileSync(
  join(ROOT, "runtime-results.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));

async function testGet(name, path, verify, headers = {}) {
  const startedAt = performance.now();
  const response = await fetchText(path, headers);
  report.timings[`${name}Ms`] = elapsed(startedAt);
  report.responses[name] = summarize(response.response, response.body);
  assert.equal(response.response.status, 200);
  verify(response);
}

async function fetchText(path, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return { response, body: await response.text() };
}

function summarize(response, body) {
  return {
    status: response.status,
    bytes: Buffer.byteLength(body),
    contentType: response.headers.get("content-type"),
    middlewareHeader: response.headers.get("x-tuto-middleware"),
    middlewarePath: response.headers.get("x-tuto-path"),
  };
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
  throw new Error("Timed out waiting for next start");
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
