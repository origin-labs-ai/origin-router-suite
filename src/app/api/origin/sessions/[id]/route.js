import { NextResponse } from "next/server";
import { getSession, listMessages, updateSession, deleteSession } from "@/lib/claudeStore";

export const dynamic = "force-dynamic";

export async function GET(_request, { params }) {
  const { id } = await params;
  const session = getSession(id);
  if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  return NextResponse.json({ session, messages: listMessages(id) });
}

export async function PATCH(request, { params }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const session = updateSession(id, body);
  if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  return NextResponse.json(session);
}

export async function DELETE(_request, { params }) {
  const { id } = await params;
  const ok = deleteSession(id);
  if (!ok) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
