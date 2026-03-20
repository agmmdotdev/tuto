import { WorkspaceTemplate } from "@/lib/ide/templates";
import {
  cloneSnapshot,
  createInitialRecord,
  createTerminalEntry,
  inferLanguage,
  normalizeWorkspacePath,
  SessionAdapter,
  SessionRecord,
  toAbsoluteWorkspacePath,
  WORKSPACE_ROOT,
} from "@/lib/ide/runtime/base";
import {
  EditorTypeLibrary,
  TerminalSnapshot,
  WorkspaceFile,
} from "@/lib/ide/types";

type SecureExecModule = typeof import("secure-exec");

interface SecureExecFileSystem {
  writeFile(path: string, content: string): Promise<void>;
  readTextFile(path: string): Promise<string>;
}

interface SecureExecRuntime {
  exec(
    code: string,
    options?: {
      cwd?: string;
      cpuTimeLimitMs?: number;
    },
  ): Promise<{
    code: number;
  }>;
  terminate(): Promise<void>;
}

async function loadSecureExec(): Promise<SecureExecModule> {
  const dynamicImport = new Function(
    "specifier",
    "return import(specifier)",
  ) as (specifier: string) => Promise<SecureExecModule>;

  return dynamicImport("secure-exec");
}

let nextLoopbackPort = 4310;

function allocateLoopbackPort() {
  const port = nextLoopbackPort;
  nextLoopbackPort += 1;

  return port;
}

export class SecureExecSessionAdapter implements SessionAdapter {
  readonly id: string;
  readonly runtimeMode = "secure-exec" as const;
  private readonly record: SessionRecord;
  private filesystem!: SecureExecFileSystem;
  private runtime!: SecureExecRuntime;
  private serverUrl!: string;
  private serverExec!: Promise<{
    code: number;
  }>;
  private readonly terminalMessage =
    "Interactive terminal is not wired into Secure Exec yet.\r\n";

  private constructor(template: WorkspaceTemplate) {
    this.record = createInitialRecord(template, this.runtimeMode);
    this.id = this.record.id;
  }

  static async create(template: WorkspaceTemplate) {
    const adapter = new SecureExecSessionAdapter(template);
    await adapter.initializeRuntime();

    await adapter.bootstrap(template);

    return adapter;
  }

  async snapshot() {
    await this.refreshFilesFromFileSystem();

    return cloneSnapshot(this.record);
  }

