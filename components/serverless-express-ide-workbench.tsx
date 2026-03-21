"use client";

import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { MonacoWorkspaceEditor } from "@/components/monaco-workspace-editor";
import { BuildDiagnostic, WorkspaceFile } from "@/lib/ide/types";

type BuildState = "idle" | "building" | "ready" | "error";
type ClientLogLevel = "log" | "info" | "warn" | "error";
type RuntimeLogLevel = "info" | "warn" | "error";
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type ResponseTab = "preview" | "body" | "headers";

type FileTreeNode = {
  name: string;
  path: string;
  kind: "file" | "directory";
  children?: FileTreeNode[];
};

type RuntimeLogEntry = {
  id: string;
  source: "runtime";
  level: RuntimeLogLevel;
  message: string;
  timestamp: string;
};

type ClientLogEntry = {
  id: string;
  source: "client";
  level: ClientLogLevel;
  kind: "stdout" | "stderr";
  message: string;
  timestamp: string;
};

type ExpressResponseView = {
  status: number;
  headers: Record<string, string>;
  body: string;
  contentType: string;
};

type ActiveRequest = {
  method: HttpMethod;
  path: string;
  headers: Record<string, string>;
  body: string;
};

export type ServerlessHttpWorkbenchConfig = {
  storageKey: string;
  defaultFilePath: string;
  htmlPreviewSource: string;
  title: string;
  badge: string;
  dependencyLabel: string;
  explorerCopy: string;
  modeValue: string;
  runtimeValue: string;
  requestPathPlaceholder: string;
  requestRoute: string;
  typeLibrariesUrl?: string;
  extraTypeLibraries?: Array<{ filePath: string; content: string }>;
  packageJsonSeed: string;
  sessionId: string;
  responseHeading: string;
  responseEmptyPreview: string;
  responseEmptyBody: string;
  outputHeading: string;
  footerMode: string;
  footerHint: string;
  previewTitle: string;
  showPreviewAsStatic?: boolean;
};

const storageKey = "tuto-serverless-express-workspace-v3";
const defaultFilePath = "src/server.ts";
const htmlPreviewSource = "tuto-serverless-express-preview-log";

const defaultConfig: ServerlessHttpWorkbenchConfig = {
  storageKey,
  defaultFilePath,
  htmlPreviewSource,
  title: "Stateless Express Playground",
  badge: "SERVERLESS",
  dependencyLabel: "Root express dependency",
  explorerCopy:
    "This route sends the current file snapshot to a stateless Express request runner. The server bundles the app, serves one request, returns the response, and tears the process down again.",
  modeValue: "serverless",
  runtimeValue: "express",
  requestPathPlaceholder: "/api/health",
  requestRoute: "/api/serverless/expressjs/request",
  typeLibrariesUrl: "/api/serverless/expressjs/types",
  extraTypeLibraries: undefined,
  packageJsonSeed: "serverless-express-root-types",
  sessionId: "serverless-express",
  responseHeading: "API Response",
  responseEmptyPreview: "Send a request that returns HTML to inspect the preview.",
  responseEmptyBody: "Send a request to inspect the response.",
  outputHeading: "Build, runtime, and client logs",
  footerMode: "serverless",
  footerHint: "Ctrl+S saves and reruns the active request",
  previewTitle: "Serverless Express preview",
  showPreviewAsStatic: false,
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

function createDefaultHeadersText(method: HttpMethod) {
  return method === "GET" ? "{}" : '{\n  "content-type": "application/json"\n}';
}

function parseHeadersText(headersText: string) {
  if (!headersText.trim()) {
    return {};
  }

  const parsed = JSON.parse(headersText) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Headers must be a JSON object.");
  }

  const headers = Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => [key, String(value)]),
  );

  return headers;
}

function maybeFormatResponseBody(response: ExpressResponseView | null) {
  if (!response) {
    return null;
  }

  if (response.contentType.includes("application/json")) {
    try {
      return JSON.stringify(JSON.parse(response.body), null, 2);
    } catch {
      return response.body;
    }
  }

  return response.body;
}

