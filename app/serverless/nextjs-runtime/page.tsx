import { notFound } from "next/navigation";
import { ServerlessNextjsRuntimeWorkbench } from "@/components/serverless-nextjs-runtime-workbench";
import { getServerlessNextjsRuntimeTemplate } from "@/lib/ide/templates";

export default function ServerlessNextjsRuntimePage() {
  const template = getServerlessNextjsRuntimeTemplate();

  if (!template) {
    notFound();
  }

  return <ServerlessNextjsRuntimeWorkbench initialFiles={template.files} />;
}
