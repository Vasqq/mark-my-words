import {
  executionEnabled,
  orderCapabilityEnabled,
  validateOrderBody,
} from "../server/order-wire.mjs";
import {
  accountLock,
  accountLockName,
  type AccountLock,
} from "./account-coordination";
import {
  bytesToHex,
  getAddress,
  hashTypedData,
  hexToBytes,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";

import {
  createRequestBudget,
  OrderNotSent,
  type RequestPriority,
} from "./perpl-request-budget";

const label = "Testnet session";
// One day: Perpl allows 16 keys per profile and counts expired ones, so keys are precious.
const lifetime = 86_400_000;
const readTargets = {
  verify: "/v1/trading/fills?count=1",
  wallet: "/v1/trading/wallet",
  positions: "/v1/trading/positions",
  orders: "/v1/trading/orders",
} as const;
const statement =
  "I authorize the creation of Perpl API key with the specified scope and parameters";
const registrationFields = [
  ["signer", "address"],
  ["statement", "string"],
  ["publicKey", "string"],
  ["scope", "string"],
  ["label", "string"],
  ["expiresAt", "string"],
  ["ipCidrs", "string"],
  ["origin", "string"],
  ["builderId", "string"],
  ["maxBuilderFeePer100K", "string"],
  ["time", "uint64"],
];
const domainFields = [
  ["name", "string"],
  ["version", "string"],
  ["chainId", "uint256"],
  ["verifyingContract", "address"],
  ["salt", "bytes32"],
];
export interface SessionTypedData {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Address;
    salt: Hex;
  };
  primaryType: "PerplRegisterApiKey";
  types: Record<string, { name: string; type: string }[]>;
  message: Record<string, string>;
}
export interface SessionStatus {
  state: "idle" | "ready" | "active" | "unavailable" | "blocked";
  expiresAt?: number;
  replacesExpiresAt?: number;
}
const base64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Unexpected Perpl response.");
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).sort().join() !== [...keys].sort().join())
    throw Error("Unexpected Perpl signing fields.");
}
function fields(value: unknown, expected: string[][]) {
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    value.some((field, i) => {
      const f = record(field);
      return (
        Object.keys(f).length !== 2 ||
        f.name !== expected[i][0] ||
        f.type !== expected[i][1]
      );
    })
  )
    throw Error("Unexpected Perpl signing schema.");
}

/** Validate the complete authorization before passing any typed data to a wallet. */
export function validateSessionPayload(
  value: unknown,
  owner: Address,
  publicKey: Uint8Array,
  expiresAt: number,
) {
  const response = record(value);
  const raw = record(response.typed_data);
  const domain = record(raw.domain);
  const types = record(raw.types);
  const message = record(raw.message);
  exactKeys(raw, ["domain", "types", "message", "primaryType"]);
  exactKeys(
    domain,
    domainFields.map(([name]) => name),
  );
  exactKeys(types, ["EIP712Domain", "PerplRegisterApiKey"]);
  exactKeys(
    message,
    registrationFields.map(([name]) => name),
  );
  fields(types.EIP712Domain, domainFields);
  fields(types.PerplRegisterApiKey, registrationFields);
  if (
    raw.primaryType !== "PerplRegisterApiKey" ||
    domain.name !== "perpl.xyz" ||
    domain.version !== "1" ||
    ![10143, "10143", "0x279f"].includes(domain.chainId as string | number) ||
    domain.verifyingContract !== "0x0000000000000000000000000000000000000000" ||
    typeof domain.salt !== "string" ||
    !/^0x[\da-f]{64}$/i.test(domain.salt) ||
    Object.values(message).some((v) => typeof v !== "string") ||
    typeof message.signer !== "string" ||
    getAddress(message.signer) !== owner ||
    message.publicKey !== base64(publicKey) ||
    message.scope !== "3" ||
    message.label !== label ||
    message.expiresAt !== String(expiresAt) ||
    expiresAt <= Date.now() ||
    expiresAt > Date.now() + lifetime ||
    message.ipCidrs !== "" ||
    message.origin !== "" ||
    message.builderId !== "0" ||
    message.maxBuilderFeePer100K !== "0" ||
    message.statement !== statement ||
    typeof message.time !== "string" ||
    !/^(0x[\da-f]+|\d+)$/i.test(message.time) ||
    BigInt(message.time) < BigInt(Date.now() - 60_000) ||
    BigInt(message.time) > BigInt(Date.now() + 30_000) ||
    typeof response.mac !== "string" ||
    !response.mac ||
    response.mac.length > 2048
  )
    throw Error(
      "Perpl authorization does not match the requested testnet session.",
    );
  const typedData: SessionTypedData = {
    domain: {
      name: "perpl.xyz",
      version: "1",
      chainId: 10143,
      verifyingContract: domain.verifyingContract as Address,
      salt: domain.salt as Hex,
    },
    primaryType: "PerplRegisterApiKey",
    types: {
      PerplRegisterApiKey: registrationFields.map(([name, type]) => ({
        name,
        type,
      })),
    },
    message: message as Record<string, string>,
  };
  return { raw, typedData, mac: response.mac };
}