function normalizeRequestPath(input: string) {
  const trimmed = input.trim();

  if (!trimmed) {
    return "/";
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function ServerlessExpressIdeWorkbench({
  initialFiles,
  config = defaultConfig,
}: {
  initialFiles: WorkspaceFile[];
  config?: ServerlessHttpWorkbenchConfig;
}) {
  const [files, setFiles] = useState<WorkspaceFile[]>(initialFiles);
  const [draftsByPath, setDraftsByPath] = useState<Record<string, string>>({});
  const [selectedFilePath, setSelectedFilePath] = useState(config.defaultFilePath);
  const [requestMethod, setRequestMethod] = useState<HttpMethod>("GET");
  const [requestPath, setRequestPath] = useState("/");
  const [requestHeadersText, setRequestHeadersText] = useState("{}");
  const [requestBodyText, setRequestBodyText] = useState("");
  const [workspaceRequestKey, setWorkspaceRequestKey] = useState(() => crypto.randomUUID());
  const [activeRequest, setActiveRequest] = useState<ActiveRequest>({
    method: "GET",
    path: "/",
    headers: {},
    body: "",
  });
  const [requestVersion, setRequestVersion] = useState(0);
  const [buildState, setBuildState] = useState<BuildState>("idle");
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [responseView, setResponseView] = useState<ExpressResponseView | null>(null);
  const [buildDiagnostics, setBuildDiagnostics] = useState<BuildDiagnostic[]>([]);
  const [runtimeLogs, setRuntimeLogs] = useState<RuntimeLogEntry[]>([]);
  const [clientLogs, setClientLogs] = useState<ClientLogEntry[]>([]);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [responseTab, setResponseTab] = useState<ResponseTab>("preview");
  const outputAnchorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(config.storageKey);

      if (!saved) {
        setRequestVersion(1);
        return;
      }

      const parsed = JSON.parse(saved) as {
        files?: WorkspaceFile[];
        draftsByPath?: Record<string, string>;
        requestMethod?: HttpMethod;
        requestPath?: string;
        requestHeadersText?: string;
        requestBodyText?: string;
        workspaceRequestKey?: string;
      };

      if (parsed.files?.length) {
        setFiles(parsed.files);
        const preferredFile =
          parsed.files.find((file) => file.path === config.defaultFilePath) ??
          parsed.files[0];

        if (preferredFile) {
          setSelectedFilePath(preferredFile.path);
        }
      }

      if (parsed.draftsByPath && typeof parsed.draftsByPath === "object") {
        setDraftsByPath(parsed.draftsByPath);
      }

      const nextMethod = parsed.requestMethod ?? "GET";
      const nextPath =
        typeof parsed.requestPath === "string" && parsed.requestPath.trim()
          ? normalizeRequestPath(parsed.requestPath)
          : "/";
      const nextHeadersText =
        typeof parsed.requestHeadersText === "string"
          ? parsed.requestHeadersText
          : createDefaultHeadersText(nextMethod);
      const nextBodyText =
        typeof parsed.requestBodyText === "string" ? parsed.requestBodyText : "";
      const nextWorkspaceRequestKey =
        typeof parsed.workspaceRequestKey === "string" && parsed.workspaceRequestKey.trim()
          ? parsed.workspaceRequestKey
          : crypto.randomUUID();

      setRequestMethod(nextMethod);
      setRequestPath(nextPath);
      setRequestHeadersText(nextHeadersText);
      setRequestBodyText(nextBodyText);
      setWorkspaceRequestKey(nextWorkspaceRequestKey);

      try {
        setActiveRequest({
          method: nextMethod,
          path: nextPath,
          headers: parseHeadersText(nextHeadersText),
          body: nextMethod === "GET" ? "" : nextBodyText,
        });
      } catch {
        setActiveRequest({
          method: nextMethod,
          path: nextPath,
          headers: {},
          body: nextMethod === "GET" ? "" : nextBodyText,
        });
      }

      setRequestVersion(1);
    } catch {
      setRequestVersion(1);
    }
  }, [config.defaultFilePath, config.storageKey]);

  useEffect(() => {
    window.localStorage.setItem(
      config.storageKey,
      JSON.stringify({
        files,
        draftsByPath,
        requestMethod,
        requestPath,
        requestHeadersText,
        requestBodyText,
        workspaceRequestKey,
      }),
    );
  }, [
    config.storageKey,
    draftsByPath,
    files,
    requestBodyText,
    requestHeadersText,
    requestMethod,
    requestPath,
    workspaceRequestKey,
  ]);

  const selectedFile = useMemo(() => {
    return files.find((file) => file.path === selectedFilePath) ?? null;
  }, [files, selectedFilePath]);
  const fileTree = useMemo(() => buildFileTree(files), [files]);
  const extraTypeLibraries = useMemo(() => {
    if (!config.extraTypeLibraries?.length) {
      return undefined;
    }

    return config.extraTypeLibraries;
  }, [config.extraTypeLibraries]);
  const currentValue = selectedFile
    ? draftsByPath[selectedFile.path] ?? selectedFile.content
    : "";
  const dirtyFileCount = useMemo(
    () =>
      files.filter((file) => draftsByPath[file.path] !== undefined && draftsByPath[file.path] !== file.content)
        .length,
    [draftsByPath, files],
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
    setRequestVersion((value) => value + 1);
  }

  function handleSendRequest() {
    try {
      const nextMethod = requestMethod;
      const nextPath = normalizeRequestPath(requestPath);
      const nextHeaders = parseHeadersText(requestHeadersText);
      const nextBody = nextMethod === "GET" ? "" : requestBodyText;

      setRequestError(null);
      setActiveRequest({
        method: nextMethod,
        path: nextPath,
        headers: nextHeaders,
        body: nextBody,
      });
      setRequestVersion((value) => value + 1);
    } catch (error) {
      setRequestError(
        error instanceof Error ? error.message : "Unable to parse request headers.",
      );
    }
  }

  useEffect(() => {
    if (requestVersion === 0) {
      return;
    }

    const timeout = window.setTimeout(async () => {
      setBuildState("building");
      setRequestError(null);

      try {
        const response = await fetch(config.requestRoute, {
          cache: "no-store",
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            files,
            request: activeRequest,
            workspaceKey: workspaceRequestKey,
          }),
        });
        const payload = (await response.json()) as {
          success?: boolean;
          diagnostics?: BuildDiagnostic[];
          logs?: Array<Omit<RuntimeLogEntry, "source">>;
          response?: ExpressResponseView | null;
          error?: string;
        };

        if (!response.ok && !payload.response) {
          throw new Error(payload.error ?? "Unable to run the stateless Express preview.");
        }

        const nextResponse = payload.response ?? null;
        const isHtml =
          nextResponse?.contentType.toLowerCase().includes("text/html") ?? false;

        startTransition(() => {
          setResponseView(nextResponse);
          setPreviewHtml(isHtml ? nextResponse?.body ?? null : null);
          setBuildDiagnostics(payload.diagnostics ?? []);
          setRuntimeLogs(
            (payload.logs ?? []).map((entry) => ({
              ...entry,
              source: "runtime" as const,
            })),
          );
          setBuildState(payload.success ? "ready" : "error");
          setClientLogs([]);
          setResponseTab(isHtml ? "preview" : "body");
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to run the stateless Express preview.";

        setRequestError(message);
        setResponseView(null);
        setPreviewHtml(null);
        setRuntimeLogs([]);
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
    }, 450);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [activeRequest, config.requestRoute, files, requestVersion, workspaceRequestKey]);

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

      if (payload?.source !== config.htmlPreviewSource || !payload.message) {
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
  }, [config.htmlPreviewSource]);

  const outputEntries = useMemo(() => {
    const buildEntries = buildDiagnostics.map((entry) => ({
      ...entry,
      source: "build" as const,
    }));

    return [...buildEntries, ...runtimeLogs, ...clientLogs].sort((left, right) =>
      left.timestamp.localeCompare(right.timestamp),
    );
  }, [buildDiagnostics, clientLogs, runtimeLogs]);

  useEffect(() => {
    outputAnchorRef.current?.scrollIntoView({ block: "end" });
  }, [outputEntries]);

  const responseBody = maybeFormatResponseBody(responseView);
  const responseLabel = responseView
    ? `${responseView.status} ${responseView.contentType.split(";")[0]}`
    : "Waiting for response";
  const canHaveBody = requestMethod !== "GET";
  const prettyHeaders = responseView
    ? JSON.stringify(responseView.headers, null, 2)
    : null;

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-[#1e1e1e] text-[#cccccc]">
      <header className="flex h-10 items-center justify-between border-b border-[#2a2d2e] bg-[#181818] px-3 text-xs">
        <div className="flex min-w-0 items-center gap-3">
          <span className="font-semibold tracking-wide text-[#9cdcfe]">TUTO</span>
          <span className="text-[#858585]">{config.badge}</span>
          <span className="truncate text-[#cccccc]">
            {config.title}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[#858585]">
          <span className="rounded border border-[#3c3c3c] bg-[#252526] px-3 py-1 text-[#cccccc]">
            {config.dependencyLabel}
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
          <ActivityButton label="API" />
        </aside>

        <aside className="flex w-80 min-w-0 flex-col border-r border-[#2a2d2e] bg-[#252526]">
          <div className="border-b border-[#2a2d2e] px-4 py-3">
            <p className="text-[11px] uppercase tracking-[0.12em] text-[#858585]">
              Explorer
            </p>
            <p className="mt-2 text-sm text-[#cccccc]">
              {config.explorerCopy}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-px border-b border-[#2a2d2e] bg-[#2a2d2e] text-[11px]">
            <StatusCell label="Mode" value={config.modeValue} />
            <StatusCell label="Build" value={buildState} />
            <StatusCell label="Runtime" value={config.runtimeValue} />
            <StatusCell label="Dirty" value={String(dirtyFileCount)} />
          </div>

          <div className="border-b border-[#2a2d2e] px-3 py-3">
            <div className="mb-3 flex gap-2">
              <select
                className="w-28 rounded border border-[#3c3c3c] bg-[#1e1e1e] px-3 py-2 text-sm text-[#f5f5f5] outline-none"
                onChange={(event) => {
                  const nextMethod = event.target.value as HttpMethod;
                  setRequestMethod(nextMethod);
                  if (requestHeadersText === "{}" && nextMethod !== "GET") {
                    setRequestHeadersText(createDefaultHeadersText(nextMethod));
                  }
                  if (nextMethod === "GET") {
                    setRequestBodyText("");
                  }
                }}
                value={requestMethod}
              >
                {(["GET", "POST", "PUT", "PATCH", "DELETE"] as HttpMethod[]).map((method) => (
                  <option key={method} value={method}>
                    {method}
                  </option>
                ))}
              </select>
              <input
                className="min-w-0 flex-1 rounded border border-[#3c3c3c] bg-[#1e1e1e] px-3 py-2 text-sm text-[#f5f5f5] outline-none placeholder:text-[#6f6f6f]"
                onChange={(event) => setRequestPath(event.target.value)}
                placeholder={config.requestPathPlaceholder}
                spellCheck={false}
                type="text"
                value={requestPath}
              />
            </div>

            <button
              className="w-full rounded border border-[#007acc] bg-[#094771] px-3 py-2 text-sm text-white hover:bg-[#0d5f94]"
              onClick={handleSendRequest}
              type="button"
            >
              Send Request
            </button>
            <button
              className="mt-2 w-full rounded border border-[#3c3c3c] bg-[#252526] px-3 py-2 text-sm text-[#cccccc] hover:bg-[#2a2d2e] disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!isCurrentFileDirty}
              onClick={handleSave}
              type="button"
            >
              Save + Rerun
            </button>

            <div className="mt-3">
              <label className="block text-[11px] uppercase tracking-[0.12em] text-[#858585]">
                Headers JSON
              </label>
              <textarea
                className="mt-2 h-28 w-full resize-none rounded border border-[#3c3c3c] bg-[#1e1e1e] px-3 py-2 font-mono text-xs text-[#f5f5f5] outline-none placeholder:text-[#6f6f6f]"
                onChange={(event) => setRequestHeadersText(event.target.value)}
                placeholder='{"content-type":"application/json"}'
                spellCheck={false}
                value={requestHeadersText}
              />
            </div>

            <div className="mt-3">
              <label className="block text-[11px] uppercase tracking-[0.12em] text-[#858585]">
                Request Body
              </label>
              <textarea
                className="mt-2 h-28 w-full resize-none rounded border border-[#3c3c3c] bg-[#1e1e1e] px-3 py-2 font-mono text-xs text-[#f5f5f5] outline-none placeholder:text-[#6f6f6f] disabled:opacity-50"
                disabled={!canHaveBody}
                onChange={(event) => setRequestBodyText(event.target.value)}
                placeholder='{"message":"hello"}'
                spellCheck={false}
                value={requestBodyText}
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
            <div className="mb-2 px-2 text-[11px] uppercase tracking-[0.12em] text-[#858585]">
              Open Editors
            </div>
            <div className="mb-3 rounded border border-[#2a2d2e] bg-[#1e1e1e] px-2 py-1.5 text-sm text-[#cccccc]">
              {selectedFile?.path ?? "No file selected"}
              {isCurrentFileDirty ? " * unsaved" : ""}
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
              {config.responseHeading}
            </div>
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.2fr)_minmax(420px,0.95fr)]">
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
                  typeLibrariesUrl={config.typeLibrariesUrl}
                  value={currentValue}
                />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-[#858585]">
                  Loading editor...
                </div>
              )}
            </div>

            <div className="flex min-h-0 flex-col bg-[#1e1e1e]">
              <div className="flex h-9 items-center justify-between border-b border-[#2a2d2e] px-4 text-xs uppercase tracking-[0.12em] text-[#858585]">
                <span>
                  {activeRequest.method} {activeRequest.path}
                </span>
                <span>{responseLabel}</span>
              </div>
              <div className="flex h-9 items-center gap-1 border-b border-[#2a2d2e] px-3 text-xs">
                {(["preview", "body", "headers"] as ResponseTab[]).map((tab) => {
                  const disabled = tab === "preview" && !previewHtml;

                  return (
                    <button
                      key={tab}
                      className={
                        responseTab === tab
                          ? "rounded border border-[#007acc] bg-[#094771] px-3 py-1 text-white"
                          : "rounded border border-[#3c3c3c] bg-[#252526] px-3 py-1 text-[#969696] hover:text-white disabled:opacity-40"
                      }
                      disabled={disabled}
                      onClick={() => setResponseTab(tab)}
                      type="button"
                    >
                      {tab === "preview" && config.showPreviewAsStatic ? "preview (static)" : tab}
                    </button>
                  );
                })}
              </div>
              <div className="min-h-0 flex-1 bg-[#ffffff]">
                {responseTab === "preview" && previewHtml ? (
                  <iframe
                    className="h-full w-full border-0"
                    sandbox="allow-scripts"
                    srcDoc={previewHtml}
                    title={config.previewTitle}
                  />
                ) : responseTab === "headers" ? (
                  <pre className="h-full overflow-auto bg-[#111111] p-4 font-mono text-sm text-[#d4d4d4]">
                    {prettyHeaders ?? "No response headers yet."}
                  </pre>
                ) : responseBody ? (
                  <pre className="h-full overflow-auto bg-[#111111] p-4 font-mono text-sm text-[#d4d4d4]">
                    {responseBody}
                  </pre>
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-[#858585]">
                    {responseTab === "preview"
                      ? config.responseEmptyPreview
                      : config.responseEmptyBody}
                  </div>
                )}
              </div>
            </div>
          </div>

          <section className="h-56 border-t border-[#2a2d2e] bg-[#181818]">
            <div className="flex h-9 items-center justify-between border-b border-[#2a2d2e] px-4 text-xs uppercase tracking-[0.12em] text-[#858585]">
              <span>{config.outputHeading}</span>
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
                            : entry.source === "runtime"
                              ? "rounded bg-[#23462e] px-2 py-1 text-[#9ad6a4]"
                              : "rounded bg-[#2d2d30] px-2 py-1 text-[#c5c5c5]"
                        }
                      >
                        {entry.source}
                      </span>
                      <span
                        className={
                          (entry.source === "build" && entry.level === "error") ||
                          (entry.source === "runtime" && entry.level === "error") ||
                          (entry.source === "client" && entry.kind === "stderr")
                            ? "rounded bg-[#4b1f24] px-2 py-1 text-[#f48771]"
                            : (entry.source === "build" && entry.level === "warn") ||
                                (entry.source === "runtime" && entry.level === "warn")
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
                  Waiting for the first request...
                </p>
              )}
            </div>
          </section>
        </section>
      </div>

      <footer className="flex h-6 items-center justify-between bg-[#007acc] px-3 text-[11px] text-white">
        <div className="flex items-center gap-4">
          <span>{config.footerMode}</span>
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
        {dirty ? <span className="text-[#d7ba7d]">*</span> : null}
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
