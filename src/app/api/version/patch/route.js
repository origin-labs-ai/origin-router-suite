import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { isLocalRequest } from "@/dashboardGuard";
import { getActiveRequests } from "@/lib/db/repos/usageRepo.js";
import { detectTargets, planPatch } from "@/lib/localPatch/plan.mjs";
import {
  LOG_FILE,
  PATCH_EXIT_CODE,
  RUNNER_FILE,
  STATUS_FILE,
  ensurePatchDir,
  readPatchSource,
  readPatchStatus,
  writePatchStatus,
} from "@/lib/localPatch/state.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RUNNER_SOURCE_CANDIDATES = [
  () => path.join(process.cwd(), "src", "lib", "localPatch", "runner.cjs"),
  () => path.join(process.cwd(), "..", "src", "lib", "localPatch", "runner.cjs"),
];

async function activitySnapshot() {
  try {
    const { activeRequests = [] } = await getActiveRequests();
    const inFlight = activeRequests.reduce((total, entry) => total + (Number(entry.count) || 0), 0);
    return { activeRequests, inFlight };
  } catch {
    // Fail open: a usage store that cannot answer must not block a patch that
    // the user explicitly asked for.
    return { activeRequests: [], inFlight: 0 };
  }
}

function resolveRunnerSource() {
  for (const candidate of RUNNER_SOURCE_CANDIDATES) {
    try {
      const file = candidate();
      if (fs.existsSync(file)) return file;
    } catch {
      /* try the next layout */
    }
  }
  return "";
}

function pickTarget(targets, body) {
  if (!targets.length) return null;
  if (body?.target) {
    const wanted = path.resolve(body.target);
    const direct = targets.find((target) => path.resolve(target.appDir) === wanted || path.resolve(target.root) === wanted);
    if (direct) return direct;
  }
  if (body?.targetId) {
    const byId = targets.find((target) => target.id === body.targetId);
    if (byId) return byId;
  }
  // The gateway runs with cwd set to its own app folder (custom-server.js chdirs).
  const own = targets.find((target) => path.resolve(target.appDir) === path.resolve(process.cwd()));
  return own || targets[0];
}

function statusPayload() {
  const source = readPatchSource();
  const targets = detectTargets();
  const plan = planPatch({ targets, bundleDir: source?.bundle || "" });
  return {
    running: true,
    runningDir: process.cwd(),
    version: process.env.npm_package_version || "",
    source,
    targets: plan.targets,
    status: readPatchStatus(),
  };
}

// `/api/version` is a public prefix, and this route can stop and restart the
// gateway, so it refuses anything that did not come from this machine. A remote
// dashboard still sees the card, but gets `localOnly: true` and no target paths.
const REMOTE_PAYLOAD = {
  running: true,
  localOnly: true,
  busy: false,
  inFlight: 0,
  activeRequests: [],
  canPatch: false,
  message: "Local patches can only be applied from the machine running the gateway.",
};

export async function GET(request) {
  if (!isLocalRequest(request)) {
    return NextResponse.json(REMOTE_PAYLOAD, { status: 403 });
  }
  const { activeRequests, inFlight } = await activitySnapshot();
  const payload = statusPayload();
  return NextResponse.json({
    ...payload,
    localOnly: false,
    inFlight,
    busy: inFlight > 0,
    activeRequests,
    canPatch: Boolean(payload.source?.bundle),
  });
}

/**
 * Hand the swap to a detached runner, then exit with PATCH_EXIT_CODE.
 *
 * The swap cannot happen inside this process: on Windows the running bundle
 * holds its own files. The CLI supervisor restarts the gateway on a non-zero
 * exit, which is what makes the new build load without the user touching the
 * tray. If nothing supervises this process, the runner starts the gateway
 * itself once the port is free.
 */
export async function POST(request) {
  if (!isLocalRequest(request)) {
    return NextResponse.json(
      { success: false, message: "Local patches can only be applied from the machine running the gateway." },
      { status: 403 },
    );
  }
  const body = await request.json().catch(() => ({}));
  const { inFlight } = await activitySnapshot();
  if (inFlight > 0 && body?.force !== true) {
    return NextResponse.json(
      { success: false, busy: true, inFlight, message: `${inFlight} request(s) in flight; retry when idle or pass force` },
      { status: 409 },
    );
  }

  // Only the bundle registered from the repo/CLI is eligible. Accepting a path
  // from the request would let any local page point the copy at a folder it
  // controls.
  const source = readPatchSource();
  if (!source?.bundle) {
    return NextResponse.json(
      { success: false, message: "No patch source registered. Run `npm run patch:local` from the repo once." },
      { status: 400 },
    );
  }
  const bundleDir = path.resolve(source.bundle);
  if (!fs.existsSync(path.join(bundleDir, "server.js"))) {
    return NextResponse.json(
      { success: false, message: `${bundleDir} is not a built bundle (server.js missing)` },
      { status: 400 },
    );
  }

  const plan = planPatch({ targets: detectTargets({ explicitDir: body?.target }), bundleDir });
  const target = pickTarget(plan.targets, body);
  if (!target) {
    return NextResponse.json({ success: false, message: "No installed bundle found to patch" }, { status: 404 });
  }

  // Idempotent: asking twice must not restart the gateway for nothing. `force`
  // also means "re-apply even if the manifest matches".
  if (target.current && body?.force !== true) {
    return NextResponse.json({
      success: true,
      upToDate: true,
      message: `Already on build ${source.buildId || "(unknown)"}.`,
      target: target.id,
      appDir: target.appDir,
    });
  }

  const runnerSource = resolveRunnerSource();
  if (!runnerSource) {
    return NextResponse.json({ success: false, message: "Patch runner is missing from this build" }, { status: 500 });
  }

  ensurePatchDir();
  fs.copyFileSync(runnerSource, RUNNER_FILE);

  writePatchStatus({
    phase: "requested",
    ok: false,
    message: "handing the swap to the patch runner",
    target: target.id,
    appDir: target.appDir,
    sourceDir: bundleDir,
    inFlight,
    port: Number(process.env.PORT || 20128),
  });

  const runnerArgs = [
    RUNNER_FILE,
    "--app", target.appDir,
    "--source", bundleDir,
    "--port", String(process.env.PORT || 20128),
    "--parent", String(process.pid),
    "--status", STATUS_FILE,
    "--log", LOG_FILE,
    "--version", String(source.version || ""),
    "--build-id", String(source.buildId || ""),
    "--hash", String(source.hash || ""),
    "--commit", String(source.commit || ""),
    "--repo", String(source.repo || ""),
  ];
  const child = spawn(process.execPath, runnerArgs, {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    // Never inherit the gateway's cwd: it sits inside the bundle being replaced.
    cwd: path.dirname(STATUS_FILE),
    env: process.env,
  });
  child.unref();

  // Give the HTTP response a chance to flush before this process goes away.
  setTimeout(() => process.exit(PATCH_EXIT_CODE), 600);

  return NextResponse.json(
    {
      success: true,
      message: "Patch started. The gateway will restart on the new build.",
      target: target.id,
      appDir: target.appDir,
      runnerPid: child.pid,
    },
    { status: 202 },
  );
}
