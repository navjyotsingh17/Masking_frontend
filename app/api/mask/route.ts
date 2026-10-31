import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;

// Server-side only: these are NOT exposed to the browser.
const MASKING_API_URL = process.env.MASKING_API_URL ?? "http://localhost:5000/mask";
const MASKING_API_PASSWORD = process.env.MASKING_API_PASSWORD ?? "";

export async function POST(req: NextRequest) {
  try {
    const rawBytes = await req.arrayBuffer();
    if (rawBytes.byteLength === 0) {
      return NextResponse.json({ error: "Empty request body" }, { status: 400 });
    }

    const filename = req.headers.get("x-filename") ?? "document";
    const mimetype = req.headers.get("x-mimetype") ?? "";

    const upstream = await fetch(MASKING_API_URL, {
      method: "POST",
      body: rawBytes,
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Filename": filename,
        "X-Password": MASKING_API_PASSWORD,
        "X-Mimetype": mimetype,
      },
    });

    const body = await upstream.arrayBuffer();

    return new NextResponse(body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream",
      },
    });
  } catch (err) {
    console.error("Masking proxy error:", err);
    return NextResponse.json(
      { error: "Could not reach the masking service" },
      { status: 502 }
    );
  }
}