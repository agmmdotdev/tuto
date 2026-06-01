"use client";

import { ServerlessExpressIdeWorkbench } from "@/components/serverless-express-ide-workbench";
import { WorkspaceFile } from "@/lib/ide/types";

export function ServerlessNextLiteWorkbench({
  initialFiles,
}: {
  initialFiles: WorkspaceFile[];
}) {
  return (
    <ServerlessExpressIdeWorkbench
      config={{
        storageKey: "tuto-serverless-next-lite-workspace-v1",
        defaultFilePath: "app/page.tsx",
        htmlPreviewSource: "tuto-serverless-next-lite-preview-log",
        title: "Next Lite",
        badge: "SSR SUBSET",
        dependencyLabel: "esbuild + vendored Vinext routing",
        explorerCopy:
          "This route compiles the saved App Router snapshot with the lightweight Next Lite compiler. It currently supports server-rendered page routes, a root layout, dynamic params, and search params without booting Vite or a real Next runtime.",
        modeValue: "serverless",
        runtimeValue: "next-lite",
        requestPathPlaceholder: "/posts/first-post?tab=notes",
        requestRoute: "/api/serverless/next-lite/request",
        typeLibrariesUrl: "/api/serverless/types",
        packageJsonSeed: "serverless-next-lite-root-types",
        sessionId: "serverless-next-lite",
        responseHeading: "SSR Response",
        responseEmptyPreview:
          "Send a request that returns HTML to inspect the static SSR preview.",
        responseEmptyBody: "Send a request to inspect the response.",
        outputHeading: "Build and render output",
        footerMode: "serverless-next-lite",
        footerHint: "Ctrl+S saves and reruns the active request",
        previewTitle: "Next Lite SSR preview",
        showPreviewAsStatic: true,
        defaultCompiler: "esbuild",
        compilerOptions: [{ value: "esbuild", label: "esbuild" }],
      }}
      initialFiles={initialFiles}
    />
  );
}
