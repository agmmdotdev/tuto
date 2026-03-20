import { NextResponse } from "next/server";
import { deleteSession, getSession, restartSession } from "@/lib/ide/store";

interface RouteContext {
  params: Promise<{
    sessionId: string;
  }>;
}

export async function GET(_request: Request, context: RouteContext) {
  const { sessionId } = await context.params;
  const session = await getSession(sessionId);

  if (!session) {
    return NextResponse.json({ error: "Session not found." }, { status: 404 });
  }

  return NextResponse.json(session);
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { sessionId } = await context.params;
  const deleted = await deleteSession(sessionId);

  if (!deleted) {
    return NextResponse.json({ error: "Session not found." }, { status: 404 });
  }

  return new Response(null, { status: 204 });
}

export async function POST(_request: Request, context: RouteContext) {
  const { sessionId } = await context.params;

  try {
    const session = await restartSession(sessionId);

    return NextResponse.json(session);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to restart session.";
    const status = message === "Session not found." ? 404 : 400;

    return NextResponse.json({ error: message }, { status });
  }
}
