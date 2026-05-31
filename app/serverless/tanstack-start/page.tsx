import { notFound } from "next/navigation";
import { ServerlessIdeWorkbench } from "@/components/serverless-ide-workbench";
import { getServerlessTanstackStartTemplate } from "@/lib/ide/templates";

export default function ServerlessTanstackStartPage() {
  const template = getServerlessTanstackStartTemplate();

  if (!template) {
    notFound();
  }

  return (
    <ServerlessIdeWorkbench
      initialFiles={template.files}
      mode="tanstackstart"
    />
  );
}
