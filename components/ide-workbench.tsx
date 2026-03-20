"use client";

import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { MonacoWorkspaceEditor } from "@/components/monaco-workspace-editor";
import { XtermTerminal } from "@/components/xterm-terminal";
import { RuntimeMode, SessionSnapshot, TerminalEntry, WorkspaceFile } from "@/lib/ide/types";

type SaveState = "idle" | "saving" | "saved" | "error";
type RestartState = "idle" | "restarting" | "error";
type OutputFilter = "all" | "runtime" | "client";
type ClientLogLevel = "log" | "info" | "warn" | "error";
type BottomPanelTab = "output" | "terminal";

type FileTreeNode = {
  name: string;
  path: string;
  kind: "file" | "directory";
  children?: FileTreeNode[];
};

type ClientLogEntry = {
  id: string;
  source: "client";
  level: ClientLogLevel;
  message: string;
  timestamp: string;
};

type WorkbenchLogEntry =
  | (TerminalEntry & { source: "runtime" })
  | (ClientLogEntry & {
      kind: "stdout" | "stderr" | "system";
    });

const preferredFilePathByRuntime: Record<RuntimeMode, string> = {
  mock: "preview.html",
  "secure-exec": "preview.html",
  "host-vite": "src/App.tsx",
};

const runtimeCopy: Record<
  RuntimeMode,
  {
    label: string;
    explorer: string;
    preview: string;
    terminal: string;
  }
> = {
  mock: {
    label: "Mock",
    explorer: "Session files from the in-memory adapter.",
    preview: "Preview is rendered from saved session files.",
    terminal: "Mock session events.",
  },
  "secure-exec": {
    label: "Secure Exec",
    explorer: "Workspace files synced into the isolated runtime.",
    preview: "Preview requests are proxied into Secure Exec.",
    terminal: "Runtime boot and server logs.",
  },
  "host-vite": {
    label: "Host Vite",
    explorer: "Workspace files backed by a real Vite + React project.",
    preview: "Preview is served from the host-backed Vite dev server.",
    terminal: "Install, cache, restart, and Vite process logs.",
  },
};

function getActivity(entries: TerminalEntry[], status?: SessionSnapshot["status"]) {
  const latestSystem = [...entries]
    .reverse()
    .find((entry) => entry.kind === "system")?.message;

  if (!latestSystem) {
    return status === "booting" ? "Booting session" : "Ready";
  }

  if (latestSystem.includes("Installing workspace dependencies")) {
    return "Installing dependencies";
  }

  if (latestSystem.includes("Reinstalling dependencies")) {
    return "Reinstalling dependencies";
  }

  if (latestSystem.includes("Restored workspace dependencies from cache")) {
    return "Dependency cache hit";
  }

  if (latestSystem.includes("Saved workspace dependencies to cache")) {
    return "Dependency cache updated";
  }

  if (latestSystem.includes("Pruned dependency cache")) {
    return "Dependency cache pruned";
  }

  if (latestSystem.includes("Manual restart requested")) {
    return "Restarting runtime";
  }

  if (latestSystem.includes("ready at")) {
    return "Preview ready";
  }

  return latestSystem;
}

function buildFileTree(files: WorkspaceFile[]) {
  const roots: FileTreeNode[] = [];

  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    const parts = file.path.split("/");
    let nodes = roots;
    let currentPath = "";

    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isFile = index === parts.length - 1;
      let node = nodes.find((entry) => entry.name === part);

      if (!node) {
        node = {
          name: part,
          path: currentPath,
          kind: isFile ? "file" : "directory",
          children: isFile ? undefined : [],
        };
        nodes.push(node);
        nodes.sort((left, right) => {
          if (left.kind !== right.kind) {
            return left.kind === "directory" ? -1 : 1;
          }

          return left.name.localeCompare(right.name);
        });
      }

      if (!isFile) {
        nodes = node.children ?? [];
      }
    });
  }

  return roots;
}

