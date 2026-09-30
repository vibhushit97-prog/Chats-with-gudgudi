import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../workers/api/src/index";
import {
  createIdentityKeyPair,
  exportIdentityPublicKey,
  createAuthenticatedPeerEvent,
  encryptMessage,
  deriveRoomKey,
  generateRoomSecret
} from "@elm-chat/crypto";
import {
  MESSAGE_PROTOCOL_VERSION,
  type CreateRoomResponse,
  type EncryptedMessageEnvelope,
  type MessageDeliveredEvent,
  type MessageDestroyedEvent,
  type MessageSeenEvent,
  type RoomMetadata
} from "@elm-chat/shared";

async function createRoom(disappearAfterReadSeconds?: number): Promise<CreateRoomResponse> {
  const response = await worker.fetch(
    new Request("https://elm.chat/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        inactivityTimeoutMs: 60_000,
        maxAgeMs: 120_000,
        disappearAfterReadSeconds: disappearAfterReadSeconds ?? null
      })
    }),
    env
  );
  expect(response.status).toBe(201);
  return response.json();
}

async function openSocket(roomId: string): Promise<WebSocket> {
  const response = await env.ROOM_OBJECT.getByName(roomId).fetch(
    new Request("https://room/ws", { headers: { Upgrade: "websocket" } })
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  return socket;
}

function nextSocketEvent<T extends { type: string }>(
  socket: WebSocket,
  type: string
): Promise<T> {
  return new Promise((resolve) => {
    const listener = (event: MessageEvent) => {
      const payload = JSON.parse(String(event.data)) as T;
      if (payload.type !== type) return;
      socket.removeEventListener("message", listener);
      resolve(payload);
    };
    socket.addEventListener("message", listener);
  });
}

interface TestParticipant {
  sessionId: string;
  identityKey: string;
  identityKeyPair: CryptoKeyPair;
  socket: WebSocket;
}

async function joinParticipant(
  roomId: string,
  token?: { creatorToken?: string; inviteToken?: string }
): Promise<TestParticipant> {
  const keyPair = await createIdentityKeyPair();
  const identityKey = await exportIdentityPublicKey(keyPair.publicKey);
  const sessionId = crypto.randomUUID();
  const socket = await openSocket(roomId);

  const joined = nextSocketEvent<{ type: string; room: RoomMetadata }>(socket, "joined");
  socket.send(JSON.stringify({
    type: "join",
    sessionId,
    identityKey,
    agreementKey: identityKey,
    ...token
  }));
  await joined;

  return {
    sessionId,
    identityKey,
    identityKeyPair: keyPair,
    socket
  };
}

async function createInvite(roomId: string, creatorToken: string): Promise<string> {
  const response = await worker.fetch(
    new Request(`https://elm.chat/api/rooms/${roomId}/invites`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ creatorToken, ttlMs: 60_000 })
    }),
    env
  );
  expect(response.status).toBe(201);
  const data = await response.json<{ token: string }>();
  return data.token;
}

