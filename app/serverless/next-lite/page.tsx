import { notFound } from "next/navigation";
import { ServerlessNextLiteWorkbench } from "@/components/serverless-next-lite-workbench";
import { getServerlessNextLiteTemplate } from "@/lib/ide/templates";

export default function ServerlessNextLitePage() {
  const template = getServerlessNextLiteTemplate();

  if (!template) {
    notFound();
  }

  return <ServerlessNextLiteWorkbench initialFiles={template.files} />;
}
