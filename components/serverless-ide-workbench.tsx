"use client";

import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { MonacoWorkspaceEditor } from "@/components/monaco-workspace-editor";
import { materializeTanstackRouteTree } from "@/lib/ide/tanstack-route-tree";
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
  kind: "stdout" | "stderr";
  message: string;
  timestamp: string;
};

type ServerlessWorkbenchMode = "react" | "nextjs" | "tanstackstart";

const nextTypeLibraries = [
  {
    filePath: "types/next-link.d.ts",
    content: `declare module "next/link" {
  import * as React from "react";
  export type LinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string | URL;
  };
  export default function Link(props: LinkProps): React.ReactElement;
}`,
  },
  {
    filePath: "types/next-image.d.ts",
    content: `declare module "next/image" {
  import * as React from "react";
  export interface StaticImageData {
    src: string;
    width: number;
    height: number;
    blurDataURL?: string;
  }
  export type ImageProps = Omit<React.ImgHTMLAttributes<HTMLImageElement>, "src"> & {
    src: string | StaticImageData;
    alt: string;
    fill?: boolean;
    width?: number;
    height?: number;
    quality?: number;
    priority?: boolean;
    sizes?: string;
  };
  export default function Image(props: ImageProps): React.ReactElement;
}`,
  },
  {
    filePath: "types/next-navigation.d.ts",
    content: `declare module "next/navigation" {
  export interface AppRouterInstance {
    push(href: string): void;
    replace(href: string): void;
    back(): void;
    forward(): void;
    refresh(): void;
    prefetch(href: string): Promise<void>;
  }
  export function useRouter(): AppRouterInstance;
  export function usePathname(): string;
  export function useSearchParams(): URLSearchParams;
}`,
  },
  {
    filePath: "types/next-head.d.ts",
    content: `declare module "next/head" {
  import * as React from "react";
  export default function Head(props: { children?: React.ReactNode }): React.ReactElement | null;
}`,
  },
];

const modeConfig: Record<
  ServerlessWorkbenchMode,
  {
    storageKey: string;
    defaultFilePath: string;
    title: string;
    explorerCopy: string;
    previewLabel: string;
    statusMode: string;
    footerHint: string;
    packageJsonSeed: string;
    sessionId: string;
  }
> = {
  react: {
    storageKey: "tuto-serverless-workspace-v3",
    defaultFilePath: "src/App.tsx",
    title: "Stateless React Playground",
    explorerCopy:
      "This route compiles only from the saved snapshot. Edit freely, then press Ctrl+S or use Save + Build.",
    previewLabel: "Stateless preview from the last saved snapshot",
    statusMode: "serverless",
    footerHint: "Ctrl+S saves and rebuilds preview",
    packageJsonSeed: "serverless-root-types",
    sessionId: "serverless",
  },
  nextjs: {
    storageKey: "tuto-serverless-nextjs-workspace-v1",
    defaultFilePath: "app/page.tsx",
    title: "Stateless Next.js Playground",
    explorerCopy:
      "This route compiles a small App Router-like workspace from the saved snapshot. Edit app/page.tsx or app/layout.tsx, then press Ctrl+S or use Save + Build.",
    previewLabel: "Stateless Next-style preview from the last saved snapshot",
    statusMode: "serverless-nextjs",
    footerHint: "Ctrl+S saves and rebuilds the Next-style preview",
    packageJsonSeed: "serverless-nextjs-root-types",
    sessionId: "serverless-nextjs",
  },
  tanstackstart: {
    storageKey: "tuto-serverless-tanstack-start-workspace-v8",
    defaultFilePath: "src/routes/index.tsx",
    title: "TanStack Start Runtime Playground",
    explorerCopy:
      "This route uses TanStack Start's compiler core without booting Vite. It rewrites createServerFn calls into RPC stubs, bundles the client preview with esbuild, and executes server functions through a stateless API route.",
    previewLabel: "Real TanStack Start preview from the last saved snapshot",
    statusMode: "serverless-tanstack-start",
    footerHint: "Ctrl+S saves and rebuilds the Start runtime preview",
    packageJsonSeed: "serverless-tanstack-start-root-types",
    sessionId: "serverless-tanstack-start",
  },
};

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

function buildTanstackTypeLibraries() {
  return [
    {
      filePath: "types/tanstack-router-register.d.ts",
      content: `import type { router } from "../src/router";

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

declare module "@tanstack/router-core" {
  interface Register {
    router: typeof router;
  }
}
`,
    },
  ];
}

function mergeDrafts(files: WorkspaceFile[], draftsByPath: Record<string, string>) {
  return files.map((file) => ({
    ...file,
    content: draftsByPath[file.path] ?? file.content,
  }));
}

function materializeModeFiles(mode: ServerlessWorkbenchMode, files: WorkspaceFile[]) {
  return mode === "tanstackstart" ? materializeTanstackRouteTree(files) : files;
}