describe("Phase 3: accurate message lifecycle and read/seen behavior", () => {
  it("implements complete lifecycle: sent -> delivered -> seen -> destroyed", async () => {
    const room = await createRoom(0); // instant destruction after read
    const sender = await joinParticipant(room.roomId, { creatorToken: room.creatorToken });
    const inviteToken = await createInvite(room.roomId, room.creatorToken);
    const recipient = await joinParticipant(room.roomId, { inviteToken });

    try {
      const messageId = crypto.randomUUID();
      const envelope: EncryptedMessageEnvelope = {
        protocolVersion: MESSAGE_PROTOCOL_VERSION,
        messageId,
        senderSessionId: sender.sessionId,
        ciphertext: "enc-ciphertext",
        nonce: "enc-nonce",
        sentAt: Date.now(),
        expiresAfterReadSeconds: 0,
        keyEpoch: 1
      };

      // 1. Sender sends message
      const signedPeerEvent = await createAuthenticatedPeerEvent(
        sender.identityKeyPair.privateKey,
        room.roomId,
        sender.sessionId,
        null,
        { type: "chat_message", envelope }
      );

      const recipientReceivedPeerData = nextSocketEvent<{ type: string; data: any }>(
        recipient.socket,
        "peer_data"
      );

      sender.socket.send(JSON.stringify({
        type: "peer_data",
        data: signedPeerEvent
      }));

      // 2. Recipient receives message
      const received = await recipientReceivedPeerData;
      expect(received.data.payload.envelope.messageId).toBe(messageId);

      // 3. Message is not marked seen merely because recipient connects/receives.
      // Recipient acknowledges delivery:
      const senderDeliveredPromise = nextSocketEvent<MessageDeliveredEvent>(
        sender.socket,
        "message_delivered"
      );

      recipient.socket.send(JSON.stringify({
        type: "message_delivered",
        messageId
      }));

      const deliveredEvent = await senderDeliveredPromise;
      expect(deliveredEvent.messageId).toBe(messageId);

      // Verify that message is still NOT seen or destroyed yet
      const stub = env.ROOM_OBJECT.getByName(room.roomId);
      await runInDurableObject(stub, async (_instance: any) => {
        const record = _instance.messages.get(messageId);
        expect(record).toBeDefined();
        expect(record.status).toBe("delivered");
      });

      // 4. Recipient opens/renders message -> 5. Seen event is generated
      const senderSeenPromise = nextSocketEvent<MessageSeenEvent>(
        sender.socket,
        "message_seen"
      );
      const recipientSeenPromise = nextSocketEvent<MessageSeenEvent>(
        recipient.socket,
        "message_seen"
      );

      // 6. Server validates the event
      const senderDestroyedPromise = nextSocketEvent<MessageDestroyedEvent>(
        sender.socket,
        "message_destroyed"
      );
      const recipientDestroyedPromise = nextSocketEvent<MessageDestroyedEvent>(
        recipient.socket,
        "message_destroyed"
      );

      recipient.socket.send(JSON.stringify({
        type: "message_seen",
        messageId
      }));

      // Both clients receive seen event
      const senderSeen = await senderSeenPromise;
      const recipientSeen = await recipientSeenPromise;
      expect(senderSeen.messageId).toBe(messageId);
      expect(recipientSeen.messageId).toBe(messageId);
      expect(senderSeen.seenBySessionId).toBe(recipient.sessionId);

      // 7. Message is destroyed & 8. Both clients receive destruction event
      const senderDestroyed = await senderDestroyedPromise;
      const recipientDestroyed = await recipientDestroyedPromise;
      expect(senderDestroyed.messageId).toBe(messageId);
      expect(recipientDestroyed.messageId).toBe(messageId);
      expect(senderDestroyed.reason).toBe("seen");

      // Verify message is wiped from active memory and added to destroyed list
      await runInDurableObject(stub, async (_instance: any) => {
        expect(_instance.messages.has(messageId)).toBe(false);
        expect(_instance.destroyedMessageIds.has(messageId)).toBe(true);
      });

      // 9. Refresh / reconnect / replay does not restore the destroyed message
      const attemptReplay = await createAuthenticatedPeerEvent(
        sender.identityKeyPair.privateKey,
        room.roomId,
        sender.sessionId,
        null,
        { type: "chat_message", envelope }
      );

      let peerDataReceivedOnReplay = false;
      const replayListener = (event: MessageEvent) => {
        const payload = JSON.parse(String(event.data));
        if (payload.type === "peer_data" && payload.data?.payload?.envelope?.messageId === messageId) {
          peerDataReceivedOnReplay = true;
        }
      };
      recipient.socket.addEventListener("message", replayListener);

      sender.socket.send(JSON.stringify({
        type: "peer_data",
        data: attemptReplay
      }));

      // Wait a short tick
      await new Promise((r) => setTimeout(r, 50));
      recipient.socket.removeEventListener("message", replayListener);
      expect(peerDataReceivedOnReplay).toBe(false);
    } finally {
      sender.socket.close();
      recipient.socket.close();
    }
  });

  it("rejects unauthorized seen events (sender cannot mark own message seen)", async () => {
    const room = await createRoom(10);
    const sender = await joinParticipant(room.roomId, { creatorToken: room.creatorToken });
    const inviteToken = await createInvite(room.roomId, room.creatorToken);
    const recipient = await joinParticipant(room.roomId, { inviteToken });

    try {
      const messageId = crypto.randomUUID();
      const envelope: EncryptedMessageEnvelope = {
        protocolVersion: MESSAGE_PROTOCOL_VERSION,
        messageId,
        senderSessionId: sender.sessionId,
        ciphertext: "ct",
        nonce: "n",
        sentAt: Date.now(),
        expiresAfterReadSeconds: 10,
        keyEpoch: 1
      };

      const signedPeerEvent = await createAuthenticatedPeerEvent(
        sender.identityKeyPair.privateKey,
        room.roomId,
        sender.sessionId,
        null,
        { type: "chat_message", envelope }
      );
      sender.socket.send(JSON.stringify({ type: "peer_data", data: signedPeerEvent }));

      // Wait for server to record the message
      const stub = env.ROOM_OBJECT.getByName(room.roomId);
      await runInDurableObject(stub, async (_instance: any) => {
        expect(_instance.messages.has(messageId)).toBe(true);
      });

      // Sender tries to mark own message as seen: must be rejected!
      const errorPromise = nextSocketEvent<{ type: string; code: string }>(sender.socket, "error");
      sender.socket.send(JSON.stringify({
        type: "message_seen",
        messageId
      }));

      const error = await errorPromise;
      expect(error.code).toBe("unauthorized_seen");
    } finally {
      sender.socket.close();
      recipient.socket.close();
    }
  });

  it("rejects unauthorized destroy events from non-senders on unexpired messages", async () => {
    const room = await createRoom(60);
    const sender = await joinParticipant(room.roomId, { creatorToken: room.creatorToken });
    const inviteToken = await createInvite(room.roomId, room.creatorToken);
    const recipient = await joinParticipant(room.roomId, { inviteToken });

    try {
      const messageId = crypto.randomUUID();
      const envelope: EncryptedMessageEnvelope = {
        protocolVersion: MESSAGE_PROTOCOL_VERSION,
        messageId,
        senderSessionId: sender.sessionId,
        ciphertext: "ct",
        nonce: "n",
        sentAt: Date.now(),
        expiresAfterReadSeconds: 60,
        keyEpoch: 1
      };

      const signedPeerEvent = await createAuthenticatedPeerEvent(
        sender.identityKeyPair.privateKey,
        room.roomId,
        sender.sessionId,
        null,
        { type: "chat_message", envelope }
      );
      sender.socket.send(JSON.stringify({ type: "peer_data", data: signedPeerEvent }));

      const stub = env.ROOM_OBJECT.getByName(room.roomId);
      await runInDurableObject(stub, async (_instance: any) => {
        expect(_instance.messages.has(messageId)).toBe(true);
      });

      // Recipient tries to destroy sender's message before reading/seen: must be rejected!
      const errorPromise = nextSocketEvent<{ type: string; code: string }>(recipient.socket, "error");
      recipient.socket.send(JSON.stringify({
        type: "destroy_message",
        messageId
      }));

      const error = await errorPromise;
      expect(error.code).toBe("unauthorized_destroy");
    } finally {
      sender.socket.close();
      recipient.socket.close();
    }
  });

  it("handles duplicate seen and duplicate destroy events safely and idempotently", async () => {
    const room = await createRoom(0);
    const sender = await joinParticipant(room.roomId, { creatorToken: room.creatorToken });
    const inviteToken = await createInvite(room.roomId, room.creatorToken);
    const recipient = await joinParticipant(room.roomId, { inviteToken });

    try {
      const messageId = crypto.randomUUID();
      const envelope: EncryptedMessageEnvelope = {
        protocolVersion: MESSAGE_PROTOCOL_VERSION,
        messageId,
        senderSessionId: sender.sessionId,
        ciphertext: "ct",
        nonce: "n",
        sentAt: Date.now(),
        expiresAfterReadSeconds: 0,
        keyEpoch: 1
      };

      const signedPeerEvent = await createAuthenticatedPeerEvent(
        sender.identityKeyPair.privateKey,
        room.roomId,
        sender.sessionId,
        null,
        { type: "chat_message", envelope }
      );
      sender.socket.send(JSON.stringify({ type: "peer_data", data: signedPeerEvent }));

      const destroyedPromise = nextSocketEvent<MessageDestroyedEvent>(recipient.socket, "message_destroyed");
      recipient.socket.send(JSON.stringify({ type: "message_seen", messageId }));
      await destroyedPromise;

      // Duplicate seen event: safe no-op
      recipient.socket.send(JSON.stringify({ type: "message_seen", messageId }));

      // Duplicate destroy event: safe no-op
      sender.socket.send(JSON.stringify({ type: "destroy_message", messageId }));

      // Wait a short tick, no errors
      await new Promise((r) => setTimeout(r, 50));
      expect(recipient.socket.readyState).toBe(WebSocket.OPEN);
      expect(sender.socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      sender.socket.close();
      recipient.socket.close();
    }
  });

  it("leaves offline unread messages undestroyed until fallback expiration", async () => {
    const room = await createRoom(10);
    const sender = await joinParticipant(room.roomId, { creatorToken: room.creatorToken });

    try {
      const messageId = crypto.randomUUID();
      const envelope: EncryptedMessageEnvelope = {
        protocolVersion: MESSAGE_PROTOCOL_VERSION,
        messageId,
        senderSessionId: sender.sessionId,
        ciphertext: "ct",
        nonce: "n",
        sentAt: Date.now(),
        expiresAfterReadSeconds: 10,
        keyEpoch: 1
      };

      const signedPeerEvent = await createAuthenticatedPeerEvent(
        sender.identityKeyPair.privateKey,
        room.roomId,
        sender.sessionId,
        null,
        { type: "chat_message", envelope }
      );
      sender.socket.send(JSON.stringify({ type: "peer_data", data: signedPeerEvent }));

      const stub = env.ROOM_OBJECT.getByName(room.roomId);
      await runInDurableObject(stub, async (_instance: any) => {
        const record = _instance.messages.get(messageId);
        expect(record).toBeDefined();
        expect(record.status).toBe("sent"); // Still sent, never seen
        // Fast forward fallback expiration
        record.fallbackExpiresAt = Date.now() - 1000;
      });

      // Run alarm: fallback expiration triggers destruction of abandoned unread message
      await runDurableObjectAlarm(stub);

      await runInDurableObject(stub, async (_instance: any) => {
        expect(_instance.messages.has(messageId)).toBe(false);
        expect(_instance.destroyedMessageIds.has(messageId)).toBe(true);
      });
    } finally {
      sender.socket.close();
    }
  });

  it("rejects seen event from an unjoined socket and for non-existent message", async () => {
    const room = await createRoom(10);
    const unjoined = await openSocket(room.roomId);

    try {
      // Unjoined socket trying to send message_seen
      const errorPromise = nextSocketEvent<{ type: string; code: string }>(unjoined, "error");
      unjoined.send(JSON.stringify({
        type: "message_seen",
        messageId: crypto.randomUUID()
      }));

      const error = await errorPromise;
      expect(error.code).toBe("join_required");
    } finally {
      unjoined.close();
    }

    // Joined recipient trying to mark a non-existent message seen
    const sender = await joinParticipant(room.roomId, { creatorToken: room.creatorToken });
    const inviteToken = await createInvite(room.roomId, room.creatorToken);
    const recipient = await joinParticipant(room.roomId, { inviteToken });

    try {
      const errorPromise = nextSocketEvent<{ type: string; code: string }>(recipient.socket, "error");
      recipient.socket.send(JSON.stringify({
        type: "message_seen",
        messageId: crypto.randomUUID()
      }));

      const error = await errorPromise;
      expect(error.code).toBe("message_not_found");
    } finally {
      sender.socket.close();
      recipient.socket.close();
    }
  });

  it("handles recipient reconnection / refresh and converges on destroyed state", async () => {
    const room = await createRoom(0);
    const sender = await joinParticipant(room.roomId, { creatorToken: room.creatorToken });
    const inviteToken = await createInvite(room.roomId, room.creatorToken);
    const recipient = await joinParticipant(room.roomId, { inviteToken });

    const messageId = crypto.randomUUID();
    const envelope: EncryptedMessageEnvelope = {
      protocolVersion: MESSAGE_PROTOCOL_VERSION,
      messageId,
      senderSessionId: sender.sessionId,
      ciphertext: "ct",
      nonce: "n",
      sentAt: Date.now(),
      expiresAfterReadSeconds: 0,
      keyEpoch: 1
    };

    const signedPeerEvent = await createAuthenticatedPeerEvent(
      sender.identityKeyPair.privateKey,
      room.roomId,
      sender.sessionId,
      null,
      { type: "chat_message", envelope }
    );
    sender.socket.send(JSON.stringify({ type: "peer_data", data: signedPeerEvent }));

    // Wait for server to record message
    const stub = env.ROOM_OBJECT.getByName(room.roomId);
    await runInDurableObject(stub, async (_instance: any) => {
      expect(_instance.messages.has(messageId)).toBe(true);
    });

    // Recipient refreshes: closes socket
    recipient.socket.close();

    // Reconnects with same session and consumed invite token
    const reconnectedSocket = await openSocket(room.roomId);
    const joinedPromise = nextSocketEvent<{ type: string; room: RoomMetadata }>(reconnectedSocket, "joined");
    reconnectedSocket.send(JSON.stringify({
      type: "join",
      sessionId: recipient.sessionId,
      identityKey: recipient.identityKey,
      agreementKey: recipient.identityKey,
      inviteToken
    }));
    await joinedPromise;

    try {
      const reconnectedDestroyedPromise = nextSocketEvent<MessageDestroyedEvent>(reconnectedSocket, "message_destroyed");
      const senderDestroyedPromise = nextSocketEvent<MessageDestroyedEvent>(sender.socket, "message_destroyed");

      // Reconnected recipient marks message seen
      reconnectedSocket.send(JSON.stringify({
        type: "message_seen",
        messageId
      }));

      const [recDest, senDest] = await Promise.all([reconnectedDestroyedPromise, senderDestroyedPromise]);
      expect(recDest.messageId).toBe(messageId);
      expect(senDest.messageId).toBe(messageId);
      expect(recDest.reason).toBe("seen");

      // Verify DO storage has the message destroyed
      await runInDurableObject(stub, async (_instance: any) => {
        expect(_instance.messages.has(messageId)).toBe(false);
        expect(_instance.destroyedMessageIds.has(messageId)).toBe(true);
      });
    } finally {
      sender.socket.close();
      reconnectedSocket.close();
    }
  });
});
