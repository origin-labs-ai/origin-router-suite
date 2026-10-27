import { NextResponse } from "next/server";
import { getSession, listMessages, appendMessage, deleteMessage } from "@/lib/claudeStore";

export const dynamic = "force-dynamic";

export async function GET(_request, { params }) {
  const { id } = await params;
  if (!getSession(id)) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  return NextResponse.json({ messages: listMessages(id) });
}

export async function POST(request, { params }) {
  const { id } = await params;
  if (!getSession(id)) return NextResponse.json({ error: "Session not found" }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const role = body.role === "assistant" ? "assistant" : "user";
  const content = typeof body.content === "string" ? body.content : "";
  if (!content.trim()) return NextResponse.json({ error: "content is required" }, { status: 400 });

  const message = appendMessage(id, { role, content, meta: body.meta || {} });
  return NextResponse.json(message, { status: 201 });
}

export async function DELETE(request, { params }) {
  const { id } = await params;
  const messageId = new URL(request.url).searchParams.get("messageId");
  if (!messageId) return NextResponse.json({ error: "messageId is required" }, { status: 400 });
  const ok = deleteMessage(id, messageId);
  if (!ok) return NextResponse.json({ error: "Message not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
