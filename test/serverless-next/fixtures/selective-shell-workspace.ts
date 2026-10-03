import { selectivePrefetchWorkspace } from "./selective-prefetch-workspace";

export function selectiveShellWorkspace() {
  const files = selectivePrefetchWorkspace();
  for (const file of files)
    file.content = file.content.replace(
      /<Link (?![^>]*prefetch=)/g,
      "<Link prefetch={false} ",
    );
  const root = files.find((file) => file.path === "app/layout.tsx")!;
  root.content =
    'import {rootData} from "./shell-data";\n' +
    root.content
      .replace(
        "export default function Layout(",
        "export default async function Layout(",
      )
      .replace(
        '<Counter name="root" />',
        '<output data-cached-root>{await rootData()}</output><Counter name="root" />',
      );
  const handler = files.find(
    (file) => file.path === "app/api/revalidate/route.ts",
  )!;
  handler.content = handler.content.replace(
    'if(kind==="unrelated")',
    'if(kind==="root"){revalidateTag("shell-root",{expire:0});}\nelse if(kind==="loading"){revalidateTag("shell-loading",{expire:0});}\nelse if(kind==="layout-tag"){revalidateTag("preview-layout",{expire:0});}\nelse if(kind==="unrelated")',
  );
  const replacements: Record<string, string> = {
    "app/shell-data.ts": `import {cacheTag} from "next/cache";let rootReads=0,loadingReads=0;
export async function rootData(){"use cache";cacheTag("shell-root");return ++rootReads;}
export async function loadingData(){"use cache";await new Promise(resolve=>setTimeout(resolve,80));cacheTag("shell-loading");return ++loadingReads;}`,
    "app/start/loading.tsx": `export default function Loading(){return <p data-start-loading>start loading</p>;}`,
    "app/start/page.tsx": `export default async function Page(){await new Promise(resolve=>setTimeout(resolve,100));return <p>start</p>;}`,
    "app/dashboard/shared/loading.tsx": `import {loadingData} from "../../shell-data";export default async function Loading(){return <p data-cached-loading>loading:{await loadingData()}</p>;}`,
  };
  return [
    ...files.filter((file) => !Object.hasOwn(replacements, file.path)),
    ...Object.entries(replacements).map(([path, content]) => ({
      path,
      content,
      language: "tsx" as const,
    })),
  ];
}
