var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// ../../packages/shared/src/index.ts
var ROOM_ID_BYTES = 16;
var KEY_VERSION = "v1";
var HKDF_INFO = `elm-chat:${KEY_VERSION}:room-key`;
var DEFAULT_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1e3;
var DEFAULT_MAX_ROOM_AGE_MS = 24 * 60 * 60 * 1e3;
var DEFAULT_DISAPPEAR_AFTER_READ_SECONDS = 7 * 60;
var MAX_CONNECTIONS_PER_ROOM = 16;
var MAX_FILE_BYTES = 25 * 1024 * 1024;
var FILE_CHUNK_BYTES = 64 * 1024;
var MARKETING_ACQUISITION_SOURCES = [
  "self-destructing-chat",
  "send-a-password-securely",
  "send-a-file-securely",
  "one-time-secret-chat",
  "temporary-private-chat",
  "journalist-source-communication",
  "temporary-financial-handoff",
  "security-and-limitations",
  "press",
  "the-internet-needs-places-that-forget",
  "why-i-built-elm-chat",
  "deletion-distributed-systems-contract",
  "building-ephemeral-chat-cloudflare",
  "durable-objects-websocket-hibernation",
  "cloudflare-deploy-button-monorepo",
  "single-use-invite-links"
];
var EXTERNAL_ACQUISITION_SOURCES = [
  "awesome-cloudflare",
  "dev-community",
  "devopsish",
  "freshcode",
  "free-startup-listing",
  "github-discussion",
  "github-readme",
  "hashnode",
  "high-scalability",
  "llms-txt",
  "linuxlinks",
  "linkedin",
  "reddit-cloudflare",
  "reddit-selfhosted",
  "sre-weekly",
  "zearches"
];
var ACQUISITION_SOURCES = [
  "invite",
  ...MARKETING_ACQUISITION_SOURCES,
  ...EXTERNAL_ACQUISITION_SOURCES
];
function isAcquisitionSource(value) {
  return typeof value === "string" && ACQUISITION_SOURCES.includes(value);
}
__name(isAcquisitionSource, "isAcquisitionSource");
function isExternalAcquisitionSource(value) {
  return typeof value === "string" && EXTERNAL_ACQUISITION_SOURCES.includes(value);
}
__name(isExternalAcquisitionSource, "isExternalAcquisitionSource");

// ../../packages/crypto/src/index.ts
var encoder = new TextEncoder();
var decoder = new TextDecoder();
function toBase64Url(bytes) {
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
__name(toBase64Url, "toBase64Url");
function fromBase64Url(value) {
  const padding = "=".repeat((4 - (value.length % 4 || 4)) % 4);
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/") + padding;
  const decoded = atob(normalized);
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}
__name(fromBase64Url, "fromBase64Url");
function toArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
__name(toArrayBuffer, "toArrayBuffer");
function bytesToBase64Url(bytes) {
  return toBase64Url(bytes);
}
__name(bytesToBase64Url, "bytesToBase64Url");
function base64UrlToBytes(value) {
  return fromBase64Url(value);
}
__name(base64UrlToBytes, "base64UrlToBytes");
function generateAccessCode() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  const num = buf[0] % 1e6;
  return num.toString().padStart(6, "0");
}
__name(generateAccessCode, "generateAccessCode");
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}
__name(constantTimeEqual, "constantTimeEqual");
async function hashAccessCode(code, salt) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(code),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: toArrayBuffer(salt),
      iterations: 1e4,
      hash: "SHA-256"
    },
    key,
    256
  );
  return new Uint8Array(bits);
}
__name(hashAccessCode, "hashAccessCode");
async function verifyAccessCode(code, salt, expectedHash) {
  const hash = await hashAccessCode(code, salt);
  return constantTimeEqual(hash, expectedHash);
}
__name(verifyAccessCode, "verifyAccessCode");

// ../../durable-objects/room/src/room.ts
import { DurableObject } from "cloudflare:workers";

// ../../durable-objects/room/src/expiry.ts
function roomExpiryReason(room, now, connectedCount) {
  if (room.expiresAt !== null && now >= room.expiresAt) return "max-age";
  if (room.inactivityTimeoutMs !== null && now - room.lastActivityAt >= room.inactivityTimeoutMs) {
    return connectedCount === 0 ? "join-timeout" : "inactive";
  }
  return null;
}
__name(roomExpiryReason, "roomExpiryReason");

