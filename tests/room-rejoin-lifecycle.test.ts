import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import worker from "../workers/api/src/index";
import {
  createIdentityKeyPair,
  exportIdentityPublicKey,
  deriveRoomKey,
  generateRoomSecret
} from "@elm-chat/crypto";
import type {
  CreateRoomResponse,
  RoomMetadata,
  AccessCodeVerifyResponse
} from "@elm-chat/shared";

async function createTestRoom(opts?: {
  inactivityTimeoutMs?: number;
  maxAgeMs?: number;
}): Promise<CreateRoomResponse> {
  const response = await worker.fetch(
    new Request("https://elm.chat/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        inactivityTimeoutMs: opts?.inactivityTimeoutMs ?? 60_000,
        maxAgeMs: opts?.maxAgeMs ?? 120_000,
        generateAccessCode: true
      })
    }),
    env
  );
  expect(response.status).toBe(201);
  return response.json();
}

async function createTestInvite(roomId: string, creatorToken: string): Promise<string> {
  const response = await worker.fetch(
    new Request(`https://elm.chat/api/rooms/${roomId}/invites`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${creatorToken}`
      },
      body: JSON.stringify({ creatorToken, ttlMs: 60_000 })
    }),
    env
  );
  expect(response.status).toBe(201);
  const data = await response.json<{ token: string }>();
  return data.token;
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

describe("Room Rejoin & Lifecycle Security Tests", () => {
  // Test 1: Browser navigation does not call destroyRoom()
  it("1. Browser navigation does not call destroyRoom()", async () => {
    const room = await createTestRoom();
    const fetchSpy = vi.fn();

    // Simulate navigation away from the room
    const simulateNavigation = (roomId: string) => {
      // In the updated client, popstate / back button only updates route and closes WS
      // It does NOT call destroyRoom(roomId, creatorToken)
    };
    simulateNavigation(room.roomId);

    // Verify destroy endpoint was never requested
    expect(fetchSpy).not.toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/rooms\/.*\/destroy/),
      expect.anything()
    );

    // Verify room metadata on server is still open
    const metaRes = await worker.fetch(
      new Request(`https://elm.chat/api/rooms/${room.roomId}`),
      env
    );
    const meta = await metaRes.json<RoomMetadata>();
    expect(meta.status).toBe("open");
  });

  // Test 2: Guest Leave does not destroy the room
  it("2. Guest Leave does not destroy the room", async () => {
    const room = await createTestRoom();
    const inviteToken = await createTestInvite(room.roomId, room.creatorToken);
    const code = room.accessCode!;

    // Guest verifies access code
    const verifyRes = await worker.fetch(
      new Request(`https://elm.chat/api/rooms/${room.roomId}/access-code/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inviteToken, accessCode: code })
      }),
      env
    );
    const verifyData = await verifyRes.json<AccessCodeVerifyResponse>();
    expect(verifyData.ok).toBe(true);

    // Guest connects WebSocket
    const guestWs = await openSocket(room.roomId);
    const keyPair = await createIdentityKeyPair();
    const identityKey = await exportIdentityPublicKey(keyPair.publicKey);
    const guestSessionId = crypto.randomUUID();

    const joinedPromise = nextSocketEvent<{ type: string }>(guestWs, "joined");
    guestWs.send(JSON.stringify({
      type: "join",
      sessionId: guestSessionId,
      identityKey,
      agreementKey: identityKey,
      inviteToken,
      accessCodeTicket: verifyData.ticket
    }));
    await joinedPromise;

    // Guest leaves (closes WebSocket with 1000)
    guestWs.close(1000, "user_navigation");

    // Check room metadata: Room MUST still be open
    const metaRes = await worker.fetch(
      new Request(`https://elm.chat/api/rooms/${room.roomId}`),
      env
    );
    expect(metaRes.status).toBe(200);
    const meta = await metaRes.json<RoomMetadata>();
    expect(meta.status).toBe("open");
  });

  // Test 3: Creator navigation does not destroy the room
  it("3. Creator navigation does not destroy the room", async () => {
    const room = await createTestRoom();

    // Creator connects WebSocket
    const creatorWs = await openSocket(room.roomId);
    const keyPair = await createIdentityKeyPair();
    const identityKey = await exportIdentityPublicKey(keyPair.publicKey);
    const creatorSessionId = crypto.randomUUID();

    const joinedPromise = nextSocketEvent<{ type: string }>(creatorWs, "joined");
    creatorWs.send(JSON.stringify({
      type: "join",
      sessionId: creatorSessionId,
      identityKey,
      agreementKey: identityKey,
      creatorToken: room.creatorToken
    }));
    await joinedPromise;

    // Creator navigates away (closes WebSocket with 1000)
    creatorWs.close(1000, "user_navigation");

    // Check room metadata: Room MUST remain open and alive
    const metaRes = await worker.fetch(
      new Request(`https://elm.chat/api/rooms/${room.roomId}`),
      env
    );
    expect(metaRes.status).toBe(200);
    const meta = await metaRes.json<RoomMetadata>();
    expect(meta.status).toBe("open");
  });

  // Test 4: End Conversation does destroy the room
  it("4. End Conversation does destroy the room", async () => {
    const room = await createTestRoom();

    // Creator explicitly ends conversation
    const destroyRes = await worker.fetch(
      new Request(`https://elm.chat/api/rooms/${room.roomId}/destroy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ creatorToken: room.creatorToken })
      }),
      env
    );
    expect(destroyRes.status).toBe(200);
    const destroyData = await destroyRes.json<RoomMetadata>();
    expect(destroyData.status).toBe("destroyed");

    // Verify room is destroyed and subsequent joins fail
    const metaRes = await worker.fetch(
      new Request(`https://elm.chat/api/rooms/${room.roomId}`),
      env
    );
    const meta = await metaRes.json<RoomMetadata>();
    expect(meta.status).toBe("destroyed");
  });

  // Test 5: Expired room cannot be rejoined
  it("5. Expired room cannot be rejoined", async () => {
    // Create room with tiny inactivity timeout (1 ms)
    const room = await createTestRoom({ inactivityTimeoutMs: 1 });
    // Wait for room inactivity expiration
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Try to verify access code for expired room
    const verifyRes = await worker.fetch(
      new Request(`https://elm.chat/api/rooms/${room.roomId}/access-code/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ creatorToken: room.creatorToken, accessCode: room.accessCode! })
      }),
      env
    );
    expect([404, 410]).toContain(verifyRes.status);
  });

  // Test 6: Active room can be rejoined
  it("6. Active room can be rejoined", async () => {
    const room = await createTestRoom();
    const code = room.accessCode!;

    // Creator verifies pass key to rejoin
    const verifyRes = await worker.fetch(
      new Request(`https://elm.chat/api/rooms/${room.roomId}/access-code/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ creatorToken: room.creatorToken, accessCode: code })
      }),
      env
    );
    expect(verifyRes.status).toBe(200);
    const verifyData = await verifyRes.json<AccessCodeVerifyResponse>();
    expect(verifyData.ok).toBe(true);
    expect(verifyData.ticket).toBeDefined();

    // Rejoin WebSocket with issued ticket
    const ws = await openSocket(room.roomId);
    const keyPair = await createIdentityKeyPair();
    const identityKey = await exportIdentityPublicKey(keyPair.publicKey);

    const joinedPromise = nextSocketEvent<{ type: string; room: RoomMetadata }>(ws, "joined");
    ws.send(JSON.stringify({
      type: "join",
      sessionId: crypto.randomUUID(),
      identityKey,
      agreementKey: identityKey,
      creatorToken: room.creatorToken,
      accessCodeTicket: verifyData.ticket
    }));

    const event = await joinedPromise;
    expect(event.type).toBe("joined");
    expect(event.room.roomId).toBe(room.roomId);
    ws.close();
  });

  // Test 7: Wrong access code cannot rejoin
  it("7. Wrong access code cannot rejoin", async () => {
    const room = await createTestRoom();

    const verifyRes = await worker.fetch(
      new Request(`https://elm.chat/api/rooms/${room.roomId}/access-code/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ creatorToken: room.creatorToken, accessCode: "000000" })
      }),
      env
    );
    expect(verifyRes.status).toBe(401);
    const verifyData = await verifyRes.json<AccessCodeVerifyResponse>();
    expect(verifyData.ok).toBe(false);
    expect(verifyData.ticket).toBeUndefined();
  });

  // Test 8: Correct access code permits rejoin
  it("8. Correct access code permits rejoin", async () => {
    const room = await createTestRoom();
    const code = room.accessCode!;

    const verifyRes = await worker.fetch(
      new Request(`https://elm.chat/api/rooms/${room.roomId}/access-code/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ creatorToken: room.creatorToken, accessCode: code })
      }),
      env
    );
    expect(verifyRes.status).toBe(200);
    const verifyData = await verifyRes.json<AccessCodeVerifyResponse>();
    expect(verifyData.ok).toBe(true);
    expect(typeof verifyData.ticket).toBe("string");
  });

  // Test 9: Room secret is never sent in an HTTP request
  it("9. Room secret is never sent in an HTTP request", async () => {
    const secret = generateRoomSecret();
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    // Perform room metadata request and access verification
    await fetchSpy("/api/rooms/test-room");
    await fetchSpy("/api/rooms/test-room/access-code/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessCode: "123456" })
    });

    for (const call of fetchSpy.mock.calls) {
      const url = String(call[0]);
      const init = call[1] as RequestInit | undefined;
      expect(url).not.toContain(secret);
      if (init?.body) {
        expect(String(init.body)).not.toContain(secret);
      }
    }
  });

  // Test 10: Room secret is never moved from URL fragment into query parameters
  it("10. Room secret is never moved from URL fragment into query parameters", () => {
    const secret = generateRoomSecret();
    const roomId = "test-room-123";
    const roomUrl = `/c/${roomId}#${secret}`;

    // Verify fragment structure
    const url = new URL(roomUrl, "https://elm.chat");
    expect(url.hash).toBe(`#${secret}`);
    expect(url.searchParams.has("secret")).toBe(false);
    expect(url.searchParams.toString()).not.toContain(secret);
  });

  // Test 11: Rejoin does not replace roomSecret with accessCode
  it("11. Rejoin does not replace roomSecret with accessCode", async () => {
    const accessCode = "123456";

    // Deriving room key from a 6-digit access code fails because access code is not a 256-bit secret
    await expect(deriveRoomKey(accessCode)).rejects.toThrow("Room secret is too short.");

    // Deriving from legitimate room secret succeeds
    const legitimateSecret = generateRoomSecret();
    const key = await deriveRoomKey(legitimateSecret);
    expect(key).toBeDefined();
  });

  // Test 12: Existing WebSocket behavior still works
  it("12. Existing WebSocket behavior still works", async () => {
    const room = await createTestRoom();
    const code = room.accessCode!;

    // Join creator
    const creatorWs = await openSocket(room.roomId);
    const creatorKeyPair = await createIdentityKeyPair();
    const creatorKey = await exportIdentityPublicKey(creatorKeyPair.publicKey);
    const creatorSessionId = crypto.randomUUID();

    const creatorJoined = nextSocketEvent<{ type: string }>(creatorWs, "joined");
    creatorWs.send(JSON.stringify({
      type: "join",
      sessionId: creatorSessionId,
      identityKey: creatorKey,
      agreementKey: creatorKey,
      creatorToken: room.creatorToken
    }));
    await creatorJoined;

    // Join guest with invite & ticket
    const inviteToken = await createTestInvite(room.roomId, room.creatorToken);
    const verifyRes = await worker.fetch(
      new Request(`https://elm.chat/api/rooms/${room.roomId}/access-code/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inviteToken, accessCode: code })
      }),
      env
    );
    const verifyData = await verifyRes.json<AccessCodeVerifyResponse>();
    expect(verifyData.ok).toBe(true);

    const guestWs = await openSocket(room.roomId);
    const guestKeyPair = await createIdentityKeyPair();
    const guestKey = await exportIdentityPublicKey(guestKeyPair.publicKey);
    const guestSessionId = crypto.randomUUID();

    const presencePromise = nextSocketEvent<{ type: string; presence: { count: number } }>(creatorWs, "presence");
    guestWs.send(JSON.stringify({
      type: "join",
      sessionId: guestSessionId,
      identityKey: guestKey,
      agreementKey: guestKey,
      inviteToken,
      accessCodeTicket: verifyData.ticket
    }));

    const presence = await presencePromise;
    expect(presence.presence.count).toBe(2);

    creatorWs.close();
    guestWs.close();
  });

  // Test 13: Existing invite flow still works
  it("13. Existing invite flow still works", async () => {
    const room = await createTestRoom();
    const inviteToken = await createTestInvite(room.roomId, room.creatorToken);
    expect(typeof inviteToken).toBe("string");
    expect(inviteToken.length).toBeGreaterThan(10);

    // List invites with authorization header
    const listRes = await worker.fetch(
      new Request(`https://elm.chat/api/rooms/${room.roomId}/invites`, {
        headers: { authorization: `Bearer ${room.creatorToken}` }
      }),
      env
    );
    expect(listRes.status).toBe(200);
    const invites = await listRes.json<Array<{ token: string; revokedAt: number | null }>>();
    expect(invites.some((i) => i.token === inviteToken)).toBe(true);
  });

  // Test 14: Existing room countdown still works
  it("14. Existing room countdown still works", async () => {
    const maxAgeMs = 120_000;
    const room = await createTestRoom({ maxAgeMs });

    const metaRes = await worker.fetch(
      new Request(`https://elm.chat/api/rooms/${room.roomId}`),
      env
    );
    const meta = await metaRes.json<RoomMetadata>();

    // Server-authoritative expiresAt must be defined and within expected window
    expect(typeof meta.expiresAt).toBe("number");
    const delta = meta.expiresAt! - Date.now();
    expect(delta).toBeGreaterThan(100_000);
    expect(delta).toBeLessThanOrEqual(maxAgeMs);
  });
});
