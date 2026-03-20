import { NextResponse } from "next/server";
import { getSessionTypeLibraries } from "@/lib/ide/store";

interface RouteContext {
  params: Promise<{
    sessionId: string;
  }>;
}

export async function GET(_request: Request, context: RouteContext) {
  const { sessionId } = await context.params;

  try {
    const libraries = await getSessionTypeLibraries(sessionId);

    return NextResponse.json({ libraries });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to load session types.";
    const status = message === "Session not found." ? 404 : 400;

    return NextResponse.json({ error: message }, { status });
  }
}
