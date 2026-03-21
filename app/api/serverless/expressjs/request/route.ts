import { NextResponse } from "next/server";
import { BuildDiagnostic, WorkspaceFile } from "@/lib/ide/types";
import {
  runServerlessExpressRequest,
  ServerlessExpressRequestInput,
} from "@/lib/serverless-express/compiler";

export const runtime = "nodejs";

const previewBridgeScript = `<script>
(() => {
  const previewSource = "tuto-serverless-express-preview-log";
  const toText = (value) => {
    if (value instanceof Error) {
      return value.stack || value.message;
    }
    if (typeof value === "string") {
      return value;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };
  const send = (level, args) => {
    window.parent?.postMessage(
      {
        source: previewSource,
        level,
        message: args.map(toText).join(" "),
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

function injectPreviewBridge(html: string) {
  if (html.includes("</body>")) {
    return html.replace("</body>", () => `${previewBridgeScript}</body>`);
  }

  return `${html}${previewBridgeScript}`;
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      files?: WorkspaceFile[];
      request?: Partial<ServerlessExpressRequestInput>;
    };
    const result = await runServerlessExpressRequest(
      payload.files ?? [],
      {
        method: payload.request?.method ?? "GET",
        path: payload.request?.path ?? "/",
        headers: payload.request?.headers ?? {},
        body: payload.request?.body ?? "",
      },
    );

    return NextResponse.json(
      {
        ...result,
        response:
          result.response &&
          result.response.contentType.toLowerCase().includes("text/html")
            ? {
                ...result.response,
                body: injectPreviewBridge(result.response.body),
              }
            : result.response,
      },
      {
        headers: {
          "cache-control": "no-store",
        },
        status: result.success ? 200 : 422,
      },
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unable to run the stateless Express preview.";
    const diagnostics: BuildDiagnostic[] = [
      {
        id: crypto.randomUUID(),
        level: "error",
        message,
        timestamp: new Date().toISOString(),
      },
    ];

    return NextResponse.json(
      {
        success: false,
        diagnostics,
        logs: [],
        response: null,
        error: message,
      },
      {
        headers: {
          "cache-control": "no-store",
        },
        status: 400,
      },
    );
  }
}
