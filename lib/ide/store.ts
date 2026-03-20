import "server-only";

import { getTemplate, listTemplates } from "@/lib/ide/templates";
import { SessionAdapter } from "@/lib/ide/runtime/base";
import { HostViteSessionAdapter } from "@/lib/ide/runtime/host-vite-adapter";
import { MockSessionAdapter } from "@/lib/ide/runtime/mock-adapter";
import { SecureExecSessionAdapter } from "@/lib/ide/runtime/secure-exec-adapter";
import { RuntimeMode } from "@/lib/ide/types";

declare global {
  var __ideSessionStore: Map<string, SessionAdapter> | undefined;
}

const sessions = globalThis.__ideSessionStore ?? new Map<string, SessionAdapter>();

if (!globalThis.__ideSessionStore) {
  globalThis.__ideSessionStore = sessions;
}

function resolveRuntimeMode(input?: RuntimeMode) {
  if (input) {
    return input;
  }

  if (
    process.env.IDE_RUNTIME_MODE === "secure-exec" ||
    process.env.IDE_RUNTIME_MODE === "host-vite"
  ) {
    return process.env.IDE_RUNTIME_MODE;
  }

  return "mock";
}

async function buildAdapter(templateId?: string, runtimeMode?: RuntimeMode) {
  const resolvedRuntimeMode = resolveRuntimeMode(runtimeMode);
  const resolvedTemplateId =
    templateId ??
    (resolvedRuntimeMode === "host-vite"
      ? "vite-react-starter"
      : "next-tutorial-starter");
  const template = getTemplate(resolvedTemplateId);

  if (!template) {
    throw new Error(`Unknown template: ${resolvedTemplateId}`);
  }

  if (resolvedRuntimeMode === "host-vite") {
    return HostViteSessionAdapter.create(template);
  }

  if (resolvedRuntimeMode === "secure-exec") {
    return SecureExecSessionAdapter.create(template);
  }

  return MockSessionAdapter.create(template);
}

export { listTemplates };

export async function createSession(
  templateId?: string,
  runtimeMode?: RuntimeMode,
) {
  const session = await buildAdapter(templateId, runtimeMode);

  sessions.set(session.id, session);

  return session.snapshot();
}

export async function getSession(sessionId: string) {
  const session = sessions.get(sessionId);

  return session ? session.snapshot() : null;
}

export async function updateSessionFile(
  sessionId: string,
  filePath: string,
  content: string,
) {
  const session = sessions.get(sessionId);

  if (!session) {
    throw new Error("Session not found.");
  }

  return session.updateFile(filePath, content);
}

export async function restartSession(sessionId: string) {
  const session = sessions.get(sessionId);

  if (!session) {
    throw new Error("Session not found.");
  }

  return session.restart();
}

export async function getSessionTypeLibraries(sessionId: string) {
  const session = sessions.get(sessionId);

  if (!session) {
    throw new Error("Session not found.");
  }

  return session.getTypeLibraries();
}

export async function getSessionTerminalSnapshot(
  sessionId: string,
  cursor?: number,
) {
  const session = sessions.get(sessionId);

  if (!session) {
    throw new Error("Session not found.");
  }

  return session.getTerminalSnapshot(cursor);
}

export async function writeSessionTerminalInput(sessionId: string, input: string) {
  const session = sessions.get(sessionId);

  if (!session) {
    throw new Error("Session not found.");
  }

  await session.writeTerminalInput(input);
}

export async function resizeSessionTerminal(
  sessionId: string,
  columns: number,
  rows: number,
) {
  const session = sessions.get(sessionId);

  if (!session) {
    throw new Error("Session not found.");
  }

  await session.resizeTerminal(columns, rows);
}

export async function fetchPreview(
  sessionId: string,
  input: {
    path: string;
    search: string;
    method: string;
    headers: Record<string, string>;
  },
) {
  const session = sessions.get(sessionId);

  return session ? session.fetchPreview(input) : null;
}

export async function deleteSession(sessionId: string) {
  const session = sessions.get(sessionId);

  if (!session) {
    return false;
  }

  await session.terminate();
  sessions.delete(sessionId);

  return true;
}
