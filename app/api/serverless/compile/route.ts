import { NextResponse } from "next/server";
import { compileServerlessWorkspace } from "@/lib/serverless-vite/compiler";
import { WorkspaceFile } from "@/lib/ide/types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      files?: WorkspaceFile[];
    };
    const result = await compileServerlessWorkspace(payload.files ?? []);

    return NextResponse.json(
      result,
      {
        headers: {
          "cache-control": "no-store",
        },
        status: result.success ? 200 : 422,
      },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to compile the stateless preview.";

    return NextResponse.json(
      { error: message },
      {
        headers: {
          "cache-control": "no-store",
        },
        status: 400,
      },
    );
  }
}
