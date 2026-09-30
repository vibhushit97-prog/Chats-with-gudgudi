import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../workers/api/src/index";
import {
  createIdentityKeyPair,
  exportIdentityPublicKey
} from "@elm-chat/crypto";
import type {
  AccessCodeManageResponse,
  AccessCodeVerifyResponse,
  CreateRoomResponse,
  RoomMetadata
} from "@elm-chat/shared";

async function createRoom(accessCodeOpts?: {
  accessCode?: string;
  generateAccessCode?: boolean;
}): Promise<CreateRoomResponse> {
  const response = await worker.fetch(
    new Request("https://elm.chat/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        inactivityTimeoutMs: 60_000,
        maxAgeMs: 120_000,
        ...accessCodeOpts
      })
    }),
    env
  );
  expect(response.status).toBe(201);
  return response.json();
}

async function createInvite(roomId: string, creatorToken: string, ttlMs = 60_000): Promise<string> {
  const response = await worker.fetch(
    new Request(`https://elm.chat/api/rooms/${roomId}/invites`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ creatorToken, ttlMs })
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

interface TestParticipant {
  sessionId: string;
  identityKey: string;
  identityKeyPair: CryptoKeyPair;
  socket: WebSocket;
}

async function joinParticipant(
  roomId: string,
  token?: { creatorToken?: string; inviteToken?: string; accessCodeTicket?: string; sessionId?: string }
): Promise<TestParticipant> {
  const keyPair = await createIdentityKeyPair();
  const identityKey = await exportIdentityPublicKey(keyPair.publicKey);
  const sessionId = token?.sessionId ?? crypto.randomUUID();
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

describe("Phase 3A: Creator-Controlled Room Access Code", () => {
  it("1 & 2. Creator creates room and sets access code", async () => {
    // Creator creates room without code initially
    const room = await createRoom();
    expect(room.accessCodeProtected).toBeFalsy();

    // Creator configures custom 6-digit access code
    const manageRes = await worker.fetch(
      new Request(`https://elm.chat/api/rooms/${room.roomId}/access-code`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${room.creatorToken}`
        },
        body: JSON.stringify({ action: "set", code: "741852" })
      }),
      env
    );
    expect(manageRes.status).toBe(200);
    const manageData = await manageRes.json<AccessCodeManageResponse>();
    expect(manageData.ok).toBe(true);
    expect(manageData.enabled).toBe(true);
    expect(manageData.code).toBe("741852");

    // Check room metadata reflects protected state
    const metaRes = await worker.fetch(
      new Request(`https://elm.chat/api/rooms/${room.roomId}`),
      env
    );
    const meta = await metaRes.json<RoomMetadata>();
    expect(meta.accessCodeProtected).toBe(true);
  });

  it("3. Valid invitation + valid code -> join succeeds", async () => {
    const room = await createRoom({ accessCode: "123456" });
    expect(room.accessCodeProtected).toBe(true);
    const inviteToken = await createInvite(room.roomId, room.creatorToken);

    // Verify access code
    const verifyRes = await worker.fetch(
      new Request(`https://elm.chat/api/rooms/${room.roomId}/access-code/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inviteToken, accessCode: "123456" })
      }),
      env
    );
    expect(verifyRes.status).toBe(200);
    const verifyData = await verifyRes.json<AccessCodeVerifyResponse>();
    expect(verifyData.ok).toBe(true);
    expect(verifyData.ticket).toBeDefined();

    // Join with ticket succeeds
    const guest = await joinParticipant(room.roomId, {
      inviteToken,
      accessCodeTicket: verifyData.ticket
    });
    expect(guest.sessionId).toBeDefined();
    guest.socket.close();
  });

  it("4. Valid invitation + wrong code -> access denied, join without ticket rejected", async () => {
    const room = await createRoom({ accessCode: "888888" });
    const inviteToken = await createInvite(room.roomId, room.creatorToken);

    // Verify with incorrect code
    const verifyRes = await worker.fetch(
      new Request(`https://elm.chat/api/rooms/${room.roomId}/access-code/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inviteToken, accessCode: "000000" })
      }),
      env
    );
    expect(verifyRes.status).toBe(401);
    const verifyData = await verifyRes.json<AccessCodeVerifyResponse>();
    expect(verifyData.ok).toBe(false);
    expect(verifyData.error).toContain("Access Denied");
    expect(verifyData.remainingAttempts).toBe(4);

    // Attempting to join WebSocket without ticket is rejected
    const keyPair = await createIdentityKeyPair();
    const identityKey = await exportIdentityPublicKey(keyPair.publicKey);
    const socket = await openSocket(room.roomId);

    const errorPromise = nextSocketEvent<{ type: string; code: string }>(socket, "error");
    const closePromise = new Promise<number>((resolve) => {
      socket.addEventListener("close", (event) => resolve(event.code), { once: true });
    });

    socket.send(JSON.stringify({
      type: "join",
      sessionId: crypto.randomUUID(),
      identityKey,
      agreementKey: identityKey,
      inviteToken
    }));

    const err = await errorPromise;
    expect(err.code).toBe("access_code_required");
    const closeCode = await closePromise;
    expect(closeCode).toBe(4403);
  });

  it("5. Repeated wrong codes -> rate limiting/backoff (lockout)", async () => {
    const room = await createRoom({ accessCode: "999999" });
    const inviteToken = await createInvite(room.roomId, room.creatorToken);

    // 4 failed attempts
    for (let i = 0; i < 4; i++) {
      const res = await worker.fetch(
        new Request(`https://elm.chat/api/rooms/${room.roomId}/access-code/verify`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ inviteToken, accessCode: "111111" })
        }),
        env
      );
      expect(res.status).toBe(401);
    }

    // 5th failed attempt triggers 429 lockout
    const fifthRes = await worker.fetch(
      new Request(`https://elm.chat/api/rooms/${room.roomId}/access-code/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inviteToken, accessCode: "111111" })
      }),
      env
    );
    expect(fifthRes.status).toBe(429);
    const fifthData = await fifthRes.json<AccessCodeVerifyResponse>();
    expect(fifthData.error?.toLowerCase()).toContain("locked out");

    // Immediate next attempt during lockout period is rejected with 429 even with correct code
    const lockedRes = await worker.fetch(
      new Request(`https://elm.chat/api/rooms/${room.roomId}/access-code/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inviteToken, accessCode: "999999" })
      }),
      env
    );
    expect(lockedRes.status).toBe(429);
  });

  it("6. Revoked code -> access denied", async () => {
    const room = await createRoom({ accessCode: "555555" });
    const inviteToken = await createInvite(room.roomId, room.creatorToken);

    // Creator revokes access code
    const revokeRes = await worker.fetch(
      new Request(`https://elm.chat/api/rooms/${room.roomId}/access-code`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${room.creatorToken}`
        },
        body: JSON.stringify({ action: "revoke" })
      }),
      env
    );
    expect(revokeRes.status).toBe(200);

    // Verifying with previous code gives access denied (revoked)
    const verifyRes = await worker.fetch(
      new Request(`https://elm.chat/api/rooms/${room.roomId}/access-code/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inviteToken, accessCode: "555555" })
      }),
      env
    );
    expect(verifyRes.status).toBe(403);
    const verifyData = await verifyRes.json<AccessCodeVerifyResponse>();
    expect(verifyData.error).toContain("revoked");
  });

  it("7 & 8. Regenerated code -> old code rejected, new code accepted", async () => {
    const room = await createRoom({ accessCode: "111222" });
    const inviteToken = await createInvite(room.roomId, room.creatorToken);

    // Creator regenerates code
    const regenRes = await worker.fetch(
      new Request(`https://elm.chat/api/rooms/${room.roomId}/access-code`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${room.creatorToken}`
        },
        body: JSON.stringify({ action: "generate" })
      }),
      env
    );
    expect(regenRes.status).toBe(200);
    const regenData = await regenRes.json<AccessCodeManageResponse>();
    const newCode = regenData.code!;
    expect(newCode).toMatch(/^\d{6}$/);
    expect(newCode).not.toBe("111222");

    // Old code rejected
    const oldVerifyRes = await worker.fetch(
      new Request(`https://elm.chat/api/rooms/${room.roomId}/access-code/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inviteToken, accessCode: "111222" })
      }),
      env
    );
    expect(oldVerifyRes.status).toBe(401);

    // New code accepted
    const newVerifyRes = await worker.fetch(
      new Request(`https://elm.chat/api/rooms/${room.roomId}/access-code/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inviteToken, accessCode: newCode })
      }),
      env
    );
    expect(newVerifyRes.status).toBe(200);
    const newVerifyData = await newVerifyRes.json<AccessCodeVerifyResponse>();
    expect(newVerifyData.ok).toBe(true);
    expect(newVerifyData.ticket).toBeDefined();

    // Guest joins with new ticket
    const guest = await joinParticipant(room.roomId, {
      inviteToken,
      accessCodeTicket: newVerifyData.ticket
    });
    guest.socket.close();
  });

  it("9. Exactly two participants -> third participant rejected", async () => {
    const room = await createRoom({ accessCode: "333444" });
    const creator = await joinParticipant(room.roomId, { creatorToken: room.creatorToken });
    const invite1 = await createInvite(room.roomId, room.creatorToken);
    const invite2 = await createInvite(room.roomId, room.creatorToken);

    // Guest 1 verifies and joins
    const verify1 = await worker.fetch(
      new Request(`https://elm.chat/api/rooms/${room.roomId}/access-code/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inviteToken: invite1, accessCode: "333444" })
      }),
      env
    );
    const ticket1 = (await verify1.json<AccessCodeVerifyResponse>()).ticket!;
    const guest1 = await joinParticipant(room.roomId, { inviteToken: invite1, accessCodeTicket: ticket1 });

    // Room is now full (2 participants). Third participant attempting to join is rejected
    const verify2 = await worker.fetch(
      new Request(`https://elm.chat/api/rooms/${room.roomId}/access-code/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inviteToken: invite2, accessCode: "333444" })
      }),
      env
    );
    const ticket2 = (await verify2.json<AccessCodeVerifyResponse>()).ticket!;

    const keyPair3 = await createIdentityKeyPair();
    const identityKey3 = await exportIdentityPublicKey(keyPair3.publicKey);
    const socket3 = await openSocket(room.roomId);

    const errorPromise = nextSocketEvent<{ type: string; code: string }>(socket3, "error");
    const closePromise = new Promise<number>((resolve) => {
      socket3.addEventListener("close", (event) => resolve(event.code), { once: true });
    });

    socket3.send(JSON.stringify({
      type: "join",
      sessionId: crypto.randomUUID(),
      identityKey: identityKey3,
      agreementKey: identityKey3,
      inviteToken: invite2,
      accessCodeTicket: ticket2
    }));

    const err = await errorPromise;
    expect(err.code).toBe("room_full");
    const closeCode = await closePromise;
    expect(closeCode).toBe(4409);

    creator.socket.close();
    guest1.socket.close();
  });

  it("10. Non-creator attempts to change code -> rejected", async () => {
    const room = await createRoom({ accessCode: "654321" });

    // Request without creator token
    const unauthRes = await worker.fetch(
      new Request(`https://elm.chat/api/rooms/${room.roomId}/access-code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "set", code: "000000" })
      }),
      env
    );
    expect(unauthRes.status).toBe(403);

    // Request with forged/wrong creator token
    const forgedRes = await worker.fetch(
      new Request(`https://elm.chat/api/rooms/${room.roomId}/access-code`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer wrong-token-xyz"
        },
        body: JSON.stringify({ action: "set", code: "000000" })
      }),
      env
    );
    expect(forgedRes.status).toBe(403);
  });

  it("11. Refresh/reconnect preserves correct authorization state", async () => {
    const room = await createRoom({ accessCode: "456789" });
    const inviteToken = await createInvite(room.roomId, room.creatorToken);

    // Verify access code
    const verifyRes = await worker.fetch(
      new Request(`https://elm.chat/api/rooms/${room.roomId}/access-code/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inviteToken, accessCode: "456789" })
      }),
      env
    );
    const ticket = (await verifyRes.json<AccessCodeVerifyResponse>()).ticket!;

    const persistentSessionId = crypto.randomUUID();
    const guest = await joinParticipant(room.roomId, {
      sessionId: persistentSessionId,
      inviteToken,
      accessCodeTicket: ticket
    });

    // Guest temporarily disconnects (simulating browser refresh / tab reconnect)
    guest.socket.close();

    // Reconnecting with the same sessionId and claimed invite succeeds without needing a new ticket
    const reconnected = await joinParticipant(room.roomId, {
      sessionId: persistentSessionId,
      inviteToken
    });
    expect(reconnected.sessionId).toBe(persistentSessionId);
    reconnected.socket.close();
  });

  it("12. Invitation expiration still works with access code system", async () => {
    const room = await createRoom({ accessCode: "111111" });
    const expiredInvite = await createInvite(room.roomId, room.creatorToken);
    await runInDurableObject(env.ROOM_OBJECT.getByName(room.roomId), (instance: any) => {
      const invite = instance.invites.get(expiredInvite);
      if (invite) invite.expiresAt = Date.now() - 1000;
    });

    const verifyRes = await worker.fetch(
      new Request(`https://elm.chat/api/rooms/${room.roomId}/access-code/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inviteToken: expiredInvite, accessCode: "111111" })
      }),
      env
    );
    expect(verifyRes.status).toBe(403);
    const verifyData = await verifyRes.json<AccessCodeVerifyResponse>();
    expect(verifyData.error).toContain("expired");
  });
});
