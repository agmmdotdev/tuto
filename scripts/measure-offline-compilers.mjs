import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const benchRoot = path.join(repoRoot, ".tmp", "offline-compiler-bench");
const nodeBin = process.execPath;

const cases = new Map([
  ["esbuild-react", runEsbuildReact],
  ["rolldown-react", runRolldownReact],
  ["vite-react", runViteReact],
  ["vinext-app-router", runVinextAppRouter],
]);

function parseArgs(argv) {
  const args = {
    caseNames: [...cases.keys()],
    repeats: 3,
    worker: false,
    caseName: "",
    fixtureRoot: "",
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--worker") {
      args.worker = true;
      args.caseName = argv[index + 1] ?? "";
      args.fixtureRoot = argv[index + 2] ?? "";
      break;
    }
    if (arg === "--repeat") {
      args.repeats = Number(argv[index + 1] ?? args.repeats);
      index += 1;
      continue;
    }
    if (arg === "--case") {
      args.caseNames = (argv[index + 1] ?? "").split(",").filter(Boolean);
      index += 1;
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.worker) {
    await runWorker(args.caseName, args.fixtureRoot);
    return;
  }

  await fs.rm(benchRoot, { recursive: true, force: true });
  await fs.mkdir(benchRoot, { recursive: true });

  const results = [];
  for (const caseName of args.caseNames) {
    if (!cases.has(caseName)) {
      throw new Error(`Unknown benchmark case: ${caseName}`);
    }
    for (let iteration = 1; iteration <= args.repeats; iteration += 1) {
      const fixtureRoot = path.join(benchRoot, `${caseName}-${iteration}`);
      await createFixture(fixtureRoot, caseName);
      const result = await runMeasuredChild(caseName, fixtureRoot);
      results.push({ ...result, caseName, iteration });
      console.log(
        `${caseName} #${iteration}: ${result.durationMs.toFixed(1)}ms, peak ${(result.peakRssBytes / 1024 / 1024).toFixed(1)} MiB, output ${(result.outputBytes / 1024).toFixed(1)} KiB`,
      );
    }
  }

  console.log("\nSummary");
  console.log("case, repeats, min ms, median ms, max ms, median peak MiB, median output KiB");
  for (const caseName of args.caseNames) {
    const caseResults = results.filter((result) => result.caseName === caseName);
    const durations = caseResults.map((result) => result.durationMs).sort((a, b) => a - b);
    const rss = caseResults.map((result) => result.peakRssBytes).sort((a, b) => a - b);
    const output = caseResults.map((result) => result.outputBytes).sort((a, b) => a - b);
    console.log(
      [
        caseName,
        caseResults.length,
        durations[0].toFixed(1),
        median(durations).toFixed(1),
        durations.at(-1).toFixed(1),
        (median(rss) / 1024 / 1024).toFixed(1),
        (median(output) / 1024).toFixed(1),
      ].join(", "),
    );
  }
}