// ../../durable-objects/room/src/room.ts
var ROOM_META_KEY = "room:meta";
var INVITES_KEY = "room:invites";
var MESSAGES_KEY = "room:messages";
var DESTROYED_MESSAGES_KEY = "room:destroyed_messages";
var ACCESS_CODE_KEY = "room:access_code";
var DEFAULT_INVITE_TTL_MS = 10 * 60 * 1e3;
var JOIN_TIMEOUT_MS = 15 * 1e3;
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
__name(jsonResponse, "jsonResponse");
function wsResponse(client) {
  return new Response(null, {
    status: 101,
    webSocket: client
  });
}
__name(wsResponse, "wsResponse");
function errorEvent(code, message) {
  return { type: "error", code, message };
}
__name(errorEvent, "errorEvent");
async function safeJson(request) {
  return await request.json();
}
__name(safeJson, "safeJson");
var RoomDurableObject = class extends DurableObject {
  static {
    __name(this, "RoomDurableObject");
  }
  roomMeta = null;
  invites = /* @__PURE__ */ new Map();
  messages = /* @__PURE__ */ new Map();
  destroyedMessageIds = /* @__PURE__ */ new Set();
  accessCodeConfig = null;
  lastGeneratedCode;
  failedAttempts = 0;
  lockedUntil = 0;
  guestVerified = false;
  validTickets = /* @__PURE__ */ new Map();
  verifiedSessionIds = /* @__PURE__ */ new Set();
  storageReady;
  constructor(ctx, env) {
    super(ctx, env);
    this.storageReady = this.ctx.blockConcurrencyWhile(async () => {
      this.roomMeta = await this.ctx.storage.get(ROOM_META_KEY) ?? null;
      if (this.roomMeta && !Number.isSafeInteger(this.roomMeta.membershipVersion)) {
        this.roomMeta.membershipVersion = 0;
      }
      this.invites = new Map(await this.ctx.storage.get(INVITES_KEY) ?? []);
      this.messages = new Map(await this.ctx.storage.get(MESSAGES_KEY) ?? []);
      this.destroyedMessageIds = new Set(await this.ctx.storage.get(DESTROYED_MESSAGES_KEY) ?? []);
      this.accessCodeConfig = await this.ctx.storage.get(ACCESS_CODE_KEY) ?? null;
    });
  }
  async fetch(request) {
    await this.storageReady;
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/internal/bootstrap") {
      return this.bootstrapRoom(await safeJson(request));
    }
    if (request.method === "GET" && url.pathname === "/internal/metadata") {
      return this.handleMetadata();
    }
    if (request.method === "POST" && url.pathname === "/internal/destroy") {
      const payload = await safeJson(request);
      return this.destroyRoom("destroyed", payload.creatorToken);
    }
    if (request.method === "POST" && url.pathname === "/internal/invites/create") {
      const payload = await safeJson(request);
      return this.createInvite(payload.creatorToken, payload.ttlMs);
    }
    if (request.method === "GET" && url.pathname === "/internal/invites") {
      const creatorToken = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]+)$/i)?.[1] ?? "";
      return this.listInvites(creatorToken);
    }
    if (request.method === "POST" && url.pathname === "/internal/invites/revoke") {
      const payload = await safeJson(request);
      return this.revokeInvite(payload.creatorToken, payload.token);
    }
    if (request.method === "POST" && url.pathname === "/internal/access-code") {
      const creatorToken = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]+)$/i)?.[1] ?? "";
      const payload = await safeJson(request);
      return this.handleManageAccessCode(creatorToken || payload.creatorToken || "", payload);
    }
    if (request.method === "GET" && url.pathname === "/internal/access-code") {
      const creatorToken = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]+)$/i)?.[1] ?? "";
      return this.handleGetAccessCode(creatorToken);
    }
    if (request.method === "POST" && url.pathname === "/internal/access-code/verify") {
      const payload = await safeJson(request);
      return this.handleVerifyAccessCode(payload);
    }
    if (request.method === "GET" && url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return jsonResponse({ error: "Expected WebSocket upgrade." }, 400);
      }
      if (await this.expireIfDue() || !this.roomMeta || this.roomMeta.status !== "open") {
        return jsonResponse({ error: "Room is unavailable." }, 410);
      }
      if (this.openWebSockets().length >= MAX_CONNECTIONS_PER_ROOM) {
        return jsonResponse({ error: "Room is full." }, 409);
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({
        sessionId: "",
        creator: false,
        identityKey: "",
        agreementKey: "",
        connectedAt: Date.now()
      });
      await this.scheduleNextAlarm();
      return wsResponse(client);
    }
    return jsonResponse({ error: "Not found." }, 404);
  }
  async alarm() {
    await this.storageReady;
    if (await this.expireIfDue()) return;
    const now = Date.now();
    for (const socket of this.openWebSockets()) {
      const attachment = socket.deserializeAttachment();
      if (attachment?.sessionId === "" && attachment.connectedAt + JOIN_TIMEOUT_MS <= now) {
        socket.close(4408, "join timeout");
      }
    }
    for (const [id, record] of [...this.messages.entries()]) {
      if (record.status === "seen") {
        const delaySec = record.expiresAfterReadSeconds ?? this.roomMeta?.disappearAfterReadSeconds ?? 0;
        if (record.seenAt && record.seenAt + delaySec * 1e3 <= now) {
          await this.destroyMessage(id, "seen");
        }
      } else if (record.fallbackExpiresAt <= now) {
        await this.destroyMessage(id, "expired");
      }
    }
    await this.scheduleNextAlarm();
  }
  async webSocketMessage(ws, message) {
    await this.storageReady;
    if (await this.expireIfDue()) return;
    if (typeof message !== "string") {
      ws.send(JSON.stringify(errorEvent("binary_not_supported", "Binary payloads are not supported.")));
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(message);
    } catch {
      ws.send(JSON.stringify(errorEvent("invalid_json", "Message must be valid JSON.")));
      return;
    }
    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
      ws.send(JSON.stringify(errorEvent("invalid_event", "Message must be a room event.")));
      return;
    }
    const attachment = ws.deserializeAttachment();
    if (parsed.type !== "join" && !attachment?.sessionId) {
      ws.send(JSON.stringify(errorEvent("join_required", "Join before sending room events.")));
      ws.close(4403, "join required");
      return;
    }
    switch (parsed.type) {
      case "join":
        await this.handleJoin(ws, parsed);
        break;
      case "peer_data":
        await this.handlePeerData(ws, parsed);
        break;
      case "message_delivered":
        await this.handleMessageDelivered(ws, parsed);
        break;
      case "message_seen":
        await this.handleMessageSeen(ws, parsed);
        break;
      case "destroy_message":
        await this.handleDestroyMessage(ws, parsed);
        break;
      case "destroy":
        await this.destroyRoom("destroyed", parsed.creatorToken);
        break;
      case "kick_participant":
        await this.kickParticipant(ws, parsed);
        break;
      case "ping":
        await this.markRoomActivity();
        break;
    }
  }
  async webSocketClose(ws) {
    await this.storageReady;
    const attachment = ws.deserializeAttachment();
    if (!attachment?.sessionId) {
      await this.scheduleNextAlarm();
      return;
    }
    if (this.roomMeta?.status === "open") {
      this.roomMeta.membershipVersion += 1;
      await this.ctx.storage.put(ROOM_META_KEY, this.roomMeta);
    }
    await this.markRoomActivity();
    this.broadcast({
      type: "peer_left",
      sessionId: attachment.sessionId,
      membershipVersion: this.roomMeta?.membershipVersion ?? 0
    });
    await this.broadcastPresence();
  }
  async bootstrapRoom(bootstrap) {
    if (this.roomMeta) {
      return jsonResponse({ error: "Room already initialized." }, 409);
    }
    if (bootstrap.generateAccessCode || bootstrap.accessCode) {
      let code = bootstrap.accessCode;
      if (!code || bootstrap.generateAccessCode) {
        code = generateAccessCode();
      }
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const hash = await hashAccessCode(code, salt);
      this.accessCodeConfig = {
        enabled: true,
        revoked: false,
        saltBase64Url: bytesToBase64Url(salt),
        hashBase64Url: bytesToBase64Url(hash)
      };
      await this.ctx.storage.put(ACCESS_CODE_KEY, this.accessCodeConfig);
      this.lastGeneratedCode = code;
    }
    const meta = {
      roomId: bootstrap.roomId,
      createdAt: bootstrap.createdAt,
      expiresAt: bootstrap.expiresAt,
      inactivityTimeoutMs: bootstrap.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS,
      maxAgeMs: bootstrap.maxAgeMs ?? null,
      disappearAfterReadSeconds: bootstrap.disappearAfterReadSeconds ?? DEFAULT_DISAPPEAR_AFTER_READ_SECONDS,
      status: "open",
      participantCount: 0,
      creatorJoined: false,
      lastActivityAt: bootstrap.createdAt,
      membershipVersion: 0,
      creatorToken: bootstrap.creatorToken
    };
    this.roomMeta = meta;
    await this.ctx.storage.put(ROOM_META_KEY, meta);
    await this.scheduleNextAlarm();
    return jsonResponse({ ...this.publicMetadata(meta), accessCode: this.lastGeneratedCode }, 201);
  }
  handleMetadata() {
    if (!this.roomMeta) {
      return jsonResponse({ error: "Room not found." }, 404);
    }
    return jsonResponse(this.publicMetadata(this.roomMeta));
  }
  async handleJoin(ws, payload) {
    if (!this.roomMeta || this.roomMeta.status !== "open") {
      ws.send(JSON.stringify(errorEvent("room_unavailable", "Room is unavailable.")));
      ws.close(4404, "room unavailable");
      return;
    }
    const existing = ws.deserializeAttachment();
    if (existing?.sessionId) {
      ws.send(JSON.stringify(errorEvent("already_joined", "Session already joined.")));
      return;
    }
    if (!existing || existing.connectedAt + JOIN_TIMEOUT_MS <= Date.now() || typeof payload.sessionId !== "string" || !payload.sessionId || typeof payload.identityKey !== "string" || !/^[A-Za-z0-9_-]{87}$/.test(payload.identityKey) || typeof payload.agreementKey !== "string" || !/^[A-Za-z0-9_-]{87}$/.test(payload.agreementKey)) {
      ws.send(JSON.stringify(errorEvent("invalid_join", "Join was invalid or timed out.")));
      ws.close(4408, "invalid join");
      return;
    }
    const existingSession = this.connectedSessions().find(
      (session2) => session2.sessionId === payload.sessionId
    );
    if (existingSession) {
      ws.send(JSON.stringify(errorEvent(
        existingSession.identityKey === payload.identityKey && existingSession.agreementKey === payload.agreementKey ? "session_connected" : "identity_mismatch",
        existingSession.identityKey === payload.identityKey && existingSession.agreementKey === payload.agreementKey ? "This session is already connected." : "The session is already bound to another identity key."
      )));
      ws.close(4409, "duplicate session");
      return;
    }
    const currentSessions = this.connectedSessions().filter((s) => s.sessionId !== payload.sessionId);
    if (currentSessions.length >= 2) {
      ws.send(JSON.stringify(errorEvent("room_full", "The room has reached maximum capacity of 2 participants.")));
      ws.close(4409, "room full");
      return;
    }
    const creator = payload.creatorToken === this.roomMeta.creatorToken;
    const isAccessCodeProtected = Boolean(this.accessCodeConfig?.enabled && !this.accessCodeConfig?.revoked);
    if (!creator && isAccessCodeProtected) {
      const isReconnectingAdmittedSession = this.verifiedSessionIds.has(payload.sessionId) && Boolean(payload.inviteToken && this.invites.get(payload.inviteToken)?.consumedBySessionId === payload.sessionId);
      if (!isReconnectingAdmittedSession) {
        const ticket = payload.accessCodeTicket;
        const ticketRecord = ticket ? this.validTickets.get(ticket) : void 0;
        if (!ticket || !ticketRecord || ticketRecord.expiresAt <= Date.now()) {
          ws.send(JSON.stringify(errorEvent("access_code_required", "Room access code verification required.")));
          ws.close(4403, "access code required");
          return;
        }
        this.validTickets.delete(ticket);
        this.verifiedSessionIds.add(payload.sessionId);
      }
    }
    const admission = await this.reserveInviteForJoin(creator, payload);
    if (!admission.ok) {
      ws.send(JSON.stringify(errorEvent(admission.code, admission.message)));
      ws.close(4403, admission.closeReason);
      return;
    }
    const session = {
      sessionId: payload.sessionId,
      creator,
      connectedAt: Date.now(),
      identityKey: payload.identityKey,
      agreementKey: payload.agreementKey
    };
    ws.serializeAttachment(session);
    if (creator) {
      this.roomMeta.creatorJoined = true;
    }
    this.roomMeta.participantCount = this.connectedSessionIds().length;
    this.roomMeta.membershipVersion += 1;
    this.roomMeta.lastActivityAt = Date.now();
    await this.ctx.storage.put(ROOM_META_KEY, this.roomMeta);
    if (admission.invite && !admission.invite.consumedAt) {
      const admittedAt = Date.now();
      admission.invite.admittedAt = admittedAt;
      admission.invite.consumedAt = admittedAt;
      admission.invite.consumedBySessionId = payload.sessionId;
      this.invites.set(admission.invite.token, admission.invite);
      await this.persistInvites();
      if (admission.newlyClaimed) {
        this.env.GROWTH?.writeDataPoint({
          indexes: ["invite_redeemed"],
          blobs: [""],
          doubles: [1]
        });
      }
    }
    const peers = this.connectedSessions().filter((peer) => peer.sessionId !== payload.sessionId).sort((left, right) => left.connectedAt - right.connectedAt).map((peer) => this.describePeer(peer));
    ws.send(
      JSON.stringify({
        type: "joined",
        room: this.publicMetadata(this.roomMeta),
        sessionId: payload.sessionId,
        creator,
        self: this.describePeer(session),
        peers,
        presence: this.presenceSnapshot()
      })
    );
    this.broadcastToOtherParticipants(payload.sessionId, {
      type: "peer_joined",
      peer: this.describePeer(session),
      membershipVersion: this.roomMeta.membershipVersion
    });
    await this.broadcastPresence();
    await this.markRoomActivity();
  }
  async reserveInviteForJoin(creator, payload) {
    if (creator) {
      return { ok: true, newlyClaimed: false };
    }
    const invite = payload.inviteToken ? this.invites.get(payload.inviteToken) : void 0;
    const now = Date.now();
    if (!invite || invite.revokedAt || invite.expiresAt <= now) {
      return {
        ok: false,
        code: "invite_required",
        message: "A valid one-time invite is required.",
        closeReason: "invite required"
      };
    }
    if (invite.consumedAt) {
      if (invite.consumedBySessionId === payload.sessionId) {
        return { ok: true, invite, newlyClaimed: false };
      }
      return {
        ok: false,
        code: "invite_used",
        message: "This one-time invite has already admitted another session.",
        closeReason: "invite used"
      };
    }
    if (invite.claimedAt) {
      if (invite.claimedBySessionId === payload.sessionId) {
        return { ok: true, invite, newlyClaimed: false };
      }
      return {
        ok: false,
        code: "invite_claimed",
        message: "This one-time invite is already being used by another session.",
        closeReason: "invite claimed"
      };
    }
    invite.claimedAt = now;
    invite.claimedBySessionId = payload.sessionId;
    this.invites.set(invite.token, invite);
    await this.persistInvites();
    return { ok: true, invite, newlyClaimed: true };
  }
  async handlePeerData(ws, payload) {
    if (!this.roomMeta || this.roomMeta.status !== "open") {
      ws.send(JSON.stringify(errorEvent("room_unavailable", "Room is unavailable.")));
      return;
    }
    const attachment = ws.deserializeAttachment();
    if (!attachment?.sessionId) {
      ws.send(JSON.stringify(errorEvent("join_required", "Join before relaying peer data.")));
      return;
    }
    const data = payload.data;
    if (!data || data.protocolVersion !== 1 || data.roomId !== this.roomMeta.roomId || data.senderSessionId !== attachment.sessionId || data.targetSessionId !== (payload.toSessionId ?? null) || typeof data.eventId !== "string" || typeof data.signature !== "string" || !data.payload || typeof data.payload.type !== "string") {
      ws.send(JSON.stringify(errorEvent("invalid_peer_event", "Peer event authentication metadata is invalid.")));
      return;
    }
    if (data.payload.type === "chat_message") {
      const envelope = data.payload.envelope;
      if (envelope && typeof envelope.messageId === "string" && /^[0-9a-f-]{36}$/i.test(envelope.messageId) && envelope.senderSessionId === attachment.sessionId) {
        if (this.destroyedMessageIds.has(envelope.messageId)) {
          return;
        }
        if (!this.messages.has(envelope.messageId)) {
          const fallbackExpiresAt = this.roomMeta.expiresAt ?? envelope.sentAt + (this.roomMeta.maxAgeMs ?? 24 * 60 * 60 * 1e3);
          this.messages.set(envelope.messageId, {
            messageId: envelope.messageId,
            senderSessionId: attachment.sessionId,
            sentAt: envelope.sentAt ?? Date.now(),
            status: "sent",
            expiresAfterReadSeconds: envelope.expiresAfterReadSeconds ?? null,
            fallbackExpiresAt
          });
          await this.persistMessages();
        }
      }
    }
    if (data.payload.type === "peer_destroy") {
      for (const id of this.messages.keys()) {
        this.destroyedMessageIds.add(id);
      }
      this.messages.clear();
      await this.persistMessages();
    }
    const event = {
      type: "peer_data",
      fromSessionId: attachment.sessionId,
      data: payload.data
    };
    if (payload.toSessionId) {
      if (!this.isConnected(payload.toSessionId)) {
        ws.send(JSON.stringify(errorEvent("peer_missing", "Peer is no longer connected.")));
        return;
      }
      this.broadcastToSessions([payload.toSessionId], event);
    } else {
      this.broadcastToOtherParticipants(attachment.sessionId, event);
    }
    await this.markRoomActivity();
  }
  async handleMessageDelivered(ws, payload) {
    const attachment = ws.deserializeAttachment();
    if (!attachment?.sessionId) return;
    if (this.destroyedMessageIds.has(payload.messageId)) return;
    const record = this.messages.get(payload.messageId);
    if (!record) return;
    if (record.senderSessionId === attachment.sessionId) return;
    if (record.status === "sent") {
      record.status = "delivered";
      record.deliveredAt = Date.now();
      await this.persistMessages();
      this.broadcast({
        type: "message_delivered",
        messageId: payload.messageId,
        deliveredAt: record.deliveredAt
      });
    }
  }
  async handleMessageSeen(ws, payload) {
    const attachment = ws.deserializeAttachment();
    if (!attachment?.sessionId) {
      ws.send(JSON.stringify(errorEvent("join_required", "Join before sending room events.")));
      return;
    }
    if (!payload.messageId || typeof payload.messageId !== "string") {
      ws.send(JSON.stringify(errorEvent("invalid_event", "Invalid messageId.")));
      return;
    }
    if (this.destroyedMessageIds.has(payload.messageId)) {
      return;
    }
    const record = this.messages.get(payload.messageId);
    if (!record) {
      ws.send(JSON.stringify(errorEvent("message_not_found", "Message does not belong to this room.")));
      return;
    }
    if (record.senderSessionId === attachment.sessionId) {
      ws.send(JSON.stringify(errorEvent("unauthorized_seen", "Cannot mark own message as seen.")));
      return;
    }
    if (record.status === "seen") {
      return;
    }
    record.status = "seen";
    record.seenAt = Date.now();
    record.seenBySessionId = attachment.sessionId;
    await this.persistMessages();
    this.broadcast({
      type: "message_seen",
      messageId: payload.messageId,
      seenAt: record.seenAt,
      seenBySessionId: attachment.sessionId
    });
    const delaySec = record.expiresAfterReadSeconds ?? this.roomMeta?.disappearAfterReadSeconds ?? 0;
    if (delaySec === 0) {
      await this.destroyMessage(payload.messageId, "seen");
    } else {
      if (delaySec <= 60) {
        setTimeout(() => {
          void this.destroyMessage(payload.messageId, "seen");
        }, delaySec * 1e3);
      }
      await this.scheduleNextAlarm();
    }
  }
  async handleDestroyMessage(ws, payload) {
    const attachment = ws.deserializeAttachment();
    if (!attachment?.sessionId) {
      ws.send(JSON.stringify(errorEvent("join_required", "Join before sending room events.")));
      return;
    }
    if (!payload.messageId || typeof payload.messageId !== "string") {
      ws.send(JSON.stringify(errorEvent("invalid_event", "Invalid messageId.")));
      return;
    }
    if (this.destroyedMessageIds.has(payload.messageId)) {
      return;
    }
    const record = this.messages.get(payload.messageId);
    if (!record) {
      return;
    }
    const isSender = record.senderSessionId === attachment.sessionId;
    const isSeen = record.status === "seen";
    const isExpired = Date.now() >= record.fallbackExpiresAt;
    if (!isSender && !isSeen && !isExpired) {
      ws.send(JSON.stringify(errorEvent("unauthorized_destroy", "Cannot destroy unseen message.")));
      return;
    }
    await this.destroyMessage(payload.messageId, isSender ? "manual" : "expired");
  }
  async destroyMessage(messageId, reason) {
    if (this.destroyedMessageIds.has(messageId)) {
      return;
    }
    const record = this.messages.get(messageId);
    this.messages.delete(messageId);
    this.destroyedMessageIds.add(messageId);
    await this.persistMessages();
    this.broadcast({
      type: "message_destroyed",
      messageId,
      destroyedAt: Date.now(),
      reason
    });
  }
  async persistMessages() {
    await this.ctx.storage.put(MESSAGES_KEY, [...this.messages.entries()]);
    await this.ctx.storage.put(DESTROYED_MESSAGES_KEY, [...this.destroyedMessageIds]);
  }
  async kickParticipant(ws, payload) {
    if (!this.roomMeta || this.roomMeta.status !== "open") {
      ws.send(JSON.stringify(errorEvent("room_unavailable", "Room is unavailable.")));
      return;
    }
    if (payload.creatorToken !== this.roomMeta.creatorToken) {
      ws.send(JSON.stringify(errorEvent("unauthorized", "Only the creator can kick participants.")));
      return;
    }
    const target = payload.targetSessionId;
    if (!this.isConnected(target)) {
      ws.send(JSON.stringify(errorEvent("peer_missing", "Participant is no longer connected.")));
      return;
    }
    await this.disconnectSession(target, "removed-by-creator", "kicked");
  }
  async createInvite(creatorToken, ttlMs) {
    if (!this.roomMeta) {
      return jsonResponse({ error: "Room not found." }, 404);
    }
    if (creatorToken !== this.roomMeta.creatorToken) {
      return jsonResponse({ error: "Unauthorized." }, 403);
    }
    const now = Date.now();
    const token = crypto.randomUUID();
    const invite = {
      token,
      createdAt: now,
      expiresAt: now + Math.max(6e4, ttlMs ?? DEFAULT_INVITE_TTL_MS)
    };
    this.invites.set(token, invite);
    await this.persistInvites();
    return jsonResponse(invite, 201);
  }
  listInvites(creatorToken) {
    if (!this.roomMeta) {
      return jsonResponse({ error: "Room not found." }, 404);
    }
    if (creatorToken !== this.roomMeta.creatorToken) {
      return jsonResponse({ error: "Unauthorized." }, 403);
    }
    return jsonResponse(
      [...this.invites.values()].sort((left, right) => right.createdAt - left.createdAt)
    );
  }
  async revokeInvite(creatorToken, token) {
    if (!this.roomMeta) {
      return jsonResponse({ error: "Room not found." }, 404);
    }
    if (creatorToken !== this.roomMeta.creatorToken) {
      return jsonResponse({ error: "Unauthorized." }, 403);
    }
    const invite = this.invites.get(token);
    if (!invite) {
      return jsonResponse({ error: "Invite not found." }, 404);
    }
    invite.revokedAt = Date.now();
    this.invites.set(token, invite);
    await this.persistInvites();
    if (invite.consumedBySessionId && this.isConnected(invite.consumedBySessionId)) {
      await this.disconnectSession(invite.consumedBySessionId, "invite-revoked", "invite revoked");
    }
    return jsonResponse(invite);
  }
  async handleManageAccessCode(creatorToken, payload) {
    if (!this.roomMeta || this.roomMeta.creatorToken !== creatorToken) {
      return jsonResponse({ error: "Unauthorized." }, 403);
    }
    if (payload.action === "revoke") {
      this.accessCodeConfig = {
        enabled: true,
        revoked: true,
        saltBase64Url: "",
        hashBase64Url: ""
      };
      await this.ctx.storage.put(ACCESS_CODE_KEY, this.accessCodeConfig);
      this.lastGeneratedCode = void 0;
      this.validTickets.clear();
      this.verifiedSessionIds.clear();
      this.guestVerified = false;
      return jsonResponse({ ok: true, enabled: false });
    }
    if (payload.action === "disable") {
      this.accessCodeConfig = {
        enabled: false,
        revoked: false,
        saltBase64Url: "",
        hashBase64Url: ""
      };
      await this.ctx.storage.put(ACCESS_CODE_KEY, this.accessCodeConfig);
      this.lastGeneratedCode = void 0;
      this.validTickets.clear();
      this.verifiedSessionIds.clear();
      this.guestVerified = false;
      return jsonResponse({ ok: true, enabled: false });
    }
    let code = payload.code;
    if (payload.action === "generate") {
      code = generateAccessCode();
    }
    if (!code || !/^\d{6}$/.test(code)) {
      return jsonResponse({ error: "Access code must be exactly 6 digits." }, 400);
    }
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await hashAccessCode(code, salt);
    this.accessCodeConfig = {
      enabled: true,
      revoked: false,
      saltBase64Url: bytesToBase64Url(salt),
      hashBase64Url: bytesToBase64Url(hash)
    };
    await this.ctx.storage.put(ACCESS_CODE_KEY, this.accessCodeConfig);
    this.lastGeneratedCode = code;
    this.validTickets.clear();
    this.verifiedSessionIds.clear();
    this.guestVerified = false;
    this.failedAttempts = 0;
    this.lockedUntil = 0;
    return jsonResponse({
      ok: true,
      enabled: true,
      code,
      guestVerified: false
    });
  }
  handleGetAccessCode(creatorToken) {
    if (!this.roomMeta || this.roomMeta.creatorToken !== creatorToken) {
      return jsonResponse({ error: "Unauthorized." }, 403);
    }
    return jsonResponse({
      ok: true,
      enabled: Boolean(this.accessCodeConfig?.enabled && !this.accessCodeConfig?.revoked),
      code: this.lastGeneratedCode,
      guestVerified: this.guestVerified
    });
  }
  async handleVerifyAccessCode(payload) {
    if (!this.roomMeta || this.roomMeta.status !== "open") {
      return jsonResponse({ error: "Room is unavailable." }, 410);
    }
    if (!this.accessCodeConfig || !this.accessCodeConfig.enabled) {
      return jsonResponse({ ok: true });
    }
    if (this.accessCodeConfig.revoked) {
      return jsonResponse({
        ok: false,
        error: "Access code has been revoked by the creator."
      }, 403);
    }
    const now = Date.now();
    if (this.lockedUntil > now) {
      const retryAfterSeconds = Math.ceil((this.lockedUntil - now) / 1e3);
      return jsonResponse({
        ok: false,
        error: "Too many failed attempts. Temporary lockout in effect.",
        retryAfterSeconds
      }, 429);
    }
    if (payload.creatorToken) {
      if (payload.creatorToken !== this.roomMeta.creatorToken) {
        return jsonResponse({ ok: false, error: "Unauthorized creator token." }, 403);
      }
    } else if (payload.inviteToken) {
      const invite = this.invites.get(payload.inviteToken);
      if (!invite || invite.revokedAt || invite.expiresAt <= now) {
        return jsonResponse({ ok: false, error: "Invitation is invalid or has expired." }, 403);
      }
      if (payload.sessionId && invite.consumedBySessionId && invite.consumedBySessionId !== payload.sessionId) {
        return jsonResponse({ ok: false, error: "This invitation was consumed by another session." }, 403);
      }
    } else {
      return jsonResponse({ ok: false, error: "Valid invitation or creator token required." }, 403);
    }
    const salt = base64UrlToBytes(this.accessCodeConfig.saltBase64Url);
    const expectedHash = base64UrlToBytes(this.accessCodeConfig.hashBase64Url);
    const valid = await verifyAccessCode(payload.accessCode || "", salt, expectedHash);
    if (!valid) {
      this.failedAttempts += 1;
      if (this.failedAttempts >= 5) {
        this.lockedUntil = Date.now() + 6e4;
        this.failedAttempts = 0;
        return jsonResponse({
          ok: false,
          error: "Access Denied. Too many failed attempts. Locked out for 60 seconds.",
          retryAfterSeconds: 60
        }, 429);
      }
      return jsonResponse({
        ok: false,
        error: "Access Denied. Incorrect access code.",
        remainingAttempts: 5 - this.failedAttempts
      }, 401);
    }
    this.failedAttempts = 0;
    this.lockedUntil = 0;
    if (payload.inviteToken) {
      this.guestVerified = true;
    }
    const ticketBytes = crypto.getRandomValues(new Uint8Array(32));
    const ticket = bytesToBase64Url(ticketBytes);
    this.validTickets.set(ticket, {
      createdAt: now,
      expiresAt: now + 5 * 60 * 1e3,
      inviteToken: payload.inviteToken
    });
    return jsonResponse({ ok: true, ticket });
  }
  async destroyRoom(reason, creatorToken) {
    if (!this.roomMeta) {
      return jsonResponse({ error: "Room not found." }, 404);
    }
    if (creatorToken !== this.roomMeta.creatorToken) {
      return jsonResponse({ error: "Unauthorized." }, 403);
    }
    await this.transitionRoom("destroyed", reason);
    return jsonResponse(this.publicMetadata(this.roomMeta));
  }
  async transitionRoom(status, reason) {
    if (!this.roomMeta || this.roomMeta.status !== "open") {
      return;
    }
    this.roomMeta.status = status;
    this.roomMeta.destroyedAt = Date.now();
    this.roomMeta.lastActivityAt = Date.now();
    await this.ctx.storage.put(ROOM_META_KEY, this.roomMeta);
    await this.ctx.storage.deleteAlarm();
    this.messages.clear();
    await this.persistMessages();
    this.broadcast({
      type: "room_state",
      status,
      expiresAt: this.roomMeta.expiresAt,
      reason
    });
    for (const socket of this.ctx.getWebSockets()) {
      socket.close(4e3, status);
    }
  }
  async expireIfDue() {
    if (!this.roomMeta || this.roomMeta.status !== "open") return false;
    const reason = roomExpiryReason(this.roomMeta, Date.now(), this.connectedSessionIds().length);
    if (!reason) return false;
    await this.transitionRoom("expired", reason);
    return true;
  }
  async markRoomActivity() {
    if (!this.roomMeta || this.roomMeta.status !== "open") {
      return;
    }
    this.roomMeta.lastActivityAt = Date.now();
    await this.ctx.storage.put(ROOM_META_KEY, this.roomMeta);
    await this.scheduleNextAlarm();
  }
  async scheduleNextAlarm() {
    if (!this.roomMeta || this.roomMeta.status !== "open") {
      return;
    }
    const candidates = [
      this.roomMeta.expiresAt,
      typeof this.roomMeta.inactivityTimeoutMs === "number" ? this.roomMeta.lastActivityAt + this.roomMeta.inactivityTimeoutMs : void 0,
      ...this.openWebSockets().map((socket) => socket.deserializeAttachment()).filter((attachment) => attachment?.sessionId === "").map((attachment) => attachment.connectedAt + JOIN_TIMEOUT_MS)
    ];
    for (const record of this.messages.values()) {
      if (record.status === "seen" && record.seenAt) {
        const delaySec = record.expiresAfterReadSeconds ?? this.roomMeta.disappearAfterReadSeconds ?? 0;
        candidates.push(record.seenAt + delaySec * 1e3);
      } else {
        candidates.push(record.fallbackExpiresAt);
      }
    }
    const validCandidates = candidates.filter((value) => typeof value === "number");
    if (validCandidates.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(...validCandidates));
  }
  async persistInvites() {
    await this.ctx.storage.put(INVITES_KEY, [...this.invites.entries()]);
  }
  async broadcastPresence() {
    if (!this.roomMeta) {
      return;
    }
    this.roomMeta.participantCount = this.connectedSessionIds().length;
    await this.ctx.storage.put(ROOM_META_KEY, this.roomMeta);
    this.broadcast({
      type: "presence",
      presence: this.presenceSnapshot()
    });
  }
  async disconnectSession(targetSessionId, reason, closeReason) {
    this.broadcastToSessions([targetSessionId], {
      type: "participant_kicked",
      sessionId: targetSessionId,
      reason
    });
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      if (attachment?.sessionId === targetSessionId) {
        socket.serializeAttachment({ ...attachment, sessionId: "" });
        socket.close(4403, closeReason);
      }
    }
    if (this.roomMeta?.status === "open") {
      this.roomMeta.membershipVersion += 1;
      await this.ctx.storage.put(ROOM_META_KEY, this.roomMeta);
    }
    this.broadcast({
      type: "peer_left",
      sessionId: targetSessionId,
      membershipVersion: this.roomMeta?.membershipVersion ?? 0
    });
    await this.broadcastPresence();
    await this.markRoomActivity();
  }
  broadcast(event) {
    const payload = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      if (!attachment?.sessionId) continue;
      this.sendIfOpen(socket, payload);
    }
  }
  broadcastToOtherParticipants(senderSessionId, event) {
    const targets = this.connectedSessionIds().filter((sessionId) => sessionId !== senderSessionId);
    this.broadcastToSessions(targets, event);
  }
  broadcastToSessions(sessionIds, event) {
    const payload = JSON.stringify(event);
    const allowed = new Set(sessionIds);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      if (attachment?.sessionId && allowed.has(attachment.sessionId)) {
        this.sendIfOpen(socket, payload);
      }
    }
  }
  sendIfOpen(socket, payload) {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      socket.send(payload);
    } catch {
    }
  }
  presenceSnapshot() {
    const ids = this.connectedSessionIds();
    return {
      count: ids.length,
      connectedSessionIds: ids
    };
  }
  // Source of truth for connected participants, derived from live WebSockets so
  // it survives Durable Object hibernation. Deduplicated by session id.
  connectedSessions() {
    const seen = /* @__PURE__ */ new Set();
    const sessions = [];
    for (const socket of this.openWebSockets()) {
      const attachment = socket.deserializeAttachment();
      if (attachment?.sessionId && !seen.has(attachment.sessionId)) {
        seen.add(attachment.sessionId);
        sessions.push(attachment);
      }
    }
    return sessions;
  }
  connectedSessionIds() {
    return this.connectedSessions().map((session) => session.sessionId);
  }
  openWebSockets() {
    return this.ctx.getWebSockets().filter((socket) => socket.readyState === WebSocket.OPEN);
  }
  isConnected(sessionId) {
    return this.connectedSessions().some((session) => session.sessionId === sessionId);
  }
  describePeer(peer) {
    return {
      sessionId: peer.sessionId,
      creator: peer.creator,
      connectedAt: peer.connectedAt,
      identityKey: peer.identityKey,
      agreementKey: peer.agreementKey
    };
  }
  publicMetadata(meta) {
    return {
      roomId: meta.roomId,
      createdAt: meta.createdAt,
      expiresAt: meta.expiresAt,
      inactivityTimeoutMs: meta.inactivityTimeoutMs,
      maxAgeMs: meta.maxAgeMs,
      disappearAfterReadSeconds: meta.disappearAfterReadSeconds,
      status: meta.status,
      participantCount: this.connectedSessionIds().length,
      creatorJoined: meta.creatorJoined,
      lastActivityAt: meta.lastActivityAt,
      membershipVersion: meta.membershipVersion,
      destroyedAt: meta.destroyedAt,
      accessCodeProtected: Boolean(this.accessCodeConfig?.enabled && !this.accessCodeConfig?.revoked),
      accessCodeVerified: this.guestVerified
    };
  }
};

