import { fetchPreview } from "@/lib/ide/store";

interface RouteContext {
  params: Promise<{
    sessionId: string;
    previewPath?: string[];
  }>;
}

function toHeaderMap(headers: Headers) {
  return Object.fromEntries(headers.entries());
}

function buildPreviewBridgeScript(sessionId: string) {
  return `<script>
(() => {
  if (window.__tutoPreviewBridgeInstalled) {
    return;
  }

  window.__tutoPreviewBridgeInstalled = true;

  const sessionId = ${JSON.stringify(sessionId)};
  const postLog = (level, values) => {
    try {
      const message = values
        .map((value) => {
          if (value instanceof Error) {
            return value.stack || \`\${value.name}: \${value.message}\`;
          }

          if (typeof value === "string") {
            return value;
          }

          if (
            typeof value === "number" ||
            typeof value === "boolean" ||
            value === null ||
            value === undefined
          ) {
            return String(value);
          }

          try {
            return JSON.stringify(value);
          } catch {
            return String(value);
          }
        })
        .filter(Boolean)
        .join(" ");

      window.parent?.postMessage(
        {
          source: "tuto-preview-log",
          sessionId,
          level,
          message,
          timestamp: new Date().toISOString(),
        },
        window.location.origin,
      );
    } catch {
      // Swallow bridge failures so the preview keeps running.
    }
  };

  for (const method of ["log", "info", "warn", "error"]) {
    const original = console[method];

    console[method] = (...args) => {
      postLog(method, args);
      return original.apply(console, args);
    };
  }

  window.addEventListener("error", (event) => {
    const location = event.filename
      ? \`\${event.filename}:\${event.lineno}:\${event.colno}\`
      : "";

    postLog("error", [
      event.error ?? event.message ?? "Uncaught error",
      location,
    ]);
  });

  window.addEventListener("unhandledrejection", (event) => {
    postLog("error", [
      "Unhandled promise rejection",
      event.reason,
    ]);
  });
})();
</script>`;
}

function injectPreviewBridge(html: string, sessionId: string) {
  const bridgeScript = buildPreviewBridgeScript(sessionId);

  if (html.includes("window.__tutoPreviewBridgeInstalled")) {
    return html;
  }

  if (html.includes("</head>")) {
    return html.replace("</head>", `${bridgeScript}</head>`);
  }

  if (html.includes("</body>")) {
    return html.replace("</body>", `${bridgeScript}</body>`);
  }

  return `${bridgeScript}${html}`;
}

async function proxyRequest(request: Request, context: RouteContext) {
  const { sessionId, previewPath } = await context.params;
  const url = new URL(request.url);
  const preview = await fetchPreview(sessionId, {
    path: `/${previewPath?.join("/") ?? ""}`.replace(/\/+$/, "") || "/",
    search: url.search,
    method: request.method,
    headers: toHeaderMap(request.headers),
  });

  if (!preview) {
    return new Response("Preview not found.", { status: 404 });
  }

  const headers: Record<string, string> = {
    ...preview.headers,
    "cache-control": "no-store",
  };
  const contentType = headers["content-type"] ?? headers["Content-Type"] ?? "";
  const shouldInjectBridge =
    request.method === "GET" && contentType.includes("text/html");

  if (shouldInjectBridge) {
    delete headers["content-length"];
    delete headers["Content-Length"];
  }

  return new Response(
    shouldInjectBridge ? injectPreviewBridge(preview.body, sessionId) : preview.body,
    {
    status: preview.status,
      headers,
    },
  );
}

export async function GET(request: Request, context: RouteContext) {
  return proxyRequest(request, context);
}

export async function HEAD(request: Request, context: RouteContext) {
  return proxyRequest(request, context);
}
