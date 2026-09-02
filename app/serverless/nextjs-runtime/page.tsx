import { notFound } from "next/navigation";
import { ServerlessNextjsRuntimeWorkbench } from "@/components/serverless-nextjs-runtime-workbench";
import { getServerlessNextjsRuntimeTemplate } from "@/lib/ide/templates";

export default function ServerlessNextjsRuntimePage() {
  if (
    process.env.VERCEL === "1" &&
    process.env.TUTO_NEXT_REQUEST_RUNTIME_ENABLED !== "1"
  ) {
    return (
      <main className="min-h-screen bg-[#1e1e1e] px-6 py-10 text-[#d4d4d4]">
        <section className="mx-auto max-w-3xl rounded-xl border border-[#313131] bg-[#252526] p-6">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.24em] text-[#9cdcfe]">
            Local compatibility checkpoint
          </p>
          <h1 className="text-2xl font-semibold text-white">
            Request-compiled Next RSC is production-gated
          </h1>
          <p className="mt-4 text-sm leading-6 text-[#c5c5c5]">
            The real Next SWC, Flight, SSR, and hydration path is implemented,
            but its bounded Node workers are not yet a hostile-code security
            sandbox. Keep this workbench local until it is connected to
            Tuto&apos;s production isolation and signed artifact boundary.
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
