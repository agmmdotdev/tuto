import "server-only";

import {
  spawn,
  type ChildProcessByStdio,
} from "node:child_process";
import { createHash } from "node:crypto";
import { type Readable } from "node:stream";
import {
  access,
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { spawn as spawnPty, type IPty } from "node-pty";
import { WorkspaceTemplate } from "@/lib/ide/templates";
import { collectInstalledTypeLibraries } from "@/lib/ide/type-libraries";
import {
  cloneSnapshot,
  createInitialRecord,
  createTerminalEntry,
  inferLanguage,
  normalizeWorkspacePath,
  SessionAdapter,
  SessionRecord,
} from "@/lib/ide/runtime/base";
import {
  TerminalChunk,
  TerminalSnapshot,
  WorkspaceFile,
} from "@/lib/ide/types";

const sessionsRoot = resolve(process.cwd(), ".sessions");
const dependencyCacheRoot = resolve(process.cwd(), ".vite-dependency-cache");
const dependencyCacheMaxEntries = 6;
const dependencyCacheMaxAgeMs = 1000 * 60 * 60 * 24 * 7;
const terminalChunkLimit = 400;
const npmCliPath = resolve(
  dirname(process.execPath),
  "node_modules",
  "npm",
  "bin",
  "npm-cli.js",
);

function resolveTerminalShell() {
  if (process.platform === "win32") {
    return {
      file: "powershell.exe",
      args: ["-NoLogo"],
      title: "PowerShell",
    };
  }

  return {
    file: process.env.SHELL || "bash",
    args: [],
    title: "Shell",
  };
}

function toWorkspaceFilePath(workspaceDir: string, filePath: string) {
  return resolve(workspaceDir, ...normalizeWorkspacePath(filePath).split("/"));
}

function stripAnsi(text: string) {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function sanitizeProcessText(text: string) {
  return stripAnsi(text).replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "");
}

function trimTrailingSlash(path: string) {
  return path.replace(/\/+$/, "");
}

async function allocatePort() {
  return new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer();

    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (!address || typeof address === "string") {
        server.close(() => rejectPort(new Error("Failed to allocate a port.")));
        return;
      }

      server.close((error) => {
        if (error) {
          rejectPort(error);
          return;
        }

        resolvePort(address.port);
      });
    });
  });
}

