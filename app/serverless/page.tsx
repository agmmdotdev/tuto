import { notFound } from "next/navigation";
import { ServerlessIdeWorkbench } from "@/components/serverless-ide-workbench";
import { getServerlessTemplate } from "@/lib/ide/templates";

export default function ServerlessPage() {
  const template = getServerlessTemplate();

  if (!template) {
    notFound();
  }

  return <ServerlessIdeWorkbench initialFiles={template.files} />;
}
