import { NextResponse } from "next/server";
import { getSettings, updateSettings, getApiKeys } from "@/lib/localDb";
import { keyLimitSnapshot, normalizeKeyLimits, resetKeyLimits } from "@/lib/keyRateLimit";

export const dynamic = "force-dynamic";

// GET - the budgets of every key and what they used so far.
export async function GET() {
  try {
    const settings = (await getSettings()) || {};
    const keys = await getApiKeys();
    const defaults = normalizeKeyLimits(settings.keyRateLimitDefaults);
    const perKey = settings.keyRateLimits || {};

    return NextResponse.json({
      defaults,
      keys: keys.map((key) => {
        const limits = Object.prototype.hasOwnProperty.call(perKey, key.id)
          ? normalizeKeyLimits(perKey[key.id])
          : defaults;
        return {
          id: key.id,
          name: key.name || key.id,
          maskedKey: `${String(key.key || "").slice(0, 7)}…`,
          isActive: key.isActive,
          inherited: !Object.prototype.hasOwnProperty.call(perKey, key.id),
          usage: keyLimitSnapshot(key.id, limits),
        };
      }),
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// PATCH - set the budget of one key, or the default every key inherits.
export async function PATCH(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const settings = (await getSettings()) || {};

    if (body?.defaults) {
      const defaults = normalizeKeyLimits(body.defaults);
      await updateSettings({ keyRateLimitDefaults: defaults });
      return NextResponse.json({ ok: true, defaults });
    }

    const keyId = String(body?.keyId || "");
    if (!keyId) {
      return NextResponse.json({ error: "A key is required" }, { status: 400 });
    }
    const limits = normalizeKeyLimits(body?.limits);
    await updateSettings({
      keyRateLimits: {
        ...(settings.keyRateLimits || {}),
        [keyId]: limits,
      },
    });
    return NextResponse.json({ ok: true, keyId, limits });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// DELETE - forget the counters of one key (or of every key).
export async function DELETE(request) {
  try {
    const url = new URL(request.url);
    const keyId = url.searchParams.get("keyId");
    resetKeyLimits(keyId || undefined);
    return NextResponse.json({ ok: true, keyId: keyId || null });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
