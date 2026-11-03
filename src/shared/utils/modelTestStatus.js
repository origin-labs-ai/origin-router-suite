// How a model-test verdict is displayed. Three verdicts, not two:
//   ok      → a provider actually answered this model
//   error   → a provider refused it (unknown model, bad key, no route)
//   timeout → nothing answered inside the probe window, which is a slow or busy
//             seat, not a broken one. Collapsing this into "error" would let one
//             check click delete a model that merely took its time.
export const MODEL_TEST_STATUS = {
  ok: {
    icon: "check_circle",
    color: "#22c55e",
    border: "border-green-500/40",
    label: "Working",
  },
  error: {
    icon: "cancel",
    color: "#ef4444",
    border: "border-red-500/40",
    label: "Broken",
  },
  timeout: {
    icon: "hourglass_top",
    color: "#f59e0b",
    border: "border-amber-500/40",
    label: "Timed out — recheck",
  },
  idle: {
    icon: "smart_toy",
    color: null,
    border: "border-border",
    label: "Not tested",
  },
};

/**
 * Turns the result of POST /api/models/test into a status plus one honest line of
 * detail. The detail is what the row shows on hover, so a green tick can also
 * say who really answered when that was not the model being looked at.
 */
export function describeModelTest(data, fallbackError = "Model not reachable") {
  const latency = Math.round(data?.latencyMs || 0);

  if (data?.ok) {
    return {
      status: "ok",
      detail: data.note
        ? `${data.note} · ${latency} ms`
        : `Answered in ${latency} ms`,
    };
  }
  if (data?.timedOut) {
    return { status: "timeout", detail: data.error || `No answer in ${latency} ms — recheck` };
  }
  return { status: "error", detail: data?.error || fallbackError };
}

export function modelTestStyle(status) {
  return MODEL_TEST_STATUS[status] || MODEL_TEST_STATUS.idle;
}
