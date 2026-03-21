import { notFound } from "next/navigation";
import { ServerlessExpressIdeWorkbench } from "@/components/serverless-express-ide-workbench";
import { getServerlessExpressTemplate } from "@/lib/ide/templates";

export default function ServerlessExpressPage() {
  const template = getServerlessExpressTemplate();

  if (!template) {
    notFound();
  }

  return <ServerlessExpressIdeWorkbench initialFiles={template.files} />;
}
