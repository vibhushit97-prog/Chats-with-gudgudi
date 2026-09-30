import {
  DEFAULT_DISAPPEAR_AFTER_READ_SECONDS,
  DEFAULT_INACTIVITY_TIMEOUT_MS,
  MAX_CONNECTIONS_PER_ROOM,
  type AccessCodeManageRequest,
  type AccessCodeManageResponse,
  type AccessCodeVerifyRequest,
  type AccessCodeVerifyResponse,
  type ClientEvent,
  type CreateRoomResponse,
  type DestroyMessagePayload,
  type ErrorEventPayload,
  type JoinPayload,
  type KickParticipantPayload,
  type MessageDeliveredEvent,
  type MessageDeliveredPayload,
  type MessageDestroyedEvent,
  type MessageDeliveryStatus,
  type MessageSeenEvent,
  type MessageSeenPayload,
  type ParticipantKickedEvent,
  type PeerDataRelayEvent,
  type PeerDataRelayPayload,
  type PeerDescriptor,
  type PeerJoinedEvent,
  type PeerLeftEvent,
  type PresenceEvent,
  type PresenceSnapshot,
  type RoomInvite,
  type RoomMetadata,
  type RoomStateEvent,
  type ServerEvent
} from "@elm-chat/shared";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  generateAccessCode,
  hashAccessCode,
  verifyAccessCode
} from "@elm-chat/crypto";
import { DurableObject } from "cloudflare:workers";
import { roomExpiryReason } from "./expiry";

type RoomStorage = RoomMetadata & {
  creatorToken: string;
};

interface AccessCodeStorage {
  enabled: boolean;
  revoked?: boolean;
  saltBase64Url: string;
  hashBase64Url: string;
}

export interface RoomMessageRecord {
  messageId: string;
  senderSessionId: string;
  sentAt: number;
  status: MessageDeliveryStatus;
  expiresAfterReadSeconds: number | null;
  fallbackExpiresAt: number;
  deliveredAt?: number;
  seenAt?: number;
  seenBySessionId?: string;
  destroyedAt?: number;
}

// Stored on each accepted WebSocket via serializeAttachment. This survives
// Durable Object hibernation, so it — not an in-memory map — is the source of
// truth for who is connected. An empty sessionId marks a socket that has been
// accepted but has not completed a join yet.
type AttachmentRecord = {
  sessionId: string;
  creator: boolean;
  identityKey: string;
  agreementKey: string;
  connectedAt: number;
};

type RoomBootstrap = Pick<
  CreateRoomResponse,
  | "roomId"
  | "createdAt"
  | "expiresAt"
  | "inactivityTimeoutMs"
  | "maxAgeMs"
  | "disappearAfterReadSeconds"
  | "creatorToken"
> & {
  accessCode?: string | null;
  generateAccessCode?: boolean;
};

export interface Env {
  GROWTH?: AnalyticsEngineDataset;
  ROOM_OBJECT: DurableObjectNamespace<RoomDurableObject>;
}

const ROOM_META_KEY = "room:meta";
const INVITES_KEY = "room:invites";
const MESSAGES_KEY = "room:messages";
const DESTROYED_MESSAGES_KEY = "room:destroyed_messages";
const ACCESS_CODE_KEY = "room:access_code";
const DEFAULT_INVITE_TTL_MS = 10 * 60 * 1000;
const JOIN_TIMEOUT_MS = 15 * 1000;

type InviteAdmission =
  | { ok: true; invite?: RoomInvite; newlyClaimed: boolean }
  | { ok: false; code: string; message: string; closeReason: string };

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function wsResponse(client: WebSocket): Response {
  return new Response(null, {
    status: 101,
    webSocket: client
  } as ResponseInit & { webSocket: WebSocket });
}

function errorEvent(code: string, message: string): ErrorEventPayload {
  return { type: "error", code, message };
}

async function safeJson<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
}

