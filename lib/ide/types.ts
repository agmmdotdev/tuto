export type SessionStatus = "booting" | "ready" | "stopped";
export type RuntimeMode = "mock" | "secure-exec" | "host-vite";

export type TerminalEntryKind = "system" | "stdout" | "stderr";

export type WorkspaceLanguage =
  | "tsx"
  | "ts"
  | "js"
  | "jsx"
  | "css"
  | "json"
  | "md"
  | "html";

export interface WorkspaceFile {
  path: string;
  content: string;
  language: WorkspaceLanguage;
  description?: string;
}

export interface TerminalEntry {
  id: string;
  kind: TerminalEntryKind;
  message: string;
  timestamp: string;
}

export interface EditorTypeLibrary {
  filePath: string;
  content: string;
}

export interface TerminalChunk {
  id: number;
  data: string;
  timestamp: string;
}

export interface TerminalSnapshot {
  cursor: number;
  chunks: TerminalChunk[];
  writable: boolean;
  title: string;
}

export type BuildDiagnosticLevel = "info" | "warn" | "error";

export interface BuildDiagnostic {
  id: string;
  level: BuildDiagnosticLevel;
  message: string;
  timestamp: string;
  filePath?: string;
  line?: number;
  column?: number;
}

export interface SessionSnapshot {
  id: string;
  templateId: string;
  templateName: string;
  runtimeMode: RuntimeMode;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  previewPath: string;
  files: WorkspaceFile[];
  terminal: TerminalEntry[];
}
