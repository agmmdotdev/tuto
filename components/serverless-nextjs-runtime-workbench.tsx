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
  export function notFound(): never;
  export function redirect(path: string): never;
  export function permanentRedirect(path: string): never;
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
        storageKey: "tuto-serverless-nextjs-runtime-workspace-v3",
        defaultFilePath: "app/page.tsx",
        htmlPreviewSource: "tuto-serverless-nextjs-runtime-preview-log",
        title: "Request-compiled Next RSC Runtime",
        badge: "NEXT CORE",
        dependencyLabel: "Next SWC + React Flight",
        explorerCopy:
          "This checkpoint compiles with Next SWC, renders Flight, sends Server Actions through proxy.ts, dispatches Route Handlers, and connects Next cache APIs to a host adapter. Run the root action button or try GET /proxy-rewrite.",
        modeValue: "serverless",
        runtimeValue: "next-rsc",
        requestPathPlaceholder: "/lessons/rsc?mode=practice",
        requestRoute: "/api/serverless/nextjs-runtime/request",
        typeLibrariesUrl: "/api/serverless/types",
        extraTypeLibraries: nextTypeLibraries,
        packageJsonSeed: "serverless-next-runtime-root-types",
        sessionId: "serverless-nextjs-runtime",
        responseHeading: "RSC Response",
        responseEmptyPreview:
          "Send GET / or a nested route to compile, render, and hydrate the workspace.",
        responseEmptyBody: "Send a request to inspect the response.",
        outputHeading: "Artifact, compile, and runtime output",
        footerMode: "request-compiled-next",
        footerHint: "Ctrl+S saves and reruns the active request",
        previewTitle: "Hydrated Next RSC preview",
        showPreviewAsStatic: false,
        virtualNavigation: true,
        defaultCompiler: "esbuild",
        compilerOptions: [{ value: "esbuild", label: "Next SWC" }],
      }}
      initialFiles={initialFiles}
    />
  );
}
