import {
  createIdentityKeyPair,
  createAuthenticatedPeerEvent,
  createAgreementKeyPair,
  decryptBytes,
  deriveRoomKey,
  encryptBytes,
  encryptMessage,
  exportIdentityPublicKey,
  exportIdentityPrivateKey,
  exportAgreementPrivateKey,
  exportAgreementPublicKey,
  generateMessageId,
  generateRoomSecret,
  generateSessionId,
  importIdentityPrivateKey,
  importIdentityPublicKey,
  importAgreementPrivateKey,
  sha256Base64Url,
  verifyAuthenticatedPeerEvent,
  unwrapRoomSecret,
  wrapRoomSecret
} from "@elm-chat/crypto";
import {
  FILE_CHUNK_BYTES,
  MESSAGE_PROTOCOL_VERSION,
  isAcquisitionSource,
  isMarketingAcquisitionSource,
  MAX_FILE_BYTES,
  MAX_TRANSCRIPT_SYNC_MESSAGES,
  type CreateRoomRequest,
  type CreateRoomResponse,
  type EncryptedMessageEnvelope,
  type AuthenticatedPeerEvent,
  type PeerDataEvent,
  type PeerFileChunk,
  type PeerDescriptor,
  type PresenceSnapshot,
  type RoomInvite,
  type RoomMetadata,
  type ServerEvent,
  type MessageDeliveryStatus,
  type AccessCodeManageRequest,
  type AccessCodeManageResponse,
  type AccessCodeVerifyRequest,
  type AccessCodeVerifyResponse,
} from "@elm-chat/shared";
import { startTransition, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { recordGrowthEvent, resolveExternalAcquisitionSource } from "./growth";
import { MarketingPage, type MarketingSlug } from "./MarketingPage";
import { locale, t } from "./localization";
import { InvalidMessageEnvelopeError, receiveTextMessage } from "./message-receive";
import { ReplayGuard } from "./replay";
import { handleComposerKeyDown } from "./composer";
import { ReconnectScheduler } from "./reconnect";
import { loadRoomMetadata, RoomMetadataError } from "./room-metadata";
import { ManualInviteLink } from "./ManualInviteLink";
import { canShareInvite } from "./manual-invite";
import { useConversationScroll } from "./use-conversation-scroll";
import { useConversationFind } from "./use-conversation-find";

type View = "landing" | "marketing" | "room";

type FileTransferState =
  | "offered"
  | "requesting"
  | "transferring"
  | "ready"
  | "sent"
  | "error";

type UiFile = {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  state: FileTransferState;
  progress: number;
  url?: string;
  outgoing: boolean;
};

type UiMessage = {
  id: string;
  senderSessionId: string;
  sentAt: number;
  expiresAt?: number;
  kind: "text" | "file";
  plaintext?: string;
  file?: UiFile;
  deliveryStatus?: MessageDeliveryStatus;
  seenAt?: number;
};

type IncomingFile = {
  name: string;
  mimeType: string;
  size: number;
  totalChunks: number;
  received: number;
  receivedBytes: number;
  chunks: (Uint8Array | undefined)[];
  senderSessionId: string;
  sha256: string;
  keyEpoch: number;
  requested: boolean;
  timeoutId?: number;
};

type ActionFeedback = "idle" | "success";
type InviteFeedback = "idle" | "copied" | "shared";
type InviteAccess = "checking" | "granted" | "invalid" | "claimed" | "used";
type DurationUnit = "minutes" | "hours" | "days";
type DurationDraft = {
  amount: string;
  unit: DurationUnit;
  indefinite: boolean;
};
type InviteDurationDraft = {
  amount: string;
  unit: DurationUnit;
};

type CommunityIssue = {
  number: number;
  title: string;
  url: string;
  date: string;
};

type CommunityFeed = {
  fixes: CommunityIssue[];
  requests: CommunityIssue[];
};

type DurationKind = "message" | "room";

function roomPathname(): { view: View; roomId?: string; marketingSlug?: MarketingSlug } {
  const match = window.location.pathname.match(/^\/c\/([^/]+)$/);
  if (match) {
    return { view: "room", roomId: match[1] };
  }
  const marketingSlug = window.location.pathname.replace(/^\/|\/$/g, "");
  if (isMarketingAcquisitionSource(marketingSlug)) {
    return { view: "marketing", marketingSlug };
  }
  return { view: "landing" };
}

function formatRelativeDuration(target: number): string {
  const deltaSeconds = Math.max(0, Math.floor((target - Date.now()) / 1000));
  const minutes = Math.floor(deltaSeconds / 60);
  const seconds = deltaSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function formatClock(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(timestamp);
}

function formatStaticDuration(totalSeconds: number): string {
  if (totalSeconds <= 0) {
    return "0s";
  }

  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds}s`);
  }

  return parts.join(" ");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

const GITHUB_URL = "https://github.com/shawnbure/elm-chat";

function formatCount(value: number): string {
  if (value < 1000) {
    return String(value);
  }
  const thousands = value / 1000;
  return `${thousands.toFixed(thousands < 10 ? 1 : 0).replace(/\.0$/, "")}k`;
}

function creatorTokenKey(roomId: string): string {
  return `elm-chat:creator:${roomId}`;
}

function sessionKey(roomId: string): string {
  return `elm-chat:session:${roomId}`;
}

function identityKeyPairKey(roomId: string, sessionId: string): string {
  return `elm-chat:identity:${roomId}:${sessionId}`;
}

function replayStateKey(roomId: string, sessionId: string, kind: "message" | "event"): string {
  return `elm-chat:replay:${kind}:${roomId}:${sessionId}`;
}

async function loadIdentityKeyPair(roomId: string, sessionId: string): Promise<{
  privateKey: CryptoKey;
  publicKey: string;
  agreementPrivateKey: CryptoKey;
  agreementPublicKey: string;
}> {
  const storageKey = identityKeyPairKey(roomId, sessionId);
  const stored = safeStorageGet("session", storageKey);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as {
        privateKey: JsonWebKey;
        publicKey: string;
        agreementPrivateKey: JsonWebKey;
        agreementPublicKey: string;
      };
      return {
        privateKey: await importIdentityPrivateKey(parsed.privateKey),
        publicKey: parsed.publicKey,
        agreementPrivateKey: await importAgreementPrivateKey(parsed.agreementPrivateKey),
        agreementPublicKey: parsed.agreementPublicKey
      };
    } catch {
      // Replace corrupt or legacy identity state with a fresh tab-scoped key.
    }
  }
  const [pair, agreementPair] = await Promise.all([
    createIdentityKeyPair(),
    createAgreementKeyPair()
  ]);
  const result = {
    privateKey: pair.privateKey,
    publicKey: await exportIdentityPublicKey(pair.publicKey),
    agreementPrivateKey: agreementPair.privateKey,
    agreementPublicKey: await exportAgreementPublicKey(agreementPair.publicKey)
  };
  safeStorageSet("session", storageKey, JSON.stringify({
    privateKey: await exportIdentityPrivateKey(pair.privateKey),
    publicKey: result.publicKey,
    agreementPrivateKey: await exportAgreementPrivateKey(agreementPair.privateKey),
    agreementPublicKey: result.agreementPublicKey
  }));
  return result;
}

function safeStorageGet(storage: "local" | "session", key: string): string | null {
  try {
    const target = storage === "local" ? window.localStorage : window.sessionStorage;
    return target.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(storage: "local" | "session", key: string, value: string): void {
  try {
    const target = storage === "local" ? window.localStorage : window.sessionStorage;
    target.setItem(key, value);
  } catch {
    // Private browsing and restrictive browser contexts can block storage access.
  }
}

function safeStorageRemove(storage: "local" | "session", key: string): void {
  try {
    const target = storage === "local" ? window.localStorage : window.sessionStorage;
    target.removeItem(key);
  } catch {
    // Storage cleanup is best effort in restrictive browser contexts.
  }
}

function durationUnitLabel(unit: DurationUnit): string {
  switch (unit) {
    case "minutes":
      return t("minutes").toLowerCase();
    case "hours":
      return t("hours").toLowerCase();
    case "days":
      return t("days").toLowerCase();
  }
}

function durationToMs(amount: number, unit: DurationUnit): number {
  switch (unit) {
    case "minutes":
      return amount * 60 * 1000;
    case "hours":
      return amount * 60 * 60 * 1000;
    case "days":
      return amount * 24 * 60 * 60 * 1000;
  }
}

function durationToSeconds(amount: number, unit: DurationUnit): number {
  return Math.floor(durationToMs(amount, unit) / 1000);
}

function formatSelectedDuration(amount: string, unit: DurationUnit, indefinite: boolean): string {
  if (indefinite) {
    return t("indefinite");
  }
  const value = Number(amount) || 0;
  const label = durationUnitLabel(unit);
  return `${value} ${label}`;
}

function parseDurationDraft(
  draft: DurationDraft,
  fallbackValue: number,
  fallbackUnit: DurationUnit,
  kind: "seconds" | "milliseconds"
): number | null {
  if (draft.indefinite) {
    return null;
  }

  const parsed = Number(draft.amount);
  const safeAmount = Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackValue;
  const unit = draft.unit || fallbackUnit;
  return kind === "seconds"
    ? durationToSeconds(safeAmount, unit)
    : durationToMs(safeAmount, unit);
}

function parseInviteDurationDraft(draft: InviteDurationDraft): number {
  const parsed = Number(draft.amount);
  const safeAmount = Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
  return durationToMs(safeAmount, draft.unit || "minutes");
}

function toggleIndefiniteDuration(
  current: DurationDraft,
  checked: boolean,
  fallbackAmount: string
): DurationDraft {
  if (checked) {
    return {
      ...current,
      indefinite: true
    };
  }

  return {
    ...current,
    indefinite: false,
    amount: current.amount || fallbackAmount
  };
}

let turnstileScriptPromise: Promise<void> | null = null;
let turnstileWidgetId: string | undefined;
let turnstilePendingResolve: ((token: string | undefined) => void) | null = null;

function resolveTurnstile(token: string | undefined): void {
  const resolve = turnstilePendingResolve;
  turnstilePendingResolve = null;
  resolve?.(token);
}

function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) {
    return Promise.resolve();
  }
  if (!turnstileScriptPromise) {
    turnstileScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("challenge script failed to load"));
      document.head.appendChild(script);
    });
  }
  return turnstileScriptPromise;
}

// Runs an invisible Turnstile challenge when a site key is configured. Returns
// the token, or undefined when Turnstile is not configured (local dev) or the
// challenge could not run — the server decides whether a token is required.
async function getTurnstileToken(): Promise<string | undefined> {
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY;
  if (!siteKey) {
    return undefined;
  }
  try {
    await loadTurnstileScript();
  } catch {
    return undefined;
  }
  const turnstile = window.turnstile;
  if (!turnstile) {
    return undefined;
  }
  return new Promise<string | undefined>((resolve) => {
    turnstilePendingResolve = resolve;
    let container = document.getElementById("turnstile-holder");
    if (!container) {
      container = document.createElement("div");
      container.id = "turnstile-holder";
      container.style.position = "fixed";
      container.style.bottom = "-9999px";
      container.style.left = "-9999px";
      document.body.appendChild(container);
    }
    try {
      if (turnstileWidgetId === undefined) {
        turnstileWidgetId = turnstile.render(container, {
          sitekey: siteKey,
          execution: "execute",
          appearance: "interaction-only",
          callback: (token: string) => resolveTurnstile(token),
          "error-callback": () => resolveTurnstile(undefined),
          "timeout-callback": () => resolveTurnstile(undefined),
          "expired-callback": () => resolveTurnstile(undefined)
        });
      } else {
        turnstile.reset(turnstileWidgetId);
      }
      turnstile.execute(turnstileWidgetId, { sitekey: siteKey });
    } catch {
      resolveTurnstile(undefined);
    }
    // Never let a stuck challenge block room creation indefinitely.
    window.setTimeout(() => resolveTurnstile(undefined), 8000);
  });
}

async function createRoom(body: CreateRoomRequest): Promise<CreateRoomResponse> {
  const response = await fetch("/api/rooms", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(detail?.error ?? t("failedCreateRoom"));
  }
  return response.json();
}

async function destroyRoom(roomId: string, creatorToken: string): Promise<RoomMetadata> {
  const response = await fetch(`/api/rooms/${roomId}/destroy`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ creatorToken })
  });
  if (!response.ok) {
    throw new Error(t("destroyRoomFailed"));
  }
  return response.json();
}

async function createInvite(roomId: string, creatorToken: string, ttlMs = 10 * 60 * 1000): Promise<RoomInvite> {
  const response = await fetch(`/api/rooms/${roomId}/invites`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ creatorToken, ttlMs })
  });
  if (!response.ok) {
    throw new Error(t("createInviteFailed"));
  }
  return response.json();
}

async function listInvites(roomId: string, creatorToken: string): Promise<RoomInvite[]> {
  const response = await fetch(`/api/rooms/${roomId}/invites`, {
    headers: { authorization: `Bearer ${creatorToken}` }
  });
  if (!response.ok) {
    throw new Error(t("failedLoadInvites"));
  }
  return response.json();
}

async function revokeInvite(roomId: string, creatorToken: string, token: string): Promise<void> {
  const response = await fetch(`/api/rooms/${roomId}/invites/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ creatorToken, token })
  });
  if (!response.ok) {
    throw new Error(t("revokeInviteFailed"));
  }
}