function restoreMissingTemplateFiles(
  mode: ServerlessWorkbenchMode,
  files: WorkspaceFile[],
  initialFiles: WorkspaceFile[],
) {
  if (mode !== "tanstackstart") {
    return files;
  }

  const filesByPath = new Map(files.map((file) => [file.path, file]));

  for (const initialFile of initialFiles) {
    if (!filesByPath.has(initialFile.path)) {
      filesByPath.set(initialFile.path, initialFile);
    }
  }

  return [...filesByPath.values()];
}

function prepareModeFiles(
  mode: ServerlessWorkbenchMode,
  files: WorkspaceFile[],
  initialFiles: WorkspaceFile[],
) {
  return materializeModeFiles(mode, restoreMissingTemplateFiles(mode, files, initialFiles));
}

export function ServerlessIdeWorkbench({
  initialFiles,
  mode = "react",
}: {
  initialFiles: WorkspaceFile[];
  mode?: ServerlessWorkbenchMode;
}) {
  const config = modeConfig[mode];
  const [files, setFiles] = useState<WorkspaceFile[]>(() =>
    prepareModeFiles(mode, initialFiles, initialFiles),
  );
  const [draftsByPath, setDraftsByPath] = useState<Record<string, string>>({});
  const [selectedFilePath, setSelectedFilePath] = useState(config.defaultFilePath);
  const [buildState, setBuildState] = useState<BuildState>("idle");
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [buildDiagnostics, setBuildDiagnostics] = useState<BuildDiagnostic[]>([]);
  const [clientLogs, setClientLogs] = useState<ClientLogEntry[]>([]);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [buildVersion, setBuildVersion] = useState(0);
  const outputAnchorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(config.storageKey);

      if (!saved) {
        setBuildVersion(1);
        return;
      }

      const parsed = JSON.parse(saved) as {
        files?: WorkspaceFile[];
        draftsByPath?: Record<string, string>;
      };

      if (parsed.files?.length) {
        const nextFiles = prepareModeFiles(mode, parsed.files, initialFiles);

        setFiles(nextFiles);
        const preferredFile =
          nextFiles.find((file) => file.path === config.defaultFilePath) ??
          nextFiles[0];

        if (preferredFile) {
          setSelectedFilePath(preferredFile.path);
        }
      }

      if (parsed.draftsByPath && typeof parsed.draftsByPath === "object") {
        setDraftsByPath(parsed.draftsByPath);
      }

      setBuildVersion(1);
    } catch {
      setBuildVersion(1);
    }
  }, [config.defaultFilePath, config.storageKey, initialFiles, mode]);

  useEffect(() => {
    window.localStorage.setItem(
      config.storageKey,
      JSON.stringify({ files, draftsByPath }),
    );
  }, [config.storageKey, draftsByPath, files]);

  const savedFiles = useMemo(() => materializeModeFiles(mode, files), [files, mode]);
  const workingFiles = useMemo(
    () => materializeModeFiles(mode, mergeDrafts(savedFiles, draftsByPath)),
    [draftsByPath, mode, savedFiles],
  );
  const selectedFile = useMemo(() => {
    return workingFiles.find((file) => file.path === selectedFilePath) ?? null;
  }, [selectedFilePath, workingFiles]);
  const fileTree = useMemo(() => buildFileTree(workingFiles), [workingFiles]);
  const extraTypeLibraries = useMemo(
    () => {
      const libraries = buildLucideTypeLibrary(workingFiles);

      if (mode === "nextjs") {
        return [...libraries, ...nextTypeLibraries];
      }

      if (mode === "tanstackstart") {
        return [...libraries, ...buildTanstackTypeLibraries()];
      }

      return libraries;
    },
    [mode, workingFiles],
  );
  const currentValue = selectedFile
    ? draftsByPath[selectedFile.path] ?? selectedFile.content
    : "";
  const dirtyFileCount = useMemo(
    () =>
      savedFiles.filter((file) => draftsByPath[file.path] !== undefined && draftsByPath[file.path] !== file.content)
        .length,
    [draftsByPath, savedFiles],
  );
  const isCurrentFileDirty = selectedFile
    ? draftsByPath[selectedFile.path] !== undefined &&
      draftsByPath[selectedFile.path] !== selectedFile.content
    : false;

  function handleEditorChange(nextValue: string) {
    if (!selectedFile) {
      return;
    }

    setDraftsByPath((current) => {
      if (nextValue === selectedFile.content) {
        const next = { ...current };
        delete next[selectedFile.path];
        return next;
      }

      return {
        ...current,
        [selectedFile.path]: nextValue,
      };
    });
  }

  function handleSave() {
    if (!selectedFile || !isCurrentFileDirty) {
      return;
    }

    const nextContent = draftsByPath[selectedFile.path];

    if (typeof nextContent !== "string") {
      return;
    }

    setFiles((current) =>
      current.map((file) =>
        file.path === selectedFile.path ? { ...file, content: nextContent } : file,
      ),
    );
    setDraftsByPath((current) => {
      const next = { ...current };
      delete next[selectedFile.path];
      return next;
    });
    setBuildVersion((value) => value + 1);
  }

  function handleResetWorkspace() {
    const nextFiles = prepareModeFiles(mode, initialFiles, initialFiles);

    setFiles(nextFiles);
    setDraftsByPath({});
    setSelectedFilePath(config.defaultFilePath);
    setRequestError(null);
    setBuildVersion((value) => value + 1);
    window.localStorage.removeItem(config.storageKey);
  }

  useEffect(() => {
    if (buildVersion === 0) {
      return;
    }

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
          body: JSON.stringify({ files: savedFiles, mode }),
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
    }, 150);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [buildVersion, mode, savedFiles]);

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

      if (payload?.source !== "tuto-serverless-preview-log" || !payload.message) {
        return;
      }

      setClientLogs((current) =>
        [
          ...current,
          {
            id: crypto.randomUUID(),
            source: "client" as const,
            level:
              payload.level === "info" ||
              payload.level === "warn" ||
              payload.level === "error"
                ? payload.level
                : ("log" as const),
            kind:
              payload.level === "warn" || payload.level === "error"
                ? ("stderr" as const)
                : ("stdout" as const),
            message: payload.message ?? "",
            timestamp: payload.timestamp ?? new Date().toISOString(),
          },
        ].slice(-200),
      );
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

    return [...buildEntries, ...clientLogs].sort((left, right) =>
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
              {config.title}
            </span>
        </div>
        <div className="flex items-center gap-2 text-[#858585]">
          <span className="rounded border border-[#3c3c3c] bg-[#252526] px-3 py-1 text-[#cccccc]">
            Shared root dependencies
          </span>
          <button
            className="rounded border border-[#3c3c3c] bg-[#252526] px-3 py-1 text-[#cccccc] hover:bg-[#2a2d2e]"
            onClick={handleResetWorkspace}
            type="button"
          >
            Reset
          </button>
          <button
            className="rounded border border-[#007acc] bg-[#094771] px-3 py-1 text-white hover:bg-[#0d5f94] disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!isCurrentFileDirty}
            onClick={handleSave}
            type="button"
          >
            Save + Build
          </button>
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
              {config.explorerCopy}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-px border-b border-[#2a2d2e] bg-[#2a2d2e] text-[11px]">
            <StatusCell label="Mode" value={config.statusMode} />
            <StatusCell label="Build" value={buildState} />
            <StatusCell label="Dirty" value={String(dirtyFileCount)} />
            <StatusCell label="Deps" value="repo root" />
          </div>

          <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
            <div className="mb-2 px-2 text-[11px] uppercase tracking-[0.12em] text-[#858585]">
              Open Editors
            </div>
            <div className="mb-3 rounded border border-[#2a2d2e] bg-[#1e1e1e] px-2 py-1.5 text-sm text-[#cccccc]">
              {selectedFile?.path ?? "No file selected"}
              {isCurrentFileDirty ? " • unsaved" : ""}
            </div>

            <div className="mb-2 px-2 text-[11px] uppercase tracking-[0.12em] text-[#858585]">
              Files
            </div>
            <div>
              {fileTree.map((node) => (
                <FileTreeBranch
                  draftsByPath={draftsByPath}
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
                  onSave={handleSave}
                  packageJsonSeed={config.packageJsonSeed}
                  runtimeMode="mock"
                  sessionId={config.sessionId}
                  typeLibrariesUrl="/api/serverless/types"
                  value={currentValue}
                  workspaceFiles={mode === "tanstackstart" ? workingFiles : undefined}
                />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-[#858585]">
                  Loading editor...
                </div>
              )}
            </div>

            <div className="flex min-h-0 flex-col bg-[#1e1e1e]">
              <div className="flex h-9 items-center border-b border-[#2a2d2e] px-4 text-xs uppercase tracking-[0.12em] text-[#858585]">
                {config.previewLabel}
              </div>
              <div className="min-h-0 flex-1 bg-[#ffffff]">
                {previewHtml ? (
                  <iframe
                    className="h-full w-full border-0"
                    sandbox="allow-scripts"
                    srcDoc={previewHtml}
                    title={config.title}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-[#858585]">
                    Press Save + Build to generate the first preview.
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
                        {entry.level}
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
          <span>{config.statusMode}</span>
          <span>{buildState}</span>
          <span>{dirtyFileCount} dirty</span>
        </div>
        <div className="truncate">{config.footerHint}</div>
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
  draftsByPath,
  depth = 0,
}: {
  node: FileTreeNode;
  onSelect: (path: string) => void;
  selectedFilePath: string;
  draftsByPath: Record<string, string>;
  depth?: number;
}) {
  const paddingLeft = 8 + depth * 14;

  if (node.kind === "file") {
    const active = node.path === selectedFilePath;
    const dirty = node.path in draftsByPath;

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
        {dirty ? <span className="text-[#d7ba7d]">•</span> : null}
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
          draftsByPath={draftsByPath}
          key={child.path}
          node={child}
          onSelect={onSelect}
          selectedFilePath={selectedFilePath}
        />
      ))}
    </div>
  );
}