function toRuntimeWorkbenchEntry(entry: TerminalEntry): WorkbenchLogEntry {
  return {
    ...entry,
    source: "runtime",
  };
}

function toClientWorkbenchKind(level: ClientLogLevel) {
  if (level === "error" || level === "warn") {
    return "stderr";
  }

  return "stdout";
}

function toTimestampLabel(timestamp: string) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function IdeWorkbench() {
  const [selectedRuntimeMode, setSelectedRuntimeMode] =
    useState<RuntimeMode>("mock");
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState(
    preferredFilePathByRuntime.mock,
  );
  const [draft, setDraft] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [restartState, setRestartState] = useState<RestartState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [previewNonce, setPreviewNonce] = useState(0);
  const [outputFilter, setOutputFilter] = useState<OutputFilter>("all");
  const [bottomPanelTab, setBottomPanelTab] = useState<BottomPanelTab>("output");
  const [clientLogs, setClientLogs] = useState<ClientLogEntry[]>([]);
  const outputAnchorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const preferredFilePath = preferredFilePathByRuntime[selectedRuntimeMode];

    async function bootSession() {
      setSession(null);
      setErrorMessage(null);
      setSaveState("idle");
      setRestartState("idle");
      setPreviewNonce(0);
      setClientLogs([]);

      try {
        const response = await fetch("/api/sessions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            templateId:
              selectedRuntimeMode === "host-vite"
                ? "vite-react-starter"
                : "next-tutorial-starter",
            runtimeMode: selectedRuntimeMode,
          }),
        });

        if (!response.ok) {
          throw new Error("Failed to create a workspace session.");
        }

        const nextSession = (await response.json()) as SessionSnapshot;

        if (cancelled) {
          return;
        }

        setSession(nextSession);

        const startingFile =
          nextSession.files.find((file) => file.path === preferredFilePath) ??
          nextSession.files[0];

        if (startingFile) {
          setSelectedFilePath(startingFile.path);
          setDraft(startingFile.content);
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(
            error instanceof Error
              ? error.message
              : "Failed to create a workspace session.",
          );
        }
      }
    }

    bootSession();

    return () => {
      cancelled = true;
    };
  }, [selectedRuntimeMode]);

  useEffect(() => {
    if (!session?.id) {
      return;
    }

    let cancelled = false;

    const syncSession = async () => {
      try {
        const response = await fetch(`/api/sessions/${session.id}`, {
          cache: "no-store",
        });

        if (!response.ok) {
          return;
        }

        const nextSession = (await response.json()) as SessionSnapshot;

        if (cancelled) {
          return;
        }

        startTransition(() => {
          setSession((current) => {
            if (!current || current.id !== nextSession.id) {
              return current;
            }

            return {
              ...current,
              status: nextSession.status,
              terminal: nextSession.terminal,
              updatedAt: nextSession.updatedAt,
            };
          });
        });
      } catch {
        // Ignore transient polling failures and keep the current session view.
      }
    };

    void syncSession();

    const interval = window.setInterval(() => {
      void syncSession();
    }, 1200);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [session?.id]);

  useEffect(() => {
    function handlePreviewMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) {
        return;
      }

      const payload = event.data as
        | {
            source?: string;
            sessionId?: string;
            level?: ClientLogLevel;
            message?: string;
            timestamp?: string;
          }
        | undefined;

      if (
        payload?.source !== "tuto-preview-log" ||
        payload.sessionId !== session?.id ||
        !payload.message
      ) {
        return;
      }

      const level: ClientLogLevel =
        payload.level === "error" ||
        payload.level === "warn" ||
        payload.level === "info"
          ? payload.level
          : "log";
      const message = payload.message;
      const entry: ClientLogEntry = {
        id: crypto.randomUUID(),
        source: "client",
        level,
        message,
        timestamp: payload.timestamp ?? new Date().toISOString(),
      };

      setClientLogs((current) =>
        [...current, entry].slice(-200),
      );
    }

    window.addEventListener("message", handlePreviewMessage);

    return () => {
      window.removeEventListener("message", handlePreviewMessage);
    };
  }, [session?.id]);

  useEffect(() => {
    if (!session?.id) {
      return;
    }

    const closeSession = () => {
      void fetch(`/api/sessions/${session.id}`, {
        method: "DELETE",
        keepalive: true,
      }).catch(() => undefined);
    };

    window.addEventListener("pagehide", closeSession);

    return () => {
      window.removeEventListener("pagehide", closeSession);
      closeSession();
    };
  }, [session?.id]);

  const selectedFile = useMemo(() => {
    return session?.files.find((file) => file.path === selectedFilePath) ?? null;
  }, [selectedFilePath, session]);

  useEffect(() => {
    if (!selectedFile) {
      return;
    }

    setDraft(selectedFile.content);
    setSaveState("idle");
    setErrorMessage(null);
  }, [selectedFile]);

  useEffect(() => {
    if (!session || !selectedFile || draft === selectedFile.content) {
      return;
    }

    const timeout = window.setTimeout(async () => {
      setSaveState("saving");

      try {
        const response = await fetch(`/api/sessions/${session.id}/files`, {
          method: "PUT",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            path: selectedFile.path,
            content: draft,
          }),
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as
            | { error?: string }
            | null;

          throw new Error(payload?.error ?? "Save failed.");
        }

        const nextSession = (await response.json()) as SessionSnapshot;

        startTransition(() => {
          setSession(nextSession);
          setSaveState("saved");
          setPreviewNonce((value) => value + 1);
        });
      } catch (error) {
        setSaveState("error");
        setErrorMessage(
          error instanceof Error ? error.message : "Unable to save file.",
        );
      }
    }, 500);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [draft, selectedFile, session]);

  const previewUrl = session
    ? `/preview/${session.id}/?v=${previewNonce}`
    : undefined;
  const runtimeDetails = runtimeCopy[session?.runtimeMode ?? selectedRuntimeMode];
  const activityLabel =
    restartState === "restarting"
      ? "Restarting runtime"
      : getActivity(session?.terminal ?? [], session?.status);
  const packageJsonSeed =
    session?.files.find((file) => file.path === "package.json")?.content ?? "";
  const fileTree = buildFileTree(session?.files ?? []);
  const canRestart = !!session?.id && restartState !== "restarting";
  const outputEntries = useMemo(() => {
    const runtimeEntries = (session?.terminal ?? []).map(toRuntimeWorkbenchEntry);
    const browserEntries = clientLogs.map((entry) => ({
      ...entry,
      kind: toClientWorkbenchKind(entry.level),
    }));
    const merged = [...runtimeEntries, ...browserEntries].sort((left, right) =>
      left.timestamp.localeCompare(right.timestamp),
    );

    if (outputFilter === "runtime") {
      return merged.filter((entry) => entry.source === "runtime");
    }

    if (outputFilter === "client") {
      return merged.filter((entry) => entry.source === "client");
    }

    return merged;
  }, [clientLogs, outputFilter, session?.terminal]);

  useEffect(() => {
    outputAnchorRef.current?.scrollIntoView({ block: "end" });
  }, [outputEntries]);

  async function handleRestart() {
    if (!session?.id) {
      return;
    }

    setRestartState("restarting");
    setErrorMessage(null);

    try {
      const response = await fetch(`/api/sessions/${session.id}`, {
        method: "POST",
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;

        throw new Error(payload?.error ?? "Restart failed.");
      }

      const nextSession = (await response.json()) as SessionSnapshot;

      startTransition(() => {
        setSession(nextSession);
        setRestartState("idle");
        setPreviewNonce((value) => value + 1);
      });
    } catch (error) {
      setRestartState("error");
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to restart runtime.",
      );
    }
  }

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-[#1e1e1e] text-[#cccccc]">
      <header className="flex h-10 items-center justify-between border-b border-[#2a2d2e] bg-[#181818] px-3 text-xs">
        <div className="flex min-w-0 items-center gap-3">
          <span className="font-semibold tracking-wide text-[#9cdcfe]">TUTO</span>
          <span className="text-[#858585]">EXPLORER</span>
          <span className="truncate text-[#cccccc]">
            {session?.templateName ?? "Booting workspace"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded border border-[#3c3c3c] bg-[#252526] p-0.5">
            {(
              Object.entries(runtimeCopy) as Array<
                [RuntimeMode, (typeof runtimeCopy)[RuntimeMode]]
              >
            ).map(([mode, details]) => (
              <button
                key={mode}
                aria-pressed={selectedRuntimeMode === mode}
                className={
                  selectedRuntimeMode === mode
                    ? "rounded bg-[#094771] px-3 py-1 text-[#ffffff]"
                    : "rounded px-3 py-1 text-[#969696] hover:bg-[#2a2d2e] hover:text-[#ffffff]"
                }
                onClick={() => setSelectedRuntimeMode(mode)}
                type="button"
              >
                {details.label}
              </button>
            ))}
          </div>
          <button
            className="rounded border border-[#3c3c3c] bg-[#252526] px-3 py-1 text-[#cccccc] hover:bg-[#2a2d2e] disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canRestart}
            onClick={() => void handleRestart()}
            type="button"
          >
            {restartState === "restarting" ? "Restarting..." : "Restart Runtime"}
          </button>
        </div>
      </header>

      {errorMessage ? (
        <div className="border-b border-[#5a1d1d] bg-[#3c1f1f] px-4 py-2 text-sm text-[#f48771]">
          {errorMessage}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-12 flex-col items-center gap-3 border-r border-[#2a2d2e] bg-[#181818] py-3 text-[10px] uppercase tracking-[0.18em] text-[#858585]">
          <ActivityButton active label="EX" />
          <ActivityButton label="SR" />
          <ActivityButton label="GT" />
        </aside>

        <aside className="flex w-72 min-w-0 flex-col border-r border-[#2a2d2e] bg-[#252526]">
          <div className="border-b border-[#2a2d2e] px-4 py-3">
            <p className="text-[11px] uppercase tracking-[0.12em] text-[#858585]">
              Explorer
            </p>
            <p className="mt-2 text-sm text-[#cccccc]">{runtimeDetails.explorer}</p>
          </div>

          <div className="grid grid-cols-2 gap-px border-b border-[#2a2d2e] bg-[#2a2d2e] text-[11px]">
            <StatusCell label="Runtime" value={runtimeDetails.label} />
            <StatusCell label="Save" value={saveState} />
            <StatusCell label="Session" value={session?.status ?? "booting"} />
            <StatusCell label="Activity" value={activityLabel} />
          </div>

          <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
            <div className="mb-2 px-2 text-[11px] uppercase tracking-[0.12em] text-[#858585]">
              Open Editors
            </div>
            <div className="mb-3 rounded border border-[#2a2d2e] bg-[#1e1e1e] px-2 py-1.5 text-sm text-[#cccccc]">
              {selectedFile?.path ?? "No file selected"}
            </div>

            <div className="mb-2 px-2 text-[11px] uppercase tracking-[0.12em] text-[#858585]">
              Files
            </div>
            <div>
              {fileTree.map((node) => (
                <FileTreeBranch
                  key={node.path}
                  node={node}
                  onSelect={setSelectedFilePath}
                  selectedFilePath={selectedFilePath}
                />
              ))}
            </div>
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-9 items-end border-b border-[#2a2d2e] bg-[#252526] text-sm">
            <div className="flex h-full items-center border-r border-[#2a2d2e] bg-[#1e1e1e] px-4 text-[#ffffff]">
              {selectedFile?.path ?? "editor"}
            </div>
            <div className="flex h-full items-center border-r border-[#2a2d2e] px-4 text-[#858585]">
              Preview
            </div>
            <button
              className={
                bottomPanelTab === "output"
                  ? "flex h-full items-center border-r border-[#2a2d2e] bg-[#1e1e1e] px-4 text-[#ffffff]"
                  : "flex h-full items-center border-r border-[#2a2d2e] px-4 text-[#858585]"
              }
              onClick={() => setBottomPanelTab("output")}
              type="button"
            >
              Output
            </button>
            <button
              className={
                bottomPanelTab === "terminal"
                  ? "flex h-full items-center bg-[#1e1e1e] px-4 text-[#ffffff]"
                  : "flex h-full items-center px-4 text-[#858585]"
              }
              onClick={() => setBottomPanelTab("terminal")}
              type="button"
            >
              Terminal
            </button>
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.3fr)_minmax(360px,0.8fr)]">
            <div className="min-w-0 border-r border-[#2a2d2e] bg-[#1e1e1e]">
              {selectedFile && session ? (
                <MonacoWorkspaceEditor
                  filePath={selectedFile.path}
                  language={selectedFile.language}
                  onChange={setDraft}
                  packageJsonSeed={packageJsonSeed}
                  runtimeMode={session.runtimeMode}
                  sessionId={session.id}
                  value={draft}
                />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-[#858585]">
                  Loading editor...
                </div>
              )}
            </div>

            <div className="flex min-h-0 flex-col bg-[#1e1e1e]">
              <div className="flex h-9 items-center border-b border-[#2a2d2e] px-4 text-xs uppercase tracking-[0.12em] text-[#858585]">
                {runtimeDetails.preview}
              </div>
              <div className="min-h-0 flex-1 bg-[#ffffff]">
                {previewUrl ? (
                  <iframe
                    className="h-full w-full border-0"
                    key={previewUrl}
                    sandbox="allow-scripts allow-same-origin"
                    src={previewUrl}
                    title="Session preview"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-[#858585]">
                    Starting preview...
                  </div>
                )}
              </div>
            </div>
          </div>

          <section className="h-56 border-t border-[#2a2d2e] bg-[#181818]">
            <div className="flex h-9 items-center justify-between border-b border-[#2a2d2e] px-4 text-xs uppercase tracking-[0.12em] text-[#858585]">
              <span>
                {bottomPanelTab === "output"
                  ? runtimeDetails.terminal
                  : "Interactive workspace shell"}
              </span>
              {bottomPanelTab === "output" ? (
                <div className="flex items-center gap-1">
                  {(["all", "runtime", "client"] as OutputFilter[]).map((filter) => (
                    <button
                      aria-pressed={outputFilter === filter}
                      className={
                        outputFilter === filter
                          ? "rounded border border-[#007acc] bg-[#094771] px-2 py-0.5 text-[10px] text-white"
                          : "rounded border border-[#3c3c3c] bg-[#252526] px-2 py-0.5 text-[10px] text-[#969696] hover:text-white"
                      }
                      key={filter}
                      onClick={() => setOutputFilter(filter)}
                      type="button"
                    >
                      {filter}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="h-[calc(100%-2.25rem)] overflow-auto px-4 py-3">
              {bottomPanelTab === "terminal" && session ? (
                <div className="h-full overflow-hidden rounded border border-[#2a2d2e] bg-[#181818]">
                  <XtermTerminal sessionId={session.id} />
                </div>
              ) : outputEntries.length > 0 ? (
                <div className="space-y-1.5 font-mono text-xs">
                  {outputEntries.map((entry) => (
                    <div
                      className="grid grid-cols-[72px_64px_72px_minmax(0,1fr)] gap-3"
                      key={entry.id}
                    >
                      <span className="text-[#858585]">
                        {toTimestampLabel(entry.timestamp)}
                      </span>
                      <span
                        className={
                          entry.source === "client"
                            ? "rounded bg-[#1f3a5f] px-2 py-1 text-[#9cdcfe]"
                            : "rounded bg-[#2d2d30] px-2 py-1 text-[#c5c5c5]"
                        }
                      >
                        {entry.source}
                      </span>
                      <span
                        className={
                          entry.kind === "stderr"
                            ? "rounded bg-[#4b1f24] px-2 py-1 text-[#f48771]"
                          : entry.kind === "stdout"
                              ? "rounded bg-[#4b2f1a] px-2 py-1 text-[#ce9178]"
                              : "rounded bg-[#163b4d] px-2 py-1 text-[#9cdcfe]"
                        }
                      >
                        {entry.source === "client" && "level" in entry
                          ? entry.level
                          : entry.kind}
                      </span>
                      <p className="min-w-0 break-words text-[#d4d4d4]">
                        {entry.message}
                      </p>
                    </div>
                  ))}
                  <div ref={outputAnchorRef} />
                </div>
              ) : (
                <p className="text-sm text-[#858585]">
                  Waiting for runtime or browser output...
                </p>
              )}
            </div>
          </section>
        </section>
      </div>

      <footer className="flex h-6 items-center justify-between bg-[#007acc] px-3 text-[11px] text-white">
        <div className="flex items-center gap-4">
          <span>{runtimeDetails.label}</span>
          <span>{session?.status ?? "booting"}</span>
          <span>{saveState}</span>
        </div>
        <div className="truncate">{activityLabel}</div>
      </footer>
    </main>
  );
}

function ActivityButton({
  active = false,
  label,
}: {
  active?: boolean;
  label: string;
}) {
  return (
    <button
      className={
        active
          ? "flex h-8 w-8 items-center justify-center rounded border border-[#007acc] bg-[#094771] text-[#ffffff]"
          : "flex h-8 w-8 items-center justify-center rounded border border-transparent bg-transparent text-[#858585] hover:bg-[#2a2d2e] hover:text-[#ffffff]"
      }
      type="button"
    >
      {label}
    </button>
  );
}

function StatusCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[#252526] px-3 py-2">
      <p className="truncate text-[10px] uppercase tracking-[0.12em] text-[#858585]">
        {label}
      </p>
      <p className="mt-1 truncate text-xs text-[#cccccc]">{value}</p>
    </div>
  );
}

function FileTreeBranch({
  node,
  onSelect,
  selectedFilePath,
  depth = 0,
}: {
  node: FileTreeNode;
  onSelect: (path: string) => void;
  selectedFilePath: string;
  depth?: number;
}) {
  const paddingLeft = 8 + depth * 14;

  if (node.kind === "file") {
    const active = node.path === selectedFilePath;

    return (
      <button
        className={
          active
            ? "flex w-full items-center gap-2 rounded bg-[#37373d] py-1.5 pr-2 text-left text-sm text-[#ffffff]"
            : "flex w-full items-center gap-2 rounded py-1.5 pr-2 text-left text-sm text-[#cccccc] hover:bg-[#2a2d2e]"
        }
        onClick={() => onSelect(node.path)}
        style={{ paddingLeft }}
        type="button"
      >
        <span className="font-mono text-[#858585]">-</span>
        <span className="truncate">{node.name}</span>
      </button>
    );
  }

  return (
    <div>
      <div
        className="flex items-center gap-2 py-1.5 pr-2 text-left text-sm text-[#cccccc]"
        style={{ paddingLeft }}
      >
        <span className="font-mono text-[#858585]">+</span>
        <span className="truncate">{node.name}</span>
      </div>
      {node.children?.map((child) => (
        <FileTreeBranch
          depth={depth + 1}
          key={child.path}
          node={child}
          onSelect={onSelect}
          selectedFilePath={selectedFilePath}
        />
      ))}
    </div>
  );
}