  async updateFile(filePath: string, content: string) {
    const normalizedPath = normalizeWorkspacePath(filePath);
    const existing = this.record.files.get(normalizedPath);

    if (!existing) {
      throw new Error("File not found in this workspace.");
    }

    await this.filesystem.writeFile(
      toAbsoluteWorkspacePath(normalizedPath),
      content,
    );
    this.record.files.set(normalizedPath, {
      ...existing,
      language: inferLanguage(normalizedPath),
      content,
    });
    this.record.updatedAt = new Date().toISOString();
    this.record.terminal = [
      ...this.record.terminal,
      createTerminalEntry(
        "system",
        `Synced ${normalizedPath} into Secure Exec virtual filesystem.`,
      ),
    ].slice(-10);

    return this.snapshot();
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
          "Preview server became unavailable. Restarting Secure Exec preview server.",
        ),
      ].slice(-10);
      await this.startPreviewServer();
      response = await this.requestPreview(input);
    }

    return {
      status: response.status,
      body: await response.text(),
      headers: Object.fromEntries(response.headers.entries()),
    };
  }

  async restart() {
    this.record.status = "booting";
    this.record.updatedAt = new Date().toISOString();
    this.record.terminal = [
      ...this.record.terminal,
      createTerminalEntry("system", "Manual restart requested for Secure Exec."),
    ].slice(-10);

    await this.runtime.terminate().catch(() => undefined);
    await this.serverExec.catch(() => ({ code: 1 }));
    await this.initializeRuntime();
    await this.writeCurrentFilesToFileSystem();
    await this.startPreviewServer();

    this.record.status = "ready";
    this.record.updatedAt = new Date().toISOString();
    this.record.terminal = [
      ...this.record.terminal,
      createTerminalEntry(
        "system",
        `Secure Exec session ready at /preview/${this.record.id}`,
      ),
    ].slice(-10);

    return this.snapshot();
  }

  async getTypeLibraries(): Promise<EditorTypeLibrary[]> {
    return [];
  }

  async getTerminalSnapshot(cursor = 0): Promise<TerminalSnapshot> {
    return {
      cursor: cursor + 1,
      chunks:
        cursor === 0
          ? [
              {
                id: 1,
                data: this.terminalMessage,
                timestamp: new Date().toISOString(),
              },
            ]
          : [],
      writable: false,
      title: "Secure Exec terminal",
    };
  }

  async writeTerminalInput() {}

  async resizeTerminal() {}

  async terminate() {
    this.record.status = "stopped";
    this.record.updatedAt = new Date().toISOString();
    this.record.terminal = [
      ...this.record.terminal,
      createTerminalEntry("system", "Terminating Secure Exec runtime."),
    ].slice(-10);
    await this.runtime.terminate();
    const execResult = await this.serverExec.catch(() => ({ code: 1 }));

    this.record.terminal = [
      ...this.record.terminal,
      createTerminalEntry(
        execResult.code === 0 ? "system" : "stderr",
        `Secure Exec server process exited with code ${execResult.code}.`,
      ),
    ].slice(-10);
  }

  private async bootstrap(template: WorkspaceTemplate) {
    this.record.terminal = [
      createTerminalEntry("system", `Booting template "${template.name}"`),
      createTerminalEntry(
        "system",
        "Preparing Secure Exec in-memory filesystem and runtime.",
      ),
    ];

    for (const file of template.files) {
      await this.filesystem.writeFile(toAbsoluteWorkspacePath(file.path), file.content);
    }

    await this.startPreviewServer();

    this.record.status = "ready";
    this.record.updatedAt = new Date().toISOString();
    this.record.terminal = [
      ...this.record.terminal,
      createTerminalEntry(
        "system",
        `Secure Exec session ready at /preview/${this.record.id}`,
      ),
    ].slice(-10);
  }

  private async initializeRuntime() {
    const secureExec = await loadSecureExec();
    const filesystem = secureExec.createInMemoryFileSystem();
    const runtime = new secureExec.NodeRuntime({
      systemDriver: secureExec.createNodeDriver({
        filesystem,
        moduleAccess: {
          cwd: process.cwd(),
        },
        useDefaultNetwork: true,
        permissions: {
          fs: ({ path: requestedPath, op }) => {
            if (
              requestedPath === WORKSPACE_ROOT ||
              requestedPath.startsWith(`${WORKSPACE_ROOT}/`)
            ) {
              return { allow: true };
            }

            if (
              op === "read" &&
              (requestedPath === "/root" ||
                requestedPath === "/root/node_modules" ||
                requestedPath.startsWith("/root/node_modules/"))
            ) {
              return { allow: true };
            }

            return { allow: false };
          },
          network: ({ op }) => ({ allow: op === "listen" }),
          childProcess: () => ({ allow: false }),
          env: () => ({ allow: false }),
        },
      }),
      runtimeDriverFactory: secureExec.createNodeRuntimeDriverFactory(),
      memoryLimit: 96,
      cpuTimeLimitMs: 60_000,
      onStdio: (event) => {
        this.record.terminal = [
          ...this.record.terminal,
          createTerminalEntry(event.channel, event.message),
        ].slice(-10);
      },
    });

    this.filesystem = filesystem;
    this.runtime = runtime;
  }

  private async writeCurrentFilesToFileSystem() {
    for (const file of this.record.files.values()) {
      await this.filesystem.writeFile(
        toAbsoluteWorkspacePath(file.path),
        file.content,
      );
    }
  }

  private async startPreviewServer() {
    const port = allocateLoopbackPort();
    this.serverUrl = `http://127.0.0.1:${port}`;
    this.serverExec = this.runtime.exec(
      `
        async function main() {
          const startServer = require("${WORKSPACE_ROOT}/server.js");
          await startServer({ port: ${port}, host: "127.0.0.1" });
          await new Promise(() => {});
        }

        main().catch((error) => {
          console.error(error instanceof Error ? error.message : String(error));
          process.exitCode = 1;
        });
      `,
      {
        cwd: WORKSPACE_ROOT,
        cpuTimeLimitMs: 60_000,
      },
    );

    await this.waitForPreviewServer();
  }

  private async waitForPreviewServer() {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const execState = await Promise.race([
        this.serverExec.then((result) => ({ type: "exit" as const, result })),
        new Promise<{ type: "pending" }>((resolve) => {
          setTimeout(() => resolve({ type: "pending" }), 100);
        }),
      ]);

      if (execState.type === "exit") {
        this.record.status = "stopped";
        this.record.terminal = [
          ...this.record.terminal,
          createTerminalEntry(
            "stderr",
            `Secure Exec preview server exited before readiness with code ${execState.result.code}.`,
          ),
        ].slice(-10);
        throw new Error("Secure Exec preview server exited before readiness.");
      }

      try {
        const health = await fetch(`${this.serverUrl}/health`);

        if (health.ok) {
          return;
        }
      } catch {
        // Retry until the server is reachable or exits.
      }

      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    throw new Error("Secure Exec preview server did not become ready.");
  }

  private requestPreview(input: {
    path: string;
    search: string;
    method: string;
    headers: Record<string, string>;
  }) {
    return fetch(`${this.serverUrl}${input.path}${input.search}`, {
      method: input.method,
      headers: input.headers,
    });
  }

  private async refreshFilesFromFileSystem() {
    const entries = await Promise.all(
      [...this.record.files.values()].map(async (file) => {
        const content = await this.filesystem.readTextFile(
          toAbsoluteWorkspacePath(file.path),
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
}