// src/community.ts
var REPO = "shawnbure/elm-chat";
var TTL_MS = 15 * 60 * 1e3;
function mapIssue(issue, date) {
  if (issue.pull_request || !Number.isSafeInteger(issue.number) || (issue.number ?? 0) < 1 || typeof issue.title !== "string" || !date || !Number.isFinite(Date.parse(date))) {
    return null;
  }
  return {
    number: issue.number,
    title: issue.title.slice(0, 180),
    url: `https://github.com/${REPO}/issues/${issue.number}`,
    date
  };
}
__name(mapIssue, "mapIssue");
function shapeCommunityFeed(open, closed) {
  const fixes = closed.filter((issue) => issue.state_reason === "completed" || issue.state_reason == null).map((issue) => mapIssue(issue, issue.closed_at)).filter((issue) => issue !== null).sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, 5);
  const requests = open.map((issue) => mapIssue(issue, issue.created_at)).filter((issue) => issue !== null).sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, 5);
  return { fixes, requests };
}
__name(shapeCommunityFeed, "shapeCommunityFeed");
var cache = null;
var pending = null;
async function fetchIssues(state) {
  const url = new URL(`https://api.github.com/repos/${REPO}/issues`);
  url.searchParams.set("state", state);
  url.searchParams.set("sort", "updated");
  url.searchParams.set("direction", "desc");
  url.searchParams.set("per_page", "50");
  const response = await fetch(url, {
    headers: {
      "user-agent": "elm-chat",
      accept: "application/vnd.github+json"
    }
  });
  if (!response.ok) throw new Error(`GitHub issues unavailable: ${response.status}`);
  const issues = await response.json();
  if (!Array.isArray(issues)) throw new Error("Invalid GitHub issues response.");
  return issues;
}
__name(fetchIssues, "fetchIssues");
async function getCommunityFeed() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.feed;
  pending ??= Promise.all([fetchIssues("open"), fetchIssues("closed")]).then(([open, closed]) => {
    const feed = shapeCommunityFeed(open, closed);
    cache = { at: Date.now(), feed };
    return feed;
  }).finally(() => {
    pending = null;
  });
  try {
    return await pending;
  } catch {
    if (cache) return cache.feed;
    throw new Error("Community feed unavailable.");
  }
}
__name(getCommunityFeed, "getCommunityFeed");

