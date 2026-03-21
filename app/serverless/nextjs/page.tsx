import { notFound } from "next/navigation";
import { ServerlessIdeWorkbench } from "@/components/serverless-ide-workbench";
import { getServerlessNextjsTemplate } from "@/lib/ide/templates";

export default function ServerlessNextjsPage() {
  const template = getServerlessNextjsTemplate();

  if (!template) {
    notFound();
  }

  return <ServerlessIdeWorkbench initialFiles={template.files} mode="nextjs" />;
}
