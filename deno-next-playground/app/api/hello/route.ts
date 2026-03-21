import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    ok: true,
    runtime: "next-on-deno",
    timestamp: new Date().toISOString(),
  });
}
