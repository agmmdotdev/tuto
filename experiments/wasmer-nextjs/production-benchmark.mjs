import assert from "node:assert/strict";
import { lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { cpus } from "node:os";
import { join, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { Wasmer } from "@wasmer/sdk/node";

const EDGE_PACKAGE = "wasmer/edgejs@0.2.0";
const NEXT_VERSION = "16.2.6";
const CACHE_DIRECTORY = new URL("./.wasmer-production-cache", import.meta.url).pathname;
const RESULT_PATH = new URL("./production-results.json", import.meta.url);
const FIXTURE_DIRECTORY = new URL("./fixture", import.meta.url).pathname;
const STANDALONE_DIRECTORY = join(FIXTURE_DIRECTORY, ".next", "standalone");
const STATIC_DIRECTORY = join(FIXTURE_DIRECTORY, ".next", "static");
const SERVER_TIMEOUT_MS = 180_000;

const report = {
  environment: {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    logicalCpus: cpus().length,
    edgePackage: EDGE_PACKAGE,
    next: NEXT_VERSION,
    sdk: "0.11.0",
    requiredNodeFlag: "--experimental-wasm-jspi",
    nextMode: "production-standalone",
  },
  phases: {},
  responses: {},
};

console.log("[1/3] Reading the host-precompiled Next.js standalone artifact");
const artifactRead = beginPhase("artifact-read");
const artifactFiles = {};
loadDirectory(STANDALONE_DIRECTORY, "app", artifactFiles);
loadDirectory(STATIC_DIRECTORY, "app/.next/static", artifactFiles);
report.phases.artifactRead = endPhase(artifactRead);
report.artifact = {
  fileCount: Object.keys(artifactFiles).length,
  bytes: Object.values(artifactFiles).reduce((sum, value) => sum + value.byteLength, 0),
};

console.log("[2/3] Starting the production server and exercising Pages, RSC, and a Server Action");
try {
  await runProductionSandbox(artifactFiles);
  report.completed = true;
} catch {
  report.completed = false;
  process.exitCode = 1;
} finally {
  console.log("[3/3] Writing production-results.json");
  writeFileSync(RESULT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

async function runProductionSandbox(files) {
  const coldTotal = beginPhase("cold-total-through-first-rsc");
  const clientInit = beginPhase("wasmer-client-and-sandbox");
  const wasmer = new Wasmer({ cache: { directory: CACHE_DIRECTORY } });
  const sandbox = await wasmer.sandboxes.create({
    packages: [EDGE_PACKAGE],
    files,
    env: commonEnv(),
    network: { mode: "host" },
  });
  report.phases.clientAndSandbox = endPhase(clientInit);

  const logs = [];
  let active;
  try {
    const port = await reservePort();
    const serverStart = beginPhase("production-server-ready");
    active = await spawnServer(sandbox, port, logs);
    await sandbox.ports.wait(port, { timeoutMs: SERVER_TIMEOUT_MS });
    report.phases.serverReady = endPhase(serverStart);

    const pagesRequest = beginPhase("pages-request");
    const pages = await fetchText(port, "/");
    report.phases.pagesRequest = endPhase(pagesRequest);
    report.responses.pages = summarize(pages, "cold-v1");
    assert.equal(pages.status, 200);
    assert(pages.body.includes("cold-v1"));
    console.log(`[host] Pages response: ${pages.status}`);

    const steadyPagesRequest = beginPhase("steady-pages-request");
    const steadyPages = await fetchText(port, "/?steady=1");
    report.phases.steadyPagesRequest = endPhase(steadyPagesRequest);
    report.responses.steadyPages = summarize(steadyPages, "cold-v1");
    assert.equal(steadyPages.status, 200);
    assert(steadyPages.body.includes("cold-v1"));
    console.log(`[host] Steady Pages response: ${steadyPages.status}`);

    const rscHtmlRequest = beginPhase("rsc-html-request");
    const rscHtml = await fetchText(port, "/rsc");
    report.phases.rscHtmlRequest = endPhase(rscHtmlRequest);
    report.phases.coldTotalThroughFirstRsc = endPhase(coldTotal);
    report.responses.rscHtml = summarize(rscHtml, "rsc-v2-student-edit");
    console.log(`[host] RSC HTML response: ${rscHtml.status}`);
    assert.equal(rscHtml.status, 200);
    assert(rscHtml.body.includes("rsc-v2-student-edit"));

    const flightRequest = beginPhase("rsc-flight-request");
    const flight = await fetchText(port, "/rsc", { RSC: "1" });
    report.phases.rscFlightRequest = endPhase(flightRequest);
    report.responses.rscFlight = {
      ...summarize(flight, "rsc-v2-student-edit"),
      contentType: flight.headers.get("content-type"),
    };
    assert.equal(flight.status, 200);
    assert(flight.body.includes("rsc-v2-student-edit"));

    const actionField = /name=["'](\$ACTION_ID_[^"']+)["']/.exec(rscHtml.body)?.[1];
    assert(actionField, "Next did not render the Server Action form identifier");

    const actionRequest = beginPhase("server-action-request");
    const action = await postProgressiveAction(port, actionField);
    report.phases.serverActionRequest = endPhase(actionRequest);
    report.responses.serverAction = {
      ...summarize(action, "server-action-worked"),
      actionField,
      finalUrl: action.url,
    };
    assert.equal(action.status, 200);
    assert(action.body.includes("server-action-worked"));

    const steadyRequest = beginPhase("steady-rsc-html-request");
    const steady = await fetchText(port, "/rsc?steady=1");
    report.phases.steadyRscHtmlRequest = endPhase(steadyRequest);
    report.responses.steadyRscHtml = summarize(steady, "rsc-v2-student-edit");
    assert.equal(steady.status, 200);
    assert(steady.body.includes("rsc-v2-student-edit"));
  } catch (error) {
    report.failure = {
      name: error?.name,
      message: error?.message,
      stack: error?.stack,
      logs: logs.slice(-160),
    };
    console.error("Next.js logs before failure:\n" + logs.slice(-160).join("\n"));
    throw error;
  } finally {
    if (active) await stopServer(active);
    await sandbox.close();
    await wasmer.close();
  }
}

async function spawnServer(sandbox, port, logs) {
  const process = await sandbox
    .command("edge", ["/workspace/app/server.js"], {
      cwd: "/workspace/app",
      env: { ...commonEnv(), PORT: String(port), HOSTNAME: "0.0.0.0" },
    })
    .spawn({
      stdout: "pipe",
      stderr: "pipe",
      timeoutMs: SERVER_TIMEOUT_MS,
      outputBytes: 2 * 1024 * 1024,
    });
  return {
    process,
    pumps: [pump("stdout", process.stdout, logs), pump("stderr", process.stderr, logs)],
  };
}

async function stopServer(active) {
  await active.process.terminate({ gracePeriodMs: 2_000 });
  await active.process.wait();
  await Promise.allSettled(active.pumps);
}

function commonEnv() {
  return {
    HOME: "/workspace",
    USER: "tuto",
    TMPDIR: "/tmp",
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
  };
}

function loadDirectory(root, prefix, output) {
  visit(root);
  function visit(directory) {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const metadata = lstatSync(path);
      const targetMetadata = metadata.isSymbolicLink() ? statSync(path) : metadata;
      if (targetMetadata.isDirectory()) {
        visit(path);
        continue;
      }
      if (name.endsWith(".map") || name.endsWith(".d.ts") || name === "LICENSE") continue;
      const key = `${prefix}/${relative(root, path).split(sep).join("/")}`;
      output[key] = readFileSync(path);
    }
  }
}

async function pump(label, stream, logs) {
  if (!stream) return;
  for await (const line of stream.lines()) {
    const rendered = `[guest:${label}] ${line}`;
    logs.push(rendered);
    if (logs.length > 500) logs.shift();
    console.log(rendered);
  }
}

async function postProgressiveAction(port, actionField) {
  const body = new FormData();
  body.set(actionField, "");
  body.set("message", "server-action-worked");
  const response = await fetch(`http://127.0.0.1:${port}/rsc`, {
    method: "POST",
    body,
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
    headers: { connection: "close" },
  });
  return {
    status: response.status,
    body: await response.text(),
    headers: response.headers,
    url: response.url,
  };
}

async function fetchText(port, path, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { connection: "close", ...headers },
    signal: AbortSignal.timeout(30_000),
  });
  return {
    status: response.status,
    body: await response.text(),
    headers: response.headers,
    url: response.url,
  };
}

function summarize(response, marker) {
  return {
    status: response.status,
    containsMarker: response.body.includes(marker),
    bytes: Buffer.byteLength(response.body),
  };
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

function beginPhase(name) {
  const memory = memorySnapshot();
  const phase = {
    name,
    startedAt: performance.now(),
    cpu: process.cpuUsage(),
    memory,
    peakRssBytes: memory.rssBytes,
    timer: undefined,
  };
  phase.timer = setInterval(() => {
    const rss = process.memoryUsage.rss();
    if (rss > phase.peakRssBytes) phase.peakRssBytes = rss;
  }, 20);
  return phase;
}

function endPhase(phase) {
  clearInterval(phase.timer);
  const cpu = process.cpuUsage(phase.cpu);
  const endMemory = memorySnapshot();
  phase.peakRssBytes = Math.max(phase.peakRssBytes, endMemory.rssBytes);
  return {
    wallMs: round(performance.now() - phase.startedAt),
    cpuUserMs: round(cpu.user / 1_000),
    cpuSystemMs: round(cpu.system / 1_000),
    cpuTotalMs: round((cpu.user + cpu.system) / 1_000),
    rssStartMiB: mib(phase.memory.rssBytes),
    rssEndMiB: mib(endMemory.rssBytes),
    rssPeakMiB: mib(phase.peakRssBytes),
    pssEndMiB: endMemory.pssBytes === undefined ? undefined : mib(endMemory.pssBytes),
    privateEndMiB: endMemory.privateBytes === undefined ? undefined : mib(endMemory.privateBytes),
    threadsEnd: endMemory.threads,
  };
}

function memorySnapshot() {
  const rssBytes = process.memoryUsage.rss();
  let pssBytes;
  let privateBytes;
  let threads;
  try {
    const rollup = readFileSync("/proc/self/smaps_rollup", "utf8");
    const pssKiB = Number(/^Pss:\s+(\d+) kB$/m.exec(rollup)?.[1]);
    const privateCleanKiB = Number(/^Private_Clean:\s+(\d+) kB$/m.exec(rollup)?.[1]);
    const privateDirtyKiB = Number(/^Private_Dirty:\s+(\d+) kB$/m.exec(rollup)?.[1]);
    if (Number.isFinite(pssKiB)) pssBytes = pssKiB * 1024;
    if (Number.isFinite(privateCleanKiB) && Number.isFinite(privateDirtyKiB)) {
      privateBytes = (privateCleanKiB + privateDirtyKiB) * 1024;
    }
    const status = readFileSync("/proc/self/status", "utf8");
    threads = Number(/^Threads:\s+(\d+)$/m.exec(status)?.[1]);
  } catch {}
  return { rssBytes, pssBytes, privateBytes, threads };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function mib(bytes) {
  return round(bytes / 1024 / 1024);
}
