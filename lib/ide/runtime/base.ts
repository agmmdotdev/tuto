import { posix as path } from "node:path";
import {
  EditorTypeLibrary,
  RuntimeMode,
  SessionSnapshot,
  TerminalSnapshot,
  TerminalEntry,
  WorkspaceFile,
  WorkspaceLanguage,
} from "@/lib/ide/types";
import { WorkspaceTemplate } from "@/lib/ide/templates";

export interface SessionAdapter {
  readonly id: string;
  readonly runtimeMode: RuntimeMode;
  snapshot(): Promise<SessionSnapshot>;
  updateFile(filePath: string, content: string): Promise<SessionSnapshot>;
  restart(): Promise<SessionSnapshot>;
  getTypeLibraries(): Promise<EditorTypeLibrary[]>;
  getTerminalSnapshot(cursor?: number): Promise<TerminalSnapshot>;
  writeTerminalInput(input: string): Promise<void>;
  resizeTerminal(columns: number, rows: number): Promise<void>;
  fetchPreview(input: {
    path: string;
    search: string;
    method: string;
    headers: Record<string, string>;
  }): Promise<{
    status: number;
    body: string;
    headers: Record<string, string>;
  } | null>;
  terminate(): Promise<void>;
}

export const WORKSPACE_ROOT = "/root/workspace";

export interface SessionRecord {
  id: string;
  templateId: string;
  templateName: string;
  runtimeMode: RuntimeMode;
  status: SessionSnapshot["status"];
  createdAt: string;
  updatedAt: string;
  previewPath: string;
  files: Map<string, WorkspaceFile>;
  terminal: TerminalEntry[];
}

export function cloneFile(file: WorkspaceFile): WorkspaceFile {
  return {
    ...file,
  };
}

export function cloneSnapshot(record: SessionRecord): SessionSnapshot {
  return {
    id: record.id,
    templateId: record.templateId,
    templateName: record.templateName,
    runtimeMode: record.runtimeMode,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    previewPath: record.previewPath,
    files: [...record.files.values()]
      .map(cloneFile)
      .sort((a, b) => a.path.localeCompare(b.path)),
    terminal: [...record.terminal],
  };
}

export function createTerminalEntry(
  kind: TerminalEntry["kind"],
  message: string,
): TerminalEntry {
  return {
    id: crypto.randomUUID(),
    kind,
    message,
    timestamp: new Date().toISOString(),
  };
}

export function inferLanguage(filePath: string): WorkspaceLanguage {
  if (filePath.endsWith(".tsx")) {
    return "tsx";
  }

  if (filePath.endsWith(".ts")) {
    return "ts";
  }

  if (filePath.endsWith(".js")) {
    return "js";
  }

  if (filePath.endsWith(".jsx")) {
    return "jsx";
  }

  if (filePath.endsWith(".css")) {
    return "css";
  }

  if (filePath.endsWith(".json")) {
    return "json";
  }

  if (filePath.endsWith(".html")) {
    return "html";
  }

  return "md";
}

export function normalizeWorkspacePath(input: string): string {
  const value = input.trim();

  if (!value) {
    throw new Error("File path is required.");
  }

  if (value.includes("\0")) {
    throw new Error("File path contains invalid characters.");
  }

  const normalized = path.normalize(value.replaceAll("\\", "/"));

  if (
    normalized.startsWith("../") ||
    normalized === ".." ||
    path.isAbsolute(normalized)
  ) {
    throw new Error("File path must stay inside the workspace.");
  }

  return normalized;
}

export function toAbsoluteWorkspacePath(workspacePath: string) {
  return `${WORKSPACE_ROOT}/${normalizeWorkspacePath(workspacePath)}`;
}

export function createMissingPreviewDocument(sessionId: string) {
  return `<!doctype html>
<html lang="en">
  <body>
    <pre>Preview file not found for session ${sessionId}</pre>
  </body>
</html>`;
}

export function createInitialRecord(
  template: WorkspaceTemplate,
  runtimeMode: RuntimeMode,
): SessionRecord {
  const now = new Date().toISOString();

  return {
    id: crypto.randomUUID(),
    templateId: template.id,
    templateName: template.name,
    runtimeMode,
    status: "booting",
    createdAt: now,
    updatedAt: now,
    previewPath: template.previewPath,
    files: new Map(template.files.map((file) => [file.path, cloneFile(file)])),
    terminal: [],
  };
}
