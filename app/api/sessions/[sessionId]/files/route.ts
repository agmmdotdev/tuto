import { NextResponse } from "next/server";
import { updateSessionFile } from "@/lib/ide/store";

interface RouteContext {
  params: Promise<{
    sessionId: string;
  }>;
}

export async function PUT(request: Request, context: RouteContext) {
  const { sessionId } = await context.params;
  const body = (await request.json().catch(() => null)) as
    | {
        path?: string;
        content?: string;
      }
    | null;

  if (!body?.path || typeof body.content !== "string") {
    return NextResponse.json(
      { error: "Expected a file path and string content." },
      { status: 400 },
    );
  }

  try {
    const session = await updateSessionFile(sessionId, body.path, body.content);

    return NextResponse.json(session);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to update file.";
    const status = message === "Session not found." ? 404 : 400;

    return NextResponse.json({ error: message }, { status });
  }
}
