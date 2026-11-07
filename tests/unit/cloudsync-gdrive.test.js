// Google Drive cloud sync — the parts that must be provably safe.
//
// Everything here is pure or behind a mocked fetch: the auth URL shape, the
// token encryption at rest, the credential redaction of the backup payload,
// the restore merge plan, and the Drive calls. No database is touched (the
// module imports its repos lazily, so importing it stays free of side effects).
import { describe, it, expect, beforeAll } from "vitest";

let gdrive;

beforeAll(async () => {
  // The encryption key is derived from env at call time — set it before the
  // first encrypt/decrypt so the tests exercise a known secret.
  process.env.API_KEY_SECRET = "test-secret-for-cloudsync";
  gdrive = await import("../../src/lib/cloudsync/googleDrive.js");
});

// The one host allow-list every fetch must pass through.
describe("endpoint guard", () => {
  it("accepts the pinned Google https endpoints", () => {
    expect(gdrive.assertGoogleEndpoint("https://oauth2.googleapis.com/token")).toBeTruthy();
    expect(gdrive.assertGoogleEndpoint("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart")).toBeTruthy();
    expect(gdrive.assertGoogleEndpoint("https://accounts.google.com/o/oauth2/v2/auth")).toBeTruthy();
  });

  it("refuses non-https and non-Google hosts", () => {
    expect(() => gdrive.assertGoogleEndpoint("http://oauth2.googleapis.com/token")).toThrow(/https/);
    expect(() => gdrive.assertGoogleEndpoint("https://evil.example.com/token")).toThrow(/host/);
    // The classic SSRF shapes the outbound policy forbids.
    expect(() => gdrive.assertGoogleEndpoint("http://localhost:20128/api")).toThrow(/https/);
    expect(() => gdrive.assertGoogleEndpoint("https://127.0.0.1/x")).toThrow(/host/);
    expect(() => gdrive.assertGoogleEndpoint("https://169.254.169.254/metadata")).toThrow(/host/);
    expect(() => gdrive.assertGoogleEndpoint("not a url at all")).toThrow();
  });
});

describe("buildAuthUrl", () => {
  const base = { clientId: "my-client.apps.googleusercontent.com", redirectUri: "http://localhost:20128/api/cloudsync/callback", state: "abc123" };

  it("points at the Google consent screen with the right client and redirect", () => {
    const url = new URL(gdrive.buildAuthUrl(base));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("my-client.apps.googleusercontent.com");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:20128/api/cloudsync/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("abc123");
  });

  it("asks for the drive.appdata scope plus openid and email", () => {
    const scope = new URL(gdrive.buildAuthUrl(base)).searchParams.get("scope");
    expect(scope).toContain("https://www.googleapis.com/auth/drive.appdata");
    expect(scope).toContain("openid");
    expect(scope).toContain("email");
  });

  it("requests offline access so Google grants a refresh token", () => {
    const params = new URL(gdrive.buildAuthUrl(base)).searchParams;
    expect(params.get("access_type")).toBe("offline");
    expect(params.get("prompt")).toBe("consent");
  });

  it("refuses a flow without a client id or with a non-http redirect", () => {
    expect(() => gdrive.buildAuthUrl({ ...base, clientId: "" })).toThrow(/client id/i);
    expect(() => gdrive.buildAuthUrl({ ...base, redirectUri: "javascript:alert(1)" })).toThrow(/http or https/);
    expect(() => gdrive.buildAuthUrl({ ...base, redirectUri: "not-a-url" })).toThrow();
  });
});

