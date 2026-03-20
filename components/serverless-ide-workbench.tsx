"use client";

import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { MonacoWorkspaceEditor } from "@/components/monaco-workspace-editor";
import { BuildDiagnostic, WorkspaceFile } from "@/lib/ide/types";

type BuildState = "idle" | "building" | "ready" | "error";
type ClientLogLevel = "log" | "info" | "warn" | "error";

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

const storageKey = "tuto-serverless-workspace-v2";
const defaultFilePath = "src/App.tsx";

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

function toTimestampLabel(timestamp: string) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function toOutputKind(level: ClientLogLevel) {
  return level === "warn" || level === "error" ? "stderr" : "stdout";
}

function collectLucideImports(files: WorkspaceFile[]) {
  const importedNames = new Set<string>();
  const typeImportedNames = new Set<string>();
  const namedImportPattern =
    /import\s+(type\s+)?\{([^}]+)\}\s+from\s+["']lucide-react["']/g;

  for (const file of files) {
    if (!["ts", "tsx", "js", "jsx"].includes(file.language)) {
      continue;
    }

    for (const match of file.content.matchAll(namedImportPattern)) {
      const isTypeOnly = Boolean(match[1]);
      const specifiers = match[2]
        ?.split(",")
        .map((part) => part.trim())
        .filter(Boolean);

      for (const specifier of specifiers ?? []) {
        const importedName = specifier.split(/\s+as\s+/i)[0]?.trim();

        if (!importedName) {
          continue;
        }

        if (isTypeOnly || importedName === "LucideIcon" || importedName === "LucideProps") {
          typeImportedNames.add(importedName);
          continue;
        }

        importedNames.add(importedName);
      }
    }
  }

  return {
    importedNames: [...importedNames].sort(),
    typeImportedNames: [...typeImportedNames].sort(),
  };
}

function buildLucideTypeLibrary(files: WorkspaceFile[]) {
  const { importedNames, typeImportedNames } = collectLucideImports(files);

  if (importedNames.length === 0 && typeImportedNames.length === 0) {
    return [];
  }

  const declarations = [
    `import type { ForwardRefExoticComponent, RefAttributes, SVGProps } from "react";`,
    `export type LucideProps = RefAttributes<SVGSVGElement> & Partial<SVGProps<SVGSVGElement>> & { size?: string | number; absoluteStrokeWidth?: boolean };`,
    `export type LucideIcon = ForwardRefExoticComponent<Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>>;`,
    ...importedNames.map((name) => `export const ${name}: LucideIcon;`),
  ].join("\n");

  return [
    {
      filePath: "node_modules/lucide-react/index.d.ts",
      content: declarations,
    },
  ];
}

