import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../env";
import { getSettings, normalizeCfCookie, normalizeImageGenerationMethod } from "../settings";
import { validateApiKey } from "../repo/apiKeys";
import { dbFirst } from "../db";
import {
  selectBestToken,
  applyCooldown,
  recordTokenFailure,
} from "../repo/tokens";
import {
  generateImagineWs,
  resolveAspectRatio,
  sendExperimentalImageEditRequest,
} from "../grok/imagineExperimental";
import { getDynamicHeaders } from "../grok/headers";
import { uploadImage } from "../grok/upload";
import { createMediaPost, createPost } from "../grok/create";
import { sendConversationRequest } from "../grok/conversation";
import { listCacheRowsByType } from "../repo/cache";

export const publicRoutes = new Hono<{ Bindings: Env }>();

publicRoutes.use(
  "/*",
  cors({
    origin: "*",
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    maxAge: 86400,
  }),
);

// ---------------------------------------------------------------------------
// Auth helpers – public pages use api_key query param or Authorization header
// ---------------------------------------------------------------------------

async function verifyPublicAuth(c: any): Promise<boolean> {
  const settings = await getSettings(c.env);
  const globalKey = String(settings.grok.api_key ?? "").trim();

  // Check api_key query param first (used by WS and SSE connections)
  const queryKey = String(c.req.query("api_key") ?? c.req.query("public_key") ?? "").trim();
  // Then check Authorization header
  const authHeader = String(c.req.header("Authorization") ?? "").trim();
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const token = queryKey || bearerToken;

  if (token) {
    if (globalKey && token === globalKey) return true;
    const keyInfo = await validateApiKey(c.env.DB, token);
    return Boolean(keyInfo);
  }

  // If no global key and no API keys configured, allow anonymous access
  if (!globalKey) {
    const row = await dbFirst<{ c: number }>(
      c.env.DB,
      "SELECT COUNT(1) as c FROM api_keys WHERE is_active = 1",
    );
    return (row?.c ?? 0) === 0;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function base64UrlEncodeString(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function encodeAssetPath(raw: string): string {
  try {
    const u = new URL(raw);
    return `u_${base64UrlEncodeString(u.toString())}`;
  } catch {
    const p = raw.startsWith("/") ? raw : `/${raw}`;
    return `p_${base64UrlEncodeString(p)}`;
  }
}

function parseWsMessageData(data: unknown): Record<string, unknown> | null {
  let raw = "";
  if (typeof data === "string") raw = data;
  else if (data instanceof ArrayBuffer) raw = new TextDecoder().decode(data);
  else if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    raw = new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore parse errors
  }
  return null;
}

function wsSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseImagineWsFailureStatus(message: string): number {
  const matched = message.match(/Imagine websocket connect failed:\s*(\d{3})\b/i);
  if (matched) {
    const status = Number(matched[1]);
    if (Number.isFinite(status) && status >= 100 && status <= 599) return status;
  }
  return 500;
}

const ALLOWED_RATIOS = new Set(["16:9", "9:16", "1:1", "2:3", "3:2"]);

function normalizeImagineRatio(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "2:3";
  if (ALLOWED_RATIOS.has(raw)) return raw;
  const mapped = resolveAspectRatio(raw);
  return ALLOWED_RATIOS.has(mapped) ? mapped : "2:3";
}

// In-memory session store for SSE-based imagine/video tasks
const SESSIONS = new Map<string, Record<string, unknown>>();
const SESSION_TTL = 600_000; // 10 minutes

function cleanSessions(): void {
  const now = Date.now();
  for (const [key, info] of SESSIONS) {
    if (now - Number(info.created_at ?? 0) > SESSION_TTL) {
      SESSIONS.delete(key);
    }
  }
}

function newSession(data: Record<string, unknown>): string {
  cleanSessions();
  const id = crypto.randomUUID().replaceAll("-", "");
  SESSIONS.set(id, { ...data, created_at: Date.now() });
  return id;
}

function getSession(id: string): Record<string, unknown> | null {
  cleanSessions();
  return SESSIONS.get(id) ?? null;
}

function dropSession(id: string): void {
  SESSIONS.delete(id);
}

// Image-to-token binding (for edit chains using the same token that generated the image)
const IMAGE_TOKEN_MAP = new Map<string, { token: string; created_at: number }>();
const IMAGE_TOKEN_TTL = 7_200_000; // 2 hours

function cleanImageTokens(): void {
  const now = Date.now();
  for (const [key, info] of IMAGE_TOKEN_MAP) {
    if (now - info.created_at > IMAGE_TOKEN_TTL) {
      IMAGE_TOKEN_MAP.delete(key);
    }
  }
}

function bindImageToken(parentPostId: string, token: string): void {
  if (!parentPostId || !token) return;
  cleanImageTokens();
  IMAGE_TOKEN_MAP.set(parentPostId, { token, created_at: Date.now() });
}

function getBoundImageToken(parentPostId: string): string | null {
  if (!parentPostId) return null;
  cleanImageTokens();
  const info = IMAGE_TOKEN_MAP.get(parentPostId);
  return info?.token ?? null;
}

function extractParentPostIdFromUrl(url: string): string {
  const text = String(url || "").trim();
  if (!text) return "";
  if (/^[0-9a-fA-F-]{32,36}$/.test(text)) return text;
  for (const pattern of [
    /\/generated\/([0-9a-fA-F-]{32,36})(?:\/|$)/,
    /\/imagine-public\/images\/([0-9a-fA-F-]{32,36})(?:\.jpg|\/|$)/,
    /\/images\/([0-9a-fA-F-]{32,36})(?:\.jpg|\/|$)/,
  ]) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  const matches = text.match(/[0-9a-fA-F-]{32,36}/g);
  return matches ? matches[matches.length - 1]! : "";
}

function extractParentPostIdFromPayload(payload: Record<string, unknown>): string {
  const candidates = [
    payload.parent_post_id,
    payload.parentPostId,
    payload.image_id,
    payload.imageId,
    payload.url,
    payload.image,
  ];
  for (const value of candidates) {
    const id = extractParentPostIdFromUrl(String(value ?? ""));
    if (id) return id;
  }
  return "";
}

// ---------------------------------------------------------------------------
// GET /v1/public/imagine/config
// ---------------------------------------------------------------------------

publicRoutes.get("/imagine/config", async (c) => {
  const settings = await getSettings(c.env);
  return c.json({
    final_min_bytes: 0,
    nsfw: false,
    image_generation_method: normalizeImageGenerationMethod(
      settings.grok.image_generation_method,
    ),
    max_retry: 3,
  });
});

// ---------------------------------------------------------------------------
// POST /v1/public/imagine/start – create session for SSE-mode imagine
// ---------------------------------------------------------------------------

publicRoutes.post("/imagine/start", async (c) => {
  const authed = await verifyPublicAuth(c);
  if (!authed) return c.json({ error: "Unauthorized" }, 401);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const prompt = String(body.prompt ?? "").trim();
  const nsfw = body.nsfw === true || body.nsfw === "true" ? true : null;
  const aspectRatio = normalizeImagineRatio(body.aspect_ratio ?? body.size);
  const concurrent = Math.max(1, Math.min(4, Math.floor(Number(body.concurrent ?? 1) || 1)));

  if (!prompt) return c.json({ error: "Prompt cannot be empty" }, 400);

  const taskIds: string[] = [];
  for (let i = 0; i < concurrent; i++) {
    taskIds.push(newSession({ type: "imagine", prompt, aspect_ratio: aspectRatio, nsfw }));
  }

  return c.json({
    task_id: taskIds[0],
    task_ids: taskIds,
    concurrent,
    aspect_ratio: aspectRatio,
  });
});

// ---------------------------------------------------------------------------
// GET /v1/public/imagine/sse – SSE stream for imagine generation
// ---------------------------------------------------------------------------

publicRoutes.get("/imagine/sse", async (c) => {
  const taskId = String(c.req.query("task_id") ?? "").trim();
  const session = getSession(taskId);
  if (!session) return c.json({ error: "Task not found" }, 404);

  const prompt = String(session.prompt ?? "").trim();
  const aspectRatio = String(session.aspect_ratio ?? "2:3");
  const nsfw = session.nsfw === true ? true : undefined;

  const settings = await getSettings(c.env);
  const cf = normalizeCfCookie(settings.grok.cf_clearance ?? "");

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: string, data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
        const chosen = await selectBestToken(c.env.DB, "grok-imagine-1.0");
        if (!chosen) {
          emit("error", { error: "No available tokens", code: "rate_limit_exceeded" });
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }

        const cookie = cf
          ? `sso-rw=${chosen.token};sso=${chosen.token};${cf}`
          : `sso-rw=${chosen.token};sso=${chosen.token}`;

        emit("status", { status: "running", prompt, aspect_ratio: aspectRatio });

        const urls = await generateImagineWs({
          prompt,
          n: 4,
          cookie,
          settings: settings.grok,
          aspectRatio,
          progressCb: (p) => {
            emit("progress", { index: p.index, progress: p.progress });
          },
          completedCb: (completed) => {
            const encoded = encodeAssetPath(completed.url);
            const proxyUrl = `/images/${encodeURIComponent(encoded)}`;
            const parentId = extractParentPostIdFromUrl(completed.url);
            if (parentId) bindImageToken(parentId, chosen.token);
            emit("image", {
              url: proxyUrl,
              source_url: completed.url,
              index: completed.index,
              parent_post_id: parentId,
            });
          },
        });

        emit("status", { status: "completed", count: urls.length });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        emit("error", { error: message, code: "internal_error" });
      } finally {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
        dropSession(taskId);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
});

// ---------------------------------------------------------------------------
// GET /v1/public/imagine/ws – WebSocket waterfall (reuses admin logic)
// ---------------------------------------------------------------------------

publicRoutes.get("/imagine/ws", async (c) => {
  const upgrade = c.req.header("upgrade") ?? c.req.header("Upgrade");
  if (String(upgrade ?? "").toLowerCase() !== "websocket") {
    return c.text("Expected websocket upgrade", 426);
  }

  const wsPair = new WebSocketPair();
  const client = wsPair[0];
  const server = wsPair[1];
  server.accept();

  const authed = await verifyPublicAuth(c);
  if (!authed) {
    try {
      server.close(1008, "Auth failed");
    } catch {
      // ignore close failure
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  const settings = await getSettings(c.env);
  const cf = normalizeCfCookie(settings.grok.cf_clearance ?? "");

  let socketClosed = false;
  let runToken = 0;
  let currentRunId = "";
  let sequence = 0;
  let running = false;

  const send = (payload: Record<string, unknown>): boolean => {
    if (socketClosed) return false;
    try {
      server.send(JSON.stringify(payload));
      return true;
    } catch {
      socketClosed = true;
      return false;
    }
  };

  const stopRun = (sendStatus: boolean): void => {
    if (!running) return;
    running = false;
    runToken += 1;
    if (sendStatus && currentRunId) {
      send({ type: "status", status: "stopped", run_id: currentRunId });
    }
  };

  const startRun = (prompt: string, aspectRatio: string, nsfw?: boolean): void => {
    runToken += 1;
    const localToken = runToken;
    running = true;
    currentRunId = crypto.randomUUID().replaceAll("-", "");
    const runId = currentRunId;
    sequence = 0;

    send({
      type: "status",
      status: "running",
      prompt,
      aspect_ratio: aspectRatio,
      run_id: runId,
    });

    void (async () => {
      while (!socketClosed && localToken === runToken) {
        let chosen: { token: string; token_type: "sso" | "ssoSuper" } | null = null;
        try {
          chosen = await selectBestToken(c.env.DB, "grok-imagine-1.0");
          if (!chosen) {
            send({
              type: "error",
              message: "No available tokens. Please try again later.",
              code: "rate_limit_exceeded",
            });
            await wsSleep(2000);
            continue;
          }

          const cookie = cf
            ? `sso-rw=${chosen.token};sso=${chosen.token};${cf}`
            : `sso-rw=${chosen.token};sso=${chosen.token}`;
          const startAt = Date.now();
          const urls = await generateImagineWs({
            prompt,
            n: 6,
            cookie,
            settings: settings.grok,
            aspectRatio,
          });
          if (socketClosed || localToken !== runToken) break;

          const elapsedMs = Date.now() - startAt;
          let sentAny = false;
          for (const rawUrl of urls) {
            const raw = String(rawUrl ?? "").trim();
            if (!raw) continue;
            sentAny = true;
            sequence += 1;
            const encoded = encodeAssetPath(raw);
            const url = `/images/${encodeURIComponent(encoded)}`;
            const parentId = extractParentPostIdFromUrl(raw);
            if (parentId && chosen) bindImageToken(parentId, chosen.token);
            const ok = send({
              type: "image",
              url,
              source_url: raw,
              parent_post_id: parentId,
              sequence,
              created_at: Date.now(),
              elapsed_ms: elapsedMs,
              aspect_ratio: aspectRatio,
              run_id: runId,
            });
            if (!ok) {
              socketClosed = true;
              break;
            }
          }

          if (!sentAny) {
            send({
              type: "error",
              message: "Image generation returned empty data.",
              code: "empty_image",
            });
          }
        } catch (e) {
          if (socketClosed || localToken !== runToken) break;
          const message = e instanceof Error ? e.message : String(e);
          if (chosen?.token) {
            const status = parseImagineWsFailureStatus(message);
            const trimmed = message.slice(0, 200);
            try {
              await recordTokenFailure(c.env.DB, chosen.token, status, trimmed);
              await applyCooldown(c.env.DB, chosen.token, status);
            } catch {
              // ignore token cooldown failures
            }
          }
          send({
            type: "error",
            message: message || "Internal error",
            code: "internal_error",
          });
          await wsSleep(1500);
        }
      }

      if (!socketClosed && localToken === runToken) {
        running = false;
        send({ type: "status", status: "stopped", run_id: runId });
      }
    })();
  };

  server.addEventListener("message", (event) => {
    const payload = parseWsMessageData(event.data);
    if (!payload) {
      send({
        type: "error",
        message: "Invalid message format.",
        code: "invalid_payload",
      });
      return;
    }

    const msgType = String(payload.type ?? "").trim();
    if (msgType === "start") {
      const prompt = String(payload.prompt ?? "").trim();
      if (!prompt) {
        send({
          type: "error",
          message: "Prompt cannot be empty.",
          code: "empty_prompt",
        });
        return;
      }
      const ratio = resolveAspectRatio(String(payload.aspect_ratio ?? "2:3").trim());
      const nsfw = payload.nsfw === true;
      stopRun(false);
      startRun(prompt, ratio, nsfw);
      return;
    }

    if (msgType === "stop") {
      stopRun(true);
      return;
    }

    if (msgType === "ping") {
      send({ type: "pong" });
      return;
    }

    send({
      type: "error",
      message: "Unknown command.",
      code: "unknown_command",
    });
  });

  server.addEventListener("close", () => {
    socketClosed = true;
    runToken += 1;
    running = false;
  });
  server.addEventListener("error", () => {
    socketClosed = true;
    runToken += 1;
    running = false;
  });

  return new Response(null, { status: 101, webSocket: client });
});

// ---------------------------------------------------------------------------
// POST /v1/public/imagine/edit – edit image with prompt (parentPostId chain)
// ---------------------------------------------------------------------------

publicRoutes.post("/imagine/edit", async (c) => {
  const authed = await verifyPublicAuth(c);
  if (!authed) return c.json({ error: "Unauthorized" }, 401);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const prompt = String(body.prompt ?? "").trim();
  const parentPostId = String(body.parent_post_id ?? body.parentPostId ?? "").trim();
  const imageUrl = String(body.image_url ?? body.imageUrl ?? "").trim();
  const aspectRatio = normalizeImagineRatio(body.aspect_ratio ?? body.size);

  if (!prompt) return c.json({ error: "Prompt cannot be empty" }, 400);
  if (!parentPostId && !imageUrl) {
    return c.json({ error: "parent_post_id or image_url is required" }, 400);
  }

  const settings = await getSettings(c.env);
  const cf = normalizeCfCookie(settings.grok.cf_clearance ?? "");

  // Try to use bound token first, fall back to best available
  let chosenToken: string | null = null;
  if (parentPostId) {
    chosenToken = getBoundImageToken(parentPostId);
  }

  if (!chosenToken) {
    const chosen = await selectBestToken(c.env.DB, "grok-imagine-1.0");
    if (!chosen) return c.json({ error: "No available tokens" }, 503);
    chosenToken = chosen.token;
  }

  const cookie = cf
    ? `sso-rw=${chosenToken};sso=${chosenToken};${cf}`
    : `sso-rw=${chosenToken};sso=${chosenToken}`;

  // Build source image URL for the edit
  let sourceImageUrl = imageUrl;
  if (!sourceImageUrl && parentPostId) {
    sourceImageUrl = `https://imagine-public.x.ai/imagine-public/images/${parentPostId}.jpg`;
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: string, data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
        emit("status", { status: "running", prompt });

        // Use experimental image edit API
        const upstream = await sendExperimentalImageEditRequest({
          prompt,
          fileUris: [sourceImageUrl],
          cookie,
          settings: settings.grok,
        });

        const text = await upstream.text();
        const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

        for (const line of lines) {
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }

          const resp = (data.result as Record<string, unknown>)?.response as Record<string, unknown> | undefined;
          if (!resp) continue;

          const modelResponse = resp.modelResponse as Record<string, unknown> | undefined;
          const generatedImageUrls = modelResponse?.generatedImageUrls as string[] | undefined;
          if (generatedImageUrls?.length) {
            for (const rawUrl of generatedImageUrls) {
              const encoded = encodeAssetPath(rawUrl);
              const proxyUrl = `/images/${encodeURIComponent(encoded)}`;
              const newParentId = extractParentPostIdFromUrl(rawUrl);
              if (newParentId && chosenToken) bindImageToken(newParentId, chosenToken);
              emit("image", {
                url: proxyUrl,
                source_url: rawUrl,
                parent_post_id: newParentId,
              });
            }
          }
        }

        emit("status", { status: "completed" });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        emit("error", { error: message, code: "edit_failed" });
      } finally {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
});

// ---------------------------------------------------------------------------
// POST /v1/public/imagine/stop – stop imagine tasks
// ---------------------------------------------------------------------------

publicRoutes.post("/imagine/stop", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const taskIds = body.task_ids as string[] | undefined;
  let removed = 0;
  if (Array.isArray(taskIds)) {
    for (const id of taskIds) {
      if (typeof id === "string" && SESSIONS.has(id)) {
        dropSession(id);
        removed += 1;
      }
    }
  }
  return c.json({ removed });
});

// ---------------------------------------------------------------------------
// POST /v1/public/imagine/workbench/edit – workbench image editing
// ---------------------------------------------------------------------------

publicRoutes.post("/imagine/workbench/edit", async (c) => {
  const authed = await verifyPublicAuth(c);
  if (!authed) return c.json({ error: "Unauthorized" }, 401);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const prompt = String(body.prompt ?? "").trim();
  const imageBase64 = String(body.image_base64 ?? body.imageBase64 ?? "").trim();
  const imageUrl = String(body.image_url ?? body.imageUrl ?? "").trim();
  const parentPostId = String(body.parent_post_id ?? body.parentPostId ?? "").trim();
  const imageReferences = body.image_references as string[] | undefined;

  if (!prompt) return c.json({ error: "Prompt cannot be empty" }, 400);

  const settings = await getSettings(c.env);
  const cf = normalizeCfCookie(settings.grok.cf_clearance ?? "");

  // Try bound token first
  let chosenToken: string | null = null;
  if (parentPostId) {
    chosenToken = getBoundImageToken(parentPostId);
  }
  if (!chosenToken) {
    const chosen = await selectBestToken(c.env.DB, "grok-imagine-1.0");
    if (!chosen) return c.json({ error: "No available tokens" }, 503);
    chosenToken = chosen.token;
  }

  const cookie = cf
    ? `sso-rw=${chosenToken};sso=${chosenToken};${cf}`
    : `sso-rw=${chosenToken};sso=${chosenToken}`;

  // Collect image references for the edit
  const fileUris: string[] = [];
  if (Array.isArray(imageReferences)) {
    for (const ref of imageReferences) {
      const r = String(ref ?? "").trim();
      if (r) fileUris.push(r);
    }
  }
  if (!fileUris.length) {
    if (imageUrl) {
      fileUris.push(imageUrl);
    } else if (imageBase64) {
      // Upload the base64 image first
      try {
        const uploadResult = await uploadImage(imageBase64, cookie, settings.grok);
        if (uploadResult.fileUri) fileUris.push(uploadResult.fileUri);
      } catch (e) {
        return c.json({ error: `Image upload failed: ${e instanceof Error ? e.message : String(e)}` }, 400);
      }
    } else if (parentPostId) {
      fileUris.push(`https://imagine-public.x.ai/imagine-public/images/${parentPostId}.jpg`);
    }
  }

  if (!fileUris.length) {
    return c.json({ error: "image_base64, image_url, or image_references required" }, 400);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: string, data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
        emit("status", { status: "running", prompt });

        const upstream = await sendExperimentalImageEditRequest({
          prompt,
          fileUris,
          cookie,
          settings: settings.grok,
        });

        const text = await upstream.text();
        const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

        for (const line of lines) {
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }

          const resp = (data.result as Record<string, unknown>)?.response as Record<string, unknown> | undefined;
          if (!resp) continue;

          const modelResponse = resp.modelResponse as Record<string, unknown> | undefined;
          const generatedImageUrls = modelResponse?.generatedImageUrls as string[] | undefined;
          if (generatedImageUrls?.length) {
            for (const rawUrl of generatedImageUrls) {
              const encoded = encodeAssetPath(rawUrl);
              const proxyUrl = `/images/${encodeURIComponent(encoded)}`;
              const newParentId = extractParentPostIdFromUrl(rawUrl);
              if (newParentId && chosenToken) bindImageToken(newParentId, chosenToken);
              emit("image", {
                url: proxyUrl,
                source_url: rawUrl,
                parent_post_id: newParentId,
              });
            }
          }
        }

        emit("status", { status: "completed" });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        emit("error", { error: message, code: "workbench_edit_failed" });
      } finally {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
});

// ---------------------------------------------------------------------------
// POST /v1/public/video/start – create session for SSE-mode video generation
// ---------------------------------------------------------------------------

const VIDEO_RATIO_MAP: Record<string, string> = {
  "1280x720": "16:9",
  "720x1280": "9:16",
  "1792x1024": "3:2",
  "1024x1792": "2:3",
  "1024x1024": "1:1",
  "16:9": "16:9",
  "9:16": "9:16",
  "3:2": "3:2",
  "2:3": "2:3",
  "1:1": "1:1",
};

publicRoutes.post("/video/start", async (c) => {
  const authed = await verifyPublicAuth(c);
  if (!authed) return c.json({ error: "Unauthorized" }, 401);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const prompt = String(body.prompt ?? "").trim();
  const aspectRatio = VIDEO_RATIO_MAP[String(body.aspect_ratio ?? "3:2").trim()] ?? "3:2";
  const videoLength = Math.floor(Number(body.video_length ?? 6) || 6);
  const resolutionName = String(body.resolution_name ?? "480p");
  const preset = String(body.preset ?? "normal");
  const concurrent = Math.max(1, Math.min(4, Math.floor(Number(body.concurrent ?? 1) || 1)));
  const imageUrl = String(body.image_url ?? "").trim() || null;
  const parentPostId = String(body.parent_post_id ?? "").trim() || null;
  const sourceImageUrl = String(body.source_image_url ?? "").trim() || null;
  const reasoningEffort = String(body.reasoning_effort ?? "").trim() || null;

  // Video extension fields
  const isVideoExtension = body.is_video_extension === true;
  const extendPostId = String(body.extend_post_id ?? "").trim() || null;
  const videoExtensionStartTime = body.video_extension_start_time != null
    ? Number(body.video_extension_start_time)
    : null;
  const originalPostId = String(body.original_post_id ?? "").trim() || null;
  const fileAttachmentId = String(body.file_attachment_id ?? "").trim() || null;
  const stitchWithExtend = body.stitch_with_extend !== false;

  if (!isVideoExtension && !prompt && !imageUrl && !parentPostId) {
    return c.json({ error: "Prompt is required when no image_url/parent_post_id provided" }, 400);
  }

  const taskIds: string[] = [];
  for (let i = 0; i < concurrent; i++) {
    taskIds.push(
      newSession({
        type: "video",
        prompt,
        aspect_ratio: aspectRatio,
        video_length: videoLength,
        resolution_name: resolutionName,
        preset,
        image_url: imageUrl,
        parent_post_id: parentPostId,
        source_image_url: sourceImageUrl,
        reasoning_effort: reasoningEffort,
        is_video_extension: isVideoExtension,
        extend_post_id: extendPostId,
        video_extension_start_time: videoExtensionStartTime,
        original_post_id: originalPostId,
        file_attachment_id: fileAttachmentId,
        stitch_with_extend: stitchWithExtend,
      }),
    );
  }

  return c.json({
    task_id: taskIds[0],
    task_ids: taskIds,
    concurrent,
    aspect_ratio: aspectRatio,
    parent_post_id: parentPostId ?? "",
    extend_post_id: extendPostId ?? "",
    file_attachment_id: fileAttachmentId ?? "",
  });
});

// ---------------------------------------------------------------------------
// GET /v1/public/video/sse – SSE stream for video generation
// ---------------------------------------------------------------------------

publicRoutes.get("/video/sse", async (c) => {
  const taskId = String(c.req.query("task_id") ?? "").trim();
  const session = getSession(taskId);
  if (!session) return c.json({ error: "Task not found" }, 404);

  const prompt = String(session.prompt ?? "").trim();
  const aspectRatio = String(session.aspect_ratio ?? "3:2");
  const videoLength = Number(session.video_length ?? 6);
  const resolutionName = String(session.resolution_name ?? "480p");
  const preset = String(session.preset ?? "normal");
  const imageUrl = session.image_url as string | null;
  const parentPostId = String(session.parent_post_id ?? "").trim();
  const sourceImageUrl = session.source_image_url as string | null;

  const settings = await getSettings(c.env);
  const cf = normalizeCfCookie(settings.grok.cf_clearance ?? "");

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        // Try bound token for parentPostId chain
        let chosenToken: string | null = null;
        if (parentPostId) {
          chosenToken = getBoundImageToken(parentPostId);
        }
        if (!chosenToken) {
          const chosen = await selectBestToken(c.env.DB, "grok-imagine-1.0-video");
          if (!chosen) {
            emit({ error: "No available tokens", code: "rate_limit_exceeded" });
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            return;
          }
          chosenToken = chosen.token;
        }

        const cookie = cf
          ? `sso-rw=${chosenToken};sso=${chosenToken};${cf}`
          : `sso-rw=${chosenToken};sso=${chosenToken}`;

        // Create a media post for video generation
        const { postId } = await createMediaPost(
          { mediaType: "MEDIA_POST_TYPE_VIDEO", prompt: prompt || "Generate a video" },
          cookie,
          settings.grok,
        );

        if (!postId) {
          emit({ error: "Failed to create video post", code: "post_creation_failed" });
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }

        // Build video conversation payload
        let modeFlag = "--mode=custom";
        if (preset === "fun") modeFlag = "--mode=extremely-crazy";
        else if (preset === "normal") modeFlag = "--mode=normal";
        else if (preset === "spicy") modeFlag = "--mode=extremely-spicy-or-crazy";

        const videoPrompt = `${prompt} ${modeFlag}`.trim();
        const resolution = resolutionName === "720p" ? "HD" : "SD";

        const payload: Record<string, unknown> = {
          temporary: true,
          modelName: "grok-3",
          message: videoPrompt,
          toolOverrides: { videoGen: true },
          enableSideBySide: true,
          responseMetadata: {
            experiments: [],
            modelConfigOverride: {
              modelMap: {
                videoGenModelConfig: {
                  parentPostId: postId,
                  aspectRatio,
                  videoLength,
                  videoResolution: resolution,
                },
              },
            },
          },
        };

        emit({ status: "running", prompt, post_id: postId });

        const upstream = await sendConversationRequest({
          payload,
          cookie,
          settings: settings.grok,
          referer: "https://grok.com/imagine",
        });

        const text = await upstream.text();
        const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

        for (const line of lines) {
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }

          // Forward relevant fields
          const resp = (data.result as Record<string, unknown>)?.response as Record<string, unknown> | undefined;
          if (!resp) continue;

          const modelResponse = resp.modelResponse as Record<string, unknown> | undefined;
          const videoUrls = modelResponse?.generatedVideoUrls as string[] | undefined;
          if (videoUrls?.length) {
            for (const rawUrl of videoUrls) {
              const encoded = encodeAssetPath(rawUrl);
              const proxyUrl = `/images/${encodeURIComponent(encoded)}`;
              emit({
                type: "video",
                url: proxyUrl,
                source_url: rawUrl,
                post_id: postId,
              });
            }
          }

          // Also check for video generation progress
          const streamingVideoResponse = resp.streamingVideoGenerationResponse as Record<string, unknown> | undefined;
          if (streamingVideoResponse) {
            emit({
              type: "progress",
              ...streamingVideoResponse,
            });
          }
        }

        emit({ status: "completed", post_id: postId });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        emit({ error: message, code: "video_failed" });
      } finally {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
        dropSession(taskId);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
});

// ---------------------------------------------------------------------------
// POST /v1/public/video/stop – stop video tasks
// ---------------------------------------------------------------------------

publicRoutes.post("/video/stop", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const taskIds = body.task_ids as string[] | undefined;
  let removed = 0;
  if (Array.isArray(taskIds)) {
    for (const id of taskIds) {
      if (typeof id === "string" && SESSIONS.has(id)) {
        dropSession(id);
        removed += 1;
      }
    }
  }
  return c.json({ removed });
});

// ---------------------------------------------------------------------------
// GET /v1/public/video/cache/list – list cached videos
// ---------------------------------------------------------------------------

publicRoutes.get("/video/cache/list", async (c) => {
  try {
    const page = Math.max(1, Math.floor(Number(c.req.query("page") ?? 1)));
    const pageSize = Math.max(1, Math.min(100, Math.floor(Number(c.req.query("page_size") ?? 20))));

    const result = await listCacheRowsByType(c.env.DB, "video", pageSize, (page - 1) * pageSize);
    return c.json({
      items: result.items.map((r) => ({
        key: r.key,
        type: r.type,
        size: r.size,
        created_at: r.created_at,
      })),
      total: result.total,
      page,
      page_size: pageSize,
    });
  } catch {
    return c.json({ items: [], page: 1, page_size: 20 });
  }
});

// ---------------------------------------------------------------------------
// GET /v1/public/voice/token – get voice token (LiveKit)
// ---------------------------------------------------------------------------

publicRoutes.get("/voice/token", async (c) => {
  const authed = await verifyPublicAuth(c);
  if (!authed) return c.json({ error: "Unauthorized" }, 401);

  const voice = String(c.req.query("voice") ?? "ara").trim();
  const personality = String(c.req.query("personality") ?? "assistant").trim();
  const speed = Math.max(0.5, Math.min(2.0, Number(c.req.query("speed") ?? 1.0) || 1.0));

  const settings = await getSettings(c.env);
  const cf = normalizeCfCookie(settings.grok.cf_clearance ?? "");

  const chosen = await selectBestToken(c.env.DB, "grok-3");
  if (!chosen) return c.json({ error: "No available tokens" }, 503);

  const cookie = cf
    ? `sso-rw=${chosen.token};sso=${chosen.token};${cf}`
    : `sso-rw=${chosen.token};sso=${chosen.token}`;

  try {
    const headers = getDynamicHeaders(settings.grok, "/rest/voice/session");
    headers.Cookie = cookie;
    headers.Referer = "https://grok.com/";

    const voiceResp = await fetch("https://grok.com/rest/voice/session", {
      method: "POST",
      headers,
      body: JSON.stringify({
        voice,
        personality,
        speed,
      }),
    });

    if (!voiceResp.ok) {
      const text = await voiceResp.text().catch(() => "");
      return c.json({ error: `Voice token request failed: ${voiceResp.status}`, detail: text.slice(0, 200) }, 502);
    }

    const data = (await voiceResp.json()) as Record<string, unknown>;
    const token = String(data.token ?? "");
    if (!token) return c.json({ error: "Upstream returned no voice token" }, 502);

    // Extract LiveKit URL
    const url = String(
      data.url ?? data.livekitUrl ?? data.livekit_url ?? data.livekitServerUrl ?? "wss://livekit.grok.com",
    ).trim();

    return c.json({
      token,
      url,
      urls: [url],
      participant_name: String(data.participant_name ?? data.participantName ?? data.identity ?? ""),
      room_name: String(data.room_name ?? data.roomName ?? data.room ?? ""),
      ice_servers: data.iceServers ?? data.ice_servers ?? null,
      signal_proxy_url: null,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return c.json({ error: `Voice token error: ${message}` }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /v1/public/verify – verify public key (simple health check)
// ---------------------------------------------------------------------------

publicRoutes.get("/verify", async (c) => {
  const authed = await verifyPublicAuth(c);
  if (!authed) return c.json({ error: "Unauthorized" }, 401);
  return c.json({ status: "success" });
});
