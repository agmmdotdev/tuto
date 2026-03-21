"use client";

import { ServerlessExpressIdeWorkbench } from "@/components/serverless-express-ide-workbench";
import { WorkspaceFile } from "@/lib/ide/types";

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

export function ServerlessNextjsRuntimeWorkbench({
  initialFiles,
}: {
  initialFiles: WorkspaceFile[];
}) {
  return (
    <ServerlessExpressIdeWorkbench
      config={{
        storageKey: "tuto-serverless-nextjs-runtime-workspace-v1",
        defaultFilePath: "app/page.tsx",
        htmlPreviewSource: "tuto-serverless-nextjs-runtime-preview-log",
        title: "Stateless Next Runtime",
        badge: "EXPERIMENTAL",
        dependencyLabel: "Short-lived real Next process",
        explorerCopy:
          "This route writes the saved snapshot into a temp workspace, boots a short-lived real Next runtime for one request, captures the HTML or API response, then tears the server down. The preview pane is a static SSR capture, not a live hydrated dev server.",
        modeValue: "serverless",
        runtimeValue: "next",
        requestPathPlaceholder: "/api/hello",
        requestRoute: "/api/serverless/nextjs-runtime/request",
        typeLibrariesUrl: "/api/serverless/types",
        extraTypeLibraries: nextTypeLibraries,
        packageJsonSeed: "serverless-next-runtime-root-types",
        sessionId: "serverless-nextjs-runtime",
        responseHeading: "Runtime Response",
        responseEmptyPreview:
          "Send a request that returns HTML to inspect the static SSR preview.",
        responseEmptyBody: "Send a request to inspect the response.",
        outputHeading: "Build and runtime output",
        footerMode: "serverless-next-runtime",
        footerHint: "Ctrl+S saves and reruns the active request",
        previewTitle: "Stateless Next runtime preview",
        showPreviewAsStatic: true,
      }}
      initialFiles={initialFiles}
    />
  );
}