// src/index.ts
function recordGrowth(env, event, source = "") {
  env.GROWTH?.writeDataPoint({
    indexes: [event],
    blobs: [source],
    doubles: [1]
  });
}
__name(recordGrowth, "recordGrowth");
function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff"
    }
  });
}
__name(json, "json");
function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; connect-src 'self' https: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
__name(withSecurityHeaders, "withSecurityHeaders");
function canonicalOriginRedirect(request) {
  const url = new URL(request.url);
  const requestHost = (request.headers.get("host") ?? url.hostname).split(":", 1)[0].toLowerCase();
  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.toLowerCase();
  const requestProtocol = forwardedProtocol === "http" || forwardedProtocol === "https" ? forwardedProtocol : url.protocol.slice(0, -1);
  const isElmChatHost = requestHost === "elm.chat" || requestHost === "www.elm.chat";
  if (!isElmChatHost || requestProtocol === "https" && requestHost === "elm.chat") {
    return null;
  }
  url.protocol = "https:";
  url.hostname = "elm.chat";
  url.port = "";
  return new Response(null, {
    status: 308,
    headers: {
      location: url.toString(),
      "cache-control": "public, max-age=86400"
    }
  });
}
__name(canonicalOriginRedirect, "canonicalOriginRedirect");
function isWebSocketUpgrade(request) {
  return request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}