async function runMeasuredChild(caseName, fixtureRoot) {
  const startedAt = performance.now();
  const child = spawn(nodeBin, [fileURLToPath(import.meta.url), "--worker", caseName, fixtureRoot], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      FORCE_COLOR: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const exitCode = await new Promise((resolve) => {
    child.on("exit", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    throw new Error(`${caseName} failed with exit ${exitCode}\n${stderr}\n${stdout}`);
  }

  const workerResultLine = stdout
    .trim()
    .split(/\r?\n/)
    .find((line) => line.startsWith("{"));
  const workerResult = workerResultLine ? JSON.parse(workerResultLine) : {};

  return {
    durationMs: performance.now() - startedAt,
    outputBytes: workerResult.outputBytes ?? 0,
    peakRssBytes: workerResult.peakRssBytes ?? 0,
  };
}

async function runWorker(caseName, fixtureRoot) {
  const runCase = cases.get(caseName);
  if (!runCase) throw new Error(`Unknown worker case: ${caseName}`);

  const outDir = path.join(fixtureRoot, "dist");
  process.chdir(fixtureRoot);
  let peakRssBytes = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }, 10);
  const caseMeasurement = await runCase(fixtureRoot, outDir);
  clearInterval(sampler);
  peakRssBytes = Math.max(
    peakRssBytes,
    process.memoryUsage().rss,
    caseMeasurement?.peakRssBytes ?? 0,
  );
  const outputBytes = await directorySize(outDir);
  console.log(JSON.stringify({ outputBytes, peakRssBytes }));
}

async function runEsbuildReact(fixtureRoot, outDir) {
  const { build } = await import("esbuild");
  await build({
    entryPoints: [path.join(fixtureRoot, "src", "main.tsx")],
    bundle: true,
    outfile: path.join(outDir, "main.js"),
    platform: "browser",
    format: "esm",
    target: "es2022",
    jsx: "automatic",
    minify: true,
    logLevel: "silent",
  });
}

async function runRolldownReact(fixtureRoot, outDir) {
  const { build } = await import("rolldown");
  await build({
    input: path.join(fixtureRoot, "src", "main.tsx"),
    platform: "browser",
    resolve: {
      extensions: [".tsx", ".ts", ".jsx", ".js"],
    },
    output: {
      dir: outDir,
      format: "esm",
      minify: true,
    },
  });
}

async function runViteReact(fixtureRoot, outDir) {
  const { build } = await import("vite");
  const react = (await import("@vitejs/plugin-react")).default;
  await build({
    root: fixtureRoot,
    logLevel: "silent",
    plugins: [react()],
    build: {
      outDir,
      emptyOutDir: true,
      minify: true,
    },
  });
}

async function runVinextAppRouter(fixtureRoot, outDir) {
  await fs.rm(outDir, { recursive: true, force: true });
  const cliPath = path.join(repoRoot, "node_modules", "vinext", "dist", "cli.js");
  return runSubprocessMeasured(nodeBin, [cliPath, "build"], fixtureRoot);
}

async function createFixture(fixtureRoot, caseName) {
  await fs.mkdir(path.join(fixtureRoot, "src"), { recursive: true });
  await fs.writeFile(
    path.join(fixtureRoot, "package.json"),
    JSON.stringify({ type: "module", private: true }, null, 2),
  );

  if (caseName === "vinext-app-router") {
    await fs.mkdir(path.join(fixtureRoot, "app"), { recursive: true });
    await fs.writeFile(
      path.join(fixtureRoot, "app", "layout.tsx"),
      `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>{children}</body>
    </html>
  );
}
`,
    );
    await fs.writeFile(
      path.join(fixtureRoot, "app", "page.tsx"),
      `import Counter from "./counter";

export default function Page() {
  return (
    <main>
      <h1>Vinext offline compiler bench</h1>
      <Counter initialCount={3} />
    </main>
  );
}
`,
    );
    await fs.writeFile(
      path.join(fixtureRoot, "app", "counter.tsx"),
      `"use client";

import { useState } from "react";

export default function Counter({ initialCount }: { initialCount: number }) {
  const [count, setCount] = useState(initialCount);
  return <button onClick={() => setCount((value) => value + 1)}>Count {count}</button>;
}
`,
    );
    await fs.writeFile(path.join(fixtureRoot, "next.config.js"), `export default {};\n`);
    await fs.writeFile(path.join(fixtureRoot, "yarn.lock"), "");
    return;
  }

  await fs.writeFile(
    path.join(fixtureRoot, "index.html"),
    `<div id="root"></div><script type="module" src="/src/main.tsx"></script>\n`,
  );
  await fs.writeFile(
    path.join(fixtureRoot, "src", "main.tsx"),
    `import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

function App() {
  const [count, setCount] = useState(0);
  const rows = useMemo(() => Array.from({ length: 100 }, (_, index) => index + count), [count]);
  return (
    <StrictMode>
      <main>
        <h1>React offline compiler bench</h1>
        <button onClick={() => setCount((value) => value + 1)}>Count {count}</button>
        <ul>{rows.map((row) => <li key={row}>Row {row}</li>)}</ul>
      </main>
    </StrictMode>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
`,
  );
}

async function runSubprocessMeasured(command, args, cwd) {
  if (process.platform === "win32") {
    return runWindowsSubprocessMeasured(command, args, cwd);
  }

  const child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      NODE_ENV: "production",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let peakRssBytes = 0;
  let sampling = true;
  const sample = async () => {
    if (!sampling) return;
    peakRssBytes = Math.max(peakRssBytes, await readProcessTreeRss(child.pid).catch(() => 0));
    if (sampling) setTimeout(sample, 250);
  };
  setTimeout(sample, 0);

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const exitCode = await new Promise((resolve) => {
    child.on("exit", (code) => resolve(code ?? 1));
  });
  sampling = false;
  peakRssBytes = Math.max(peakRssBytes, await readProcessTreeRss(child.pid).catch(() => 0));

  if (exitCode !== 0) {
    throw new Error(`Subprocess failed with exit ${exitCode}\n${stderr}\n${stdout}`);
  }
  return { peakRssBytes };
}

async function runWindowsSubprocessMeasured(command, args, cwd) {
  const scriptPath = path.join(cwd, ".measure-process.ps1");
  const stdoutPath = path.join(cwd, ".measure-stdout.log");
  const stderrPath = path.join(cwd, ".measure-stderr.log");
  const argumentLines = args.map((arg) => `  ${JSON.stringify(arg)}`).join(",\n");
  await fs.writeFile(
    scriptPath,
    `$ErrorActionPreference = "Stop"
$Node = ${JSON.stringify(command)}
$Cwd = ${JSON.stringify(cwd)}
$StdoutPath = ${JSON.stringify(stdoutPath)}
$StderrPath = ${JSON.stringify(stderrPath)}
$Arguments = @(
${argumentLines}
)
$p = Start-Process -FilePath $Node -ArgumentList $Arguments -WorkingDirectory $Cwd -PassThru -WindowStyle Hidden -RedirectStandardOutput $StdoutPath -RedirectStandardError $StderrPath
$peak = 0
while (-not $p.HasExited) {
  try {
    $p.Refresh()
    $sample = (Get-Process -Id $p.Id -ErrorAction SilentlyContinue).WorkingSet64
    if ($sample -gt $peak) { $peak = $sample }
  } catch {}
  Start-Sleep -Milliseconds 10
}
$p.WaitForExit()
$p.Refresh()
$sample = (Get-Process -Id $p.Id -ErrorAction SilentlyContinue).WorkingSet64
if ($sample -gt $peak) { $peak = $sample }
if (($null -ne $p.ExitCode) -and ($p.ExitCode -ne 0)) {
  if (Test-Path $StderrPath) { Get-Content $StderrPath }
  if (Test-Path $StdoutPath) { Get-Content $StdoutPath }
  exit $p.ExitCode
}
Write-Output "{\`"peakRssBytes\`":$peak}"
`,
  );

  const child = spawn("powershell.exe", ["-NoProfile", "-File", scriptPath], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const exitCode = await new Promise((resolve) => {
    child.on("exit", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    throw new Error(`Subprocess failed with exit ${exitCode}\n${stderr}\n${stdout}`);
  }

  const resultLine = stdout
    .trim()
    .split(/\r?\n/)
    .find((line) => line.startsWith("{"));
  return resultLine ? JSON.parse(resultLine) : { peakRssBytes: 0 };
}

async function readProcessTreeRss(rootPid) {
  if (!rootPid) return 0;

  if (process.platform === "win32") {
    const ps = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `(Get-Process -Id ${Number(rootPid)} -ErrorAction SilentlyContinue).WorkingSet64`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const output = await new Promise((resolve) => {
      let text = "";
      ps.stdout.on("data", (chunk) => {
        text += chunk.toString();
      });
      ps.on("exit", () => resolve(text));
    });
    return Number(output.trim() || 0);
  }

  const ps = spawn("ps", ["-axo", "pid=,ppid=,rss="], { stdio: ["ignore", "pipe", "ignore"] });
  const output = await new Promise((resolve) => {
    let text = "";
    ps.stdout.on("data", (chunk) => {
      text += chunk.toString();
    });
    ps.on("exit", () => resolve(text));
  });
  const processes = output
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [pid, ppid, rssKb] = line.trim().split(/\s+/).map(Number);
      return { ProcessId: pid, ParentProcessId: ppid, WorkingSetSize: rssKb * 1024 };
    });
  return sumDescendantRss(processes, rootPid);
}

function sumDescendantRss(processes, rootPid) {
  const childrenByParent = new Map();
  const byPid = new Map();
  for (const processInfo of processes) {
    const pid = Number(processInfo.ProcessId);
    const parentId = Number(processInfo.ParentProcessId);
    byPid.set(pid, processInfo);
    const list = childrenByParent.get(parentId) ?? [];
    list.push(processInfo);
    childrenByParent.set(parentId, list);
  }

  let total = 0;
  const queue = [Number(rootPid)];
  const seen = new Set();
  while (queue.length > 0) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += Number(byPid.get(pid)?.WorkingSetSize ?? 0);
    for (const child of childrenByParent.get(pid) ?? []) {
      queue.push(Number(child.ProcessId));
    }
  }
  return total;
}

async function directorySize(dir) {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(absolute);
    } else if (entry.isFile()) {
      total += (await fs.stat(absolute)).size;
    }
  }
  return total;
}

function median(values) {
  if (values.length === 0) return 0;
  const middle = Math.floor(values.length / 2);
  if (values.length % 2 === 1) return values[middle];
  return (values[middle - 1] + values[middle]) / 2;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