export function ServerlessIdeWorkbench({
  initialFiles,
}: {
  initialFiles: WorkspaceFile[];
}) {
  const [files, setFiles] = useState<WorkspaceFile[]>(initialFiles);
  const [selectedFilePath, setSelectedFilePath] = useState(defaultFilePath);
  const [draft, setDraft] = useState(
    initialFiles.find((file) => file.path === defaultFilePath)?.content ??
      initialFiles[0]?.content ??
      "",
  );
  const [buildState, setBuildState] = useState<BuildState>("idle");
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [buildDiagnostics, setBuildDiagnostics] = useState<BuildDiagnostic[]>([]);
  const [clientLogs, setClientLogs] = useState<ClientLogEntry[]>([]);
  const [requestError, setRequestError] = useState<string | null>(null);
  const outputAnchorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(storageKey);

      if (!saved) {
        return;
      }

      const parsed = JSON.parse(saved) as { files?: WorkspaceFile[] };

      if (!parsed.files?.length) {
        return;
      }

      setFiles(parsed.files);
      const preferredFile =
        parsed.files.find((file) => file.path === defaultFilePath) ?? parsed.files[0];

      if (preferredFile) {
        setSelectedFilePath(preferredFile.path);
        setDraft(preferredFile.content);
      }
    } catch {
      // Ignore broken local snapshots.
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(storageKey, JSON.stringify({ files }));
  }, [files]);

  const selectedFile = useMemo(() => {
    return files.find((file) => file.path === selectedFilePath) ?? null;
  }, [files, selectedFilePath]);
  const fileTree = useMemo(() => buildFileTree(files), [files]);
  const extraTypeLibraries = useMemo(() => buildLucideTypeLibrary(files), [files]);

  useEffect(() => {
    if (!selectedFile) {
      return;
    }

    setDraft(selectedFile.content);
  }, [selectedFile]);

  function handleEditorChange(nextValue: string) {
    setDraft(nextValue);

    if (!selectedFile) {
      return;
    }

    setFiles((current) => {
      let changed = false;
      const nextFiles = current.map((file) => {
        if (file.path !== selectedFile.path || file.content === nextValue) {
          return file;
        }

        changed = true;

        return {
          ...file,
          content: nextValue,
        };
      });

      return changed ? nextFiles : current;
    });
  }

  useEffect(() => {
    const timeout = window.setTimeout(async () => {
      setBuildState("building");
      setRequestError(null);

      try {
        const response = await fetch("/api/serverless/compile", {
          cache: "no-store",
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ files }),
        });
        const payload = (await response.json()) as {
          success?: boolean;
          html?: string;
          diagnostics?: BuildDiagnostic[];
          error?: string;
        };

        if (!response.ok && !payload.html) {
          throw new Error(payload.error ?? "Unable to build stateless preview.");
        }

        startTransition(() => {
          setPreviewHtml(payload.html ?? null);
          setBuildDiagnostics(payload.diagnostics ?? []);
          setBuildState(payload.success ? "ready" : "error");
          setClientLogs([]);
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to build stateless preview.";

        setRequestError(message);
        setBuildDiagnostics([
          {
            id: crypto.randomUUID(),
            level: "error",
            message,
            timestamp: new Date().toISOString(),
          },
        ]);
        setBuildState("error");
      }
    }, 500);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [files]);

  useEffect(() => {
    function handlePreviewMessage(event: MessageEvent) {
      const payload = event.data as
        | {
            source?: string;
            level?: ClientLogLevel;
            message?: string;
            timestamp?: string;
          }
        | undefined;

      if (
        payload?.source !== "tuto-serverless-preview-log" ||
        !payload.message
      ) {
        return;
      }

      const entry: ClientLogEntry = {
        id: crypto.randomUUID(),
        source: "client",
        level:
          payload.level === "info" ||
          payload.level === "warn" ||
          payload.level === "error"
            ? payload.level
            : "log",
        message: payload.message,
        timestamp: payload.timestamp ?? new Date().toISOString(),
      };

      setClientLogs((current) => [...current, entry].slice(-200));
    }

    window.addEventListener("message", handlePreviewMessage);

    return () => {
      window.removeEventListener("message", handlePreviewMessage);
    };
  }, []);

  const outputEntries = useMemo(() => {
    const buildEntries = buildDiagnostics.map((entry) => ({
      ...entry,
      source: "build" as const,
    }));
    const browserEntries = clientLogs.map((entry) => ({
      ...entry,
      kind: toOutputKind(entry.level),
    }));

    return [...buildEntries, ...browserEntries].sort((left, right) =>
      left.timestamp.localeCompare(right.timestamp),
    );
  }, [buildDiagnostics, clientLogs]);

  useEffect(() => {
    outputAnchorRef.current?.scrollIntoView({ block: "end" });
  }, [outputEntries]);

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-[#1e1e1e] text-[#cccccc]">
      <header className="flex h-10 items-center justify-between border-b border-[#2a2d2e] bg-[#181818] px-3 text-xs">
        <div className="flex min-w-0 items-center gap-3">
          <span className="font-semibold tracking-wide text-[#9cdcfe]">TUTO</span>
          <span className="text-[#858585]">SERVERLESS</span>
          <span className="truncate text-[#cccccc]">
            Stateless React Playground
          </span>
        </div>
        <div className="flex items-center gap-2 text-[#858585]">
          <span className="rounded border border-[#3c3c3c] bg-[#252526] px-3 py-1 text-[#cccccc]">
            Shared root dependencies
          </span>
        </div>
      </header>

      {requestError ? (
        <div className="border-b border-[#5a1d1d] bg-[#3c1f1f] px-4 py-2 text-sm text-[#f48771]">
          {requestError}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-12 flex-col items-center gap-3 border-r border-[#2a2d2e] bg-[#181818] py-3 text-[10px] uppercase tracking-[0.18em] text-[#858585]">
          <ActivityButton active label="EX" />
          <ActivityButton label="ST" />
        </aside>

        <aside className="flex w-72 min-w-0 flex-col border-r border-[#2a2d2e] bg-[#252526]">
          <div className="border-b border-[#2a2d2e] px-4 py-3">
            <p className="text-[11px] uppercase tracking-[0.12em] text-[#858585]">
              Explorer
            </p>
            <p className="mt-2 text-sm text-[#cccccc]">
              This route sends the current file snapshot to a stateless Vite build
              API. No workspace dir, no child process, no terminal.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-px border-b border-[#2a2d2e] bg-[#2a2d2e] text-[11px]">
            <StatusCell label="Mode" value="serverless" />
            <StatusCell label="Build" value={buildState} />
            <StatusCell label="Storage" value="local" />
            <StatusCell label="Deps" value="repo root" />
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
            <div className="flex h-full items-center px-4 text-[#858585]">
              Preview
            </div>
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.3fr)_minmax(360px,0.8fr)]">
            <div className="min-w-0 border-r border-[#2a2d2e] bg-[#1e1e1e]">
              {selectedFile ? (
                <MonacoWorkspaceEditor
                  extraTypeLibraries={extraTypeLibraries}
                  filePath={selectedFile.path}
                  language={selectedFile.language}
                  onChange={handleEditorChange}
                  packageJsonSeed="serverless-root-types"
                  runtimeMode="mock"
                  sessionId="serverless"
                  typeLibrariesUrl="/api/serverless/types"
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
                Stateless preview generated from the current browser snapshot
              </div>
              <div className="min-h-0 flex-1 bg-[#ffffff]">
                {previewHtml ? (
                  <iframe
                    className="h-full w-full border-0"
                    sandbox="allow-scripts"
                    srcDoc={previewHtml}
                    title="Serverless preview"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-[#858585]">
                    Building preview...
                  </div>
                )}
              </div>
            </div>
          </div>

          <section className="h-56 border-t border-[#2a2d2e] bg-[#181818]">
            <div className="flex h-9 items-center justify-between border-b border-[#2a2d2e] px-4 text-xs uppercase tracking-[0.12em] text-[#858585]">
              <span>Build output and browser logs</span>
              <span>{outputEntries.length} entries</span>
            </div>
            <div className="h-[calc(100%-2.25rem)] overflow-auto px-4 py-3">
              {outputEntries.length > 0 ? (
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
                          (entry.source === "build" && entry.level === "error") ||
                          (entry.source === "client" && entry.kind === "stderr")
                            ? "rounded bg-[#4b1f24] px-2 py-1 text-[#f48771]"
                            : entry.source === "build" && entry.level === "warn"
                              ? "rounded bg-[#4b2f1a] px-2 py-1 text-[#ce9178]"
                              : "rounded bg-[#163b4d] px-2 py-1 text-[#9cdcfe]"
                        }
                      >
                        {entry.source === "build" ? entry.level : entry.level}
                      </span>
                      <div className="min-w-0">
                        {entry.source === "build" && entry.filePath ? (
                          <p className="mb-1 text-[#858585]">
                            {entry.filePath}
                            {entry.line ? `:${entry.line}:${entry.column ?? 1}` : ""}
                          </p>
                        ) : null}
                        <p className="break-words text-[#d4d4d4]">
                          {entry.message}
                        </p>
                      </div>
                    </div>
                  ))}
                  <div ref={outputAnchorRef} />
                </div>
              ) : (
                <p className="text-sm text-[#858585]">
                  Waiting for the first build...
                </p>
              )}
            </div>
          </section>
        </section>
      </div>

      <footer className="flex h-6 items-center justify-between bg-[#007acc] px-3 text-[11px] text-white">
        <div className="flex items-center gap-4">
          <span>serverless</span>
          <span>{buildState}</span>
          <span>{files.length} files</span>
        </div>
        <div className="truncate">
          Stateless preview from repo-root dependencies
        </div>
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
