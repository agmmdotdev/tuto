import { NextResponse } from "next/server";
import { resolve } from "node:path";
import { collectInstalledTypeLibraries } from "@/lib/ide/type-libraries";

export const runtime = "nodejs";

const serverlessExpressTypePackages = [
  "express",
  "@types/express",
  "@types/node",
];

export async function GET() {
  try {
    const libraries = await collectInstalledTypeLibraries(
      resolve(process.cwd(), "node_modules"),
      serverlessExpressTypePackages,
    );

    return NextResponse.json(
      { libraries },
      {
        headers: {
          "cache-control": "no-store",
        },
      },
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unable to load stateless Express editor type libraries.";

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
