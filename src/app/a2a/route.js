import { NextResponse } from "next/server";
import { buildAgentCard, sendMessage, getTask, cancelTask, taskStats, publicTask } from "@/lib/a2a/index.js";

// The A2A JSON-RPC endpoint (POST) and Agent Card (GET). Auth follows the
// dashboard guard like every other surface; non-dashboard callers use an
// OriginRouter API key.
export const dynamic = "force-dynamic";

function rpc(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcErr(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export async function GET() {
  return NextResponse.json(buildAgentCard({ baseUrl: "" }));
}

export async function POST(request) {
  let rpcBody = null;
  try {
    rpcBody = await request.json();
  } catch {
    return NextResponse.json(rpcErr(null, -32700, "parse error"), { status: 400 });
  }
  const { id, method, params } = rpcBody || {};
  try {
    if (method === "message/send") {
      const { task } = await sendMessage({ skill: params?.skill, input: params?.input });
      return NextResponse.json(rpc(id, { task }));
    }
    if (method === "tasks/get") {
      const task = getTask(params?.id);
      if (!task) return NextResponse.json(rpcErr(id, -32602, `unknown task: ${params?.id}`));
      return NextResponse.json(rpc(id, { task: publicTask(task) }));
    }
    if (method === "tasks/cancel") {
      const task = cancelTask(params?.id);
      if (!task) return NextResponse.json(rpcErr(id, -32602, `unknown task: ${params?.id}`));
      return NextResponse.json(rpc(id, { task: publicTask(task) }));
    }
    if (method === "tasks/stats") {
      return NextResponse.json(rpc(id, taskStats()));
    }
    return NextResponse.json(rpcErr(id, -32601, `unknown method: ${method}`));
  } catch (err) {
    return NextResponse.json(rpcErr(id, -32603, err?.message || String(err)));
  }
}
