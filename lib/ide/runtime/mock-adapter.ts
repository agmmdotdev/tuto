import { WorkspaceTemplate } from "@/lib/ide/templates";
import {
  cloneSnapshot,
  createInitialRecord,
  createMissingPreviewDocument,
  createTerminalEntry,
  inferLanguage,
  normalizeWorkspacePath,
  SessionAdapter,
  SessionRecord,
} from "@/lib/ide/runtime/base";
import {
  EditorTypeLibrary,
  TerminalSnapshot,
  WorkspaceFile,
} from "@/lib/ide/types";

export class MockSessionAdapter implements SessionAdapter {
  readonly id: string;
  readonly runtimeMode = "mock" as const;
  private readonly record: SessionRecord;
  private readonly terminalMessage =
    "Interactive terminal is only available in the host-vite runtime.\r\n";

  private constructor(template: WorkspaceTemplate) {
    this.record = createInitialRecord(template, this.runtimeMode);
    this.id = this.record.id;
    this.record.status = "ready";
    this.record.terminal = [
      createTerminalEntry("system", `Booting template "${template.name}"`),
      createTerminalEntry(
        "stdout",
        "Phase 1 uses an in-memory session store. Secure Exec is not connected yet.",
      ),
      createTerminalEntry(
        "system",
        `Preview contract ready at /preview/${this.record.id}`,
      ),
    ];
  }

  static async create(template: WorkspaceTemplate) {
    return new MockSessionAdapter(template);
  }

  async snapshot() {
    return cloneSnapshot(this.record);
  }

  async updateFile(filePath: string, content: string) {
    const normalizedPath = normalizeWorkspacePath(filePath);
    const existing = this.record.files.get(normalizedPath);

    if (!existing) {
      throw new Error("File not found in this workspace.");
    }

    const nextFile: WorkspaceFile = {
      ...existing,
      language: inferLanguage(normalizedPath),
      content,
    };

    this.record.files.set(normalizedPath, nextFile);
    this.record.updatedAt = new Date().toISOString();
    this.record.terminal = [
      ...this.record.terminal,
      createTerminalEntry("stdout", `Synced ${normalizedPath}`),
    ].slice(-10);

    return cloneSnapshot(this.record);
  }

  async restart() {
    this.record.status = "booting";
    this.record.updatedAt = new Date().toISOString();
    this.record.terminal = [
      ...this.record.terminal,
      createTerminalEntry("system", "Restart requested for mock session."),
      createTerminalEntry(
        "stdout",
        "Mock runtime restarted instantly because there is no external process.",
      ),
    ].slice(-10);
    this.record.status = "ready";
    this.record.updatedAt = new Date().toISOString();

    return cloneSnapshot(this.record);
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
      title: "Mock terminal",
    };
  }

  async writeTerminalInput() {}

  async resizeTerminal() {}

  async fetchPreview(input: {
    path: string;
    search: string;
    method: string;
    headers: Record<string, string>;
  }) {
    const normalizedPath =
      input.path === "/"
        ? this.record.previewPath
        : normalizeWorkspacePath(input.path.slice(1));
    const file = this.record.files.get(normalizedPath);

    if (!file) {
      return {
        status: 404,
        body: createMissingPreviewDocument(this.record.id),
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      };
    }

    const contentType =
      normalizedPath.endsWith(".css")
        ? "text/css; charset=utf-8"
        : normalizedPath.endsWith(".json")
          ? "application/json; charset=utf-8"
          : "text/html; charset=utf-8";

    return {
      status: 200,
      body: file.content,
      headers: {
        "content-type": contentType,
        "cache-control": "no-store",
      },
    };
  }

  async terminate() {
    this.record.status = "stopped";
    this.record.updatedAt = new Date().toISOString();
    this.record.terminal = [
      ...this.record.terminal,
      createTerminalEntry("system", "Mock session terminated."),
    ].slice(-10);
  }
}