async function manageAccessCode(
  roomId: string,
  creatorToken: string,
  body: AccessCodeManageRequest
): Promise<AccessCodeManageResponse> {
  const response = await fetch(`/api/rooms/${roomId}/access-code`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${creatorToken}`
    },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((data as { error?: string })?.error ?? "Failed to update access code");
  }
  return data as AccessCodeManageResponse;
}

async function getAccessCodeStatus(
  roomId: string,
  creatorToken: string
): Promise<AccessCodeManageResponse> {
  const response = await fetch(`/api/rooms/${roomId}/access-code`, {
    headers: {
      authorization: `Bearer ${creatorToken}`
    }
  });
  if (!response.ok) {
    throw new Error("Failed to get access code status");
  }
  return response.json();
}

async function verifyAccessCode(
  roomId: string,
  body: AccessCodeVerifyRequest
): Promise<AccessCodeVerifyResponse> {
  const response = await fetch(`/api/rooms/${roomId}/access-code/verify`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const data = (await response.json().catch(() => ({}))) as AccessCodeVerifyResponse & { error?: string };
  if (!response.ok) {
    return {
      ok: false,
      error: data?.error ?? "Verification failed",
      retryAfterSeconds: data?.retryAfterSeconds,
      remainingAttempts: data?.remainingAttempts
    };
  }
  return data;
}

async function copyText(value: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText) {
    return false;
  }
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function wsUrl(path: string): string {
  const url = new URL(window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = path;
  return url.toString();
}

function messageStatus(message: UiMessage): string {
  if (message.expiresAt) {
    return t("vanishesIn", { duration: formatRelativeDuration(message.expiresAt) });
  }
  return t("untilRoomCloses");
}

function upsertMessage(messages: UiMessage[], next: UiMessage): UiMessage[] {
  const existingIndex = messages.findIndex((message) => message.id === next.id);
  if (existingIndex === -1) {
    return [...messages, next].sort((left, right) => left.sentAt - right.sentAt);
  }

  const copy = [...messages];
  copy[existingIndex] = {
    ...copy[existingIndex],
    ...next
  };
  return copy;
}

function colorFromSessionId(sessionId: string): string {
  let hash = 0;
  for (let index = 0; index < sessionId.length; index += 1) {
    hash = (hash * 31 + sessionId.charCodeAt(index)) >>> 0;
  }
  const hue = hash % 360;
  const saturation = 62 + (hash % 12);
  const lightness = 48 + (hash % 10);
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

function inviteColor(invite: RoomInvite): string {
  return colorFromSessionId(invite.consumedBySessionId ?? invite.token);
}

function bubbleStyle(sessionId: string, mine: boolean): CSSProperties {
  const color = colorFromSessionId(sessionId);
  return {
    "--bubble-accent": mine ? "#a78bfa" : color,
    "--bubble-surface": mine
      ? "linear-gradient(135deg, rgba(68, 25, 120, 0.42) 0%, rgba(18, 10, 32, 0.88) 100%)"
      : "linear-gradient(135deg, rgba(26, 26, 36, 0.8) 0%, rgba(14, 14, 20, 0.92) 100%)",
    "--bubble-surface-border": mine
      ? "rgba(167, 139, 250, 0.28)"
      : "rgba(226, 232, 240, 0.12)",
    "--bubble-text": mine ? "#f8fafc" : "#f1f5f9"
  } as CSSProperties;
}

function inviteAccentStyle(invite: RoomInvite): CSSProperties | undefined {
  const color = inviteColor(invite);
  return {
    "--invite-accent": color,
    "--invite-surface": `color-mix(in srgb, ${color}, white 84%)`,
    "--invite-border": `color-mix(in srgb, ${color}, white 56%)`
  } as CSSProperties;
}

function inviteStatusLabel(invite: RoomInvite): string {
  if (invite.revokedAt) {
    return t("inviteStatusRevoked");
  }
  if (invite.consumedAt || invite.admittedAt) {
    return t("inviteStatusJoined");
  }
  if (invite.claimedAt) {
    return t("inviteStatusJoining");
  }
  if (invite.expiresAt <= Date.now()) {
    return t("inviteStatusExpired");
  }
  return t("inviteStatusExpires", { duration: formatRelativeDuration(invite.expiresAt) });
}

function buildInviteUrl(roomId: string, inviteToken: string, roomSecret: string): string {
  return `${window.location.origin}/c/${roomId}?invite=${encodeURIComponent(inviteToken)}#${roomSecret}`;
}

function roomStateMessage(status: RoomMetadata["status"], reason?: string): string {
  if (status === "destroyed") {
    return t("destroyed");
  }

  switch (reason) {
    case "join-timeout":
      return t("joinTimeout");
    case "inactive":
      return t("inactive");
    case "max-age":
      return t("maxAge");
    default:
      return t("unavailable");
  }
}

function recordMakeYourOwnClick() {
  recordGrowthEvent("make_your_own_clicked");
}

// Privacy-safe growth callout for an invite recipient. The aggregate event
// records no room, invite, participant, or message identifier.
function MakeYourOwnCallout({ compact = false }: { compact?: boolean }) {
  return (
    <p className={`make-your-own ${compact ? "make-your-own-compact" : ""}`}>
      {compact
        ? t("tryInvite")
        : t("madeWith")}
      <a
        className="make-your-own-link"
        href="/?source=invite"
        onClick={recordMakeYourOwnClick}
        rel={compact ? "noreferrer" : undefined}
        target={compact ? "_blank" : undefined}
      >
        {t("makeYourOwn")}
      </a>
    </p>
  );
}

type RecoveryFocusTarget = { focusRef?: React.RefCallback<HTMLElement> };

function InvalidInviteScreen({ reason, focusRef }: { reason: InviteAccess } & RecoveryFocusTarget) {
  const copy =
    reason === "claimed"
      ? t("inviteClaimed")
      : reason === "used"
        ? t("inviteUsed")
        : t("inviteInvalid");
  return (
    <main className="room-shell room-shell-centered">
      <section className="access-screen" aria-live="polite">
        <p className="eyebrow brand-eyebrow">[Mehraru]</p>
        <h1 className="access-title" ref={focusRef} tabIndex={-1}>{t("invalidLink")}</h1>
        <p className="access-copy">{copy}</p>
        <a
          className="secondary-button access-home-link"
          href="/?source=invite"
          onClick={recordMakeYourOwnClick}
        >
          {t("backHome")}
        </a>
        <MakeYourOwnCallout />
      </section>
    </main>
  );
}

function RemovedFromRoomScreen({ focusRef }: RecoveryFocusTarget) {
  return (
    <main className="room-shell room-shell-centered">
      <section className="access-screen" aria-live="polite">
        <p className="eyebrow brand-eyebrow">[Mehraru]</p>
        <h1 className="access-title" ref={focusRef} tabIndex={-1}>{t("removedTitle")}</h1>
        <p className="access-copy">{t("removedCopy")}</p>
        <a
          className="secondary-button access-home-link"
          href="/?source=invite"
          onClick={recordMakeYourOwnClick}
        >
          {t("backHome")}
        </a>
        <MakeYourOwnCallout />
      </section>
    </main>
  );
}

function RoomAccessVaultScreen({
  roomId,
  inviteToken,
  onVerified
}: {
  roomId: string;
  inviteToken?: string;
  onVerified: (ticket: string) => void;
}) {
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<"idle" | "verifying" | "success" | "denied" | "locked">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [remainingAttempts, setRemainingAttempts] = useState<number | null>(null);
  const [lockoutSeconds, setLockoutSeconds] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!lockoutSeconds || lockoutSeconds <= 0) return;
    const timer = setInterval(() => {
      setLockoutSeconds((prev) => {
        if (!prev || prev <= 1) {
          clearInterval(timer);
          setStatus("idle");
          setErrorMsg(null);
          return null;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [lockoutSeconds]);

  async function handleVerify(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (code.length !== 6 || status === "verifying" || status === "locked") return;

    setStatus("verifying");
    setErrorMsg(null);

    try {
      const res = await verifyAccessCode(roomId, {
        inviteToken,
        accessCode: code
      });

      if (res.ok && res.ticket) {
        setStatus("success");
        setTimeout(() => {
          onVerified(res.ticket!);
        }, 600);
      } else {
        if (res.retryAfterSeconds) {
          setStatus("locked");
          setLockoutSeconds(res.retryAfterSeconds);
          setErrorMsg(`Too many failed attempts. Temporary lockout for ${res.retryAfterSeconds}s.`);
        } else {
          setStatus("denied");
          setRemainingAttempts(res.remainingAttempts ?? null);
          setErrorMsg(res.error ?? "Access Denied. Incorrect access code.");
        }
      }
    } catch {
      setStatus("denied");
      setErrorMsg("Verification failed. Please check network connection.");
    }
  }

  return (
    <main className="room-shell room-shell-centered">
      <section className={`access-screen vault-access-screen ${status === "denied" ? "is-denied" : ""} ${status === "success" ? "is-granted" : ""}`}>
        <div className="vault-lock-badge">
          <span className="lock-icon" aria-hidden="true">{status === "success" ? "✓" : "🔐"}</span>
        </div>

        <p className="eyebrow brand-eyebrow">[Mehraru] PRIVATE VAULT</p>
        <h1 className="access-title">
          {status === "success" ? "ACCESS GRANTED" : "ROOM ACCESS REQUIRED"}
        </h1>
        <p className="access-copy">
          {status === "success"
            ? "Access verified. Entering private room..."
            : "Enter the creator-controlled 6-digit access code to enter."}
        </p>

        {status !== "success" && (
          <form className="vault-pin-form" onSubmit={handleVerify}>
            <div
              className="vault-pin-display"
              onClick={() => inputRef.current?.focus()}
              role="presentation"
            >
              {[0, 1, 2, 3, 4, 5].map((index) => {
                const char = code[index];
                const isCurrent = code.length === index;
                return (
                  <div
                    key={index}
                    className={`pin-cell ${char ? "is-filled" : ""} ${isCurrent ? "is-active" : ""}`}
                  >
                    {char ? "•" : ""}
                  </div>
                );
              })}
            </div>

            <input
              ref={inputRef}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              value={code}
              disabled={status === "locked" || status === "verifying"}
              onChange={(e) => {
                const val = e.target.value.replace(/\D/g, "").slice(0, 6);
                setCode(val);
                if (val.length === 6) {
                  setTimeout(() => {
                    const form = inputRef.current?.form;
                    form?.requestSubmit();
                  }, 50);
                }
              }}
              className="vault-pin-hidden-input"
              aria-label="Room access code 6 digits"
              autoComplete="one-time-code"
            />

            {errorMsg && (
              <div className={`vault-auth-alert ${status === "locked" ? "is-warning" : "is-error"}`} role="alert">
                <span>{errorMsg}</span>
                {remainingAttempts !== null && remainingAttempts > 0 && status !== "locked" && (
                  <span className="attempts-remaining">({remainingAttempts} attempts remaining)</span>
                )}
              </div>
            )}

            <button
              type="submit"
              className={`primary-button vault-verify-btn ${status === "verifying" ? "is-verifying" : ""}`}
              disabled={code.length !== 6 || status === "verifying" || status === "locked"}
            >
              {status === "verifying" ? "VERIFYING..." : "VERIFY ACCESS CODE"}
            </button>
          </form>
        )}

        <div className="vault-access-footer">
          <span className="vault-subtext">Protected by room creator · End-to-end encrypted vault</span>
        </div>
      </section>
    </main>
  );
}

function RoomSecurityModal({
  roomId,
  creatorToken,
  room,
  invites,
  knownAccessCode,
  presenceCount,
  onClose,
  onUpdateCode,
  onRevokeInvite
}: {
  roomId: string;
  creatorToken: string;
  room: RoomMetadata | null;
  invites: RoomInvite[];
  knownAccessCode?: string;
  presenceCount: number;
  onClose: () => void;
  onUpdateCode: (code?: string, enabled?: boolean) => void;
  onRevokeInvite: (token: string) => void;
}) {
  const [customCode, setCustomCode] = useState("");
  const [working, setWorking] = useState(false);
  const [msg, setMsg] = useState<{ text: string; kind: "info" | "success" | "error" } | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleGenerate() {
    setWorking(true);
    setMsg(null);
    try {
      const res = await manageAccessCode(roomId, creatorToken, { action: "generate" });
      onUpdateCode(res.code, true);
      setMsg({ text: "New 6-digit access code generated successfully.", kind: "success" });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Failed to generate code", kind: "error" });
    } finally {
      setWorking(false);
    }
  }

  async function handleSetCustom(e: React.FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(customCode)) {
      setMsg({ text: "Access code must be exactly 6 numeric digits.", kind: "error" });
      return;
    }
    setWorking(true);
    setMsg(null);
    try {
      const res = await manageAccessCode(roomId, creatorToken, { action: "set", code: customCode });
      onUpdateCode(res.code, true);
      setCustomCode("");
      setMsg({ text: "Custom access code configured successfully.", kind: "success" });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Failed to set code", kind: "error" });
    } finally {
      setWorking(false);
    }
  }

  async function handleRevoke() {
    if (!window.confirm("Are you sure you want to revoke the room access code? Any participant attempting to join will be denied until a new code is set.")) return;
    setWorking(true);
    setMsg(null);
    try {
      await manageAccessCode(roomId, creatorToken, { action: "revoke" });
      onUpdateCode(undefined, false);
      setMsg({ text: "Room access code revoked. Entry is now blocked.", kind: "info" });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Failed to revoke code", kind: "error" });
    } finally {
      setWorking(false);
    }
  }

  async function handleDisable() {
    if (!window.confirm("Disable access code protection for this room? Guests will only need the invitation link.")) return;
    setWorking(true);
    setMsg(null);
    try {
      await manageAccessCode(roomId, creatorToken, { action: "disable" });
      onUpdateCode(undefined, false);
      setMsg({ text: "Access code protection disabled.", kind: "info" });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Failed to disable code", kind: "error" });
    } finally {
      setWorking(false);
    }
  }

  async function handleCopy() {
    if (!knownAccessCode) return;
    if (await copyText(knownAccessCode)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  }

  return (
    <div
      className="vault-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="vault-modal" role="dialog" aria-modal="true" aria-labelledby="security-modal-title">
        <div className="vault-modal-header">
          <div className="modal-title-cluster">
            <span className="modal-key-icon" aria-hidden="true">🛡️</span>
            <div>
              <h2 id="security-modal-title">Room Security & Access Code</h2>
              <p className="modal-sub">Creator-controlled access protection & guest authentication</p>
            </div>
          </div>
          <button className="modal-close-btn" onClick={onClose} type="button" aria-label="Close modal">
            ✕
          </button>
        </div>

        <div className="vault-modal-body">
          {/* Guest authentication presence */}
          <div className="security-status-card">
            <div className="status-header-row">
              <span className="setting-label">Person 2 Status</span>
              <span className="status-indicator">
                {presenceCount >= 2 ? (
                  <><span className="conn-dot" style={{ background: "#10b981" }} /> Authenticated & Present</>
                ) : room?.accessCodeVerified ? (
                  <><span className="conn-dot" style={{ background: "#a78bfa" }} /> Verified (Offline/Reconnecting)</>
                ) : (
                  <><span className="conn-dot" style={{ background: "#f59e0b" }} /> Awaiting Code Verification</>
                )}
              </span>
            </div>
            <p className="setting-note" style={{ margin: 0 }}>
              The room strictly supports exactly two participants. Person 2 cannot join without authenticating.
            </p>
          </div>

          {/* Access code controls */}
          <div className="security-status-card">
            <div className="status-header-row">
              <span className="setting-label">Access Code Protection</span>
              <span className="vault-badge-secure" style={{
                background: room?.accessCodeProtected ? "rgba(16, 185, 129, 0.2)" : "rgba(244, 63, 94, 0.2)",
                borderColor: room?.accessCodeProtected ? "rgba(16, 185, 129, 0.4)" : "rgba(244, 63, 94, 0.4)",
                color: room?.accessCodeProtected ? "#34d399" : "#fda4af"
              }}>
                {room?.accessCodeProtected ? "ENABLED" : "DISABLED"}
              </span>
            </div>

            {room?.accessCodeProtected && knownAccessCode && (
              <div className="code-display-box">
                <div>
                  <span className="eyebrow" style={{ color: "var(--muted)", fontSize: 10 }}>ACTIVE ACCESS CODE</span>
                  <div className="code-numbers">{knownAccessCode}</div>
                </div>
                <button
                  className={`secondary-button ${copied ? "button-success" : ""}`}
                  onClick={handleCopy}
                  type="button"
                >
                  {copied ? "Copied!" : "Copy Code"}
                </button>
              </div>
            )}

            <p className="setting-note" style={{ margin: 0 }}>
              {room?.accessCodeProtected
                ? "The code is salted and hashed using PBKDF2 on the server. Share it out-of-band with your guest."
                : "Enable an access code to prevent anyone from joining without creator authorization."}
            </p>

            <div className="security-actions-grid">
              <button
                className="secondary-button"
                disabled={working}
                onClick={handleGenerate}
                type="button"
              >
                ⚡ {room?.accessCodeProtected ? "Regenerate Code" : "Generate Code"}
              </button>
              {room?.accessCodeProtected ? (
                <button
                  className="secondary-button"
                  style={{ color: "#fda4af", borderColor: "rgba(244, 63, 94, 0.3)" }}
                  disabled={working}
                  onClick={handleRevoke}
                  type="button"
                >
                  🚫 Revoke Code
                </button>
              ) : null}
            </div>

            <form onSubmit={handleSetCustom} className="custom-code-input-row" style={{ marginTop: 6 }}>
              <input
                className="setting-input custom-code-input"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                placeholder="Custom 6 Digits"
                value={customCode}
                onChange={(e) => setCustomCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                disabled={working}
              />
              <button
                className="primary-button"
                type="submit"
                disabled={customCode.length !== 6 || working}
              >
                Set Code
              </button>
            </form>

            {room?.accessCodeProtected && (
              <button
                className="secondary-button"
                style={{ fontSize: 12, marginTop: 4, alignSelf: "flex-start", opacity: 0.8 }}
                onClick={handleDisable}
                disabled={working}
                type="button"
              >
                Disable Code Protection
              </button>
            )}
          </div>

          {msg && (
            <div
              className={`vault-auth-alert ${msg.kind === "error" ? "is-error" : msg.kind === "success" ? "is-granted" : "is-warning"}`}
              style={{
                background: msg.kind === "success" ? "rgba(16, 185, 129, 0.15)" : undefined,
                color: msg.kind === "success" ? "#6ee7b7" : undefined,
                borderColor: msg.kind === "success" ? "rgba(16, 185, 129, 0.4)" : undefined
              }}
            >
              {msg.text}
            </div>
          )}

          {/* Active Invites & Revocation */}
          {invites.filter((i) => !i.revokedAt).length > 0 && (
            <div className="vault-invites-block" style={{ marginTop: 8 }}>
              <span className="eyebrow">Active Invitations ({invites.filter((i) => !i.revokedAt).length})</span>
              <div className="vault-invites-scroll">
                {invites.filter((i) => !i.revokedAt).map((invite) => (
                  <div className="invite-row vault-invite-row" key={invite.token}>
                    <div className="vault-invite-meta">
                      <span className="invite-tag">{inviteStatusLabel(invite)}</span>
                      <span className="invite-token-code">Token: {invite.token.slice(0, 8)}...</span>
                    </div>
                    <div className="invite-actions">
                      <button
                        className="secondary-button invite-revoke"
                        onClick={() => onRevokeInvite(invite.token)}
                        type="button"
                      >
                        Revoke Invite
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MehraruLogo({ size = 24, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={`mehraru-logo ${className}`}
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="vaultGrad" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#c4b5fd" />
          <stop offset="45%" stopColor="#8b5cf6" />
          <stop offset="100%" stopColor="#4c1d95" />
        </linearGradient>
        <linearGradient id="shieldGrad" x1="12" y1="2" x2="12" y2="22" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="rgba(139, 92, 246, 0.22)" />
          <stop offset="100%" stopColor="rgba(20, 10, 36, 0.55)" />
        </linearGradient>
      </defs>
      <path
        d="M12 2.5L3.5 6.2v5.8c0 5.4 3.6 10.4 8.5 11.6 4.9-1.2 8.5-6.2 8.5-11.6V6.2L12 2.5z"
        fill="url(#shieldGrad)"
        stroke="url(#vaultGrad)"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
      <circle cx="8.5" cy="11.5" fill="#e2e8f0" r="1.6" />
      <circle cx="15.5" cy="11.5" fill="#a78bfa" r="1.6" />
      <path
        d="M8.5 11.5h7"
        stroke="#cbd5e1"
        strokeDasharray="1.5 1.5"
        strokeLinecap="round"
        strokeWidth="1.25"
      />
      <circle cx="12" cy="15.5" fill="#c4b5fd" r="1" />
    </svg>
  );
}

function GithubMark({ size = 16 }: { size?: number }) {
  return (
    <svg aria-hidden="true" fill="currentColor" height={size} viewBox="0 0 16 16" width={size}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 012-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function FileCard({ file, onDownload }: { file: UiFile; onDownload: () => void }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const progress = file.progress ?? 0;
  const percent = Number.isFinite(progress) ? Math.round(Math.min(1, Math.max(0, progress)) * 100) : 0;
  return (
    <div aria-label={t("fileCardLabel", { name: file.name })} className="file-card" ref={cardRef} role="group" tabIndex={-1}>
      <div className="file-card-head">
        <span className="file-icon" aria-hidden="true">
          &#128206;
        </span>
        <div className="file-meta">
          <span className="file-name">{file.name}</span>
          <span className="file-size">{formatBytes(file.size)}</span>
        </div>
      </div>
      {file.outgoing ? (
        <span className="file-status">{t("fileShared")}</span>
      ) : file.state === "offered" ? (
        <button aria-label={t("downloadFileLabel", { name: file.name })} className="secondary-button file-action" onClick={(event) => {
          // Preserve the initiating control's focus before progress replaces it.
          if (document.activeElement === event.currentTarget) cardRef.current?.focus({ preventScroll: true });
          onDownload();
        }} type="button">
          {t("download")}
        </button>
      ) : file.state === "requesting" || file.state === "transferring" ? (
        <div
          aria-label={t("fileProgressLabel", { name: file.name })}
          aria-live="off"
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={percent}
          className="file-progress"
          role="progressbar"
        >
          <div className="file-progress-track">
            <div className="file-progress-bar" style={{ width: `${percent}%` }} />
          </div>
          <span className="file-progress-label">{percent}%</span>
        </div>
      ) : file.state === "ready" && file.url ? (
        <a aria-label={t("saveFileLabel", { name: file.name })} className="secondary-button file-action" download={file.name} href={file.url}>
          {t("saveFile")}
        </a>
      ) : file.state === "error" ? (
        <span className="file-status file-status-error">{t("transferFailed")}</span>
      ) : null}
    </div>
  );
}

function InviteCheckingScreen({ connection, error, onRetry, focusRef }: {
  connection: string;
  error: string | null;
  onRetry?: () => void;
} & RecoveryFocusTarget) {
  return (
    <main className="room-shell room-shell-centered">
      <section className="access-screen" aria-live="polite">
        <p className="eyebrow brand-eyebrow">[Mehraru]</p>
        <h1 className="access-title">{t("checkingInvite")}</h1>
        <p className="access-copy">{t("verifyingInvite")}</p>
        <p ref={focusRef} tabIndex={-1}>{connection}</p>
        {error ? <p className="error-text" role="alert">{error}</p> : null}
        {onRetry ? <button className="secondary-button" onClick={onRetry} type="button">{t("retryConnection")}</button> : null}
        <MakeYourOwnCallout />
      </section>
    </main>
  );
}

function RoomGoneScreen({ fromInvite, reason, focusRef }: { fromInvite: boolean; reason?: string } & RecoveryFocusTarget) {
  return (
    <main className="room-shell room-shell-centered">
      <section className="access-screen" aria-live="polite">
        <p className="eyebrow brand-eyebrow">[Mehraru]</p>
        <h1 className="access-title" ref={focusRef} tabIndex={-1}>{t("roomGone")}</h1>
        <p className="access-copy">
          {reason ?? t("roomGoneCopy")}
        </p>
        <a
          className="primary-button access-home-link"
          href={fromInvite ? "/?source=invite" : "/"}
          onClick={fromInvite ? recordMakeYourOwnClick : undefined}
        >
          {t("startNew")} &rarr;
        </a>
        {fromInvite ? <MakeYourOwnCallout /> : null}
      </section>
    </main>
  );
}

export function App() {
  const route = roomPathname();
  useEffect(() => {
    const previousLanguage = document.documentElement.lang;
    // Marketing articles are English; the landing and room UI use the catalog locale.
    document.documentElement.lang = route.view === "marketing" ? "en" : locale;
    return () => {
      document.documentElement.lang = previousLanguage;
    };
  }, [route.view]);
  if (route.view === "room" && route.roomId) {
    return <RoomPage roomId={route.roomId} />;
  }
  if (route.view === "marketing" && route.marketingSlug) {
    const sourceParam = new URLSearchParams(window.location.search).get("source");
    const externalSource = resolveExternalAcquisitionSource(sourceParam, document.referrer);
    return <MarketingPage externalSource={externalSource} slug={route.marketingSlug} />;
  }
  return <LandingPage />;
}

function LandingPage() {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [community, setCommunity] = useState<CommunityFeed | null>(null);
  const [communityError, setCommunityError] = useState(false);
  const [ghStats, setGhStats] = useState<{ stars: number | null; forks: number | null }>({
    stars: null,
    forks: null
  });
  const whyUseUrl =
    "https://github.com/shawnbure/elm-chat/blob/main/docs/why-use-elm-chat.md";
  const articleUrl =
    "https://github.com/shawnbure/elm-chat/blob/main/docs/truly-private-messaging.md";
  const sourceParam = new URLSearchParams(window.location.search).get("source");
  const externalSource = resolveExternalAcquisitionSource(sourceParam, document.referrer);
  const [messageDuration, setMessageDuration] = useState<DurationDraft>({
    amount: "7",
    unit: "minutes",
    indefinite: false
  });
  const [roomDuration, setRoomDuration] = useState<DurationDraft>({
    amount: "10",
    unit: "minutes",
    indefinite: false
  });

  useEffect(() => {
    let active = true;
    fetch("/api/stars")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (active && data) {
          setGhStats({ stars: data.stars ?? null, forks: data.forks ?? null });
        }
      })
      .catch(() => {
        // Non-fatal: counts simply stay hidden if the lookup fails.
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/community")
      .then((response) => {
        if (!response.ok) throw new Error("Community feed unavailable.");
        return response.json() as Promise<CommunityFeed>;
      })
      .then((feed) => {
        if (active) setCommunity(feed);
      })
      .catch(() => {
        if (active) setCommunityError(true);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (externalSource) {
      recordGrowthEvent("external_referral_viewed", externalSource);
    }
  }, [externalSource]);

  function updateDurationIndefinite(kind: DurationKind, checked: boolean) {
    if (kind === "message") {
      setMessageDuration((current) => toggleIndefiniteDuration(current, checked, "7"));
      return;
    }
    setRoomDuration((current) => toggleIndefiniteDuration(current, checked, "10"));
  }

  async function handleCreate() {
    try {
      setCreating(true);
      setError(null);
      const secret = generateRoomSecret();
      const turnstileToken = await getTurnstileToken();
      const source = new URLSearchParams(window.location.search).get("source");
      const room = await createRoom({
        acquisitionSource: isAcquisitionSource(source) ? source : undefined,
        disappearAfterReadSeconds: parseDurationDraft(
          messageDuration,
          7,
          "minutes",
          "seconds"
        ),
        inactivityTimeoutMs: parseDurationDraft(roomDuration, 10, "minutes", "milliseconds"),
        maxAgeMs: null,
        generateAccessCode: true,
        turnstileToken
      });
      safeStorageSet("local", creatorTokenKey(room.roomId), room.creatorToken);
      if (room.accessCode) {
        safeStorageSet("session", `elm-chat:access-code:${room.roomId}`, room.accessCode);
      }
      window.location.assign(`${room.roomUrl}#${secret}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("unableCreateRoom"));
      setCreating(false);
    }
  }

  return (
    <main className="landing-shell">
      <section className="hero">
        <div className="hero-copy">
          {externalSource === "freshcode" ? (
            <aside className="external-arrival" aria-label={t("freshcodeFound")}>
              <span className="external-arrival-label">{t("freshcodeFound")}</span>
              <strong>{t("freshcodeOpen")}</strong>
              <p>{t("freshcodeCopy")}</p>
              <div className="external-arrival-actions">
                <a
                  href={`${GITHUB_URL}/releases/tag/v0.1.0`}
                  onClick={() => recordGrowthEvent("external_source_clicked", externalSource)}
                  rel="noreferrer"
                  target="_blank"
                >
                  {t("inspectRelease")}
                </a>
                <a
                  href={`https://deploy.workers.cloudflare.com/?url=${GITHUB_URL}`}
                  onClick={() => recordGrowthEvent("external_deploy_clicked", externalSource)}
                  rel="noreferrer"
                  target="_blank"
                >
                  {t("deployOwn")}
                </a>
              </div>
            </aside>
          ) : null}
          <div className="hero-brand">
            <MehraruLogo size={34} />
            <div className="hero-brand-info">
              <span className="hero-brand-name">[Mehraru]</span>
              <span className="hero-brand-meaning">
                <span className="hero-brand-separator" aria-hidden="true">·</span>
                {t("nameMeaning")}
              </span>
            </div>
          </div>
          <h1>{t("heroTitle")}</h1>
          <p className="lede">
            {t("heroCopy")}
          </p>
          <div className="hero-privacy-badges" aria-label="Privacy Highlights">
            <span className="privacy-pill">🔒 1-on-1 Only</span>
            <span className="privacy-pill">🛡️ In-Browser Encrypted</span>
            <span className="privacy-pill">⏱️ Disappearing Messages</span>
          </div>
          <div className="creation-panel">
            <div className="setting-row" role="group" aria-labelledby="message-policy-label">
              <div>
                <span className="setting-label" id="message-policy-label">{t("messageVanish")}</span>
                <p className="setting-note">
                  {formatSelectedDuration(
                    messageDuration.amount,
                    messageDuration.unit,
                    messageDuration.indefinite
                  )}
                </p>
              </div>
              <div
                className={`setting-controls ${messageDuration.indefinite ? "setting-controls-disabled" : ""}`}
              >
                <input
                  aria-label={t("messageDurationAmount")}
                  className="setting-input"
                  disabled={messageDuration.indefinite}
                  inputMode="numeric"
                  min="1"
                  onChange={(event) =>
                    setMessageDuration((current) => ({ ...current, amount: event.target.value }))
                  }
                  type="number"
                  value={messageDuration.indefinite ? "" : messageDuration.amount}
                />
                <select
                  aria-label={t("messageDurationUnit")}
                  className="setting-select"
                  disabled={messageDuration.indefinite}
                  onChange={(event) =>
                    setMessageDuration((current) => ({
                      ...current,
                      unit: event.target.value as DurationUnit
                    }))
                  }
                  value={messageDuration.unit}
                >
                  <option value="minutes">{t("minutes")}</option>
                  <option value="hours">{t("hours")}</option>
                  <option value="days">{t("days")}</option>
                </select>
                <label className="toggle-pill">
                  <input
                    aria-labelledby="message-policy-label message-indefinite-label"
                    checked={messageDuration.indefinite}
                    onChange={(event) =>
                      updateDurationIndefinite("message", event.target.checked)
                    }
                    type="checkbox"
                  />
                  <span id="message-indefinite-label">{t("indefinite")}</span>
                </label>
              </div>
            </div>
            <div className="setting-row" role="group" aria-labelledby="room-policy-label">
              <div>
                <span className="setting-label" id="room-policy-label">{t("roomSelfDestruct")}</span>
                <p className="setting-note">
                  {roomDuration.indefinite
                    ? t("onlyManualDestroy")
                    : `${formatSelectedDuration(roomDuration.amount, roomDuration.unit, false)} ${t("idle")}`}
                </p>
              </div>
              <div
                className={`setting-controls ${roomDuration.indefinite ? "setting-controls-disabled" : ""}`}
              >
                <input
                  aria-label={t("roomDurationAmount")}
                  className="setting-input"
                  disabled={roomDuration.indefinite}
                  inputMode="numeric"
                  min="1"
                  onChange={(event) =>
                    setRoomDuration((current) => ({ ...current, amount: event.target.value }))
                  }
                  type="number"
                  value={roomDuration.indefinite ? "" : roomDuration.amount}
                />
                <select
                  aria-label={t("roomDurationUnit")}
                  className="setting-select"
                  disabled={roomDuration.indefinite}
                  onChange={(event) =>
                    setRoomDuration((current) => ({
                      ...current,
                      unit: event.target.value as DurationUnit
                    }))
                  }
                  value={roomDuration.unit}
                >
                  <option value="minutes">{t("minutes")}</option>
                  <option value="hours">{t("hours")}</option>
                  <option value="days">{t("days")}</option>
                </select>
                <label className="toggle-pill">
                  <input
                    aria-labelledby="room-policy-label room-indefinite-label"
                    checked={roomDuration.indefinite}
                    onChange={(event) =>
                      updateDurationIndefinite("room", event.target.checked)
                    }
                    type="checkbox"
                  />
                  <span id="room-indefinite-label">{t("indefinite")}</span>
                </label>
              </div>
            </div>
          </div>
          <div className="hero-actions">
            <button className="primary-button" disabled={creating} onClick={handleCreate}>
              {creating ? t("creatingRoom") : t("createRoom")}
            </button>
            <p className="helper-text">
              {t("roomSecret")}
            </p>
            <p className="helper-text">{t("securityWarning")}</p>
          </div>
          {error ? <p className="error-text">{error}</p> : null}
        </div>
        <div className="hero-panel">
          <div className="signal-grid" />
          <div className="architecture-panel">
            <div className="architecture-header">
              <span className="eyebrow">Architecture & Guarantees</span>
              <h2>Private by design. Temporary by default.</h2>
              <p className="architecture-intro">
                Built specifically for private, two-person communication that self-destructs without leaving a digital trace.
              </p>
            </div>
            <div className="architecture-cards">
              <div className="architecture-card">
                <div className="card-badge">01</div>
                <div className="card-body">
                  <h3>One-Time Cryptographic Invite</h3>
                  <p>Each link admits only one guest. Once joined, the single-use invite token is consumed, preventing forwarded links or eavesdroppers from entering.</p>
                </div>
              </div>
              <div className="architecture-card">
                <div className="card-badge">02</div>
                <div className="card-body">
                  <h3>Client-Side Web Crypto</h3>
                  <p>All message plaintext and attachments are encrypted and decrypted directly in your browser. Encryption keys stay in the URL fragment (#) and never reach the server.</p>
                </div>
              </div>
              <div className="architecture-card">
                <div className="card-badge">03</div>
                <div className="card-body">
                  <h3>Disappearing Messages & Ephemeral State</h3>
                  <p>Messages vanish on timer after reading. The entire room and all session memory self-destruct when closed or upon inactivity.</p>
                </div>
              </div>
            </div>
            <div className="hero-metrics">
              <div>
                <span>{t("access")}</span>
                <strong>{t("secretLinkOnly")}</strong>
              </div>
              <div>
                <span>{t("messagePolicy")}</span>
                <strong>
                  {messageDuration.indefinite
                    ? t("manualCleanup")
                    : formatSelectedDuration(messageDuration.amount, messageDuration.unit, false)}
                </strong>
              </div>
              <div>
                <span>{t("roomPolicy")}</span>
                <strong>{roomDuration.indefinite ? t("noIdleTimeout") : t("idleSelfDestruct")}</strong>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

function RoomPage({ roomId }: { roomId: string }) {
  const roomSecret = window.location.hash.replace(/^#/, "");
  const inviteToken = new URLSearchParams(window.location.search).get("invite") ?? "";
  const storedCreatorToken = safeStorageGet("local", creatorTokenKey(roomId)) ?? "";
  const isInviteGuest = Boolean(inviteToken && !storedCreatorToken);
  const [room, setRoom] = useState<RoomMetadata | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [invites, setInvites] = useState<RoomInvite[]>([]);
  const [manualInvite, setManualInvite] = useState<{ token: string; trigger: HTMLButtonElement; focusOwner: Element | null } | null>(null);
  const inviteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const inviteActionRef = useRef(0);
  const currentInvitesRef = useRef(invites);
  currentInvitesRef.current = invites;
  const [draft, setDraft] = useState("");
  const draftRevisionRef = useRef(0);
  const sendingRef = useRef(false);
  const [sending, setSending] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState(t("connecting"));
  const [canRetryConnection, setCanRetryConnection] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const retryConnectionRef = useRef<(() => void) | null>(null);
  const retryFocusTargetRef = useRef<HTMLElement | null>(null);
  const preserveRetryFocusRef = useRef(false);
  const setRetryFocusTarget = useCallback((element: HTMLElement | null) => {
    if (!element) {
      // Follow a replacement view only while the manually focused status owns focus.
      preserveRetryFocusRef.current = preserveRetryFocusRef.current &&
        document.activeElement === retryFocusTargetRef.current;
    }
    retryFocusTargetRef.current = element;
    if (element && preserveRetryFocusRef.current) element.focus();
  }, []);
  const [keyReady, setKeyReady] = useState(false);
  const [presence, setPresence] = useState<PresenceSnapshot>({ count: 0, connectedSessionIds: [] });
  const [now, setNow] = useState(Date.now());
  const conversationFind = useConversationFind(messages, now, (id) => {
    const log = chatLogRef.current;
    const article = log?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
    if (!log || !article) return;
    log.scrollTop += article.getBoundingClientRect().top - log.getBoundingClientRect().top - 12;
    handleConversationScroll();
  });
  const [roomNotice, setRoomNotice] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<ActionFeedback>("idle");
  const [destroyFeedback, setDestroyFeedback] = useState<ActionFeedback>("idle");
  const [inviteFeedback, setInviteFeedback] = useState<InviteFeedback>("idle");
  const [destroying, setDestroying] = useState(false);
  const [inviteAccess, setInviteAccess] = useState<InviteAccess>(isInviteGuest ? "checking" : "granted");
  const [removedFromRoom, setRemovedFromRoom] = useState(false);
  const [inviteDuration, setInviteDuration] = useState<InviteDurationDraft>({
    amount: "10",
    unit: "minutes"
  });
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [accessCodeTicket, setAccessCodeTicket] = useState<string | null>(() => {
    return safeStorageGet("session", `elm-chat:ticket:${roomId}`);
  });
  const [accessCodeVerified, setAccessCodeVerified] = useState<boolean>(() => {
    return Boolean(safeStorageGet("session", `elm-chat:ticket:${roomId}`));
  });
  const [knownAccessCode, setKnownAccessCode] = useState<string | undefined>(() => {
    return safeStorageGet("session", `elm-chat:access-code:${roomId}`) ?? undefined;
  });
  const [showSecurityModal, setShowSecurityModal] = useState(false);
  const [sessionId] = useState(() => {
    const stored = safeStorageGet("session", sessionKey(roomId));
    if (stored) {
      return stored;
    }
    const next = generateSessionId();
    safeStorageSet("session", sessionKey(roomId), next);
    return next;
  });
  const creatorToken = storedCreatorToken;
  const socketRef = useRef<WebSocket | null>(null);
  const roomKeyRef = useRef<CryptoKey | null>(null);
  const roomKeysRef = useRef(new Map<number, CryptoKey>());
  const keyEpochRef = useRef(1);
  const keyReadyRef = useRef(false);
  const membershipVersionRef = useRef(0);
  const keyWorkGenerationRef = useRef(0);
  const identityKeyRef = useRef<string>("");
  const identityPrivateKeyRef = useRef<CryptoKey | null>(null);
  const agreementPrivateKeyRef = useRef<CryptoKey | null>(null);
  const agreementPublicKeyRef = useRef<string>("");
  const peerIdentityKeysRef = useRef(new Map<string, string>());
  const peersRef = useRef(new Map<string, PeerDescriptor>());
  const joinedRef = useRef(false);
  // Mirror of the latest room status so the socket close handler (captured once
  // by the connection effect) can distinguish a live-room drop from an
  // already-closed room without reading a stale `room` value.
  const roomStatusRef = useRef<RoomMetadata["status"] | null>(null);
  const { chatLogRef, awayFromLatest, newMessageCount, jumpToLatest, handleConversationScroll } =
    useConversationScroll(messages, ready, conversationFind.open);
  const messageRef = useRef(new Map<string, AuthenticatedPeerEvent>());
  const destroyedMessageIdsRef = useRef(new Set<string>());
  const seenMessageIdsRef = useRef(new Set<string>());
  const replayGuardRef = useRef<ReplayGuard | null>(null);
  const eventReplayGuardRef = useRef<ReplayGuard | null>(null);
  if (!replayGuardRef.current) {
    replayGuardRef.current = new ReplayGuard(
      10000,
      window.sessionStorage,
      replayStateKey(roomId, sessionId, "message")
    );
  }
  if (!eventReplayGuardRef.current) {
    eventReplayGuardRef.current = new ReplayGuard(
      10000,
      window.sessionStorage,
      replayStateKey(roomId, sessionId, "event")
    );
  }
  const measuredInviteHandoffsRef = useRef(new Set<string>());
  const shouldRequestSyncRef = useRef(false);
  // Files being served by this client (we are the sender), kept in memory so we
  // can stream chunks on demand when a peer requests them.
  const outgoingFilesRef = useRef(new Map<string, File>());
  const outgoingFileHashesRef = useRef(new Map<string, string>());
  const outgoingFileEpochsRef = useRef(new Map<string, number>());
  // Files being received by this client, accumulating decrypted chunks.
  const incomingFilesRef = useRef(new Map<string, IncomingFile>());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Object URLs created for received files, revoked on expiry/unmount.
  const objectUrlsRef = useRef(new Set<string>());

  const checkVisibleMessages = useCallback(() => {
    if (!joinedRef.current) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const chatLog = chatLogRef.current;
    if (!chatLog) return;

    const logRect = chatLog.getBoundingClientRect();
    if (logRect.height === 0 || logRect.width === 0) return;

    for (const msg of messages) {
      if (msg.senderSessionId === sessionId) continue;
      if (msg.deliveryStatus === "seen" || msg.deliveryStatus === "destroyed") continue;
      if (seenMessageIdsRef.current.has(msg.id) || destroyedMessageIdsRef.current.has(msg.id)) continue;

      const element = chatLog.querySelector(`[data-message-id="${CSS.escape(msg.id)}"]`);
      if (!element) continue;

      const elRect = element.getBoundingClientRect();
      const isVisibleInViewport =
        elRect.bottom > logRect.top &&
        elRect.top < logRect.bottom &&
        elRect.height > 0;

      if (isVisibleInViewport) {
        seenMessageIdsRef.current.add(msg.id);
        socket.send(JSON.stringify({
          type: "message_seen",
          messageId: msg.id
        }));
      }
    }
  }, [messages, sessionId]);

  useEffect(() => {
    if (typeof requestAnimationFrame === "function") {
      const raf = requestAnimationFrame(() => {
        checkVisibleMessages();
      });
      return () => cancelAnimationFrame(raf);
    } else {
      checkVisibleMessages();
    }
  }, [messages, checkVisibleMessages]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        checkVisibleMessages();
      }
    };
    const onActive = () => {
      checkVisibleMessages();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onActive);
    window.addEventListener("resize", onActive);
    const chatLog = chatLogRef.current;
    chatLog?.addEventListener("scroll", onActive, { passive: true });
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onActive);
      window.removeEventListener("resize", onActive);
      chatLog?.removeEventListener("scroll", onActive);
    };
  }, [checkVisibleMessages]);

  async function sendPeerData(payload: PeerDataEvent, toSessionId?: string, isCurrent?: () => boolean) {
    const socket = socketRef.current;
    const privateKey = identityPrivateKeyRef.current;
    if (socket?.readyState !== WebSocket.OPEN || !joinedRef.current || !privateKey || (isCurrent && !isCurrent())) return null;
    const data = await createAuthenticatedPeerEvent(
      privateKey,
      roomId,
      sessionId,
      toSessionId ?? null,
      payload
    );
    // Signing yields to the browser; the connection may close before it finishes.
    if (socketRef.current !== socket || socket.readyState !== WebSocket.OPEN || !joinedRef.current || (isCurrent && !isCurrent())) return null;
    socket.send(JSON.stringify({ type: "peer_data", toSessionId, data }));
    eventReplayGuardRef.current?.markLocal(data.eventId);
    return data;
  }

  function currentKeyLeader(): PeerDescriptor | undefined {
    return [...peersRef.current.values()].sort((left, right) =>
      Number(right.creator) - Number(left.creator) ||
      left.connectedAt - right.connectedAt ||
      left.sessionId.localeCompare(right.sessionId)
    )[0];
  }

  // Crypto can finish after a disconnect, a new membership, or effect cleanup.
  function captureKeyWork(keyEpoch: number, leader: PeerDescriptor): () => boolean {
    const socket = socketRef.current;
    const generation = keyWorkGenerationRef.current;
    return () => {
      const currentLeader = currentKeyLeader();
      return generation === keyWorkGenerationRef.current &&
        socket !== null && socketRef.current === socket && socket.readyState === WebSocket.OPEN &&
        joinedRef.current && roomStatusRef.current === "open" &&
        membershipVersionRef.current === keyEpoch &&
        currentLeader?.sessionId === leader.sessionId &&
        currentLeader.identityKey === leader.identityKey &&
        currentLeader.agreementKey === leader.agreementKey;
    };
  }

  async function rotateRoomKey(keyEpoch: number) {
    const leader = currentKeyLeader();
    const agreementPrivateKey = agreementPrivateKeyRef.current;
    if (!leader || leader.sessionId !== sessionId || !agreementPrivateKey) return;
    const isCurrent = captureKeyWork(keyEpoch, leader);
    if (!isCurrent()) return;
    const roomSecretForEpoch = generateRoomSecret();
    const nextKey = await deriveRoomKey(roomSecretForEpoch);
    if (!isCurrent()) return;
    roomKeysRef.current.set(keyEpoch, nextKey);
    roomKeyRef.current = nextKey;
    keyEpochRef.current = keyEpoch;
    keyReadyRef.current = true;
    setKeyReady(true);
    setConnection(t("connected"));
    await Promise.all([...peersRef.current.values()]
      .filter((peer) => peer.sessionId !== sessionId)
      .map(async (peer) => {
        const wrapped = await wrapRoomSecret(
          agreementPrivateKey,
          peer.agreementKey,
          roomId,
          keyEpoch,
          sessionId,
          peer.sessionId,
          roomSecretForEpoch
        );
        if (!isCurrent()) return;
        await sendPeerData({
          type: "key_rotation",
          keyEpoch,
          senderAgreementKey: agreementPublicKeyRef.current,
          ...wrapped
        }, peer.sessionId, isCurrent);
      }));
  }

  function beginMembershipChange(keyEpoch: number) {
    if (keyEpoch <= membershipVersionRef.current) return;
    membershipVersionRef.current = keyEpoch;
    keyReadyRef.current = false;
    setKeyReady(false);
    setConnection(t("securing"));
    void rotateRoomKey(keyEpoch);
  }

  function clearRoomSecurityState() {
    conversationFind.close();
    for (const [fileId, transfer] of incomingFilesRef.current) removeIncomingFile(fileId, transfer);
    replayGuardRef.current?.clear();
    eventReplayGuardRef.current?.clear();
    roomKeysRef.current.clear();
    keyReadyRef.current = false;
    setKeyReady(false);
    safeStorageRemove("session", identityKeyPairKey(roomId, sessionId));
    safeStorageRemove("session", sessionKey(roomId));
  }

  async function refreshInvites() {
    if (!creatorToken) {
      return;
    }
    try {
      const nextInvites = await listInvites(roomId, creatorToken);
      currentInvitesRef.current = nextInvites;
      setInvites(nextInvites);
    } catch {
      // Keep the last known invite state if the refresh fails.
    }
  }

  function updateFileMessage(fileId: string, patch: Partial<UiFile>) {
    startTransition(() => {
      setMessages((current) =>
        current.map((message) =>
          message.kind === "file" && message.file?.fileId === fileId
            ? { ...message, file: { ...message.file, ...patch } }
            : message
        )
      );
    });
  }

  function removeIncomingFile(fileId: string, entry = incomingFilesRef.current.get(fileId)) {
    if (!entry) return;
    if (entry.timeoutId !== undefined) window.clearTimeout(entry.timeoutId);
    entry.timeoutId = undefined;
    if (incomingFilesRef.current.get(fileId) === entry) incomingFilesRef.current.delete(fileId);
  }

  function armFileTimeout(fileId: string, entry: IncomingFile) {
    if (!entry.requested || incomingFilesRef.current.get(fileId) !== entry) return;
    if (entry.timeoutId !== undefined) window.clearTimeout(entry.timeoutId);
    const timeoutId = window.setTimeout(() => {
      // A cleared/queued callback must not remove a replacement or refreshed transfer.
      if (incomingFilesRef.current.get(fileId) !== entry || entry.timeoutId !== timeoutId) return;
      removeIncomingFile(fileId, entry);
      updateFileMessage(fileId, { state: "error" });
      void sendPeerData({ type: "file_cancel", fileId, reason: "timeout" }, entry.senderSessionId);
    }, 30_000);
    entry.timeoutId = timeoutId;
  }

  async function waitForSocketDrain() {
    const socket = socketRef.current;
    if (!socket) {
      return;
    }
    const maxBuffer = 4 * 1024 * 1024;
    while (socket.bufferedAmount > maxBuffer && socket.readyState === WebSocket.OPEN) {
      await new Promise((resolve) => window.setTimeout(resolve, 25));
    }
  }

  // Sender side: stream an outgoing file to the requesting peer as encrypted chunks.
  async function serveFile(fileId: string, requesterSessionId: string) {
    const file = outgoingFilesRef.current.get(fileId);
    const keyEpoch = outgoingFileEpochsRef.current.get(fileId);
    const key = typeof keyEpoch === "number" ? roomKeysRef.current.get(keyEpoch) : undefined;
    if (!file || !key) {
      return;
    }
    const buffer = new Uint8Array(await file.arrayBuffer());
    const totalChunks = Math.max(1, Math.ceil(buffer.byteLength / FILE_CHUNK_BYTES));
    for (let index = 0; index < totalChunks; index += 1) {
      const start = index * FILE_CHUNK_BYTES;
      const slice = buffer.subarray(start, Math.min(start + FILE_CHUNK_BYTES, buffer.byteLength));
      const { ciphertext, nonce } = await encryptBytes(key, slice);
      await waitForSocketDrain();
      const delivered = await sendPeerData(
        { type: "file_chunk", fileId, chunkIndex: index, totalChunks, ciphertext, nonce, keyEpoch: keyEpoch! },
        requesterSessionId
      );
      if (!delivered) {
        return;
      }
    }
    const sha256 = outgoingFileHashesRef.current.get(fileId);
    if (sha256) await sendPeerData({ type: "file_complete", fileId, sha256 }, requesterSessionId);
  }

  // Receiver side: decrypt and store an incoming chunk, updating transfer progress.
  async function receiveChunk(payload: PeerFileChunk) {
    const key = roomKeysRef.current.get(payload.keyEpoch);
    if (!key) {
      return;
    }
    const entry = incomingFilesRef.current.get(payload.fileId);
    if (!entry?.requested) return;
    if (entry.keyEpoch !== payload.keyEpoch) return;
    if (entry.chunks.length !== payload.totalChunks) {
      entry.chunks = new Array<Uint8Array | undefined>(payload.totalChunks);
      entry.received = 0;
      entry.receivedBytes = 0;
      entry.totalChunks = payload.totalChunks;
    }
    if (!entry.chunks[payload.chunkIndex]) {
      try {
        const chunk = await decryptBytes(key, payload.ciphertext, payload.nonce);
        if (incomingFilesRef.current.get(payload.fileId) !== entry) return;
        if (entry.receivedBytes + chunk.byteLength > entry.size || chunk.byteLength > FILE_CHUNK_BYTES) {
          throw new Error("File chunk exceeds declared bounds.");
        }
        entry.chunks[payload.chunkIndex] = chunk;
        entry.received += 1;
        entry.receivedBytes += chunk.byteLength;
      } catch {
        if (incomingFilesRef.current.get(payload.fileId) !== entry) return;
        removeIncomingFile(payload.fileId, entry);
        updateFileMessage(payload.fileId, { state: "error" });
        return;
      }
    }
    updateFileMessage(payload.fileId, {
      state: "transferring",
      progress: entry.totalChunks ? entry.received / entry.totalChunks : 0
    });
    armFileTimeout(payload.fileId, entry);
  }

  // Receiver side: reassemble a completed file into a downloadable blob URL.
  async function finalizeIncoming(fileId: string, announcedSha256: string) {
    const entry = incomingFilesRef.current.get(fileId);
    if (!entry?.requested) return;
    if (entry.timeoutId !== undefined) window.clearTimeout(entry.timeoutId);
    entry.timeoutId = undefined;
    if (entry.totalChunks === 0 || entry.received < entry.totalChunks) {
      removeIncomingFile(fileId, entry);
      updateFileMessage(fileId, { state: "error" });
      return;
    }
    const parts = entry.chunks.filter((chunk): chunk is Uint8Array => Boolean(chunk));
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    const digest = await sha256Base64Url(bytes);
    if (incomingFilesRef.current.get(fileId) !== entry) return;
    if (bytes.byteLength !== entry.size || digest !== entry.sha256 || digest !== announcedSha256) {
      removeIncomingFile(fileId, entry);
      updateFileMessage(fileId, { state: "error" });
      await sendPeerData({ type: "file_cancel", fileId, reason: "integrity" }, entry.senderSessionId);
      return;
    }
    const blob = new Blob(parts as BlobPart[], { type: entry.mimeType });
    const url = URL.createObjectURL(blob);
    objectUrlsRef.current.add(url);
    removeIncomingFile(fileId, entry);
    updateFileMessage(fileId, { state: "ready", progress: 1, url });
  }

  async function handleAttachFiles(fileList: FileList | null) {
    if (!fileList || !room || room.status !== "open" || !keyReadyRef.current) {
      return;
    }
    for (const file of Array.from(fileList)) {
      if (file.size > MAX_FILE_BYTES) {
        setError(t("fileTooLarge", { name: file.name, limit: formatBytes(MAX_FILE_BYTES) }));
        continue;
      }
      const fileId = generateMessageId();
      const sentAt = Date.now();
      const mimeType = file.type || "application/octet-stream";
      const expiresAfterReadSeconds = room.disappearAfterReadSeconds ?? null;
      const expiresAt =
        typeof expiresAfterReadSeconds === "number"
          ? sentAt + expiresAfterReadSeconds * 1000
          : undefined;
      const fileBytes = new Uint8Array(await file.arrayBuffer());
      const sha256 = await sha256Base64Url(fileBytes);
      outgoingFilesRef.current.set(fileId, file);
      outgoingFileHashesRef.current.set(fileId, sha256);
      outgoingFileEpochsRef.current.set(fileId, keyEpochRef.current);
      setError(null);
      jumpToLatest();
      startTransition(() => {
        setMessages((current) =>
          upsertMessage(current, {
            id: fileId,
            senderSessionId: sessionId,
            sentAt,
            expiresAt,
            kind: "file",
            file: {
              fileId,
              name: file.name,
              mimeType,
              size: file.size,
              state: "sent",
              progress: 1,
              outgoing: true
            }
          })
        );
      });
      const delivered = await sendPeerData({
        type: "file_offer",
        fileId,
        senderSessionId: sessionId,
        name: file.name,
        mimeType,
        size: file.size,
        sentAt,
        expiresAfterReadSeconds,
        sha256,
        keyEpoch: keyEpochRef.current
      });
      if (!delivered) {
        setError(t("fileDeliveryPending"));
      }
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  async function handleRequestFile(fileId: string, senderSessionId: string) {
    const entry = incomingFilesRef.current.get(fileId);
    if (!entry || entry.senderSessionId !== senderSessionId || entry.requested) return;
    entry.requested = true;
    armFileTimeout(fileId, entry);
    updateFileMessage(fileId, { state: "transferring", progress: 0 });
    const requested = await sendPeerData({ type: "file_request", fileId }, senderSessionId);
    if (!requested && incomingFilesRef.current.get(fileId) === entry) {
      removeIncomingFile(fileId, entry);
      updateFileMessage(fileId, { state: "error" });
      setError(t("fileRequestFailed"));
    }
  }

  useEffect(() => {
    if (!roomSecret) {
      setError(t("missingSecret"));
      return;
    }

    let active = true;
    let reconnectAllowed = true;
    const connectionAllowed = () => active && reconnectAllowed &&
      (roomStatusRef.current === null || roomStatusRef.current === "open");
    const reconnect = new ReconnectScheduler(
      connectionAllowed,
      () => { void bootstrap(); },
      (delay) => {
        setCanRetryConnection(false);
        setConnection(t("reconnecting", { seconds: Math.ceil(delay / 1000) }));
      }
    );
    function stopReconnecting() {
      for (const [fileId, transfer] of incomingFilesRef.current) removeIncomingFile(fileId, transfer);
      keyWorkGenerationRef.current += 1;
      reconnectAllowed = false;
      reconnect.cancel();
      if (active) setCanRetryConnection(false);
    }
    retryConnectionRef.current = () => {
      if (!reconnect.canRetry) return;
      const focusTarget = retryFocusTargetRef.current;
      focusTarget?.focus({ preventScroll: true });
      preserveRetryFocusRef.current = Boolean(focusTarget && document.activeElement === focusTarget);
      setCanRetryConnection(false);
      setConnectionError(null);
      setConnection(t("connecting"));
      reconnect.retryNow();
    };
    const tick = window.setInterval(() => setNow(Date.now()), 1000);

    async function bootstrap() {
      try {
        const [metadata, key, identity] = await Promise.all([
          loadRoomMetadata(roomId),
          deriveRoomKey(roomSecret),
          loadIdentityKeyPair(roomId, sessionId)
        ]);
        if (!connectionAllowed()) {
          return;
        }
        roomKeyRef.current = key;
        roomKeysRef.current.set(0, key);
        identityPrivateKeyRef.current = identity.privateKey;
        identityKeyRef.current = identity.publicKey;
        agreementPrivateKeyRef.current = identity.agreementPrivateKey;
        agreementPublicKeyRef.current = identity.agreementPublicKey;
        peerIdentityKeysRef.current.set(sessionId, identity.publicKey);
        roomStatusRef.current = metadata.status;
        setRoom(metadata);
        if (metadata.status !== "open") {
          stopReconnecting();
          setReady(true);
          setConnection(t("closed"));
          setRoomNotice(roomStateMessage(metadata.status));
          return;
        }

        const currentTicket = accessCodeTicket || safeStorageGet("session", `elm-chat:ticket:${roomId}`) || undefined;
        if (metadata.accessCodeProtected && isInviteGuest && !accessCodeVerified && !currentTicket) {
          setReady(true);
          return;
        }

        const socket = new WebSocket(wsUrl(`/api/rooms/${roomId}/ws`));
        socketRef.current = socket;

        socket.addEventListener("open", () => {
          if (!connectionAllowed() || socketRef.current !== socket) return;
          setConnection(t("connected"));
          joinedRef.current = false;
          socket.send(
            JSON.stringify({
              type: "join",
              sessionId,
              identityKey: identityKeyRef.current,
              agreementKey: agreementPublicKeyRef.current,
              creatorToken: creatorToken || undefined,
              inviteToken: inviteToken || undefined,
              accessCodeTicket: currentTicket
            })
          );
        });

        socket.addEventListener("close", (closeEvent) => {
          if (!active || socketRef.current !== socket) return;
          keyWorkGenerationRef.current += 1;
          joinedRef.current = false;
          keyReadyRef.current = false;
          setKeyReady(false);
          if (isInviteGuest && closeEvent.code === 4403) {
            stopReconnecting();
            if (closeEvent.reason && closeEvent.reason.includes("access code")) {
              safeStorageRemove("session", `elm-chat:ticket:${roomId}`);
              setAccessCodeTicket(null);
              setAccessCodeVerified(false);
              setReady(true);
              return;
            }
            setInviteAccess((current) => {
              if (current === "claimed" || current === "used") {
                return current;
              }
              if (closeEvent.reason === "invite claimed") {
                return "claimed";
              }
              if (closeEvent.reason === "invite used") {
                return "used";
              }
              return "invalid";
            });
            setError(null);
            setRoom(null);
            setRoomNotice(null);
            setReady(true);
            return;
          }
          if (reconnect.schedule()) return;
          setCanRetryConnection(reconnect.canRetry);
          setConnection(roomStatusRef.current === "open" ? t("disconnected") : t("closed"));
        });

        socket.addEventListener("error", () => {
          if (!connectionAllowed() || socketRef.current !== socket) return;
          setConnection(t("connectionError"));
        });

        socket.addEventListener("message", async (event) => {
          if (!connectionAllowed() || socketRef.current !== socket) return;
          const payload = JSON.parse(String(event.data)) as ServerEvent;
          if (payload.type === "joined") {
            joinedRef.current = true;
            reconnect.reset();
            setCanRetryConnection(false);
            setConnectionError(null);
            startTransition(() => {
              setInviteAccess("granted");
              setRoom(payload.room);
              setPresence(payload.presence);
              setReady(true);
            });
            if (creatorToken) {
              void refreshInvites();
            }
            peersRef.current.clear();
            peersRef.current.set(sessionId, payload.self);
            for (const peer of payload.peers) {
              peersRef.current.set(peer.sessionId, peer);
              peerIdentityKeysRef.current.set(peer.sessionId, peer.identityKey);
            }
            beginMembershipChange(payload.room.membershipVersion);
            shouldRequestSyncRef.current = payload.peers.length > 0;
            if (payload.peers.length > 0 && keyReadyRef.current) {
              await sendPeerData({ type: "sync_request" });
            }
            return;
          }

          if (payload.type === "presence") {
            startTransition(() => setPresence(payload.presence));
            if (creatorToken) {
              void refreshInvites();
            }
            return;
          }

          if (payload.type === "peer_joined") {
            peerIdentityKeysRef.current.set(payload.peer.sessionId, payload.peer.identityKey);
            peersRef.current.set(payload.peer.sessionId, payload.peer);
            beginMembershipChange(payload.membershipVersion);
            startTransition(() =>
              setPresence((current) => ({
                count: current.connectedSessionIds.includes(payload.peer.sessionId)
                  ? current.count
                  : current.count + 1,
                connectedSessionIds: current.connectedSessionIds.includes(payload.peer.sessionId)
                  ? current.connectedSessionIds
                  : [...current.connectedSessionIds, payload.peer.sessionId]
              }))
            );
            if (creatorToken) {
              void refreshInvites();
            }
            if (messageRef.current.size > 0) {
              const validMessages = [...messageRef.current.values()]
                .filter((e) => e.payload.type === "chat_message" && !destroyedMessageIdsRef.current.has(e.payload.envelope.messageId))
                .sort((left, right) => left.sentAt - right.sentAt)
                .slice(-MAX_TRANSCRIPT_SYNC_MESSAGES);
              if (validMessages.length > 0) {
                await sendPeerData({
                  type: "sync_response",
                  messages: validMessages,
                  completeness: "peer-partial",
                  truncated: messageRef.current.size > MAX_TRANSCRIPT_SYNC_MESSAGES
                }, payload.peer.sessionId);
              }
            }
            return;
          }

          if (payload.type === "peer_left") {
            peersRef.current.delete(payload.sessionId);
            beginMembershipChange(payload.membershipVersion);
            startTransition(() =>
              setPresence((current) => {
                const nextIds = current.connectedSessionIds.filter((id) => id !== payload.sessionId);
                return {
                  count: nextIds.length,
                  connectedSessionIds: nextIds
                };
              })
            );
            if (creatorToken) {
              void refreshInvites();
            }
            for (const [fileId, transfer] of incomingFilesRef.current) {
              if (transfer.senderSessionId === payload.sessionId) {
                removeIncomingFile(fileId, transfer);
                updateFileMessage(fileId, { state: "error" });
              }
            }
            return;
          }

          if (payload.type === "peer_data") {
            await handlePeerData(payload.fromSessionId, payload.data, socket);
            return;
          }

          if (payload.type === "message_delivered") {
            startTransition(() => {
              setMessages((current) =>
                current.map((msg) =>
                  msg.id === payload.messageId && (!msg.deliveryStatus || msg.deliveryStatus === "sent")
                    ? { ...msg, deliveryStatus: "delivered" }
                    : msg
                )
              );
            });
            return;
          }

          if (payload.type === "message_seen") {
            seenMessageIdsRef.current.add(payload.messageId);
            startTransition(() => {
              setMessages((current) =>
                current.map((msg) => {
                  if (msg.id !== payload.messageId) return msg;
                  return {
                    ...msg,
                    deliveryStatus: "seen",
                    seenAt: payload.seenAt,
                    expiresAt: payload.destroyedAt ?? msg.expiresAt
                  };
                })
              );
            });
            return;
          }

          if (payload.type === "message_destroyed") {
            destroyedMessageIdsRef.current.add(payload.messageId);
            messageRef.current.delete(payload.messageId);
            startTransition(() => {
              setMessages((current) => current.filter((msg) => msg.id !== payload.messageId));
            });
            return;
          }

          if (payload.type === "room_state") {
            stopReconnecting();
            roomStatusRef.current = payload.status;
            startTransition(() => {
              setRoom((current) =>
                current
                  ? {
                      ...current,
                      status: payload.status
                    }
                  : current
              );
              setRoomNotice(roomStateMessage(payload.status, payload.reason));
              setDestroying(false);
              setDestroyFeedback(payload.status === "destroyed" ? "success" : "idle");
              setConnection(t("closed"));
            });
            clearRoomSecurityState();
            await sendPeerData({ type: "peer_destroy" });
            return;
          }

          if (payload.type === "participant_kicked") {
            if (payload.sessionId === sessionId) {
              stopReconnecting();
              setRemovedFromRoom(true);
              setRoomNotice(null);
              setError(null);
              setConnection(t("closed"));
              joinedRef.current = false;
              clearRoomSecurityState();
              socket.close();
            }
            if (creatorToken) {
              void refreshInvites();
            }
            return;
          }

          if (payload.type === "error") {
            if (
              payload.code === "invite_required" ||
              payload.code === "invite_claimed" ||
              payload.code === "invite_used"
            ) {
              stopReconnecting();
              setInviteAccess(
                payload.code === "invite_claimed"
                  ? "claimed"
                  : payload.code === "invite_used"
                    ? "used"
                    : "invalid"
              );
              setError(null);
              setRoom(null);
              setRoomNotice(null);
              setReady(true);
              socket.close(4403, "invalid-invite");
              return;
            }
            if (payload.code === "peer_missing") {
              return;
            }
            setError(payload.message);
          }
        });
      } catch (cause) {
        if (!connectionAllowed()) return;
        if (cause instanceof RoomMetadataError && cause.kind === "missing") {
          stopReconnecting();
          setNotFound(true);
          setReady(true);
          return;
        }
        if (cause instanceof RoomMetadataError && cause.kind === "temporary") {
          if (reconnect.schedule()) return;
          setCanRetryConnection(reconnect.canRetry);
          setConnection(t("disconnected"));
          setConnectionError(t("failedJoinRoom"));
          return;
        }
        setCanRetryConnection(false);
        setConnection(t("disconnected"));
        setError(cause instanceof RoomMetadataError ? t("failedJoinRoom") :
          cause instanceof Error ? cause.message : t("failedJoinRoom"));
      }
    }

    async function verifyPeerEvent(
      event: AuthenticatedPeerEvent,
      relaySenderId?: string
    ): Promise<boolean> {
      if (
        event.roomId !== roomId ||
        (relaySenderId && event.senderSessionId !== relaySenderId) ||
        (event.targetSessionId !== null && event.targetSessionId !== sessionId) ||
        event.sentAt > Date.now() + 5 * 60 * 1000
      ) return false;
      const encodedKey = peerIdentityKeysRef.current.get(event.senderSessionId);
      if (!encodedKey) return false;
      try {
        return await eventReplayGuardRef.current!.accept(event.eventId, null, async () => {
          const key = await importIdentityPublicKey(encodedKey);
          if (!(await verifyAuthenticatedPeerEvent(key, event))) {
            throw new Error("Peer signature verification failed.");
          }
        });
      } catch {
        return false;
      }
    }

    async function addEnvelope(event: AuthenticatedPeerEvent) {
      if (event.payload.type !== "chat_message") return;
      const envelope = event.payload.envelope;
      if (destroyedMessageIdsRef.current.has(envelope.messageId)) return;
      const messageKey = roomKeysRef.current.get(envelope.keyEpoch);
      if (!messageKey) return;

      try {
        const received = await receiveTextMessage(
          messageKey, roomId, envelope, replayGuardRef.current!, event.senderSessionId
        );
        if (!received) return;
        const { plaintext, expiresAt } = received;
        messageRef.current.set(envelope.messageId, event);

        const mine = envelope.senderSessionId === sessionId;
        startTransition(() => {
          setMessages((current) =>
            upsertMessage(current, {
              id: envelope.messageId,
              senderSessionId: envelope.senderSessionId,
              plaintext,
              sentAt: envelope.sentAt,
              expiresAt,
              kind: "text",
              deliveryStatus: mine ? "sent" : "delivered"
            })
          );
        });

        if (!mine) {
          const socket = socketRef.current;
          if (socket?.readyState === WebSocket.OPEN && joinedRef.current) {
            socket.send(JSON.stringify({
              type: "message_delivered",
              messageId: envelope.messageId
            }));
          }
        }
      } catch (cause) {
        setError(
          cause instanceof InvalidMessageEnvelopeError
            ? t("alteredMessage")
            : cause instanceof Error && cause.message === "Message replay limit reached."
            ? t("replayLimit")
            : t("authFailed")
        );
      }
    }

    async function handlePeerData(peerId: string, event: AuthenticatedPeerEvent, sourceSocket: WebSocket) {
      const verified = await verifyPeerEvent(event, peerId);
      if (!connectionAllowed() || socketRef.current !== sourceSocket || !joinedRef.current) return;
      if (!verified) {
        setError(t("authFailed"));
        return;
      }
      const payload = event.payload;
      if (payload.type === "key_rotation") {
        const leader = currentKeyLeader();
        const agreementPrivateKey = agreementPrivateKeyRef.current;
        if (
          !leader ||
          event.senderSessionId !== leader.sessionId ||
          payload.senderAgreementKey !== leader.agreementKey ||
          payload.keyEpoch !== membershipVersionRef.current ||
          payload.keyEpoch <= keyEpochRef.current ||
          !agreementPrivateKey
        ) return;
        const isCurrent = captureKeyWork(payload.keyEpoch, leader);
        if (!isCurrent()) return;
        try {
          const nextSecret = await unwrapRoomSecret(
            agreementPrivateKey,
            payload.senderAgreementKey,
            roomId,
            payload.keyEpoch,
            event.senderSessionId,
            sessionId,
            payload.ciphertext,
            payload.nonce
          );
          if (!isCurrent()) return;
          const nextKey = await deriveRoomKey(nextSecret);
          if (!isCurrent() || payload.keyEpoch <= keyEpochRef.current) return;
          roomKeysRef.current.set(payload.keyEpoch, nextKey);
          roomKeyRef.current = nextKey;
          keyEpochRef.current = payload.keyEpoch;
          keyReadyRef.current = true;
          setKeyReady(true);
          setConnection(t("connected"));
          if (shouldRequestSyncRef.current) await sendPeerData({ type: "sync_request" });
        } catch {
          if (isCurrent()) setError(t("authFailed"));
        }
        return;
      }
      if (payload.type === "chat_message") {
        await addEnvelope(event);
        return;
      }

      if (payload.type === "sync_request") {
        const transcript = [...messageRef.current.values()]
          .filter((e) => e.payload.type === "chat_message" && !destroyedMessageIdsRef.current.has(e.payload.envelope.messageId))
          .sort((left, right) => left.sentAt - right.sentAt)
          .slice(-MAX_TRANSCRIPT_SYNC_MESSAGES);
        await sendPeerData({
          type: "sync_response",
          messages: transcript,
          completeness: "peer-partial",
          truncated: messageRef.current.size > MAX_TRANSCRIPT_SYNC_MESSAGES
        }, peerId);
        return;
      }

      if (payload.type === "sync_response") {
        if (
          payload.completeness !== "peer-partial" ||
          payload.messages.length > MAX_TRANSCRIPT_SYNC_MESSAGES
        ) return;
        shouldRequestSyncRef.current = false;
        setRoomNotice(
          payload.messages.length === 0
            ? t("syncEmpty")
            : payload.truncated
              ? t("syncTruncated")
              : t("syncPartial")
        );
        for (const syncedEvent of payload.messages.slice(-MAX_TRANSCRIPT_SYNC_MESSAGES)) {
          if (syncedEvent.payload.type === "chat_message" && destroyedMessageIdsRef.current.has(syncedEvent.payload.envelope.messageId)) {
            continue;
          }
          if (await verifyPeerEvent(syncedEvent)) await addEnvelope(syncedEvent);
        }
        return;
      }

      if (payload.type === "file_offer") {
        if (
          payload.senderSessionId !== event.senderSessionId ||
          payload.size < 0 ||
          payload.size > MAX_FILE_BYTES ||
          !/^[A-Za-z0-9_-]{43}$/.test(payload.sha256)
        ) {
          setError(t("authFailed"));
          return;
        }
        const expiresAt =
          typeof payload.expiresAfterReadSeconds === "number"
            ? payload.sentAt + payload.expiresAfterReadSeconds * 1000
            : undefined;
        if (typeof expiresAt === "number" && expiresAt <= Date.now()) {
          return;
        }
        removeIncomingFile(payload.fileId);
        incomingFilesRef.current.set(payload.fileId, {
          requested: false,
          name: payload.name,
          mimeType: payload.mimeType || "application/octet-stream",
          size: payload.size,
          totalChunks: 0,
          received: 0,
          receivedBytes: 0,
          chunks: [],
          senderSessionId: payload.senderSessionId,
          sha256: payload.sha256,
          keyEpoch: payload.keyEpoch
        });
        startTransition(() => {
          setMessages((current) =>
            upsertMessage(current, {
              id: payload.fileId,
              senderSessionId: payload.senderSessionId,
              sentAt: payload.sentAt,
              expiresAt,
              kind: "file",
              file: {
                fileId: payload.fileId,
                name: payload.name,
                mimeType: payload.mimeType || "application/octet-stream",
                size: payload.size,
                state: "offered",
                progress: 0,
                outgoing: false
              }
            })
          );
        });
        return;
      }

      if (payload.type === "file_request") {
        void serveFile(payload.fileId, peerId);
        return;
      }

      if (payload.type === "file_chunk") {
        const incoming = incomingFilesRef.current.get(payload.fileId);
        if (
          !incoming ||
          incoming.senderSessionId !== event.senderSessionId ||
          !Number.isSafeInteger(payload.chunkIndex) ||
          !Number.isSafeInteger(payload.totalChunks) ||
          payload.chunkIndex < 0 ||
          payload.totalChunks < 1 ||
          payload.chunkIndex >= payload.totalChunks ||
          payload.totalChunks > Math.ceil(MAX_FILE_BYTES / FILE_CHUNK_BYTES) ||
          payload.totalChunks !== Math.max(1, Math.ceil(incoming.size / FILE_CHUNK_BYTES)) ||
          payload.keyEpoch !== incoming.keyEpoch
        ) {
          return;
        }
        await receiveChunk(payload);
        return;
      }

      if (payload.type === "file_complete") {
        const incoming = incomingFilesRef.current.get(payload.fileId);
        if (!incoming || incoming.senderSessionId !== event.senderSessionId) return;
        await finalizeIncoming(payload.fileId, payload.sha256);
        return;
      }

      if (payload.type === "file_cancel") {
        removeIncomingFile(payload.fileId);
        updateFileMessage(payload.fileId, { state: "error" });
        return;
      }

      if (payload.type === "peer_destroy") {
        stopReconnecting();
        setRoomNotice(t("peerDestroyed"));
        setConnection(t("closed"));
        clearRoomSecurityState();
      }
    }

    void bootstrap();

    return () => {
      active = false;
      stopReconnecting();
      retryConnectionRef.current = null;
      window.clearInterval(tick);
      socketRef.current?.close();
      for (const [fileId, transfer] of incomingFilesRef.current) removeIncomingFile(fileId, transfer);
    };
  }, [creatorToken, inviteToken, roomId, roomSecret, sessionId, accessCodeVerified, accessCodeTicket]);

  useEffect(() => {
    if (copyFeedback !== "success") {
      return;
    }
    const timeout = window.setTimeout(() => setCopyFeedback("idle"), 1600);
    return () => window.clearTimeout(timeout);
  }, [copyFeedback]);

  useEffect(() => {
    if (inviteFeedback === "idle") {
      return;
    }
    const timeout = window.setTimeout(() => setInviteFeedback("idle"), 1600);
    return () => window.clearTimeout(timeout);
  }, [inviteFeedback]);

  useEffect(() => {
    if (destroyFeedback !== "success") {
      return;
    }
    const timeout = window.setTimeout(() => setDestroyFeedback("idle"), 2200);
    return () => window.clearTimeout(timeout);
  }, [destroyFeedback]);

  useEffect(() => {
    if (!ready || room?.status !== "open") {
      return;
    }
    const interval = window.setInterval(() => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN && joinedRef.current) {
        socket.send(JSON.stringify({ type: "ping" }));
      }
    }, 15000);
    return () => window.clearInterval(interval);
  }, [ready, room?.status]);

  useEffect(() => {
    startTransition(() => {
      setMessages((current) =>
        current.filter((message) => {
          const keep = !message.expiresAt || message.expiresAt > now;
          if (!keep && message.kind === "file") {
            if (message.file?.url) {
              URL.revokeObjectURL(message.file.url);
              objectUrlsRef.current.delete(message.file.url);
            }
            outgoingFilesRef.current.delete(message.id);
            outgoingFileHashesRef.current.delete(message.id);
            removeIncomingFile(message.id);
          }
          return keep;
        })
      );
    });
    for (const [messageId, envelope] of messageRef.current.entries()) {
      const message = envelope.payload.type === "chat_message" ? envelope.payload.envelope : null;
      const expiresAt =
        typeof message?.expiresAfterReadSeconds === "number"
          ? message.sentAt + message.expiresAfterReadSeconds * 1000
          : undefined;
      if (typeof expiresAt === "number" && expiresAt <= now) {
        messageRef.current.delete(messageId);
      }
    }
  }, [now]);

  useEffect(() => {
    void refreshInvites();
  }, [creatorToken, roomId]);

  useEffect(() => {
    roomStatusRef.current = room?.status ?? null;
  }, [room?.status]);

  useEffect(() => {
    const urls = objectUrlsRef.current;
    return () => {
      for (const url of urls) {
        URL.revokeObjectURL(url);
      }
      urls.clear();
    };
  }, []);

  async function handleSend(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sendingRef.current) return;
    const trimmed = draft.trim();
    const key = roomKeyRef.current;
    const leader = currentKeyLeader();
    if (!trimmed || !key || !leader || !room || room.status !== "open") return;
    if (!keyReadyRef.current) {
      setError(t("securing"));
      return;
    }
    const keyEpoch = keyEpochRef.current;
    const keyWorkIsCurrent = captureKeyWork(keyEpoch, leader);
    const isCurrent = () => keyWorkIsCurrent() && roomKeyRef.current === key;
    if (!isCurrent()) return;
    const draftRevision = draftRevisionRef.current;
    // A ref blocks same-tick Enter/click submissions before React renders.
    sendingRef.current = true;
    setSending(true);
    try {
      const sentAt = Date.now();
      const expiresAt = typeof room.disappearAfterReadSeconds === "number"
        ? sentAt + room.disappearAfterReadSeconds * 1000 : undefined;
      const envelope: EncryptedMessageEnvelope = {
        protocolVersion: MESSAGE_PROTOCOL_VERSION,
        messageId: generateMessageId(),
        senderSessionId: sessionId,
        ciphertext: "",
        nonce: "",
        sentAt,
        expiresAfterReadSeconds: room.disappearAfterReadSeconds ?? null,
        keyEpoch
      };
      const encrypted = await encryptMessage(key, roomId, envelope, trimmed);
      if (!isCurrent()) return;
      envelope.ciphertext = encrypted.ciphertext;
      envelope.nonce = encrypted.nonce;
      try {
        replayGuardRef.current!.markLocal(envelope.messageId, expiresAt ?? null);
      } catch {
        setError(t("replayLimit"));
        return;
      }
      const sentEvent = await sendPeerData({ type: "chat_message", envelope }, undefined, isCurrent);
      if (!sentEvent) {
        if (isCurrent()) setError(t("messageSendFailed"));
        return;
      }
      messageRef.current.set(envelope.messageId, sentEvent);
      // Keep edits made while encryption/signing was pending, even if the user
      // edited back to the same text. Failed attempts also retain the draft.
      if (draftRevisionRef.current === draftRevision) setDraft("");
      jumpToLatest();
      setError(null);
      startTransition(() => {
        setMessages((current) => upsertMessage(current, {
          id: envelope.messageId,
          senderSessionId: sessionId,
          plaintext: trimmed,
          sentAt,
          expiresAt,
          kind: "text",
          deliveryStatus: "sent"
        }));
      });
    } catch {
      if (isCurrent()) setError(t("messageSendFailed"));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  async function handleCopyLink() {
    if (await copyText(window.location.href)) {
      setCopyFeedback("success");
      setError(null);
      return;
    }
    setError(t("clipboardLinkFailed"));
  }

  function recordInviteHandoff(token: string) {
    if (measuredInviteHandoffsRef.current.has(token)) {
      return;
    }
    measuredInviteHandoffsRef.current.add(token);
    recordGrowthEvent("invite_share_handoff");
  }

  function inviteActionIsCurrent(action: number, token: string) {
    return action === inviteActionRef.current && roomStatusRef.current === "open" &&
      canShareInvite(currentInvitesRef.current.find((invite) => invite.token === token), Date.now());
  }

  async function handleShareInvite(event: React.MouseEvent<HTMLButtonElement>) {
    const trigger = event.currentTarget;
    const focusOwner = document.activeElement;
    const action = ++inviteActionRef.current;
    setManualInvite(null);
    setRoomNotice(null);
    setError(null);
    if (!creatorToken) {
      return;
    }
    try {
      const inviteTtlMs = parseInviteDurationDraft(inviteDuration);
      const invite = await createInvite(roomId, creatorToken, inviteTtlMs);
      if (action !== inviteActionRef.current || roomStatusRef.current !== "open") return;
      currentInvitesRef.current = [invite, ...currentInvitesRef.current];
      setInvites(currentInvitesRef.current);
      if (!inviteActionIsCurrent(action, invite.token)) return;
      const inviteUrl = buildInviteUrl(roomId, invite.token, roomSecret);
      if (typeof navigator.share === "function") {
        try {
          await navigator.share({
            title: "elm.chat invite",
            text: t("inviteShareText"),
            url: inviteUrl
          });
          recordInviteHandoff(invite.token);
          if (!inviteActionIsCurrent(action, invite.token)) return;
          setInviteFeedback("shared");
          setRoomNotice(t("sharedInviteNotice"));
          setError(null);
          return;
        } catch (cause) {
          if (!inviteActionIsCurrent(action, invite.token)) return;
          if (cause instanceof DOMException && cause.name === "AbortError") {
            setInviteFeedback("idle");
            setRoomNotice(t("createdInviteNotice"));
            setError(null);
            return;
          }
        }
      }
      if (await copyText(inviteUrl)) {
        recordInviteHandoff(invite.token);
        if (!inviteActionIsCurrent(action, invite.token)) return;
        setInviteFeedback("copied");
        setRoomNotice(t("copiedInviteNotice"));
        setError(null);
        return;
      }
      if (!inviteActionIsCurrent(action, invite.token)) return;
      setManualInvite({ token: invite.token, trigger, focusOwner });
      setInviteFeedback("idle");
    } catch (cause) {
      if (action !== inviteActionRef.current || roomStatusRef.current !== "open") return;
      setError(cause instanceof Error ? cause.message : t("createInviteFailed"));
    }
  }

  async function handleCopyInvite(token: string, trigger: HTMLButtonElement) {
    const focusOwner = document.activeElement;
    const action = ++inviteActionRef.current;
    setManualInvite(null);
    setRoomNotice(null);
    setError(null);
    if (await copyText(buildInviteUrl(roomId, token, roomSecret))) {
      recordInviteHandoff(token);
      if (!inviteActionIsCurrent(action, token)) return;
      setInviteFeedback("copied");
      setRoomNotice(t("copiedInviteNotice"));
      setError(null);
      return;
    }
    if (!inviteActionIsCurrent(action, token)) return;
    setManualInvite({ token, trigger, focusOwner });
  }

  async function handleNativeShareInvite(token: string, trigger: HTMLButtonElement) {
    const focusOwner = document.activeElement;
    const action = ++inviteActionRef.current;
    setManualInvite(null);
    setRoomNotice(null);
    setError(null);
    if (typeof navigator.share !== "function") {
      return;
    }
    try {
      await navigator.share({
        title: "elm.chat invite",
        text: t("inviteShareText"),
        url: buildInviteUrl(roomId, token, roomSecret)
      });
      recordInviteHandoff(token);
      if (!inviteActionIsCurrent(action, token)) return;
      setInviteFeedback("shared");
      setRoomNotice(t("sharedInviteNotice"));
      setError(null);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) {
        if (!inviteActionIsCurrent(action, token)) return;
        setManualInvite({ token, trigger, focusOwner });
      }
    }
  }

  async function handleRevokeInvite(token: string) {
    // Removing an invite supersedes any copy/share still awaiting browser APIs.
    inviteActionRef.current += 1;
    if (!creatorToken) {
      return;
    }
    try {
      await revokeInvite(roomId, creatorToken, token);
      setInvites((current) =>
        current.map((invite) =>
          invite.token === token ? { ...invite, revokedAt: Date.now() } : invite
        )
      );
      setRoomNotice(t("removedInviteNotice"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("revokeInviteFailed"));
    }
  }

  function handleKickParticipant(targetSessionId: string) {
    if (!creatorToken || targetSessionId === sessionId) {
      return;
    }
    socketRef.current?.send(
      JSON.stringify({
        type: "kick_participant",
        creatorToken,
        targetSessionId
      })
    );
  }

  async function handleDestroy() {
    if (!creatorToken) {
      return;
    }
    try {
      setDestroying(true);
      setDestroyFeedback("idle");
      const next = await destroyRoom(roomId, creatorToken);
      await sendPeerData({ type: "peer_destroy" });
      setRoomNotice(null);
      setRoom(next);
    } catch (cause) {
      setDestroying(false);
      setError(cause instanceof Error ? cause.message : t("destroyRoomFailed"));
    }
  }

  const presentCount = presence.count;
  const sortedPresenceIds = [...presence.connectedSessionIds].sort((left, right) =>
    left === sessionId ? -1 : right === sessionId ? 1 : left.localeCompare(right)
  );
  const messagePolicyLabel =
    typeof room?.disappearAfterReadSeconds === "number"
      ? t("messagesVanish", { duration: formatStaticDuration(room.disappearAfterReadSeconds) })
      : t("messagesStay");
  const idleDeadline =
    typeof room?.inactivityTimeoutMs === "number"
      ? room.lastActivityAt + room.inactivityTimeoutMs
      : null;
  const roomDeadline =
    typeof room?.expiresAt === "number" && typeof idleDeadline === "number"
      ? Math.min(room.expiresAt, idleDeadline)
      : typeof room?.expiresAt === "number"
        ? room.expiresAt
        : idleDeadline;
  const roomPolicyLabel =
    typeof roomDeadline === "number"
      ? t("roomExpires", { duration: formatRelativeDuration(roomDeadline) })
      : t("roomStays");
  const isCreator = Boolean(creatorToken);
  const manualInviteRecord = invites.find((invite) => invite.token === manualInvite?.token);
  const showManualInvite = isCreator && room?.status === "open" &&
    canShareInvite(manualInviteRecord, Math.max(now, Date.now()));
  function dismissManualInvite() {
    inviteActionRef.current += 1;
    setManualInvite(null);
  }

  useEffect(() => {
    if (showManualInvite && manualInvite) {
      setShowInviteModal(true);
    }
  }, [showManualInvite, manualInvite]);

  useEffect(() => {
    if (removedFromRoom || notFound || (room && room.status !== "open") ||
      ["invalid", "claimed", "used"].includes(inviteAccess)) conversationFind.close();
  }, [removedFromRoom, notFound, room?.status, inviteAccess]);

  if (removedFromRoom) {
    return <RemovedFromRoomScreen focusRef={setRetryFocusTarget} />;
  }

  if (inviteAccess === "invalid" || inviteAccess === "claimed" || inviteAccess === "used") {
    return <InvalidInviteScreen reason={inviteAccess} focusRef={setRetryFocusTarget} />;
  }

  if (notFound) {
    return (
      <RoomGoneScreen
        fromInvite={isInviteGuest}
        reason={t("roomNotFound")}
        focusRef={setRetryFocusTarget}
      />
    );
  }

  if (ready && room && room.status !== "open") {
    return (
      <RoomGoneScreen
        fromInvite={isInviteGuest}
        reason={roomNotice ?? roomStateMessage(room.status)}
        focusRef={setRetryFocusTarget}
      />
    );
  }

  if (room?.accessCodeProtected && isInviteGuest && !accessCodeVerified && !accessCodeTicket) {
    return (
      <RoomAccessVaultScreen
        roomId={roomId}
        inviteToken={inviteToken}
        onVerified={(ticket) => {
          safeStorageSet("session", `elm-chat:ticket:${roomId}`, ticket);
          setAccessCodeTicket(ticket);
          setAccessCodeVerified(true);
        }}
      />
    );
  }

  if (isInviteGuest && (inviteAccess !== "granted" || !room || !ready)) {
    return <InviteCheckingScreen connection={connection} error={connectionError ?? error}
      focusRef={setRetryFocusTarget}
      onRetry={canRetryConnection ? () => retryConnectionRef.current?.() : undefined} />;
  }

  return (
    <main className="room-shell room-vault-shell">
      <header className="room-vault-header">
        <div className="vault-header-top">
          <div className="vault-brand-cluster">
            <MehraruLogo size={22} />
            <div className="vault-brand-meta">
              <span className="vault-name">[Mehraru]</span>
              <span className="vault-badge">VAULT</span>
            </div>
            <span className="vault-room-id" title={roomId}>
              <span className="vault-lock-glyph" aria-hidden="true">🔒</span>
              <span className="vault-room-num">#{roomId.slice(0, 8)}</span>
            </span>
          </div>

          <div className="vault-actions">
            {canRetryConnection ? (
              <button className="secondary-button vault-action-btn" onClick={() => retryConnectionRef.current?.()} type="button">
                {t("retryConnection")}
              </button>
            ) : null}
            {isCreator ? (
              <button
                className={`vault-action-btn vault-invite-btn ${inviteFeedback !== "idle" ? "button-success" : ""}`}
                onClick={() => setShowInviteModal(true)}
                ref={inviteTriggerRef}
                type="button"
                title={t("invitePartner")}
              >
                <span className="btn-icon" aria-hidden="true">🔑</span>
                <span>{t("invitePartner")}</span>
                {invites.filter((i) => !i.revokedAt).length > 0 && (
                  <span className="vault-badge-count">{invites.filter((i) => !i.revokedAt).length}</span>
                )}
              </button>
            ) : (
              <button
                className={`vault-action-btn ${copyFeedback === "success" ? "button-success" : ""}`}
                onClick={handleCopyLink}
                type="button"
              >
                {copyFeedback === "success" ? t("copied") : t("copyMyLink")}
              </button>
            )}
            {isCreator ? (
              <button
                className="vault-action-btn vault-security-btn"
                onClick={() => setShowSecurityModal(true)}
                type="button"
                title="Room Security & Access Code"
              >
                <span className="btn-icon" aria-hidden="true">🛡️</span>
                <span>Security</span>
                {room?.accessCodeProtected && (
                  <span className="vault-badge-secure" title="Protected by Access Code">PIN</span>
                )}
              </button>
            ) : null}
            {isCreator ? (
              <button
                className={`vault-action-btn vault-danger-btn ${destroyFeedback === "success" ? "button-success" : ""}`}
                disabled={!creatorToken || destroying || room?.status !== "open"}
                onClick={handleDestroy}
                type="button"
                title="Permanently wipe vault"
              >
                {destroying ? t("destroying") : t("destroy")}
              </button>
            ) : (
              <button
                className="vault-action-btn vault-danger-btn"
                onClick={() => {
                  if (window.confirm(t("leaveConfirm"))) {
                    window.location.assign("/");
                  }
                }}
                type="button"
                title="Leave private conversation"
              >
                {t("leaveRoom")}
              </button>
            )}
          </div>
        </div>

        <div className="vault-header-sub">
          <div className="vault-presence-cluster" aria-live="polite" ref={setRetryFocusTarget} tabIndex={-1}>
            <span className={`vault-conn-pill ${connection === t("connected") ? "is-connected" : "is-connecting"}`}>
              <span className="conn-dot" aria-hidden="true" />
              {connection}
            </span>
            <div className="vault-presence-duo" aria-label="Presence Status">
              <span className="presence-agent you active" title="Your presence">
                <span className="agent-indicator" aria-hidden="true" /> {t("you")}
              </span>
              <span className="presence-separator" aria-hidden="true">·</span>
              <span className={`presence-agent partner ${presentCount >= 2 ? "active" : "waiting"}`} title={presentCount >= 2 ? "Partner connected" : "Awaiting partner"}>
                <span className="agent-indicator" aria-hidden="true" /> {presentCount >= 2 ? t("partnerPresent") : t("waitingForPartner")}
              </span>
              {isCreator && sortedPresenceIds.some((id) => id !== sessionId) && (
                <button
                  className="vault-kick-btn"
                  onClick={() => {
                    const guestId = sortedPresenceIds.find((id) => id !== sessionId);
                    if (guestId) handleKickParticipant(guestId);
                  }}
                  title={t("remove")}
                  type="button"
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          <div className="vault-security-pills" aria-label="Security policy">
            <span className="security-pill">🛡️ {t("e2eEncrypted")}</span>
            <span className="security-pill">⏱️ {messagePolicyLabel}</span>
            <span className="security-pill">⌛ {roomPolicyLabel}</span>
          </div>
        </div>

        <span className="sr-only" role="status" aria-live="polite">
          {inviteFeedback === "shared"
            ? t("inviteSharedStatus")
            : inviteFeedback === "copied"
              ? t("inviteCopiedStatus")
              : copyFeedback === "success"
                ? t("roomLinkCopiedStatus")
                : ""}
        </span>
      </header>

      {showInviteModal && (
        <div
          className="vault-modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowInviteModal(false);
          }}
        >
          <div className="vault-modal" role="dialog" aria-modal="true" aria-labelledby="invite-modal-title">
            <div className="vault-modal-header">
              <div className="modal-title-cluster">
                <span className="modal-key-icon" aria-hidden="true">🔑</span>
                <div>
                  <h2 id="invite-modal-title">{t("inviteModalTitle")}</h2>
                  <p className="modal-sub">{t("inviteModalSub")}</p>
                </div>
              </div>
              <button
                className="modal-close-btn"
                onClick={() => setShowInviteModal(false)}
                type="button"
                aria-label="Close modal"
              >
                ✕
              </button>
            </div>

            <div className="vault-modal-body">
              {isCreator ? (
                <div className="invite-generator-panel">
                  <div className="invite-duration-row">
                    <span className="setting-label">{t("newInviteExpires")}</span>
                    <div className="setting-controls">
                      <input
                        aria-label={t("inviteLifetimeAmount")}
                        className="setting-input modal-input"
                        inputMode="numeric"
                        min="1"
                        onChange={(event) =>
                          setInviteDuration((current) => ({ ...current, amount: event.target.value }))
                        }
                        type="number"
                        value={inviteDuration.amount}
                      />
                      <select
                        aria-label={t("inviteLifetimeUnit")}
                        className="setting-select modal-select"
                        onChange={(event) =>
                          setInviteDuration((current) => ({
                            ...current,
                            unit: event.target.value as DurationUnit
                          }))
                        }
                        value={inviteDuration.unit}
                      >
                        <option value="minutes">{t("minutes")}</option>
                        <option value="hours">{t("hours")}</option>
                        <option value="days">{t("days")}</option>
                      </select>
                    </div>
                  </div>

                  <button
                    className={`primary-button modal-generate-btn ${inviteFeedback !== "idle" ? "button-success" : ""}`}
                    onClick={handleShareInvite}
                    type="button"
                  >
                    {inviteFeedback === "shared"
                      ? t("inviteShared")
                      : inviteFeedback === "copied"
                        ? t("inviteCopiedSend")
                        : typeof navigator.share === "function"
                          ? t("sendInvite")
                          : t("inviteOne")}
                  </button>
                </div>
              ) : null}

              {showManualInvite && manualInvite ? (
                <div className="modal-manual-wrapper">
                  <ManualInviteLink
                    key={manualInvite.token}
                    url={buildInviteUrl(roomId, manualInvite.token, roomSecret)}
                    trigger={manualInvite.trigger}
                    focusOwner={manualInvite.focusOwner}
                    fallbackTrigger={inviteTriggerRef.current}
                    onDismiss={dismissManualInvite}
                  />
                </div>
              ) : null}

              {isCreator && invites.length > 0 ? (
                <div className="vault-invites-block">
                  <span className="eyebrow">{t("activePasses")} ({invites.length})</span>
                  <div className="vault-invites-scroll">
                    {invites.slice(0, 6).map((invite) => (
                      <div className="invite-row vault-invite-row" key={invite.token} style={inviteAccentStyle(invite)}>
                        <div className="vault-invite-meta">
                          <span className="invite-tag">{inviteStatusLabel(invite)}</span>
                          <span className="invite-token-code">Token: {invite.token.slice(0, 8)}...</span>
                        </div>
                        <div className="invite-actions">
                          {canShareInvite(invite, now) ? (
                            <>
                              {typeof navigator.share === "function" ? (
                                <button
                                  className="secondary-button invite-copy"
                                  onClick={(event) => handleNativeShareInvite(invite.token, event.currentTarget)}
                                  type="button"
                                >
                                  {t("share")}
                                </button>
                              ) : null}
                              <button
                                className="secondary-button invite-copy"
                                onClick={(event) => handleCopyInvite(invite.token, event.currentTarget)}
                                type="button"
                              >
                                {t("copyInvite")}
                              </button>
                            </>
                          ) : null}
                          {!invite.revokedAt ? (
                            <button
                              className="secondary-button invite-revoke"
                              onClick={() => handleRevokeInvite(invite.token)}
                              type="button"
                            >
                              {t("remove")}
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="vault-modal-footer">
              <p className="modal-security-note">
                🛡️ Pass admits one participant and expires after single use.
              </p>
              <button
                className="secondary-button modal-done-btn"
                onClick={() => setShowInviteModal(false)}
                type="button"
              >
                {t("done")}
              </button>
            </div>
          </div>
        </div>
      )}

      {roomNotice ? (
        <div className="vault-toast-banner" role="status" aria-live="polite">
          {roomNotice}
        </div>
      ) : null}
      {error ? <div className="vault-toast-banner error-text" role="alert">{error}</div> : null}
      {connectionError ? <div className="vault-toast-banner error-text" role="alert">{connectionError}</div> : null}

      {conversationFind.controls}

      <section className="chat-stage">
        <section
          aria-label={t("conversationLog")}
          aria-live="polite"
          aria-relevant="additions"
          className="chat-log"
          ref={chatLogRef}
          role="log"
          tabIndex={0}
          onScroll={handleConversationScroll}
        >
          <div className="chat-thread">
            {isInviteGuest && messages.length === 0 ? <MakeYourOwnCallout compact /> : null}
            {!ready ? <p className="system-line">{t("deriving")}</p> : null}
            {messages.length === 0 && ready ? (
              <div className="vault-empty-state">
                <span className="empty-glyph" aria-hidden="true">🔒</span>
                <p className="empty-title">Encrypted Vault Channel Active</p>
                <p className="empty-desc">{messagePolicyLabel}</p>
              </div>
            ) : null}
            {messages.map((message) => {
              const mine = message.senderSessionId === sessionId;
              return (
                <article
                  className={`bubble ${mine ? "bubble-mine" : "bubble-theirs"}${conversationFind.selectedId === message.id ? " bubble-find-selected" : ""}`}
                  data-message-id={message.id}
                  key={message.id}
                  style={bubbleStyle(message.senderSessionId, mine)}
                >
                  <span className="bubble-author">{mine ? t("you") : t("guest")}</span>
                  {message.kind === "file" && message.file ? (
                    <FileCard
                      file={message.file}
                      onDownload={() =>
                        handleRequestFile(message.file!.fileId, message.senderSessionId)
                      }
                    />
                  ) : (
                    <p className="bubble-content">{message.plaintext}</p>
                  )}
                  <footer className="bubble-footer">
                    <span className="bubble-timestamp">{formatClock(message.sentAt)}</span>
                    {mine && (
                      <span
                        className={
                          message.deliveryStatus === "seen"
                            ? "bubble-seen-status"
                            : message.deliveryStatus === "delivered"
                            ? "bubble-delivered-status"
                            : "bubble-sent-status"
                        }
                        title={
                          message.deliveryStatus === "seen"
                            ? "Rendered in recipient's active viewport"
                            : message.deliveryStatus === "delivered"
                            ? "Delivered and decrypted by recipient"
                            : "Sent to room relay"
                        }
                      >
                        {message.deliveryStatus === "seen"
                          ? "✓✓ " + t("seen")
                          : message.deliveryStatus === "delivered"
                          ? "✓ " + t("delivered")
                          : "○ " + t("sent")}
                      </span>
                    )}
                    <span className="bubble-vanish-status" title="Message lifetime">
                      <span aria-hidden="true">⏱ </span>{messageStatus(message)}
                    </span>
                  </footer>
                </article>
              );
            })}
          </div>
        </section>

        {awayFromLatest ? (
          <button
            className="secondary-button jump-to-latest"
            type="button"
            onClick={() => {
              jumpToLatest();
              chatLogRef.current?.focus({ preventScroll: true });
            }}
          >
            {newMessageCount > 0 ? t("newMessagesJump", { count: newMessageCount }) : t("jumpToLatest")}
          </button>
        ) : null}
      </section>

      <form className="composer composer-vault" onSubmit={handleSend}>
        <div className="composer-meta-bar">
          <span className="composer-enc-badge">
            <span className="composer-shield-icon" aria-hidden="true">🛡️</span>
            {t("encryptionNotice")}
          </span>
          <span className="composer-hint">Enter ↵ to send · Shift+Enter for newline</span>
        </div>
        <div className="composer-input-row">
          <button
            aria-label={t("attachFileLabel")}
            className="secondary-button composer-attach"
            disabled={room?.status !== "open" || !keyReady}
            onClick={() => fileInputRef.current?.click()}
            title={t("attachFile")}
            type="button"
          >
            📎
          </button>
          <input
            hidden
            multiple
            onChange={(event) => void handleAttachFiles(event.target.files)}
            ref={fileInputRef}
            type="file"
          />
          <textarea
            aria-label={t("writeMessageLabel")}
            value={draft}
            onChange={(event) => {
              draftRevisionRef.current += 1;
              setDraft(event.target.value);
            }}
            onKeyDown={handleComposerKeyDown}
            disabled={room?.status !== "open" || !keyReady}
            placeholder={room?.status === "open" ? (keyReady ? t("writeMessage") : t("securing")) : roomNotice ?? t("roomClosed")}
            rows={2}
          />
          <button
            className="primary-button composer-send-btn"
            type="submit"
            disabled={sending || !draft.trim() || room?.status !== "open" || !keyReady}
            title={t("sendEncrypted")}
          >
            <span className="send-text">{t("sendEncrypted")}</span>
            <span className="send-icon" aria-hidden="true">↑</span>
          </button>
        </div>
      </form>
      {showSecurityModal && creatorToken ? (
        <RoomSecurityModal
          roomId={roomId}
          creatorToken={creatorToken}
          room={room}
          invites={invites}
          knownAccessCode={knownAccessCode}
          presenceCount={presence.count}
          onClose={() => setShowSecurityModal(false)}
          onUpdateCode={(code, enabled) => {
            if (code) {
              safeStorageSet("session", `elm-chat:access-code:${roomId}`, code);
              setKnownAccessCode(code);
            } else if (enabled === false) {
              safeStorageRemove("session", `elm-chat:access-code:${roomId}`);
              setKnownAccessCode(undefined);
            }
            setRoom((prev) => prev ? { ...prev, accessCodeProtected: enabled ?? prev.accessCodeProtected } : prev);
          }}
          onRevokeInvite={handleRevokeInvite}
        />
      ) : null}
    </main>
  );
}
