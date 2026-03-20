import { NextResponse } from "next/server";
import { createSession, listTemplates } from "@/lib/ide/store";

export async function GET() {
  return NextResponse.json({
    templates: listTemplates(),
  });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    templateId?: string;
    runtimeMode?: "mock" | "secure-exec" | "host-vite";
  };

  const session = await createSession(body.templateId, body.runtimeMode);

  return NextResponse.json(session, { status: 201 });
}
