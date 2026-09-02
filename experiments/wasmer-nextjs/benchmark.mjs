import assert from "node:assert/strict";
import { lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import net from "node:net";
import { join, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { Wasmer } from "@wasmer/sdk/node";

const EDGE_PACKAGE = "wasmer/edgejs@0.2.0";
const NEXT_VERSION = "16.2.6";
const CACHE_DIRECTORY = new URL("./.wasmer-benchmark-cache", import.meta.url).pathname;
const RESULT_PATH = new URL("./results.json", import.meta.url);
const FIXTURE_DIRECTORY = new URL("./fixture", import.meta.url).pathname;
const SERVER_TIMEOUT_MS = 180_000;

const editedPage = pageSource("edited-v2");

const report = {
  environment: {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    logicalCpus: cpus().length,
    edgePackage: EDGE_PACKAGE,
    next: NEXT_VERSION,
    sdk: "0.11.0",
    requiredNodeFlag: "--experimental-wasm-jspi",
  },
  phases: {},
};

console.log("[1/3] Reading the preinstalled Tuto student artifact from the host");
const artifactRead = beginPhase("artifact-read");
const artifactFiles = loadHostArtifact(FIXTURE_DIRECTORY);
report.artifactRead = endPhase(artifactRead);
report.artifact = {
  fileCount: Object.keys(artifactFiles).length,
  bytes: Object.values(artifactFiles).reduce((sum, value) => sum + value.byteLength, 0),
};

console.log("[2/3] Starting a fresh Wasmer client and fresh sandbox from the prepared artifact");
const execution = await benchmarkFreshSandbox(artifactFiles);
Object.assign(report.phases, execution.phases);
report.responses = execution.responses;

console.log("[3/3] Writing results");
writeFileSync(RESULT_PATH, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

async function benchmarkFreshSandbox(files) {
  const responses = {};
  const phases = {};
  const total = beginPhase("cold-total");

  const clientInit = beginPhase("wasmer-client-and-sandbox");
  const wasmer = new Wasmer({ cache: { directory: CACHE_DIRECTORY } });
  const sandbox = await wasmer.sandboxes.create({
    packages: [EDGE_PACKAGE],
    files,
    env: {
      HOME: "/workspace",
      USER: "tuto",
      TMPDIR: "/tmp",
    },
    network: { mode: "host" },
  });
  phases.clientAndSandbox = endPhase(clientInit);

  const logs = [];
  let active;

  try {
    const port = await reservePort();
    const serverStart = beginPhase("next-server-ready");
    active = await spawnNextServer(sandbox, port, logs);
    await sandbox.ports.wait(port, { timeoutMs: SERVER_TIMEOUT_MS });
    phases.serverReady = endPhase(serverStart);

    const firstRequest = beginPhase("first-request");
    const firstResponse = await fetchText(port, "/?t=cold");
    phases.firstRequest = endPhase(firstRequest);
    responses.first = {
      status: firstResponse.status,
      containsMarker: firstResponse.body.includes("cold-v1"),
      bytes: Buffer.byteLength(firstResponse.body),
    };
    assert.equal(firstResponse.status, 200);
    assert(firstResponse.body.includes("cold-v1"));
    phases.coldTotalThroughFirstResponse = endPhase(total);

    const editTotal = beginPhase("edit-total-through-updated-response");
    const stopBeforeEdit = beginPhase("stop-before-edit");
    await stopNextServer(active);
    active = undefined;
    phases.stopBeforeEdit = endPhase(stopBeforeEdit);

    const editWrite = beginPhase("edit-write-through-sdk");
    await sandbox.fs.writeText("app/pages/index.js", editedPage);
    const storedEdit = await sandbox.fs.readText("app/pages/index.js");
    assert(storedEdit.includes("edited-v2"));
    phases.editWrite = endPhase(editWrite);

    const editPort = await reservePort();
    const restartReady = beginPhase("edit-restart-ready");
    active = await spawnNextServer(sandbox, editPort, logs);
    await sandbox.ports.wait(editPort, { timeoutMs: SERVER_TIMEOUT_MS });
    phases.editRestartReady = endPhase(restartReady);

    const editedFirstRequest = beginPhase("edit-first-request");
    const editedResponse = await fetchText(editPort, "/?t=edited");
    phases.editFirstRequest = endPhase(editedFirstRequest);
    phases.editTotalThroughUpdatedResponse = endPhase(editTotal);
    responses.edited = {
      status: editedResponse.status,
      containsMarker: editedResponse.body.includes("edited-v2"),
      bytes: Buffer.byteLength(editedResponse.body),
    };
    assert.equal(editedResponse.status, 200);
    assert(editedResponse.body.includes("edited-v2"));

    const steady = beginPhase("steady-request");
    const steadyResponse = await fetchText(editPort, "/?t=steady");
    phases.steadyRequest = endPhase(steady);
    responses.steady = {
      status: steadyResponse.status,
      containsMarker: steadyResponse.body.includes("edited-v2"),
      bytes: Buffer.byteLength(steadyResponse.body),
    };
  } catch (error) {
    console.error("Next.js logs before failure:\n" + logs.slice(-120).join("\n"));
    throw error;
  } finally {
    if (active) await stopNextServer(active);
    await sandbox.close();
    await wasmer.close();
  }

  return { phases, responses };
}

async function spawnNextServer(sandbox, port, logs) {
  const process = await sandbox
    .command("edge", [
      "/workspace/app/node_modules/next/dist/bin/next",
      "dev",
      "--webpack",
      "-H",
      "0.0.0.0",
      "-p",
      String(port),
    ], {
      cwd: "/workspace/app",
      env: {
        HOME: "/workspace",
        USER: "tuto",
        TMPDIR: "/tmp",
        WATCHPACK_POLLING: "true",
      },
    })
    .spawn({
      stdout: "pipe",
      stderr: "pipe",
      timeoutMs: SERVER_TIMEOUT_MS,
      outputBytes: 2 * 1024 * 1024,
    });
  return {
    process,
    pumps: [
      pump("stdout", process.stdout, logs),
      pump("stderr", process.stderr, logs),
    ],
  };
}

async function stopNextServer(active) {
  await active.process.terminate({ gracePeriodMs: 2_000 });
  await active.process.wait();
  await Promise.allSettled(active.pumps);
}

function loadHostArtifact(root) {
  const output = {};
  visit(root);
  return output;

  function visit(directory) {
    for (const name of readdirSync(directory)) {
      if (name === ".next") continue;
      const path = join(directory, name);
      const metadata = lstatSync(path);
      const targetMetadata = metadata.isSymbolicLink() ? statSync(path) : metadata;
      if (targetMetadata.isDirectory()) {
        visit(path);
        continue;
      }
      if (
        name.endsWith(".map") ||
        name.endsWith(".d.ts") ||
        name.endsWith(".md") ||
        name === "LICENSE"
      ) continue;
      const key = `app/${relative(root, path).split(sep).join("/")}`;
      output[key] = readFileSync(path);
      const count = Object.keys(output).length;
      if (count % 2_000 === 0) console.log(`  loaded ${count} files`);
    }
  }
}

async function pump(label, stream, logs, echo = false) {
  if (!stream) return;
  for await (const line of stream.lines()) {
    const rendered = `[guest:${label}] ${line}`;
    logs.push(rendered);
    if (logs.length > 500) logs.shift();
    if (echo) console.log(rendered);
  }
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

async function fetchText(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { connection: "close" },
  });
  return { status: response.status, body: await response.text() };
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

function pageSource(marker) {
  return `
export default function Page() {
  return <main data-marker="${marker}"><h1>${marker}</h1><p>Rendered inside Edge.js/WASIX.</p></main>;
}
`;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function mib(bytes) {
  return round(bytes / 1024 / 1024);
}
