/**
 * `originrouter patch` — apply a locally built bundle to the running gateway.
 *
 * The build comes from `npm run patch:local` in the repo, which registers the
 * bundle in `<DATA_DIR>/patch/source.json`. This command only triggers the swap,
 * so it is the "I already built it, patch it now" button for a terminal.
 *
 * The gateway restarts as part of the swap: if requests are in flight the server
 * answers 409 with the count, exactly like the update command, and nothing is
 * touched unless `--force` is passed.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_PORT = 20128;

const HELP = `
Usage: originrouter patch [options]

Apply the bundle registered by \`npm run patch:local\` to the running gateway.
The gateway restarts on the new build; in-flight requests block the patch unless
--force is passed.

  originrouter patch              # patch when the gateway is idle
  originrouter patch --status     # show the registered bundle and install targets
  originrouter patch --force      # patch even with requests in flight

Options:
  -p, --port <port>   Gateway port (default: ${DEFAULT_PORT})
  --status            Print state only; never patch
  --force             Ignore in-flight requests (they will be cut off)
  --target <id>       Target id: server, desktop, portable or custom
  --json              Machine-readable output
  -h, --help          Show this help
`;

function parseArgs(argv) {
  const opts = { port: DEFAULT_PORT, force: false, status: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return next;
    };
    switch (arg) {
      case "-p":
      case "--port":
        opts.port = Number(value()) || DEFAULT_PORT;
        break;
      case "--force":
        opts.force = true;
        break;
      case "--status":
        opts.status = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--target":
        opts.target = value();
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

function dataDir() {
  return process.env.ORIGINROUTER_DATA_DIR || process.env.DATA_DIR || path.join(os.homedir(), ".or");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readStatus() {
  return readJson(path.join(dataDir(), "patch", "status.json"));
}

async function request(port, options = {}) {
  // A bare AbortSignal.timeout keeps a libuv timer alive; process.exit() then
  // races the closing fetch handle and trips an assertion on Windows. A manual
  // controller that is always cleared, plus Connection: close, exits cleanly.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/version/patch`, {
      ...options,
      headers: { Connection: "close", ...(options.headers || {}) },
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    return { status: response.status, payload };
  } finally {
    clearTimeout(timer);
  }
}

function describeState(payload) {
  const source = payload.source;
  if (!source?.bundle) {
    console.log("No bundle registered yet.");
    console.log("Run `npm run patch:local -- --no-restart` in the repo to register one.");
    return;
  }
  console.log(`Bundle   ${source.bundle}`);
  console.log(`Version  ${source.version || "?"}  build ${source.buildId || "?"}  ${source.commit || ""}`.trimEnd());
  console.log(`Built    ${source.builtAt || "unknown"}   registered ${source.registeredAt || "?"}`);
  if (!payload.targets?.length) {
    console.log("Targets  none detected");
  } else {
    console.log("Targets");
    for (const target of payload.targets) {
      console.log(
        `  ${target.id.padEnd(8)} ${target.current ? "current" : "stale  "}  ${target.appDir}` +
          (target.installed?.patchedAt ? `  (last patched ${target.installed.patchedAt})` : ""),
      );
    }
  }
  if (payload.busy) console.log(`Activity ${payload.inFlight} request(s) in flight — patch will be refused without --force`);
  const status = payload.status || readStatus();
  if (status?.phase) {
    console.log(`Last run ${status.phase}${status.message ? ` — ${status.message}` : ""} (${status.at || "?"})`);
  }
}

async function waitForRestart(port, previousPid) {
  // The swap is done by a detached runner; this process only watches the status
  // file so the terminal shows "restarting" instead of looking like a crash.
  const deadline = Date.now() + 120000;
  let last = "";
  while (Date.now() < deadline) {
    const status = readStatus();
    if (status?.phase && status.phase !== last) {
      last = status.phase;
      console.log(`  ${status.phase}${status.message ? ` — ${status.message}` : ""}`);
    }
    if (status && ["healthy", "rolled-back", "failed"].includes(status.phase)) return status;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  return readStatus();
}

async function run(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(HELP.trim());
    return 0;
  }

  let state;
  try {
    state = await request(opts.port);
  } catch (error) {
    console.error(`Gateway is not reachable on port ${opts.port} (${error.message}).`);
    console.error("Start it with `originrouter`, then run this again.");
    return 1;
  }

  if (state.status === 403) {
    console.error(state.payload.message || "This can only run on the machine hosting the gateway.");
    return 1;
  }
  if (state.status !== 200) {
    console.error(state.payload.message || `Gateway answered ${state.status}`);
    return 1;
  }

  if (opts.json) console.log(JSON.stringify(state.payload, null, 2));
  else describeState(state.payload);

  if (opts.status) return 0;
  if (!state.payload.source?.bundle) return 1;

  if (state.payload.busy && !opts.force) {
    console.error("");
    console.error(`  ${state.payload.inFlight} request(s) are in flight.`);
    console.error("  The patch restarts the gateway — wait until the dashboard is idle,");
    console.error("  or pass --force to cut those requests off.");
    return 2;
  }

  const started = await request(opts.port, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ force: opts.force, targetId: opts.target }),
  });

  if (started.status === 409) {
    console.error(started.payload.message || "Gateway is busy; retry when idle or pass --force.");
    return 2;
  }
  if (started.status === 200 && started.payload.upToDate) {
    console.log(started.payload.message || "The install is already on the registered build.");
    return 0;
  }
  if (started.status !== 202) {
    console.error(started.payload.message || `Patch refused (${started.status})`);
    return 1;
  }

  console.log(started.payload.message || "Patch started.");
  const status = await waitForRestart(opts.port, started.payload.runnerPid);
  if (status?.phase === "healthy") {
    console.log("Done — the gateway is back on the new build.");
    return 0;
  }
  console.error(status?.message || "The patch did not report success; check the dashboard logs.");
  return 1;
}

module.exports = { run };