describe("token encryption", () => {
  it("round-trips the token pair", () => {
    const sealed = gdrive.encryptJson({ refreshToken: "1//refresh", accessToken: "ya29.access", expiresAt: 123456 });
    expect(gdrive.decryptJson(sealed)).toEqual({ refreshToken: "1//refresh", accessToken: "ya29.access", expiresAt: 123456 });
  });

  it("stores a sealed blob, never the plaintext", () => {
    const sealed = gdrive.encryptJson({ refreshToken: "1//super-secret-refresh-token-value", accessToken: "ya29-secret" });
    expect(typeof sealed).toBe("string");
    expect(sealed.startsWith("v1.")).toBe(true);
    // Neither the token values nor even the field names may leak through.
    expect(sealed).not.toContain("super-secret-refresh-token-value");
    expect(sealed).not.toContain("ya29-secret");
    expect(sealed).not.toContain("refreshToken");
  });

  it("returns null instead of throwing on tampered or garbage blobs", () => {
    const sealed = gdrive.encryptJson({ refreshToken: "1//refresh" });
    const parts = sealed.split(".");
    // Flip a byte of ciphertext: GCM's auth tag must refuse it.
    const ct = Buffer.from(parts[3], "base64url");
    ct[0] ^= 0xff;
    const tampered = ["v1", parts[1], parts[2], ct.toString("base64url")].join(".");
    expect(gdrive.decryptJson(tampered)).toBeNull();
    expect(gdrive.decryptJson("garbage")).toBeNull();
    expect(gdrive.decryptJson(null)).toBeNull();
    expect(gdrive.decryptJson("v1.deadbeef.deadbeef.deadbeef")).toBeNull();
  });
});