type Lock = AccountLock;

interface StoredSession {
  key: CryptoKey;
  token: string;
  expiresAt: number;
  id: string;
}
// Perpl allows 16 active keys per profile and offers no API to revoke one, so a key must
// survive a reload instead of being replaced. The signing key is stored as a non-extractable
// CryptoKey: script can ask it to sign but can never read it, and the token is useless alone.
function sessionStore(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const open = indexedDB.open("perpl-session-v1", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("sessions");
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => resolve(null);
    open.onblocked = () => resolve(null);
  });
}
async function stored<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | undefined> {
  const db = await sessionStore();
  if (!db) return undefined;
  try {
    return await new Promise<T | undefined>((resolve) => {
      const request = work(
        db.transaction("sessions", mode).objectStore("sessions"),
      );
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
    });
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

/** Session credentials stay in this closure and, for the key's one-day life, in this origin's IndexedDB. */
export function createPerplSession(
  address: string,
  options: {
    fetcher?: typeof fetch;
    storage?: Pick<Storage, "getItem" | "setItem">;
    lock?: Lock;
    budgetLock?: Lock;
  } = {},
) {
  const owner = getAddress(address);
  const storage = () => options.storage ?? window.localStorage;
  const markerKey = `perpl-session-v1:10143:${owner.toLowerCase()}`;
  const fetcher = options.fetcher ?? fetch;
  let draft:
    | {
        payload: ReturnType<typeof validateSessionPayload>;
        key: CryptoKey;
        expiresAt: number;
        previousExpiry: number;
      }
    | undefined;
  let session:
    | { key: CryptoKey; token: string; expiresAt: number; id: string }
    | undefined;
  let disposed = false;
  let readingSnapshot = false;
  let submitReached = false;
  let snapshotBudget:
    { remaining: number; priority: RequestPriority } | undefined;
  const budget = () => createRequestBudget(storage(), options.budgetLock);
  function available() {
    if (disposed) throw Error("Wallet session changed. Review again.");
  }
  function marker(): number {
    const raw = storage().getItem(markerKey);
    if (raw === null) return 0;
    if (!/^\d{13}$/.test(raw) || Number(raw) > Date.now() + lifetime + 60_000)
      throw Error(
        "Saved enrollment status is invalid. Resolve it before enrolling again.",
      );
    return Number(raw);
  }
  function status(): SessionStatus {
    if (session && session.expiresAt <= Date.now()) session = undefined;
    if (draft && draft.expiresAt <= Date.now()) draft = undefined;
    if (session) return { state: "active", expiresAt: session.expiresAt };
    const expiresAt = marker();
    if (draft && draft.previousExpiry === expiresAt)
      return {
        state: "ready",
        expiresAt: draft.expiresAt,
        ...(expiresAt > Date.now() ? { replacesExpiresAt: expiresAt } : {}),
      };
    if (expiresAt > Date.now()) return { state: "unavailable", expiresAt };
    return { state: "idle" };
  }
  async function request(
    route: string,
    body: unknown,
    authorizationRejected?: () => void,
    signal?: AbortSignal,
    priority: RequestPriority = "observation",
  ): Promise<unknown> {
    if (route !== "enroll") {
      if (
        ["wallet", "positions", "orders"].includes(route) &&
        snapshotBudget?.remaining &&
        snapshotBudget.priority === priority
      )
        snapshotBudget.remaining--;
      else await budget().take(1, priority);
    }
    signal?.throwIfAborted();
    if (route === "submit-orders") submitReached = true;
    const response = await fetcher(`/perpl-account/${route}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Perpl-Client": "1",
        "X-Perpl-Priority": priority,
      },
      body: JSON.stringify(body),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(12_000)])
        : AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      if (authorizationRejected && [401, 403].includes(response.status)) {
        authorizationRejected();
        throw Error(
          `Perpl access was rejected (HTTP ${response.status}). Restore session access; the issued key may still be active until expiry.`,
        );
      }
      // A 4xx is a refusal of the whole HTTP request: no order in it was accepted.
      if (
        route === "submit-orders" &&
        [400, 401, 403, 429].includes(response.status)
      )
        throw new OrderNotSent(
          `Perpl refused the order request (HTTP ${response.status}).`,
        );
      // Perpl answers 423 when the profile already holds its maximum of 16 keys.
      if (route === "enroll" && response.status === 423)
        throw Error(
          "This wallet has reached Perpl's limit of 16 access keys. Revoke unused keys on Perpl, then authorize again.",
        );
      throw Error(`Perpl ${route} request failed (HTTP ${response.status}).`);
    }
    return response.json();
  }
  async function prepareUnlocked({ replaceUnavailable = false } = {}) {
    available();
    const current = status();
    if (
      current.state === "active" ||
      (current.state === "unavailable" && !replaceUnavailable)
    )
      throw Error(
        "An unexpired session already exists. Use it or wait for expiry.",
      );
    const previousExpiry = marker();
    draft = undefined;
    const pair = await crypto.subtle.generateKey("Ed25519", false, [
      "sign",
      "verify",
    ]);
    const publicKey = new Uint8Array(
      await crypto.subtle.exportKey("raw", pair.publicKey),
    );
    const expiresAt = Date.now() + lifetime;
    const response = await request("payload", {
      chain_id: 10143,
      address: owner,
      public_key: bytesToHex(publicKey),
      scope_mask: 2,
      label,
      expires_at: expiresAt,
    });
    available();
    const payload = validateSessionPayload(
      response,
      owner,
      publicKey,
      expiresAt,
    );
    draft = {
      payload,
      key: pair.privateKey,
      expiresAt,
      previousExpiry,
    };
    return status();
  }
  const prepare = (input: Parameters<typeof prepareUnlocked>[0] = {}) =>
    (options.lock ?? accountLock)(accountLockName(owner), () =>
      prepareUnlocked(input),
    );
  async function enroll(sign: (data: SessionTypedData) => Promise<Hex>) {
    return (options.lock ?? accountLock)(accountLockName(owner), async () => {
      available();
      if (status().state !== "ready" || !draft)
        throw Error("Review a fresh session before signing.");
      await budget().take(1, "observation"); // Reserve before requesting an owner signature; no quota failure after signing.
      const reviewed = draft;
      // The signer receives its own copy, so the reviewed authorization cannot be mutated.
      const signature = await sign(structuredClone(reviewed.payload.typedData));
      available();
      if (draft !== reviewed || status().state !== "ready")
        throw Error("Session review expired or changed. Review again.");
      const recovered = await recoverTypedDataAddress({
        ...reviewed.payload.typedData,
        signature,
      });
      if (getAddress(recovered) !== owner)
        throw Error("Wallet signature does not match the selected account.");
      const digest = hexToBytes(hashTypedData(reviewed.payload.typedData));
      const proof = bytesToHex(
        new Uint8Array(
          await crypto.subtle.sign(
            "Ed25519",
            reviewed.key,
            new Uint8Array(digest),
          ),
        ),
      );
      available();
      if (draft !== reviewed || status().state !== "ready")
        throw Error("Session review expired or changed. Review again.");
      storage().setItem(markerKey, String(reviewed.expiresAt));
      if (storage().getItem(markerKey) !== String(reviewed.expiresAt))
        throw Error("Enrollment status could not be saved.");
      draft = undefined;
      // Once sent, a lost response may still mean a live key. Do not create or resend another key automatically.
      const response = record(
        await request("enroll", {
          chain_id: 10143,
          address: owner,
          typed_data: reviewed.payload.raw,
          mac: reviewed.payload.mac,
          signature,
          pop_signature: proof,
        }),
      );
      const info = record(
        typeof response.api_key === "object" ? response.api_key : response,
      );
      // Report field names only: upstream values may contain credentials.
      const mismatches = [
        [
          "api_key",
          typeof info.api_key === "string" &&
            /^[\x21-\x7e]{1,4096}$/.test(info.api_key),
        ],
        [
          "address",
          typeof info.address === "string" &&
            info.address.toLowerCase() === owner.toLowerCase(),
        ],
        ["scope_mask", info.scope_mask === 3],
        ["expires_at", info.expires_at === reviewed.expiresAt],
        ["origin", info.origin === ""],
        ["label", info.label === label],
        [
          "ip_cidrs",
          info.ip_cidrs === null ||
            (Array.isArray(info.ip_cidrs) && info.ip_cidrs.length === 0),
        ],
        ["builder_id", info.builder_id === undefined || info.builder_id === 0],
        [
          "max_builder_fee_per_100k",
          info.max_builder_fee_per_100k === undefined ||
            info.max_builder_fee_per_100k === 0,
        ],
      ]
        .filter(([, valid]) => !valid)
        .map(([field]) => field);
      if (mismatches.length || typeof info.api_key !== "string")
        throw Error(
          `Enrollment response did not match the reviewed session (${mismatches.join(", ")}). The key may still be active until expiry.`,
        );
      available();
      session = {
        id: crypto.randomUUID(),
        key: reviewed.key,
        token: info.api_key,
        expiresAt: reviewed.expiresAt,
      };
      await stored("readwrite", (store) => store.put(session, markerKey));
      return status();
    });
  }
  async function signedRequest(
    route: string,
    target: string,
    page?: string,
    body?: string,
    signal?: AbortSignal,
    priority: RequestPriority = "observation",
  ) {
    signal?.throwIfAborted();
    available();
    if (status().state !== "active" || !session)
      throw Error("No active session in this tab.");
    const current = session;
    const timestamp = String(Date.now());
    const nonce = base64(crypto.getRandomValues(new Uint8Array(16)));
    const bodyHash = bytesToHex(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(body ?? ""),
        ),
      ),
    ).slice(2);
    const canonical = [
      10143,
      body === undefined ? "GET" : "POST",
      target,
      timestamp,
      nonce,
      bodyHash,
    ].join("\n");
    const signature = base64(
      new Uint8Array(
        await crypto.subtle.sign(
          "Ed25519",
          current.key,
          new TextEncoder().encode(canonical),
        ),
      ),
    );
    signal?.throwIfAborted();
    available();
    if (session !== current || current.expiresAt <= Date.now())
      throw Error("Session changed before the request.");
    const response = record(
      await request(
        route,
        {
          ...(page === undefined ? {} : { page }),
          ...(body === undefined ? {} : { body }),
          key: current.token,
          timestamp,
          nonce,
          signature,
        },
        () => {
          if (session === current) session = undefined;
          void forget();
        },
        signal,
        priority,
      ),
    );
    signal?.throwIfAborted();
    available();
    if (session !== current || current.expiresAt <= Date.now())
      throw Error("Session changed during the request.");
    return response;
  }
  const read = (
    route: keyof typeof readTargets,
    signal?: AbortSignal,
    priority: RequestPriority = "observation",
  ) =>
    signedRequest(
      route,
      readTargets[route],
      undefined,
      undefined,
      signal,
      priority,
    );
  async function history(
    route: "order-history" | "fills" | "account-history" | "position-history",
    page?: string,
    signal?: AbortSignal,
    priority: RequestPriority = "recovery",
  ) {
    signal?.throwIfAborted();
    if (
      ![
        "order-history",
        "fills",
        "account-history",
        "position-history",
      ].includes(route) ||
      (page !== undefined && !/^[\x21-\x7e]{1,512}$/.test(page))
    )
      throw Error("Invalid history request.");
    const query = new URLSearchParams({ count: "100" });
    if (page !== undefined) query.set("page", page);
    return signedRequest(
      route,
      `/v1/trading/${route}?${query}`,
      page,
      undefined,
      signal,
      priority,
    );
  }
  async function verify() {
    const response = await read("verify");
    if (
      !Array.isArray(response.d) ||
      response.d.length > 1 ||
      (response.np !== undefined && typeof response.np !== "string")
    )
      throw Error("Unexpected authenticated history response.");
    available();
    return { checkedAt: Date.now(), recentFillCount: response.d.length };
  }
  const forget = () =>
    stored("readwrite", (store) => store.delete(markerKey)).then(() => {});
  /** Restores this wallet's unexpired session after a reload. Never creates a key. */
  async function restore() {
    if (disposed || session) return status();
    const saved = (await stored("readonly", (store) =>
      store.get(markerKey),
    )) as StoredSession | undefined;
    if (
      !disposed &&
      !session &&
      saved &&
      saved.key instanceof CryptoKey &&
      !saved.key.extractable &&
      typeof saved.token === "string" &&
      typeof saved.id === "string" &&
      Number.isSafeInteger(saved.expiresAt) &&
      saved.expiresAt > Date.now() + 5000 &&
      saved.expiresAt === marker()
    )
      session = saved;
    else if (saved && saved.expiresAt <= Date.now()) await forget();
    return status();
  }
  return {
    restore,
    forget,
    async submit(body: string) {
      submitReached = false;
      try {
        validateOrderBody(body);
        if (!(executionEnabled && orderCapabilityEnabled(body)))
          throw Error("Live order transport is unavailable.");
        return await signedRequest(
          "submit-orders",
          "/v1/trading/orders",
          undefined,
          body,
          undefined,
          "write",
        );
      } catch (cause) {
        // Budget, session and validation failures happen before any network call.
        if (!submitReached && !(cause instanceof OrderNotSent))
          throw new OrderNotSent(
            cause instanceof Error ? cause.message : "Order was not sent.",
          );
        throw cause;
      }
    },
    async snapshot<T>(
      readSnapshot: () => Promise<T>,
      priority: RequestPriority = "observation",
    ) {
      available();
      if (readingSnapshot)
        throw Error("A signed snapshot is already being read.");
      readingSnapshot = true;
      try {
        await budget().take(3, priority); // All three slots are reserved before any network read.
        snapshotBudget = { remaining: 3, priority };
        return await readSnapshot();
      } finally {
        snapshotBudget = undefined;
        readingSnapshot = false;
      }
    },
    prepare,
    enroll,
    verify,
    read,
    history,
    status,
    identity() {
      available();
      return status().state === "active" && session
        ? {
            owner,
            chainId: 10143 as const,
            id: session.id,
            expiresAt: session.expiresAt,
          }
        : null;
    },
    dispose() {
      disposed = true;
      draft = undefined;
      session = undefined;
    },
  };
}