export class RoomDurableObject extends DurableObject<Env> {
  private roomMeta: RoomStorage | null = null;
  private invites = new Map<string, RoomInvite>();
  private messages = new Map<string, RoomMessageRecord>();
  private destroyedMessageIds = new Set<string>();
  private accessCodeConfig: AccessCodeStorage | null = null;
  private lastGeneratedCode?: string;
  private failedAttempts = 0;
  private lockedUntil = 0;
  private guestVerified = false;
  private validTickets = new Map<string, { createdAt: number; expiresAt: number; inviteToken?: string }>();
  private verifiedSessionIds = new Set<string>();
  private storageReady: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.storageReady = this.ctx.blockConcurrencyWhile(async () => {
      this.roomMeta = (await this.ctx.storage.get<RoomStorage>(ROOM_META_KEY)) ?? null;
      if (this.roomMeta && !Number.isSafeInteger(this.roomMeta.membershipVersion)) {
        this.roomMeta.membershipVersion = 0;
      }
      this.invites = new Map((await this.ctx.storage.get<[string, RoomInvite][]>(INVITES_KEY)) ?? []);
      this.messages = new Map((await this.ctx.storage.get<[string, RoomMessageRecord][]>(MESSAGES_KEY)) ?? []);
      this.destroyedMessageIds = new Set((await this.ctx.storage.get<string[]>(DESTROYED_MESSAGES_KEY)) ?? []);
      this.accessCodeConfig = (await this.ctx.storage.get<AccessCodeStorage>(ACCESS_CODE_KEY)) ?? null;
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.storageReady;

    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/internal/bootstrap") {
      return this.bootstrapRoom(await safeJson<RoomBootstrap>(request));
    }

    if (request.method === "GET" && url.pathname === "/internal/metadata") {
      return this.handleMetadata();
    }

    if (request.method === "POST" && url.pathname === "/internal/destroy") {
      const payload = await safeJson<{ creatorToken: string }>(request);
      return this.destroyRoom("destroyed", payload.creatorToken);
    }

    if (request.method === "POST" && url.pathname === "/internal/invites/create") {
      const payload = await safeJson<{ creatorToken: string; ttlMs?: number }>(request);
      return this.createInvite(payload.creatorToken, payload.ttlMs);
    }

    if (request.method === "GET" && url.pathname === "/internal/invites") {
      const creatorToken = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]+)$/i)?.[1] ?? "";
      return this.listInvites(creatorToken);
    }

    if (request.method === "POST" && url.pathname === "/internal/invites/revoke") {
      const payload = await safeJson<{ creatorToken: string; token: string }>(request);
      return this.revokeInvite(payload.creatorToken, payload.token);
    }

    if (request.method === "POST" && url.pathname === "/internal/access-code") {
      const creatorToken =
        request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]+)$/i)?.[1] ?? "";
      const payload = await safeJson<AccessCodeManageRequest & { creatorToken?: string }>(request);
      return this.handleManageAccessCode(creatorToken || payload.creatorToken || "", payload);
    }

    if (request.method === "GET" && url.pathname === "/internal/access-code") {
      const creatorToken =
        request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]+)$/i)?.[1] ?? "";
      return this.handleGetAccessCode(creatorToken);
    }

    if (request.method === "POST" && url.pathname === "/internal/access-code/verify") {
      const payload = await safeJson<AccessCodeVerifyRequest>(request);
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
      } satisfies AttachmentRecord);
      await this.scheduleNextAlarm();
      return wsResponse(client);
    }

    return jsonResponse({ error: "Not found." }, 404);
  }

  async alarm(): Promise<void> {
    await this.storageReady;
    if (await this.expireIfDue()) return;
    const now = Date.now();
    for (const socket of this.openWebSockets()) {
      const attachment = socket.deserializeAttachment() as AttachmentRecord | null;
      if (attachment?.sessionId === "" && attachment.connectedAt + JOIN_TIMEOUT_MS <= now) {
        socket.close(4408, "join timeout");
      }
    }
    for (const [id, record] of [...this.messages.entries()]) {
      if (record.status === "seen") {
        const delaySec = record.expiresAfterReadSeconds ?? this.roomMeta?.disappearAfterReadSeconds ?? 0;
        if (record.seenAt && record.seenAt + delaySec * 1000 <= now) {
          await this.destroyMessage(id, "seen");
        }
      } else if (record.fallbackExpiresAt <= now) {
        await this.destroyMessage(id, "expired");
      }
    }
    await this.scheduleNextAlarm();
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.storageReady;
    if (await this.expireIfDue()) return;
    if (typeof message !== "string") {
      ws.send(JSON.stringify(errorEvent("binary_not_supported", "Binary payloads are not supported.")));
      return;
    }

    let parsed: ClientEvent;
    try {
      parsed = JSON.parse(message) as ClientEvent;
    } catch {
      ws.send(JSON.stringify(errorEvent("invalid_json", "Message must be valid JSON.")));
      return;
    }
    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
      ws.send(JSON.stringify(errorEvent("invalid_event", "Message must be a room event.")));
      return;
    }

    const attachment = ws.deserializeAttachment() as AttachmentRecord | null;
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

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.storageReady;
    const attachment = ws.deserializeAttachment() as AttachmentRecord | null;
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
    } satisfies PeerLeftEvent);
    await this.broadcastPresence();
  }

  private async bootstrapRoom(bootstrap: RoomBootstrap): Promise<Response> {
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

    const meta: RoomStorage = {
      roomId: bootstrap.roomId,
      createdAt: bootstrap.createdAt,
      expiresAt: bootstrap.expiresAt,
      inactivityTimeoutMs: bootstrap.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS,
      maxAgeMs: bootstrap.maxAgeMs ?? null,
      disappearAfterReadSeconds:
        bootstrap.disappearAfterReadSeconds ?? DEFAULT_DISAPPEAR_AFTER_READ_SECONDS,
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

  private handleMetadata(): Response {
    if (!this.roomMeta) {
      return jsonResponse({ error: "Room not found." }, 404);
    }

    return jsonResponse(this.publicMetadata(this.roomMeta));
  }

  private async handleJoin(ws: WebSocket, payload: JoinPayload): Promise<void> {
    if (!this.roomMeta || this.roomMeta.status !== "open") {
      ws.send(JSON.stringify(errorEvent("room_unavailable", "Room is unavailable.")));
      ws.close(4404, "room unavailable");
      return;
    }

    const existing = ws.deserializeAttachment() as AttachmentRecord | null;
    if (existing?.sessionId) {
      ws.send(JSON.stringify(errorEvent("already_joined", "Session already joined.")));
      return;
    }

    if (
      !existing ||
      existing.connectedAt + JOIN_TIMEOUT_MS <= Date.now() ||
      typeof payload.sessionId !== "string" ||
      !payload.sessionId ||
      typeof payload.identityKey !== "string" ||
      !/^[A-Za-z0-9_-]{87}$/.test(payload.identityKey) ||
      typeof payload.agreementKey !== "string" ||
      !/^[A-Za-z0-9_-]{87}$/.test(payload.agreementKey)
    ) {
      ws.send(JSON.stringify(errorEvent("invalid_join", "Join was invalid or timed out.")));
      ws.close(4408, "invalid join");
      return;
    }

    const existingSession = this.connectedSessions().find(
      (session) => session.sessionId === payload.sessionId
    );
    if (existingSession) {
      ws.send(JSON.stringify(errorEvent(
        existingSession.identityKey === payload.identityKey && existingSession.agreementKey === payload.agreementKey
          ? "session_connected" : "identity_mismatch",
        existingSession.identityKey === payload.identityKey && existingSession.agreementKey === payload.agreementKey
          ? "This session is already connected."
          : "The session is already bound to another identity key."
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
      const isReconnectingAdmittedSession =
        this.verifiedSessionIds.has(payload.sessionId) &&
        Boolean(payload.inviteToken && this.invites.get(payload.inviteToken)?.consumedBySessionId === payload.sessionId);

      if (!isReconnectingAdmittedSession) {
        const ticket = payload.accessCodeTicket;
        const ticketRecord = ticket ? this.validTickets.get(ticket) : undefined;
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

    const session: AttachmentRecord = {
      sessionId: payload.sessionId,
      creator,
      connectedAt: Date.now(),
      identityKey: payload.identityKey,
      agreementKey: payload.agreementKey
    };
    ws.serializeAttachment(session satisfies AttachmentRecord);

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

    const peers = this.connectedSessions()
      .filter((peer) => peer.sessionId !== payload.sessionId)
      .sort((left, right) => left.connectedAt - right.connectedAt)
      .map((peer) => this.describePeer(peer));

    ws.send(
      JSON.stringify({
        type: "joined",
        room: this.publicMetadata(this.roomMeta),
        sessionId: payload.sessionId,
        creator,
        self: this.describePeer(session),
        peers,
        presence: this.presenceSnapshot()
      } satisfies ServerEvent)
    );

    this.broadcastToOtherParticipants(payload.sessionId, {
      type: "peer_joined",
      peer: this.describePeer(session),
      membershipVersion: this.roomMeta.membershipVersion
    } satisfies PeerJoinedEvent);

    await this.broadcastPresence();
    await this.markRoomActivity();
  }

  private async reserveInviteForJoin(
    creator: boolean,
    payload: JoinPayload
  ): Promise<InviteAdmission> {
    if (creator) {
      return { ok: true, newlyClaimed: false };
    }

    const invite = payload.inviteToken ? this.invites.get(payload.inviteToken) : undefined;
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

  private async handlePeerData(ws: WebSocket, payload: PeerDataRelayPayload): Promise<void> {
    if (!this.roomMeta || this.roomMeta.status !== "open") {
      ws.send(JSON.stringify(errorEvent("room_unavailable", "Room is unavailable.")));
      return;
    }

    const attachment = ws.deserializeAttachment() as AttachmentRecord | null;
    if (!attachment?.sessionId) {
      ws.send(JSON.stringify(errorEvent("join_required", "Join before relaying peer data.")));
      return;
    }

    const data = payload.data;
    if (
      !data ||
      data.protocolVersion !== 1 ||
      data.roomId !== this.roomMeta.roomId ||
      data.senderSessionId !== attachment.sessionId ||
      data.targetSessionId !== (payload.toSessionId ?? null) ||
      typeof data.eventId !== "string" ||
      typeof data.signature !== "string" ||
      !data.payload ||
      typeof data.payload.type !== "string"
    ) {
      ws.send(JSON.stringify(errorEvent("invalid_peer_event", "Peer event authentication metadata is invalid.")));
      return;
    }

    if (data.payload.type === "chat_message") {
      const envelope = (data.payload as { envelope?: { messageId?: string; senderSessionId?: string; sentAt?: number; expiresAfterReadSeconds?: number | null } }).envelope;
      if (
        envelope &&
        typeof envelope.messageId === "string" &&
        /^[0-9a-f-]{36}$/i.test(envelope.messageId) &&
        envelope.senderSessionId === attachment.sessionId
      ) {
        if (this.destroyedMessageIds.has(envelope.messageId)) {
          return;
        }
        if (!this.messages.has(envelope.messageId)) {
          const fallbackExpiresAt = this.roomMeta.expiresAt ?? (envelope.sentAt! + (this.roomMeta.maxAgeMs ?? 24 * 60 * 60 * 1000));
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
    } satisfies PeerDataRelayEvent;

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

  private async handleMessageDelivered(ws: WebSocket, payload: MessageDeliveredPayload): Promise<void> {
    const attachment = ws.deserializeAttachment() as AttachmentRecord | null;
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
      } satisfies MessageDeliveredEvent);
    }
  }

  private async handleMessageSeen(ws: WebSocket, payload: MessageSeenPayload): Promise<void> {
    const attachment = ws.deserializeAttachment() as AttachmentRecord | null;
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
    } satisfies MessageSeenEvent);

    const delaySec = record.expiresAfterReadSeconds ?? this.roomMeta?.disappearAfterReadSeconds ?? 0;
    if (delaySec === 0) {
      await this.destroyMessage(payload.messageId, "seen");
    } else {
      if (delaySec <= 60) {
        setTimeout(() => {
          void this.destroyMessage(payload.messageId, "seen");
        }, delaySec * 1000);
      }
      await this.scheduleNextAlarm();
    }
  }

  private async handleDestroyMessage(ws: WebSocket, payload: DestroyMessagePayload): Promise<void> {
    const attachment = ws.deserializeAttachment() as AttachmentRecord | null;
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

  private async destroyMessage(messageId: string, reason?: "seen" | "expired" | "manual"): Promise<void> {
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
    } satisfies MessageDestroyedEvent);
  }

  private async persistMessages(): Promise<void> {
    await this.ctx.storage.put(MESSAGES_KEY, [...this.messages.entries()]);
    await this.ctx.storage.put(DESTROYED_MESSAGES_KEY, [...this.destroyedMessageIds]);
  }

  private async kickParticipant(ws: WebSocket, payload: KickParticipantPayload): Promise<void> {
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

  private async createInvite(creatorToken: string, ttlMs?: number): Promise<Response> {
    if (!this.roomMeta) {
      return jsonResponse({ error: "Room not found." }, 404);
    }
    if (creatorToken !== this.roomMeta.creatorToken) {
      return jsonResponse({ error: "Unauthorized." }, 403);
    }
    const now = Date.now();
    const token = crypto.randomUUID();
    const invite: RoomInvite = {
      token,
      createdAt: now,
      expiresAt: now + Math.max(60_000, ttlMs ?? DEFAULT_INVITE_TTL_MS)
    };
    this.invites.set(token, invite);
    await this.persistInvites();
    return jsonResponse(invite, 201);
  }

  private listInvites(creatorToken: string): Response {
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

  private async revokeInvite(creatorToken: string, token: string): Promise<Response> {
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

  private async handleManageAccessCode(
    creatorToken: string,
    payload: AccessCodeManageRequest
  ): Promise<Response> {
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
      this.lastGeneratedCode = undefined;
      this.validTickets.clear();
      this.verifiedSessionIds.clear();
      this.guestVerified = false;
      return jsonResponse({ ok: true, enabled: false } satisfies AccessCodeManageResponse);
    }

    if (payload.action === "disable") {
      this.accessCodeConfig = {
        enabled: false,
        revoked: false,
        saltBase64Url: "",
        hashBase64Url: ""
      };
      await this.ctx.storage.put(ACCESS_CODE_KEY, this.accessCodeConfig);
      this.lastGeneratedCode = undefined;
      this.validTickets.clear();
      this.verifiedSessionIds.clear();
      this.guestVerified = false;
      return jsonResponse({ ok: true, enabled: false } satisfies AccessCodeManageResponse);
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
    } satisfies AccessCodeManageResponse);
  }

  private handleGetAccessCode(creatorToken: string): Response {
    if (!this.roomMeta || this.roomMeta.creatorToken !== creatorToken) {
      return jsonResponse({ error: "Unauthorized." }, 403);
    }

    return jsonResponse({
      ok: true,
      enabled: Boolean(this.accessCodeConfig?.enabled && !this.accessCodeConfig?.revoked),
      code: this.lastGeneratedCode,
      guestVerified: this.guestVerified
    } satisfies AccessCodeManageResponse);
  }

  private async handleVerifyAccessCode(payload: AccessCodeVerifyRequest): Promise<Response> {
    if (!this.roomMeta || this.roomMeta.status !== "open") {
      return jsonResponse({ error: "Room is unavailable." }, 410);
    }

    if (!this.accessCodeConfig || !this.accessCodeConfig.enabled) {
      return jsonResponse({ ok: true } satisfies AccessCodeVerifyResponse);
    }

    if (this.accessCodeConfig.revoked) {
      return jsonResponse({
        ok: false,
        error: "Access code has been revoked by the creator."
      } satisfies AccessCodeVerifyResponse, 403);
    }

    const now = Date.now();
    if (this.lockedUntil > now) {
      const retryAfterSeconds = Math.ceil((this.lockedUntil - now) / 1000);
      return jsonResponse({
        ok: false,
        error: "Too many failed attempts. Temporary lockout in effect.",
        retryAfterSeconds
      } satisfies AccessCodeVerifyResponse, 429);
    }

    if (payload.creatorToken) {
      if (payload.creatorToken !== this.roomMeta.creatorToken) {
        return jsonResponse({ ok: false, error: "Unauthorized creator token." } satisfies AccessCodeVerifyResponse, 403);
      }
    } else if (payload.inviteToken) {
      const invite = this.invites.get(payload.inviteToken);
      if (!invite || invite.revokedAt || invite.expiresAt <= now) {
        return jsonResponse({ ok: false, error: "Invitation is invalid or has expired." } satisfies AccessCodeVerifyResponse, 403);
      }
      if (payload.sessionId && invite.consumedBySessionId && invite.consumedBySessionId !== payload.sessionId) {
        return jsonResponse({ ok: false, error: "This invitation was consumed by another session." } satisfies AccessCodeVerifyResponse, 403);
      }
    } else {
      return jsonResponse({ ok: false, error: "Valid invitation or creator token required." } satisfies AccessCodeVerifyResponse, 403);
    }

    const salt = base64UrlToBytes(this.accessCodeConfig.saltBase64Url);
    const expectedHash = base64UrlToBytes(this.accessCodeConfig.hashBase64Url);
    const valid = await verifyAccessCode(payload.accessCode || "", salt, expectedHash);

    if (!valid) {
      this.failedAttempts += 1;
      if (this.failedAttempts >= 5) {
        this.lockedUntil = Date.now() + 60_000;
        this.failedAttempts = 0;
        return jsonResponse({
          ok: false,
          error: "Access Denied. Too many failed attempts. Locked out for 60 seconds.",
          retryAfterSeconds: 60
        } satisfies AccessCodeVerifyResponse, 429);
      }
      return jsonResponse({
        ok: false,
        error: "Access Denied. Incorrect access code.",
        remainingAttempts: 5 - this.failedAttempts
      } satisfies AccessCodeVerifyResponse, 401);
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
      expiresAt: now + 5 * 60 * 1000,
      inviteToken: payload.inviteToken
    });

    return jsonResponse({ ok: true, ticket } satisfies AccessCodeVerifyResponse);
  }

  private async destroyRoom(reason: string, creatorToken: string): Promise<Response> {
    if (!this.roomMeta) {
      return jsonResponse({ error: "Room not found." }, 404);
    }

    if (creatorToken !== this.roomMeta.creatorToken) {
      return jsonResponse({ error: "Unauthorized." }, 403);
    }

    await this.transitionRoom("destroyed", reason);
    return jsonResponse(this.publicMetadata(this.roomMeta));
  }

  private async transitionRoom(status: "expired" | "destroyed", reason: string): Promise<void> {
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
    } satisfies RoomStateEvent);

    for (const socket of this.ctx.getWebSockets()) {
      socket.close(4000, status);
    }
  }

  private async expireIfDue(): Promise<boolean> {
    if (!this.roomMeta || this.roomMeta.status !== "open") return false;
    const reason = roomExpiryReason(this.roomMeta, Date.now(), this.connectedSessionIds().length);
    if (!reason) return false;
    await this.transitionRoom("expired", reason);
    return true;
  }

  private async markRoomActivity(): Promise<void> {
    if (!this.roomMeta || this.roomMeta.status !== "open") {
      return;
    }
    this.roomMeta.lastActivityAt = Date.now();
    await this.ctx.storage.put(ROOM_META_KEY, this.roomMeta);
    await this.scheduleNextAlarm();
  }

  private async scheduleNextAlarm(): Promise<void> {
    if (!this.roomMeta || this.roomMeta.status !== "open") {
      return;
    }

    const candidates = [
      this.roomMeta.expiresAt,
      typeof this.roomMeta.inactivityTimeoutMs === "number"
        ? this.roomMeta.lastActivityAt + this.roomMeta.inactivityTimeoutMs
        : undefined,
      ...this.openWebSockets()
        .map((socket) => socket.deserializeAttachment() as AttachmentRecord | null)
        .filter((attachment): attachment is AttachmentRecord => attachment?.sessionId === "")
        .map((attachment) => attachment.connectedAt + JOIN_TIMEOUT_MS)
    ];

    for (const record of this.messages.values()) {
      if (record.status === "seen" && record.seenAt) {
        const delaySec = record.expiresAfterReadSeconds ?? this.roomMeta.disappearAfterReadSeconds ?? 0;
        candidates.push(record.seenAt + delaySec * 1000);
      } else {
        candidates.push(record.fallbackExpiresAt);
      }
    }

    const validCandidates = candidates.filter((value): value is number => typeof value === "number");

    if (validCandidates.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    await this.ctx.storage.setAlarm(Math.min(...validCandidates));
  }

  private async persistInvites(): Promise<void> {
    await this.ctx.storage.put(INVITES_KEY, [...this.invites.entries()]);
  }

  private async broadcastPresence(): Promise<void> {
    if (!this.roomMeta) {
      return;
    }

    this.roomMeta.participantCount = this.connectedSessionIds().length;
    await this.ctx.storage.put(ROOM_META_KEY, this.roomMeta);
    this.broadcast({
      type: "presence",
      presence: this.presenceSnapshot()
    } satisfies PresenceEvent);
  }

  private async disconnectSession(
    targetSessionId: string,
    reason: string,
    closeReason: string
  ): Promise<void> {
    this.broadcastToSessions([targetSessionId], {
      type: "participant_kicked",
      sessionId: targetSessionId,
      reason
    } satisfies ParticipantKickedEvent);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as AttachmentRecord | null;
      if (attachment?.sessionId === targetSessionId) {
        socket.serializeAttachment({ ...attachment, sessionId: "" } satisfies AttachmentRecord);
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
    } satisfies PeerLeftEvent);
    await this.broadcastPresence();
    await this.markRoomActivity();
  }

  private broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as AttachmentRecord | null;
      if (!attachment?.sessionId) continue;
      this.sendIfOpen(socket, payload);
    }
  }

  private broadcastToOtherParticipants(senderSessionId: string, event: ServerEvent): void {
    const targets = this.connectedSessionIds().filter((sessionId) => sessionId !== senderSessionId);
    this.broadcastToSessions(targets, event);
  }

  private broadcastToSessions(sessionIds: string[], event: ServerEvent): void {
    const payload = JSON.stringify(event);
    const allowed = new Set(sessionIds);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as AttachmentRecord | null;
      if (attachment?.sessionId && allowed.has(attachment.sessionId)) {
        this.sendIfOpen(socket, payload);
      }
    }
  }

  private sendIfOpen(socket: WebSocket, payload: string): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      socket.send(payload);
    } catch {
      // A peer can close between the readyState check and send. Its close
      // callback will update presence, so one failed broadcast should not fail
      // the room event that triggered it.
    }
  }

  private presenceSnapshot(): PresenceSnapshot {
    const ids = this.connectedSessionIds();
    return {
      count: ids.length,
      connectedSessionIds: ids
    };
  }

  // Source of truth for connected participants, derived from live WebSockets so
  // it survives Durable Object hibernation. Deduplicated by session id.
  private connectedSessions(): AttachmentRecord[] {
    const seen = new Set<string>();
    const sessions: AttachmentRecord[] = [];
    for (const socket of this.openWebSockets()) {
      const attachment = socket.deserializeAttachment() as AttachmentRecord | null;
      if (attachment?.sessionId && !seen.has(attachment.sessionId)) {
        seen.add(attachment.sessionId);
        sessions.push(attachment);
      }
    }
    return sessions;
  }

  private connectedSessionIds(): string[] {
    return this.connectedSessions().map((session) => session.sessionId);
  }

  private openWebSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((socket) => socket.readyState === WebSocket.OPEN);
  }

  private isConnected(sessionId: string): boolean {
    return this.connectedSessions().some((session) => session.sessionId === sessionId);
  }

  private describePeer(peer: AttachmentRecord): PeerDescriptor {
    return {
      sessionId: peer.sessionId,
      creator: peer.creator,
      connectedAt: peer.connectedAt,
      identityKey: peer.identityKey,
      agreementKey: peer.agreementKey
    };
  }

  private publicMetadata(meta: RoomStorage): RoomMetadata {
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
}