// A connection as it comes out of providerConnectionsRepo: the `data` column
// spread on top, credentials everywhere. The redacted payload may not contain
// a single credential field.
describe("backup payload redaction", () => {
  const connection = {
    id: "conn-1",
    provider: "deepseek",
    authType: "apikey",
    name: "Main key",
    email: null,
    priority: 1,
    isActive: true,
    // Credential fields live in the spread of the data column:
    apiKey: "sk-real-deepseek-key",
    accessToken: "ya29-should-not-travel",
    refreshToken: "1//should-not-travel",
    testStatus: "active",
    providerSpecificData: {
      apiKey: "sk-nested-key",
      baseUrl: "https://api.deepseek.com/v1",
      apiType: "chat",
      prefix: "oc-prod",
      idToken: "eyJhbGciOi.eyJlbWFpbC.evil",
    },
  };

  it("leaves no apiKey/accessToken/refreshToken/idToken field anywhere", () => {
    const redacted = gdrive.redactProviderConnection(connection);
    const text = JSON.stringify(redacted);
    // Field names gone…
    expect(text).not.toMatch(/"apiKey"/);
    expect(text).not.toMatch(/"accessToken"/);
    expect(text).not.toMatch(/"refreshToken"/);
    expect(text).not.toMatch(/"idToken"/);
    // …and values gone too.
    expect(text).not.toContain("sk-real-deepseek-key");
    expect(text).not.toContain("sk-nested-key");
    expect(text).not.toContain("ya29-should-not-travel");
    expect(text).not.toContain("1//should-not-travel");
  });

  it("marks the redacted spots and keeps the useful metadata", () => {
    const redacted = gdrive.redactProviderConnection(connection);
    expect(redacted.apiKeyRedacted).toBe("__redacted__");
    expect(redacted.providerSpecificData.apiKeyRedacted).toBe("__redacted__");
    expect(redacted.provider).toBe("deepseek");
    expect(redacted.name).toBe("Main key");
    expect(redacted.providerSpecificData.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(redacted.providerSpecificData.prefix).toBe("oc-prod");
    expect(redacted.testStatus).toBe("active");
  });

  it("never lets a look-alike field name sneak through (allow-list copy)", () => {
    const sneaky = { ...connection, somethingElse: { nestedSecretValue: "sk-xyz", note: "fine" } };
    const text = JSON.stringify(gdrive.redactProviderConnection(sneaky));
    expect(text).not.toContain("sk-xyz"); // not on the allow-list → dropped
    expect(text).not.toContain("fine");   // the whole stray branch is dropped
  });

  it("walks nested objects when redacting raw values, keeping benign fields", () => {
    const walked = gdrive.redactValue({ clientSecret: "sk-xyz", note: "fine", nested: { refresh_token: "1//x", keep: "me" } });
    expect(walked.clientSecretRedacted).toBe("__redacted__");
    expect(walked.note).toBe("fine");
    expect(walked.nested.refresh_tokenRedacted).toBe("__redacted__");
    expect(walked.nested.keep).toBe("me");
  });

  it("scrubs the settings slice: password and cloudsync dropped, secrets renamed", () => {
    const settings = {
      requireLogin: true,
      password: "bcrypt-hash-stays-home",
      cloudsync: { credentials: "v1.secret" },
      oidcClientSecret: "oidc-secret",
      routingPolicy: { maxAgentsConcurrency: 8 },
      mitmRouterBaseUrl: "http://localhost:20128",
    };
    const text = JSON.stringify(gdrive.redactSettings(settings));
    expect(text).not.toContain("bcrypt-hash-stays-home");
    expect(text).not.toContain("oidc-secret");
    expect(text).not.toContain("v1.secret");
    expect(text).toContain("oidcClientSecretRedacted");
    expect(text).toContain('"requireLogin":true');
    expect(text).toContain('"maxAgentsConcurrency":8');
  });

  it("does not redact benign look-alike fields", () => {
    expect(gdrive.isCredentialKey("apiKeyOptionalWith")).toBe(false);
    expect(gdrive.isCredentialKey("tokenType")).toBe(false);
    expect(gdrive.isCredentialKey("credentialForm")).toBe(false);
    expect(gdrive.isCredentialKey("credentialFallback")).toBe(false);
    expect(gdrive.isCredentialKey("apiKey")).toBe(true);
    expect(gdrive.isCredentialKey("refresh_token")).toBe(true);
    expect(gdrive.isCredentialKey("connectionProxyUrl")).toBe(true);
  });
});

// Restore is a merge: existing names stay, missing ones are created, and no
// credential-shaped part of the backup is ever written back.
describe("restore merge logic", () => {
  const backup = {
    version: 1,
    origin: "origin-router",
    exportedAt: "2026-01-01T00:00:00.000Z",
    settings: {
      requireLogin: true,
      exposeAllModels: true,
      password: "stays-home",
      cloudsync: { connected: true },
      oidcClientSecretRedacted: "__redacted__",
    },
    providerConnections: [{ id: "conn-1", provider: "deepseek", apiKeyRedacted: "__redacted__" }],
    combos: [
      { name: "Main", models: ["deepseek/deepseek-chat"], kind: null, maxContextWindow: null, displayName: null },
      { name: "Cheap", models: ["groq/llama-3.3-70b-versatile"], kind: null, maxContextWindow: 8192, displayName: "Cheap" },
    ],
    aliases: { "sonnet": "deepseek/deepseek-chat", "fast": "groq/llama-3.3-70b-versatile" },
  };

  const local = {
    combos: [{ name: "Main", models: ["openrouter/gpt-4o"] }],
    aliases: { "sonnet": "openrouter/gpt-4o" },
  };

  it("creates only the combos whose name is free", () => {
    const plan = gdrive.planRestore(backup, local);
    expect(plan.combosToCreate.map((c) => c.name)).toEqual(["Cheap"]);
    expect(plan.combosSkipped).toEqual([{ name: "Main", reason: "already exists" }]);
    // The planned combo keeps the shape createCombo expects.
    expect(plan.combosToCreate[0]).toEqual({
      name: "Cheap", models: ["groq/llama-3.3-70b-versatile"], kind: null, maxContextWindow: 8192, displayName: "Cheap",
    });
  });

  it("fills only aliases that have no local mapping", () => {
    const plan = gdrive.planRestore(backup, local);
    expect(plan.aliasesToSet).toEqual({ "fast": "groq/llama-3.3-70b-versatile" });
    expect(plan.aliasesSkipped).toBe(1); // "sonnet" stays local
  });

  it("plans a settings patch without credentials or placeholders", () => {
    const plan = gdrive.planRestore(backup, local);
    expect(plan.settingsPatch).toEqual({ requireLogin: true, exposeAllModels: true });
    expect(Object.keys(plan.settingsPatch)).not.toContain("password");
    expect(Object.keys(plan.settingsPatch)).not.toContain("cloudsync");
    expect(Object.keys(plan.settingsPatch)).not.toContain("oidcClientSecretRedacted");
  });

  it("counts redacted connections but never plans to restore them", () => {
    const plan = gdrive.planRestore(backup, local);
    expect(plan.connectionCount).toBe(1);
    expect(plan.connectionNote).toMatch(/redacted/i);
    expect(plan.combosToCreate).toHaveLength(1);
  });

  it("rejects a backup from a different origin or an empty payload", () => {
    const plan = gdrive.planRestore({ ...backup, origin: "other-router" }, local);
    expect(plan.errors).toHaveLength(1);
    expect(gdrive.planRestore(null, local).errors).toHaveLength(1);
    expect(gdrive.planRestore({}, local).errors).toHaveLength(1);
  });
});

// Network paths — every request goes through a recorded mock fetch. The
// assertions double as a tripwire: if a refactor points a call at a URL that
// is not the pinned Google endpoint, the mock record shows it.
describe("Drive API with mocked fetch", () => {
  function recordingFetch(responder) {
    const calls = [];
    const impl = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return responder(url, init);
    };
    impl.calls = calls;
    return impl;
  }

  it("exchanges the code at the pinned token endpoint with form-encoded body", async () => {
    const fetchMock = recordingFetch(() => Response.json({
      access_token: "ya29-new", refresh_token: "1//new-refresh", expires_in: 3600,
      id_token: `x.${Buffer.from(JSON.stringify({ email: "me@example.com" })).toString("base64url")}.y`,
    }));
    const tokens = await gdrive.exchangeCode(
      { clientId: "c", clientSecret: "s", code: "abc", redirectUri: "http://localhost:20128/api/cloudsync/callback" },
      fetchMock
    );
    const call = fetchMock.calls[0];
    expect(call.url).toBe("https://oauth2.googleapis.com/token");
    expect(call.init.method).toBe("POST");
    expect(call.init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(call.init.body).toContain("grant_type=authorization_code");
    expect(call.init.body).toContain("code=abc");
    expect(tokens.refreshToken).toBe("1//new-refresh");
    expect(tokens.email).toBe("me@example.com");
  });

  it("refreshes through the pinned endpoint and keeps the old token if Google does not rotate", async () => {
    const fetchMock = recordingFetch(() => Response.json({ access_token: "ya29-fresh", expires_in: 900 }));
    const result = await gdrive.refreshToken({ clientId: "c", clientSecret: "s", refreshToken: "1//old" }, fetchMock);
    expect(fetchMock.calls[0].url).toBe("https://oauth2.googleapis.com/token");
    expect(fetchMock.calls[0].init.body).toContain("grant_type=refresh_token");
    expect(fetchMock.calls[0].init.body).toContain("refresh_token=1%2F%2Fold");
    expect(result.refreshToken).toBe("1//old");
    expect(result.accessToken).toBe("ya29-fresh");
  });

  it("uploads a multipart backup into appDataFolder under the fixed name", async () => {
    const fetchMock = recordingFetch(() => Response.json({ id: "file-123", modifiedTime: "2026-01-01T00:00:00.000Z" }));
    const result = await gdrive.uploadBackup("ya29-token", { version: 1, combos: [] }, fetchMock);
    const call = fetchMock.calls[0];
    expect(call.url).toBe("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart");
    expect(call.init.headers.Authorization).toBe("Bearer ya29-token");
    expect(call.init.headers["Content-Type"]).toMatch(/^multipart\/related; boundary=/);
    expect(call.init.body).toContain('{"name":"origin-router-backup.json","parents":["appDataFolder"]');
    expect(call.init.body).toContain('"version":1');
    expect(result.fileId).toBe("file-123");
  });

  it("lists and downloads the newest backup from appDataFolder", async () => {
    const fetchMock = recordingFetch((url) => {
      if (String(url).includes("/drive/v3/files?spaces=appDataFolder")) {
        return Response.json({ files: [{ id: "newest", name: "origin-router-backup.json", modifiedTime: "2026-01-02T00:00:00.000Z" }] });
      }
      return Response.json({ version: 1, combos: [{ name: "Main" }] });
    });
    const files = await gdrive.listBackups("ya29-token", fetchMock);
    expect(files).toHaveLength(1);
    const backup = await gdrive.fetchNewestBackup("ya29-token", fetchMock);
    expect(backup.combos[0].name).toBe("Main");
    // calls: [list, list again inside fetchNewestBackup, download]
    const downloadCall = fetchMock.calls[2];
    expect(downloadCall.url).toBe("https://www.googleapis.com/drive/v3/files/newest?alt=media");
  });

  it("maps an appDataFolder refusal to the typed error", async () => {
    const fetchMock = recordingFetch(() => new Response(JSON.stringify({ error: { message: "insufficient permissions" } }), { status: 403 }));
    await expect(gdrive.listBackups("ya29-token", fetchMock)).rejects.toMatchObject({
      name: "DriveAccessError",
      code: "APPDATA_UNAVAILABLE",
    });
  });

  it("returns null when no backup exists yet", async () => {
    const fetchMock = recordingFetch(() => Response.json({ files: [] }));
    expect(await gdrive.fetchNewestBackup("ya29-token", fetchMock)).toBeNull();
  });
});
