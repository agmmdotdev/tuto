import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  return NextResponse.json({
    kind: "app-route-get",
    query: request.nextUrl.searchParams.get("query"),
  });
}
export async function POST(request: NextRequest) {
  const body = await request.json();
  return NextResponse.json({ kind: "app-route-post", body });
}