async function pathExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export class HostViteSessionAdapter implements SessionAdapter {
  readonly id: string;
  readonly runtimeMode = "host-vite" as const;
  private readonly record: SessionRecord;
  private readonly workspaceDir: string;
  private serverUrl!: string;
  private readonly previewBasePath: string;
  private viteProcess: ChildProcessByStdio<null, Readable, Readable> | null =
    null;
  private viteExitPromise: Promise<{ code: number | null }> | null = null;
  private terminalPty: IPty | null = null;
  private terminalCursor = 0;
  private terminalChunks: TerminalChunk[] = [];
  private terminalTitle = resolveTerminalShell().title;

  private constructor(template: WorkspaceTemplate) {
    this.record = createInitialRecord(template, this.runtimeMode);
    this.id = this.record.id;
    this.workspaceDir = resolve(sessionsRoot, this.id);
    this.previewBasePath = `/preview/${this.id}/`;
  }

  static async create(template: WorkspaceTemplate) {
    const adapter = new HostViteSessionAdapter(template);
    await adapter.bootstrap(template);

    return adapter;
  }

  async snapshot() {
    await this.refreshFilesFromDisk();

    return cloneSnapshot(this.record);
  }

  async updateFile(filePath: string, content: string) {
    const normalizedPath = normalizeWorkspacePath(filePath);
    const existing = this.record.files.get(normalizedPath);

    if (!existing) {
      throw new Error("File not found in this workspace.");
    }

    await this.writeWorkspaceFile(normalizedPath, content);
    this.record.files.set(normalizedPath, {
      ...existing,
      language: inferLanguage(normalizedPath),
      content,
    });
    this.record.updatedAt = new Date().toISOString();
    this.record.terminal = [
      ...this.record.terminal,
      createTerminalEntry("stdout", `Synced ${normalizedPath}`),
    ].slice(-200);

    if (normalizedPath === "package.json") {
      await this.reinstallWorkspaceDependencies();
    } else if (normalizedPath === "vite.config.mjs") {
      await this.restartServer("Reloading Vite after a config change.");
    }

    return this.snapshot();
  }

  async restart() {
    await this.restartServer("Manual restart requested. Restarting Vite.");

    return this.snapshot();
  }

  async getTypeLibraries() {
    const workspacePackageJson = JSON.parse(
      await readFile(resolve(this.workspaceDir, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    return collectInstalledTypeLibraries(resolve(this.workspaceDir, "node_modules"), [
      ...Object.keys(workspacePackageJson.dependencies ?? {}),
      ...Object.keys(workspacePackageJson.devDependencies ?? {}).filter((name) =>
        name.startsWith("@types/"),
      ),
    ]);
  }

  async getTerminalSnapshot(cursor = 0): Promise<TerminalSnapshot> {
    await this.ensureTerminal();

    return {
      cursor: this.terminalCursor,
      chunks: this.terminalChunks.filter((chunk) => chunk.id > cursor),
      writable: true,
      title: this.terminalTitle,
    };
  }

  async writeTerminalInput(input: string) {
    await this.ensureTerminal();
    this.terminalPty?.write(input);
  }

  async resizeTerminal(columns: number, rows: number) {
    await this.ensureTerminal();

    const safeColumns = Math.max(40, Math.floor(columns));
    const safeRows = Math.max(8, Math.floor(rows));

    this.terminalPty?.resize(safeColumns, safeRows);
  }

  async fetchPreview(input: {
    path: string;
    search: string;
    method: string;
    headers: Record<string, string>;
  }) {
    let response: Response;

    try {
      response = await this.requestPreview(input);
    } catch {
      this.record.terminal = [
        ...this.record.terminal,
        createTerminalEntry(
          "stderr",
          "Vite preview server became unavailable. Restarting host-backed Vite process.",
        ),
      ].slice(-200);
      await this.startServer();
      response = await this.requestPreview(input);
    }

    return {
      status: response.status,
      body: await response.text(),
      headers: Object.fromEntries(response.headers.entries()),
    };
  }

  async terminate() {
    this.record.status = "stopped";
    this.record.updatedAt = new Date().toISOString();
    this.record.terminal = [
      ...this.record.terminal,
      createTerminalEntry("system", "Stopping Vite workspace session."),
    ].slice(-200);
    this.stopTerminal();
    await this.stopServer();
    await rm(this.workspaceDir, { recursive: true, force: true });
  }

  private async bootstrap(template: WorkspaceTemplate) {
    this.record.terminal = [
      createTerminalEntry("system", `Booting template "${template.name}"`),
      createTerminalEntry(
        "system",
        "Preparing a host-backed workspace and starting Vite.",
      ),
    ];
    await mkdir(this.workspaceDir, { recursive: true });

    for (const file of template.files) {
      await this.writeWorkspaceFile(file.path, file.content);
    }

    await this.installDependencies();
    await this.startServer();
    await this.ensureTerminal();

    this.record.status = "ready";
    this.record.updatedAt = new Date().toISOString();
    this.record.terminal = [
      ...this.record.terminal,
      createTerminalEntry(
        "system",
        `Host-backed Vite session ready at ${this.previewBasePath}`,
      ),
    ].slice(-200);
  }

  private async startServer() {
    await this.stopServer();

    const port = await allocatePort();
    this.serverUrl = `http://127.0.0.1:${port}`;
    const child = spawn(
      process.execPath,
      [
        this.resolveWorkspaceViteBinPath(),
        "--config",
        resolve(this.workspaceDir, "vite.config.mjs"),
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--strictPort",
        "--clearScreen",
        "false",
      ],
      {
        cwd: this.workspaceDir,
        env: {
          ...process.env,
          BROWSER: "none",
          FORCE_COLOR: "0",
          TUTO_VITE_BASE: this.previewBasePath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    this.viteProcess = child;
    this.viteExitPromise = new Promise((resolveExit) => {
      child.once("exit", (code) => {
        this.record.terminal = [
          ...this.record.terminal,
          createTerminalEntry(
            code === 0 ? "system" : "stderr",
            `Vite process exited with code ${code ?? -1}.`,
          ),
        ].slice(-200);
        resolveExit({ code });
      });
    });

    child.stdout.on("data", (chunk: Buffer) => {
      this.pushProcessOutput("stdout", chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.pushProcessOutput("stderr", chunk);
    });

    await this.waitForServer();
  }

  private async stopServer() {
    if (!this.viteProcess) {
      return;
    }

    const child = this.viteProcess;
    const exitPromise = this.viteExitPromise;

    this.viteProcess = null;
    this.viteExitPromise = null;

    child.kill();

    if (exitPromise) {
      await Promise.race([
        exitPromise,
        new Promise((resolveDelay) => setTimeout(resolveDelay, 1000)),
      ]);
    }
  }

  private async ensureTerminal() {
    if (this.terminalPty) {
      return;
    }

    const shell = resolveTerminalShell();

    this.terminalTitle = shell.title;
    this.terminalPty = spawnPty(shell.file, shell.args, {
      cols: 120,
      rows: 32,
      cwd: this.workspaceDir,
      env: {
        ...process.env,
        TERM: "xterm-256color",
      },
      name: "xterm-color",
    });

    this.terminalPty.onData((data) => {
      this.appendTerminalChunk(data);
    });

    this.terminalPty.onExit(({ exitCode, signal }) => {
      this.appendTerminalChunk(
        `\r\n[terminal exited with code ${exitCode}${signal ? `, signal ${signal}` : ""}]\r\n`,
      );
      this.terminalPty = null;
    });
  }

  private stopTerminal() {
    if (!this.terminalPty) {
      return;
    }

    this.terminalPty.kill();
    this.terminalPty = null;
  }

  private appendTerminalChunk(data: string) {
    this.terminalCursor += 1;
    this.terminalChunks = [
      ...this.terminalChunks,
      {
        id: this.terminalCursor,
        data,
        timestamp: new Date().toISOString(),
      },
    ].slice(-terminalChunkLimit);
  }

  private async waitForServer() {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const exitState = this.viteExitPromise
        ? await Promise.race([
            this.viteExitPromise.then((result) => ({
              type: "exit" as const,
              result,
            })),
            new Promise<{ type: "pending" }>((resolvePending) => {
              setTimeout(() => resolvePending({ type: "pending" }), 100);
            }),
          ])
        : { type: "pending" as const };

      if (exitState.type === "exit") {
        throw new Error("Vite process exited before readiness.");
      }

      try {
        const response = await fetch(`${this.serverUrl}${this.previewBasePath}`);

        if (response.ok) {
          return;
        }
      } catch {
        // The dev server is not listening yet.
      }

      await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    }

    throw new Error("Vite preview server did not become ready.");
  }

  private async installDependencies() {
    this.record.status = "booting";
    this.record.updatedAt = new Date().toISOString();

    const cacheKey = await this.computeDependencyCacheKey();

    if (await this.restoreDependencyCache(cacheKey)) {
      this.record.terminal = [
        ...this.record.terminal,
        createTerminalEntry(
          "system",
          `Restored workspace dependencies from cache ${cacheKey.slice(0, 12)}.`,
        ),
      ].slice(-200);
      await this.pruneDependencyCache();
      return;
    }

    this.record.terminal = [
      ...this.record.terminal,
      createTerminalEntry(
        "system",
        "Installing workspace dependencies from package.json.",
      ),
    ].slice(-200);

    try {
      await this.runWorkspaceCommand(process.execPath, [
        npmCliPath,
        "install",
        "--no-fund",
        "--no-audit",
      ]);
      await this.saveDependencyCache(cacheKey);
    } catch (error) {
      this.record.status = "stopped";
      this.record.updatedAt = new Date().toISOString();
      this.record.terminal = [
        ...this.record.terminal,
        createTerminalEntry(
          "stderr",
          error instanceof Error
            ? error.message
            : "Dependency install failed.",
        ),
      ].slice(-200);
      throw error;
    }
  }

  private async reinstallWorkspaceDependencies() {
    this.record.terminal = [
      ...this.record.terminal,
      createTerminalEntry(
        "system",
        "package.json changed. Reinstalling dependencies and restarting Vite.",
      ),
    ].slice(-200);
    await this.stopServer();
    await this.installDependencies();
    await this.startServer();
    this.record.status = "ready";
    this.record.updatedAt = new Date().toISOString();
  }

  private async restartServer(message: string) {
    this.record.status = "booting";
    this.record.updatedAt = new Date().toISOString();
    this.record.terminal = [
      ...this.record.terminal,
      createTerminalEntry("system", message),
    ].slice(-200);
    await this.startServer();
    this.record.status = "ready";
    this.record.updatedAt = new Date().toISOString();
  }

  private resolveWorkspaceViteBinPath() {
    return resolve(this.workspaceDir, "node_modules", "vite", "bin", "vite.js");
  }

  private async runWorkspaceCommand(command: string, args: string[]) {
    const outputBuffer: string[] = [];
    const child = spawn(command, args, {
      cwd: this.workspaceDir,
      env: {
        ...process.env,
        BROWSER: "none",
        FORCE_COLOR: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk: Buffer) => {
      this.pushProcessOutput("stdout", chunk);
      outputBuffer.push(...sanitizeProcessText(chunk.toString("utf8")).split(/\r?\n/));
      outputBuffer.splice(0, Math.max(0, outputBuffer.length - 12));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.pushProcessOutput("stderr", chunk);
      outputBuffer.push(...sanitizeProcessText(chunk.toString("utf8")).split(/\r?\n/));
      outputBuffer.splice(0, Math.max(0, outputBuffer.length - 12));
    });

    await this.waitForChildProcess(child, 180_000, outputBuffer);
  }

  private async computeDependencyCacheKey() {
    const packageJson = await readFile(
      resolve(this.workspaceDir, "package.json"),
      "utf8",
    );

    return createHash("sha256")
      .update(
        JSON.stringify({
          packageJson,
          platform: process.platform,
          arch: process.arch,
          nodeMajor: process.versions.node.split(".")[0],
        }),
      )
      .digest("hex");
  }

  private getDependencyCacheDir(cacheKey: string) {
    return resolve(dependencyCacheRoot, cacheKey);
  }

  private async restoreDependencyCache(cacheKey: string) {
    const cacheDir = this.getDependencyCacheDir(cacheKey);
    const cacheReadyFile = resolve(cacheDir, ".ready");
    const cachedNodeModules = resolve(cacheDir, "node_modules");

    if (
      !(await pathExists(cacheReadyFile)) ||
      !(await pathExists(cachedNodeModules))
    ) {
      return false;
    }

    await rm(resolve(this.workspaceDir, "node_modules"), {
      recursive: true,
      force: true,
    });
    await rm(resolve(this.workspaceDir, "package-lock.json"), {
      force: true,
    });
    await cp(cachedNodeModules, resolve(this.workspaceDir, "node_modules"), {
      recursive: true,
    });

    const cachedPackageLock = resolve(cacheDir, "package-lock.json");

    if (await pathExists(cachedPackageLock)) {
      await copyFile(
        cachedPackageLock,
        resolve(this.workspaceDir, "package-lock.json"),
      );
    }

    await this.touchDependencyCache(cacheKey);

    return true;
  }

  private async saveDependencyCache(cacheKey: string) {
    const cacheDir = this.getDependencyCacheDir(cacheKey);

    if (await pathExists(resolve(cacheDir, ".ready"))) {
      return;
    }

    const workspaceNodeModules = resolve(this.workspaceDir, "node_modules");

    if (!(await pathExists(workspaceNodeModules))) {
      return;
    }

    await mkdir(dependencyCacheRoot, { recursive: true });

    const stagingDir = `${cacheDir}.tmp-${process.pid}-${Date.now()}`;

    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(stagingDir, { recursive: true });
    await cp(workspaceNodeModules, resolve(stagingDir, "node_modules"), {
      recursive: true,
    });

    const workspacePackageLock = resolve(this.workspaceDir, "package-lock.json");

    if (await pathExists(workspacePackageLock)) {
      await copyFile(
        workspacePackageLock,
        resolve(stagingDir, "package-lock.json"),
      );
    }

    await writeFile(resolve(stagingDir, ".ready"), cacheKey, "utf8");

    try {
      await rename(stagingDir, cacheDir);
    } catch {
      await rm(stagingDir, { recursive: true, force: true });
    }

    this.record.terminal = [
      ...this.record.terminal,
      createTerminalEntry(
        "system",
        `Saved workspace dependencies to cache ${cacheKey.slice(0, 12)}.`,
      ),
    ].slice(-200);

    await this.pruneDependencyCache();
  }

  private async touchDependencyCache(cacheKey: string) {
    const cacheReadyFile = resolve(this.getDependencyCacheDir(cacheKey), ".ready");

    if (!(await pathExists(cacheReadyFile))) {
      return;
    }

    const now = new Date();
    await utimes(cacheReadyFile, now, now);
  }

  private async pruneDependencyCache() {
    if (!(await pathExists(dependencyCacheRoot))) {
      return;
    }

    const entries = await readdir(dependencyCacheRoot, { withFileTypes: true });
    const now = Date.now();
    const readyEntries: Array<{
      cacheDir: string;
      cacheKey: string;
      mtimeMs: number;
    }> = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const cacheDir = resolve(dependencyCacheRoot, entry.name);
      const cacheReadyFile = resolve(cacheDir, ".ready");
      const cachedNodeModules = resolve(cacheDir, "node_modules");

      if (
        !(await pathExists(cacheReadyFile)) ||
        !(await pathExists(cachedNodeModules))
      ) {
        await rm(cacheDir, { recursive: true, force: true });
        continue;
      }

      const readyStat = await stat(cacheReadyFile);

      if (now - readyStat.mtimeMs > dependencyCacheMaxAgeMs) {
        await rm(cacheDir, { recursive: true, force: true });
        continue;
      }

      readyEntries.push({
        cacheDir,
        cacheKey: entry.name,
        mtimeMs: readyStat.mtimeMs,
      });
    }

    readyEntries.sort((left, right) => right.mtimeMs - left.mtimeMs);

    for (const entry of readyEntries.slice(dependencyCacheMaxEntries)) {
      await rm(entry.cacheDir, { recursive: true, force: true });
      this.record.terminal = [
        ...this.record.terminal,
        createTerminalEntry(
          "system",
          `Pruned dependency cache ${entry.cacheKey.slice(0, 12)}.`,
        ),
      ].slice(-200);
    }
  }

  private waitForChildProcess(
    child: ChildProcessByStdio<null, Readable, Readable>,
    timeoutMs: number,
    outputBuffer: string[],
  ) {
    return new Promise<void>((resolveProcess, rejectProcess) => {
      const timeout = setTimeout(() => {
        child.kill();
        rejectProcess(new Error("Workspace command timed out."));
      }, timeoutMs);

      child.once("error", (error) => {
        clearTimeout(timeout);
        rejectProcess(error);
      });

      child.once("exit", (code) => {
        clearTimeout(timeout);

        if (code === 0) {
          resolveProcess();
          return;
        }

        rejectProcess(
          new Error(
            [
              `Workspace command exited with code ${code ?? -1}.`,
              ...outputBuffer.filter(Boolean).slice(-8),
            ].join("\n"),
          ),
        );
      });
    });
  }

  private pushProcessOutput(kind: "stdout" | "stderr", chunk: Buffer) {
    const text = sanitizeProcessText(chunk.toString("utf8")).trim();

    if (!text) {
      return;
    }

    for (const line of text.split(/\r?\n/)) {
      this.record.terminal = [
        ...this.record.terminal,
        createTerminalEntry(kind, line),
      ].slice(-200);
    }
  }

  private async refreshFilesFromDisk() {
    const entries = await Promise.all(
      [...this.record.files.values()].map(async (file) => {
        const content = await readFile(
          toWorkspaceFilePath(this.workspaceDir, file.path),
          "utf8",
        );

        const nextFile: WorkspaceFile = {
          ...file,
          content,
        };

        return [file.path, nextFile] as const;
      }),
    );

    this.record.files = new Map(entries);
  }

  private async writeWorkspaceFile(filePath: string, content: string) {
    const targetPath = toWorkspaceFilePath(this.workspaceDir, filePath);

    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, "utf8");
  }

  private requestPreview(input: {
    path: string;
    search: string;
    method: string;
    headers: Record<string, string>;
  }) {
    const proxyPath =
      input.path === "/"
        ? this.previewBasePath
        : `${trimTrailingSlash(this.previewBasePath)}${input.path}`;

    return fetch(`${this.serverUrl}${proxyPath}${input.search}`, {
      method: input.method,
      headers: input.headers,
    });
  }
}
