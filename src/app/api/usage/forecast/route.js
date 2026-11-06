import { NextResponse } from "next/server";
import { getUsageHistory } from "@/lib/usageDb";
import { buildForecast } from "@/lib/usageForecast";

export const dynamic = "force-dynamic";

// What has this month cost so far, and where is it going.
export async function GET() {
  try {
    const history = await getUsageHistory();
    return NextResponse.json(buildForecast(history));
  } catch (error) {
    console.error("[API] Failed to build the cost forecast:", error);
    return NextResponse.json({ error: "Failed to build the cost forecast" }, { status: 500 });
  }
}
