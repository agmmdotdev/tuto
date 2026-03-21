import { notFound } from "next/navigation";
import { ServerlessNextjsRuntimeWorkbench } from "@/components/serverless-nextjs-runtime-workbench";
import { getServerlessNextjsRuntimeTemplate } from "@/lib/ide/templates";

export default function ServerlessNextjsRuntimePage() {
  if (process.env.VERCEL === "1") {
    return (
      <main className="min-h-screen bg-[#1e1e1e] px-6 py-10 text-[#d4d4d4]">
        <section className="mx-auto max-w-3xl rounded-xl border border-[#313131] bg-[#252526] p-6">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.24em] text-[#9cdcfe]">
            Experimental Route Disabled
          </p>
          <h1 className="text-2xl font-semibold text-white">
            Real Next runtime is unavailable on Vercel
          </h1>
          <p className="mt-4 text-sm leading-6 text-[#c5c5c5]">
            This route boots a short-lived real Next process and requires a very
            large function bundle. On Vercel it exceeds the 250 MB unzipped
            Serverless Function limit, so this deployment serves only the lighter
            stateless playground routes.
          </p>
          <p className="mt-4 text-sm leading-6 text-[#c5c5c5]">
            Use <code>/serverless/nextjs</code> for the Next-style stateless
            playground on Vercel, or run this experimental route locally or on a
            self-hosted Node environment.
          </p>
        </section>
      </main>
    );
  }

  const template = getServerlessNextjsRuntimeTemplate();

  if (!template) {
    notFound();
  }

  return <ServerlessNextjsRuntimeWorkbench initialFiles={template.files} />;
}