__name(isWebSocketUpgrade, "isWebSocketUpgrade");
function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
__name(base64Url, "base64Url");
function randomRoomId() {
  const bytes = new Uint8Array(ROOM_ID_BYTES);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}
__name(randomRoomId, "randomRoomId");
function randomToken() {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}
__name(randomToken, "randomToken");
async function safeJson2(request) {
  return await request.json();
}
__name(safeJson2, "safeJson");
function buildRoomUrl(request, roomId) {
  const url = new URL(request.url);
  return `${url.origin}/c/${roomId}`;
}
__name(buildRoomUrl, "buildRoomUrl");
async function verifyTurnstile(secret, token, remoteIp) {
  if (!token) {
    return false;
  }
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (remoteIp) {
    form.append("remoteip", remoteIp);
  }
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form
    });
    if (!response.ok) {
      return false;
    }
    const outcome = await response.json();
    return outcome.success === true;
  } catch {
    return false;
  }
}
__name(verifyTurnstile, "verifyTurnstile");
async function handleCreateRoom(request, env) {
  const body = await safeJson2(request).catch(() => ({}));
  if (env.TURNSTILE_SECRET) {
    const passed = await verifyTurnstile(
      env.TURNSTILE_SECRET,
      body.turnstileToken,
      request.headers.get("CF-Connecting-IP")
    );
    if (!passed) {
      return json({ error: "Bot verification failed. Please try again." }, 403);
    }
  }
  const now = Date.now();
  const roomId = randomRoomId();
  const creatorToken = randomToken();
  const disappearAfterReadSeconds = body.disappearAfterReadSeconds === void 0 ? DEFAULT_DISAPPEAR_AFTER_READ_SECONDS : body.disappearAfterReadSeconds;
  const inactivityTimeoutMs = body.inactivityTimeoutMs === void 0 ? DEFAULT_INACTIVITY_TIMEOUT_MS : body.inactivityTimeoutMs;
  const maxAgeMs = body.maxAgeMs === void 0 ? null : body.maxAgeMs;
  const expiresAt = typeof maxAgeMs === "number" ? now + maxAgeMs : null;
  const response = {
    roomId,
    roomUrl: buildRoomUrl(request, roomId),
    websocketPath: `/api/rooms/${roomId}/ws`,
    createdAt: now,
    expiresAt,
    inactivityTimeoutMs,
    maxAgeMs,
    disappearAfterReadSeconds,
    creatorToken
  };
  const stub = env.ROOM_OBJECT.getByName(roomId);
  const bootstrapRes = await stub.fetch("https://room/internal/bootstrap", {
    method: "POST",
    body: JSON.stringify({
      ...response,
      accessCode: body.accessCode,
      generateAccessCode: body.generateAccessCode
    })
  });
  if (bootstrapRes.ok) {
    const bootstrapData = await bootstrapRes.json();
    if (bootstrapData.accessCode) {
      response.accessCode = bootstrapData.accessCode;
    }
    if (typeof bootstrapData.accessCodeProtected === "boolean") {
      response.accessCodeProtected = bootstrapData.accessCodeProtected;
    }
  }
  recordGrowth(
    env,
    "room_created",
    isAcquisitionSource(body.acquisitionSource) ? body.acquisitionSource : "direct"
  );
  return json(response, 201);
}
__name(handleCreateRoom, "handleCreateRoom");
async function handleGetRoom(roomId, env) {
  const stub = env.ROOM_OBJECT.getByName(roomId);
  return stub.fetch("https://room/internal/metadata");
}
__name(handleGetRoom, "handleGetRoom");
async function handleDestroyRoom(request, roomId, env) {
  const { creatorToken } = await safeJson2(request);
  const stub = env.ROOM_OBJECT.getByName(roomId);
  return stub.fetch("https://room/internal/destroy", {
    method: "POST",
    body: JSON.stringify({ creatorToken })
  });
}
__name(handleDestroyRoom, "handleDestroyRoom");
async function handleRoomWebSocket(request, roomId, env) {
  const stub = env.ROOM_OBJECT.getByName(roomId);
  return stub.fetch("https://room/ws", request);
}
__name(handleRoomWebSocket, "handleRoomWebSocket");
async function handleCreateInvite(request, roomId, env) {
  const payload = await safeJson2(request);
  const stub = env.ROOM_OBJECT.getByName(roomId);
  const response = await stub.fetch("https://room/internal/invites/create", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  if (response.ok) {
    recordGrowth(env, "invite_created");
  }
  return response;
}
__name(handleCreateInvite, "handleCreateInvite");
async function handleListInvites(request, roomId, env) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.match(/^Bearer [A-Za-z0-9_-]+$/i)) {
    return json({ error: "Unauthorized." }, 403);
  }
  const stub = env.ROOM_OBJECT.getByName(roomId);
  return stub.fetch("https://room/internal/invites", {
    headers: { authorization }
  });
}
__name(handleListInvites, "handleListInvites");
async function handleRevokeInvite(request, roomId, env) {
  const payload = await safeJson2(request);
  const stub = env.ROOM_OBJECT.getByName(roomId);
  return stub.fetch("https://room/internal/invites/revoke", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}
__name(handleRevokeInvite, "handleRevokeInvite");
var GITHUB_REPO = "shawnbure/elm-chat";
var CLOUDFLARE_DEPLOY_URL = "https://deploy.workers.cloudflare.com/?url=https://github.com/shawnbure/elm-chat";
var GITHUB_STATS_TTL_MS = 60 * 60 * 1e3;
var MARKETING_PATHS = /* @__PURE__ */ new Set([
  "/self-destructing-chat",
  "/send-a-password-securely",
  "/send-a-file-securely",
  "/one-time-secret-chat",
  "/temporary-private-chat",
  "/journalist-source-communication",
  "/temporary-financial-handoff",
  "/security-and-limitations",
  "/press",
  "/the-internet-needs-places-that-forget",
  "/why-i-built-elm-chat",
  "/deletion-distributed-systems-contract",
  "/building-ephemeral-chat-cloudflare",
  "/durable-objects-websocket-hibernation",
  "/cloudflare-deploy-button-monorepo",
  "/single-use-invite-links"
]);
var githubStatsCache = null;
async function handleGithubStats() {
  const now = Date.now();
  if (!githubStatsCache || now - githubStatsCache.at > GITHUB_STATS_TTL_MS) {
    let stars = null;
    let forks = null;
    try {
      const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}`, {
        headers: {
          "user-agent": "elm-chat",
          accept: "application/vnd.github+json"
        }
      });
      if (res.ok) {
        const data = await res.json();
        stars = typeof data.stargazers_count === "number" ? data.stargazers_count : null;
        forks = typeof data.forks_count === "number" ? data.forks_count : null;
      }
    } catch {
    }
    githubStatsCache = { at: stars === null ? now - GITHUB_STATS_TTL_MS + 5 * 60 * 1e3 : now, stars, forks };
  }
  return json({
    repo: GITHUB_REPO,
    stars: githubStatsCache.stars,
    forks: githubStatsCache.forks
  });
}
__name(handleGithubStats, "handleGithubStats");
function handleCloudflareDeploy(request, env) {
  const source = new URL(request.url).searchParams.get("source");
  if (request.method === "GET") {
    recordGrowth(
      env,
      "external_deploy_clicked",
      isAcquisitionSource(source) && source !== "invite" ? source : "direct"
    );
  }
  return new Response(null, {
    status: 302,
    headers: {
      location: CLOUDFLARE_DEPLOY_URL,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer"
    }
  });
}
__name(handleCloudflareDeploy, "handleCloudflareDeploy");
function routeApi(request, env) {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/api/growth") {
    return safeJson2(request).then(({ event, source }) => {
      if (event === "make_your_own_clicked" || event === "invite_share_handoff") {
        recordGrowth(env, event);
        return new Response(null, { status: 204 });
      }
      if (event === "github_star_clicked" || event === "good_first_issue_clicked") {
        recordGrowth(
          env,
          event,
          isAcquisitionSource(source) && source !== "invite" ? source : "direct"
        );
        return new Response(null, { status: 204 });
      }
      const isExternalEvent = event === "external_referral_viewed" || event === "external_source_clicked" || event === "external_deploy_clicked";
      if (isExternalEvent) {
        if (!isExternalAcquisitionSource(source)) {
          return json({ error: "Unsupported event." }, 400);
        }
        recordGrowth(env, event, source);
        return new Response(null, { status: 204 });
      }
      const isMarketingEvent = event === "marketing_page_viewed" || event === "marketing_cta_clicked" || event === "marketing_source_clicked" || event === "marketing_deploy_clicked";
      if (!isMarketingEvent || !isAcquisitionSource(source) || source === "invite") {
        return json({ error: "Unsupported event." }, 400);
      }
      recordGrowth(env, event, source);
      return new Response(null, { status: 204 });
    }).catch(() => json({ error: "Invalid event." }, 400));
  }
  if (request.method === "POST" && url.pathname === "/api/rooms") {
    return handleCreateRoom(request, env);
  }
  if (request.method === "GET" && url.pathname === "/api/stars") {
    return handleGithubStats();
  }
  if (request.method === "GET" && url.pathname === "/api/community") {
    return getCommunityFeed().then((feed) => json(feed)).catch(() => json({ error: "Community feed unavailable." }, 503));
  }
  const revokeMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/invites\/revoke$/);
  if (revokeMatch && request.method === "POST") {
    return handleRevokeInvite(request, revokeMatch[1], env);
  }
  const accessVerifyMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/access-code\/verify$/);
  if (accessVerifyMatch && request.method === "POST") {
    const stub = env.ROOM_OBJECT.getByName(accessVerifyMatch[1]);
    return stub.fetch("https://room/internal/access-code/verify", request);
  }
  const accessManageMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/access-code$/);
  if (accessManageMatch) {
    const stub = env.ROOM_OBJECT.getByName(accessManageMatch[1]);
    if (request.method === "GET") {
      return stub.fetch("https://room/internal/access-code", {
        headers: request.headers
      });
    }
    if (request.method === "POST") {
      return stub.fetch("https://room/internal/access-code", request);
    }
    return Promise.resolve(json({ error: "Method not allowed." }, 405));
  }
  const match = url.pathname.match(/^\/api\/rooms\/([^/]+)(?:\/(destroy|ws|invites))?$/);
  if (!match) {
    return Promise.resolve(json({ error: "Not found." }, 404));
  }
  const roomId = match[1];
  const action = match[2];
  if (request.method === "GET" && !action) {
    return handleGetRoom(roomId, env);
  }
  if (request.method === "POST" && action === "destroy") {
    return handleDestroyRoom(request, roomId, env);
  }
  if (action === "invites" && request.method === "POST") {
    return handleCreateInvite(request, roomId, env);
  }
  if (action === "invites" && request.method === "GET") {
    return handleListInvites(request, roomId, env);
  }
  if (request.method === "GET" && action === "ws") {
    return handleRoomWebSocket(request, roomId, env);
  }
  return Promise.resolve(json({ error: "Method not allowed." }, 405));
}
__name(routeApi, "routeApi");
var src_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const redirect = canonicalOriginRedirect(request);
    if (redirect) {
      return withSecurityHeaders(redirect);
    }
    if (url.pathname.startsWith("/api/")) {
      try {
        const response = await routeApi(request, env);
        return isWebSocketUpgrade(request) ? response : withSecurityHeaders(response);
      } catch {
        return withSecurityHeaders(json({ error: "Internal error." }, 500));
      }
    }
    if (url.pathname === "/deploy/cloudflare" && (request.method === "GET" || request.method === "HEAD")) {
      return withSecurityHeaders(handleCloudflareDeploy(request, env));
    }
    if (MARKETING_PATHS.has(url.pathname)) {
      const assetUrl = new URL(request.url);
      assetUrl.pathname += "/";
      return withSecurityHeaders(await env.ASSETS.fetch(new Request(assetUrl, request)));
    }
    const assetResponse = await env.ASSETS.fetch(request);
    if (url.pathname !== "/" && !url.pathname.split("/").at(-1)?.includes(".")) {
      const headers = new Headers(assetResponse.headers);
      headers.set("Cache-Control", "no-store");
      return withSecurityHeaders(
        new Response(assetResponse.body, {
          status: assetResponse.status,
          statusText: assetResponse.statusText,
          headers
        })
      );
    }
    return withSecurityHeaders(assetResponse);
  }
};

// ../../node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-l0NC2n/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// ../../node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-l0NC2n/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  RoomDurableObject,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
