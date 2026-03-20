import { NextResponse } from "next/server";
import {
  getSessionTerminalSnapshot,
  resizeSessionTerminal,
  writeSessionTerminalInput,
} from "@/lib/ide/store";

interface RouteContext {
  params: Promise<{
    sessionId: string;
  }>;
}

export async function GET(request: Request, context: RouteContext) {
  const { sessionId } = await context.params;
  const { searchParams } = new URL(request.url);
  const cursorValue = Number(searchParams.get("cursor") ?? "0");
  const cursor = Number.isFinite(cursorValue) ? Math.max(0, cursorValue) : 0;

  try {
    const snapshot = await getSessionTerminalSnapshot(sessionId, cursor);

    return NextResponse.json(snapshot);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to load terminal.";
    const status = message === "Session not found." ? 404 : 400;

    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(request: Request, context: RouteContext) {
  const { sessionId } = await context.params;
  const body = (await request.json().catch(() => ({}))) as {
    action?: "write" | "resize";
    input?: string;
    columns?: number;
    rows?: number;
  };

  try {
    if (body.action === "resize") {
      await resizeSessionTerminal(
        sessionId,
        Number(body.columns ?? 0),
        Number(body.rows ?? 0),
      );
    } else {
      await writeSessionTerminalInput(sessionId, String(body.input ?? ""));
    }

    return new Response(null, { status: 204 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to update terminal.";
    const status = message === "Session not found." ? 404 : 400;

    return NextResponse.json({ error: message }, { status });
  }
}
