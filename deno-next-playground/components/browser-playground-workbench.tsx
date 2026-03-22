"use client";

import type { CSSProperties } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

type PlaygroundFile = {
  path: string;
  label: string;
  language: string;
  content: string;
};

type ApiResult = {
  status: number;
  body: string;
  timestamp: string;
} | null;

type PreviewLog = {
  id: string;
  level: string;
  message: string;
  timestamp: string;
};

const storageKey = "tuto-deno-browser-playground-v1";
const previewSource = "tuto-deno-browser-preview-log";

const starterFiles: PlaygroundFile[] = [
  {
    path: "index.html",
    label: "index.html",
    language: "html",
    content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Deno Playground</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <main class="shell">
      <p class="eyebrow">Deno Deploy</p>
      <h1>Browser-only playground</h1>
      <p class="lede">
        Edit HTML, CSS, and JavaScript in the panel, then save to rebuild the
        preview.
      </p>
      <button id="action">Run interaction</button>
      <div id="output" class="output">Ready.</div>
    </main>
    <script src="./script.js"></script>
  </body>
</html>`,
  },
  {
    path: "styles.css",
    label: "styles.css",
    language: "css",
    content: `:root {
  color-scheme: dark;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  background:
    radial-gradient(circle at top, rgba(56, 189, 248, 0.28), transparent 35%),
    linear-gradient(180deg, #0f172a 0%, #020617 100%);
  color: #e2e8f0;
  font-family: "Segoe UI", sans-serif;
}

.shell {
  width: min(680px, calc(100vw - 32px));
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 24px;
  background: rgba(15, 23, 42, 0.82);
  backdrop-filter: blur(20px);
  padding: 32px;
  box-shadow: 0 24px 120px rgba(15, 23, 42, 0.45);
}

.eyebrow {
  margin: 0;
  font-size: 12px;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: #7dd3fc;
}

h1 {
  margin: 12px 0 0;
  font-size: 40px;
  line-height: 1.05;
}

.lede {
  margin: 16px 0 24px;
  color: #cbd5e1;
  line-height: 1.7;
}

button {
  border: 0;
  border-radius: 999px;
  background: #38bdf8;
  color: #082f49;
  font: inherit;
  font-weight: 700;
  padding: 12px 18px;
  cursor: pointer;
}

.output {
  margin-top: 20px;
  border-radius: 16px;
  border: 1px solid rgba(125, 211, 252, 0.18);
  background: rgba(15, 23, 42, 0.9);
  padding: 16px;
  min-height: 64px;
  color: #e2e8f0;
}`,
  },
  {
    path: "script.js",
    label: "script.js",
    language: "javascript",
    content: `const button = document.getElementById("action");
const output = document.getElementById("output");

button?.addEventListener("click", () => {
  const timestamp = new Date().toLocaleTimeString();
  if (output) {
    output.textContent = "Interaction ran at " + timestamp;
  }

  console.log("Button clicked at", timestamp);
});`,
  },
];

function createPreviewDocument(files: PlaygroundFile[]) {
  const html = files.find((file) => file.path === "index.html")?.content ?? "";
  const css = files.find((file) => file.path === "styles.css")?.content ?? "";
  const js = files.find((file) => file.path === "script.js")?.content ?? "";
  const bridge = `<script>
(() => {
  const previewSource = ${JSON.stringify(previewSource)};
  const send = (level, args) => {
    window.parent?.postMessage(
      {
        source: previewSource,
        level,
        message: args.map((value) => {
          if (value instanceof Error) return value.stack || value.message;
          if (typeof value === "string") return value;
          try { return JSON.stringify(value); } catch { return String(value); }
        }).join(" "),
        timestamp: new Date().toISOString(),
      },
      "*",
    );
  };
  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level];
    console[level] = (...args) => {
      send(level, args);
      return original.apply(console, args);
    };
  }
  window.addEventListener("error", (event) => {
    send("error", [event.message]);
  });
  window.addEventListener("unhandledrejection", (event) => {
    send("error", [event.reason]);
  });
})();
</script>`;

  const nextHtml = html
    .replace(/<link\b[^>]*href=["']\.\/styles\.css["'][^>]*>/i, `<style>${css}</style>`)
    .replace(/<script\b[^>]*src=["']\.\/script\.js["'][^>]*><\/script>/i, `<script>${js}<\/script>`);

  if (nextHtml.includes("</body>")) {
    return nextHtml.replace("</body>", `${bridge}</body>`);
  }

  return `${nextHtml}${bridge}`;
}

function cloneFiles(files: PlaygroundFile[]) {
  return files.map((file) => ({ ...file }));
}

export function BrowserPlaygroundWorkbench() {
  const [savedFiles, setSavedFiles] = useState<PlaygroundFile[]>(() => cloneFiles(starterFiles));
  const [draftFiles, setDraftFiles] = useState<PlaygroundFile[]>(() => cloneFiles(starterFiles));
  const [activePath, setActivePath] = useState("index.html");
  const [previewVersion, setPreviewVersion] = useState(0);
  const [logs, setLogs] = useState<PreviewLog[]>([]);
  const [apiResult, setApiResult] = useState<ApiResult>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isCallingApi, setIsCallingApi] = useState(false);
  const draftRef = useRef(draftFiles);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);

      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw) as {
        savedFiles?: PlaygroundFile[];
        draftFiles?: PlaygroundFile[];
        activePath?: string;
      };

      if (parsed.savedFiles?.length) {
        setSavedFiles(cloneFiles(parsed.savedFiles));
      }

      if (parsed.draftFiles?.length) {
        setDraftFiles(cloneFiles(parsed.draftFiles));
      }

      if (parsed.activePath) {
        setActivePath(parsed.activePath);
      }
    } catch {
      // Ignore invalid local state.
    }
  }, []);

  useEffect(() => {
    draftRef.current = draftFiles;
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        savedFiles,
        draftFiles,
        activePath,
      }),
    );
  }, [activePath, draftFiles, savedFiles]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as {
        source?: string;
        level?: string;
        message?: string;
        timestamp?: string;
      };

      if (data?.source !== previewSource || !data.message) {
        return;
      }

      setLogs((current) => {
        const message = data.message ?? "";
        const next = [
          ...current,
          {
            id: crypto.randomUUID(),
            level: data.level ?? "log",
            message,
            timestamp: data.timestamp ?? new Date().toISOString(),
          },
        ];

        return next.slice(-80);
      });
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        setIsSaving(true);
        setSavedFiles(cloneFiles(draftRef.current));
        setPreviewVersion((value) => value + 1);
        window.setTimeout(() => setIsSaving(false), 160);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const activeDraft = draftFiles.find((file) => file.path === activePath) ?? draftFiles[0];
  const unsavedPaths = useMemo(() => {
    return draftFiles
      .filter((file, index) => file.content !== savedFiles[index]?.content)
      .map((file) => file.path);
  }, [draftFiles, savedFiles]);

  const previewDocument = useMemo(
    () => createPreviewDocument(savedFiles),
    [previewVersion, savedFiles],
  );

  const saveFiles = () => {
    setIsSaving(true);
    setSavedFiles(cloneFiles(draftFiles));
    setPreviewVersion((value) => value + 1);
    window.setTimeout(() => setIsSaving(false), 160);
  };

  const resetFiles = () => {
    setDraftFiles(cloneFiles(starterFiles));
    setSavedFiles(cloneFiles(starterFiles));
    setLogs([]);
    setPreviewVersion((value) => value + 1);
  };

  const runApiTest = async () => {
    setIsCallingApi(true);

    try {
      const response = await fetch("/api/hello", {
        cache: "no-store",
      });
      const body = await response.text();

      setApiResult({
        status: response.status,
        body,
        timestamp: new Date().toISOString(),
      });
    } finally {
      setIsCallingApi(false);
    }
  };

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#111827",
        color: "#e5e7eb",
        display: "grid",
        gridTemplateRows: "56px 1fr 28px",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 18px",
          borderBottom: "1px solid #1f2937",
          background: "#0f172a",
        }}
      >
        <div>
          <strong style={{ display: "block", fontSize: 14 }}>Deno Browser Playground</strong>
          <span style={{ fontSize: 12, color: "#93c5fd" }}>
            Stateless save-and-preview workbench
          </span>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button
            type="button"
            onClick={runApiTest}
            style={buttonStyle("ghost")}
          >
            {isCallingApi ? "Testing API..." : "Test /api/hello"}
          </button>
          <button type="button" onClick={resetFiles} style={buttonStyle("ghost")}>
            Reset
          </button>
          <button type="button" onClick={saveFiles} style={buttonStyle("primary")}>
            {isSaving ? "Saved" : "Save + Refresh"}
          </button>
        </div>
      </header>

      <section
        style={{
          minHeight: 0,
          display: "grid",
          gridTemplateColumns: "220px minmax(0, 1fr) minmax(320px, 42%)",
        }}
      >
        <aside
          style={{
            borderRight: "1px solid #1f2937",
            background: "#111827",
            padding: "14px 10px",
          }}
        >
          <p
            style={{
              margin: "0 8px 12px",
              fontSize: 11,
              letterSpacing: "0.16em",
              textTransform: "uppercase",
              color: "#93c5fd",
            }}
          >
            Files
          </p>
          <div style={{ display: "grid", gap: 4 }}>
            {draftFiles.map((file) => {
              const isActive = file.path === activePath;
              const isDirty = unsavedPaths.includes(file.path);

              return (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => setActivePath(file.path)}
                  style={{
                    textAlign: "left",
                    padding: "10px 12px",
                    borderRadius: 10,
                    border: "1px solid transparent",
                    background: isActive ? "#1e293b" : "transparent",
                    color: isActive ? "#f8fafc" : "#cbd5e1",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span>{file.label}</span>
                    {isDirty ? (
                      <span style={{ color: "#38bdf8", fontSize: 11 }}>unsaved</span>
                    ) : null}
                  </div>
                  <div style={{ marginTop: 4, fontSize: 11, color: "#64748b" }}>
                    {file.language}
                  </div>
                </button>
              );
            })}
          </div>

          <div
            style={{
              marginTop: 18,
              borderRadius: 14,
              border: "1px solid #1f2937",
              background: "#0f172a",
              padding: 12,
              fontSize: 12,
              color: "#cbd5e1",
              lineHeight: 1.6,
            }}
          >
            Save is manual. The iframe preview only updates from the last saved
            snapshot, just like the heavier playgrounds in the main app.
          </div>
        </aside>

        <section
          style={{
            minWidth: 0,
            display: "grid",
            gridTemplateRows: "44px minmax(0, 1fr) 220px",
            borderRight: "1px solid #1f2937",
            background: "#0b1120",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              padding: "0 14px",
              borderBottom: "1px solid #1f2937",
              background: "#111827",
              fontSize: 13,
            }}
          >
            {activeDraft.label}
          </div>
          <textarea
            value={activeDraft.content}
            onChange={(event) => {
              setDraftFiles((current) =>
                current.map((file) =>
                  file.path === activeDraft.path
                    ? { ...file, content: event.target.value }
                    : file,
                ),
              );
            }}
            spellCheck={false}
            style={{
              width: "100%",
              height: "100%",
              resize: "none",
              border: 0,
              outline: "none",
              background: "#0b1120",
              color: "#e2e8f0",
              padding: 16,
              fontFamily: "Consolas, monospace",
              fontSize: 13,
              lineHeight: 1.6,
            }}
          />
          <section
            style={{
              borderTop: "1px solid #1f2937",
              background: "#0f172a",
              padding: 12,
              overflow: "auto",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 10,
              }}
            >
              <strong style={{ fontSize: 12 }}>Console</strong>
              <span style={{ fontSize: 11, color: "#64748b" }}>
                iframe logs and errors
              </span>
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {logs.length === 0 ? (
                <div style={emptyPanelStyle}>No preview logs yet.</div>
              ) : (
                logs.map((log) => (
                  <div
                    key={log.id}
                    style={{
                      borderRadius: 10,
                      border: "1px solid #1f2937",
                      background: "#111827",
                      padding: "10px 12px",
                      fontFamily: "Consolas, monospace",
                      fontSize: 12,
                      color: log.level === "error" ? "#fca5a5" : "#d1d5db",
                    }}
                  >
                    <div style={{ marginBottom: 6, color: "#64748b" }}>
                      [{log.level}] {new Date(log.timestamp).toLocaleTimeString()}
                    </div>
                    <div>{log.message}</div>
                  </div>
                ))
              )}
            </div>
          </section>
        </section>

        <section
          style={{
            minWidth: 0,
            display: "grid",
            gridTemplateRows: "44px minmax(0, 1fr) 220px",
            background: "#0f172a",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "0 14px",
              borderBottom: "1px solid #1f2937",
              background: "#111827",
            }}
          >
            <strong style={{ fontSize: 13 }}>Preview</strong>
            <span style={{ fontSize: 11, color: "#64748b" }}>
              Saved snapshot #{previewVersion + 1}
            </span>
          </div>
          <iframe
            key={previewVersion}
            title="Deno browser playground preview"
            srcDoc={previewDocument}
            sandbox="allow-scripts allow-same-origin"
            style={{
              width: "100%",
              height: "100%",
              border: 0,
              background: "white",
            }}
          />
          <section
            style={{
              borderTop: "1px solid #1f2937",
              background: "#0b1120",
              padding: 12,
              overflow: "auto",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 10,
              }}
            >
              <strong style={{ fontSize: 12 }}>API tester</strong>
              <span style={{ fontSize: 11, color: "#64748b" }}>
                Calls the Deno route handler
              </span>
            </div>
            {apiResult ? (
              <div
                style={{
                  borderRadius: 12,
                  border: "1px solid #1f2937",
                  background: "#111827",
                  padding: 12,
                  fontFamily: "Consolas, monospace",
                  fontSize: 12,
                  color: "#d1d5db",
                }}
              >
                <div style={{ marginBottom: 8, color: "#93c5fd" }}>
                  Status {apiResult.status} at{" "}
                  {new Date(apiResult.timestamp).toLocaleTimeString()}
                </div>
                <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{apiResult.body}</pre>
              </div>
            ) : (
              <div style={emptyPanelStyle}>
                Use <strong>Test /api/hello</strong> to hit the route handler from the
                Deno-targeted app.
              </div>
            )}
          </section>
        </section>
      </section>

      <footer
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 12px",
          borderTop: "1px solid #1f2937",
          background: "#0b1120",
          color: "#93c5fd",
          fontSize: 12,
        }}
      >
        <span>{unsavedPaths.length} unsaved file(s)</span>
        <span>Ctrl+S saves and refreshes preview</span>
      </footer>
    </main>
  );
}

function buttonStyle(mode: "primary" | "ghost") {
  return {
    border: mode === "primary" ? "0" : "1px solid #334155",
    borderRadius: 999,
    background: mode === "primary" ? "#38bdf8" : "transparent",
    color: mode === "primary" ? "#082f49" : "#e2e8f0",
    padding: "10px 14px",
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
  } satisfies CSSProperties;
}

const emptyPanelStyle = {
  borderRadius: 12,
  border: "1px dashed #334155",
  background: "#111827",
  padding: 12,
  fontSize: 12,
  color: "#94a3b8",
  lineHeight: 1.6,
} satisfies CSSProperties;
