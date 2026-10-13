import { accountLockName } from "./account-coordination";
import { describe, expect, it, vi } from "vitest";
import { hashTypedData, hexToBytes, verifyTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createPerplSession, type SessionTypedData } from "./perpl-session";

const wallet = privateKeyToAccount(`0x${"0".repeat(63)}1`);
// The session still persists only its expiry; global quota metadata contains request timestamps only.
function sessionSaved(saved: Map<string, string>) {
  const budget = saved.get("perpl-handler-budget-v2");
  if (budget !== undefined) {
    const timestamps: unknown = JSON.parse(budget);
    expect(Array.isArray(timestamps)).toBe(true);
    expect((timestamps as number[]).length).toBeLessThanOrEqual(110);
    expect(
      (timestamps as number[]).every(
        (at) => Number.isSafeInteger(at) && Math.abs(Date.now() - at) < 60000,
      ),
    ).toBe(true);
  }
  const marker = `perpl-session-v1:10143:${wallet.address.toLowerCase()}`;
  expect(
    [...saved.keys()].every(
      (key) => key === marker || key === "perpl-handler-budget-v2",
    ),
  ).toBe(true);
  return [...saved.entries()]
    .filter(([key]) => key !== "perpl-handler-budget-v2")
    .map(([, value]) => value);
}

const domain = [
  "name:string",
  "version:string",
  "chainId:uint256",
  "verifyingContract:address",
  "salt:bytes32",
];
const fields = [
  "signer:address",
  "statement:string",
  "publicKey:string",
  "scope:string",
  "label:string",
  "expiresAt:string",
  "ipCidrs:string",
  "origin:string",
  "builderId:string",
  "maxBuilderFeePer100K:string",
  "time:uint64",
];
const typedFields = (items: string[]) =>
  items.map((item) => {
    const [name, type] = item.split(":");
    return { name, type };
  });
const json = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
function harness(
  options: {
    createSession?: typeof createPerplSession;
    change?: (data: Record<string, unknown>) => void;
    loseEnrollment?: boolean;
    enrolled?: (info: Record<string, unknown>) => void;
    readFailure?: () => number | undefined;
    readWait?: (signal: AbortSignal) => Promise<void>;
  } = {},
) {
  const saved = new Map<string, string>();
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => {
      saved.set(key, value);
    },
  };
  let publicKey: CryptoKey;
  let expiry = 0;
  let enrolls = 0;
  let calls = 0;
  let held = false;
  let submits = 0;
  const nonces = new Set<string>();
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    const body = JSON.parse(init!.body as string);
    if (url === "/perpl-account/payload") {
      const bytes = new Uint8Array(hexToBytes(body.public_key));
      publicKey = await crypto.subtle.importKey(
        "raw",
        bytes,
        "Ed25519",
        false,
        ["verify"],
      );
      expiry = body.expires_at;
      const payload = {
        typed_data: {
          domain: {
            name: "perpl.xyz",
            version: "1",
            chainId: "0x279f",
            verifyingContract: `0x${"0".repeat(40)}`,
            salt: `0x${"1".repeat(64)}`,
          },
          primaryType: "PerplRegisterApiKey",
          types: {
            EIP712Domain: typedFields(domain),
            PerplRegisterApiKey: typedFields(fields),
          },
          message: {
            signer: wallet.address,
            statement:
              "I authorize the creation of Perpl API key with the specified scope and parameters",
            publicKey: btoa(String.fromCharCode(...bytes))
              .replace(/\+/g, "-")
              .replace(/\//g, "_")
              .replace(/=+$/, ""),
            scope: "3",
            label: body.label,
            expiresAt: String(expiry),
            ipCidrs: "",
            origin: "",
            builderId: "0",
            maxBuilderFeePer100K: "0",
            time: `0x${Date.now().toString(16)}`,
          },
        },
        mac: "opaque-proof",
      };
      options.change?.(payload.typed_data);
      return json(payload);
    }
    if (url === "/perpl-account/enroll") {
      enrolls++;
      const typedData = body.typed_data;
      expect(
        await verifyTypedData({
          ...typedData,
          address: wallet.address,
          signature: body.signature,
        }),
      ).toBe(true);
      expect(
        await crypto.subtle.verify(
          "Ed25519",
          publicKey,
          new Uint8Array(hexToBytes(body.pop_signature)),
          new Uint8Array(
            hexToBytes(
              hashTypedData({
                ...typedData,
                domain: { ...typedData.domain, chainId: 10143 },
              }),
            ),
          ),
        ),
      ).toBe(true);
      if (options.loseEnrollment) throw Error("Lost response after enrollment");
      const info = {
        api_key: "opaque-test-token",
        address: wallet.address,
        scope_mask: 3,
        expires_at: expiry,
        origin: "",
        label: "Testnet session",
        ip_cidrs: null,
      };
      options.enrolled?.(info);
      return json({ api_key: info });
    }
    if (String(url).endsWith("/submit-orders")) {
      expect(body.key).toBe("opaque-test-token");
      expect(JSON.parse(body.body).d).toHaveLength(1);
      submits++;
      return json({ d: [] });
    }
    await options.readWait?.(init!.signal!);
    const failure = options.readFailure?.();
    if (failure) return new Response("redacted", { status: failure });
    const route = String(url).split("/").at(-1)!;
    expect([
      "verify",
      "wallet",
      "positions",
      "orders",
      "order-history",
      "fills",
      "account-history",
      "position-history",
    ]).toContain(route);
    const query = new URLSearchParams({ count: "100" });
    if (body.page !== undefined) query.set("page", body.page);
    expect(body.key).toBe("opaque-test-token");
    expect(nonces.has(body.nonce)).toBe(false);
    nonces.add(body.nonce);
    const canonical = [
      "10143",
      "GET",
      route === "verify"
        ? "/v1/trading/fills?count=1"
        : [
              "order-history",
              "fills",
              "account-history",
              "position-history",
            ].includes(route)
          ? `/v1/trading/${route}?${query}`
          : `/v1/trading/${route}`,
      body.timestamp,
      body.nonce,
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    ].join("\n");
    expect(
      await crypto.subtle.verify(
        "Ed25519",
        publicKey,
        Uint8Array.from(
          atob(body.signature.replace(/-/g, "+").replace(/_/g, "/")),
          (char) => char.charCodeAt(0),
        ),
        new TextEncoder().encode(canonical),
      ),
    ).toBe(true);
    return json({ d: [], np: "" });
  };
  const optionsForApp = {
    storage,
    fetcher,
    budgetLock: async <T>(_name: string, work: () => Promise<T>) => work(),
    lock: async <T>(name: string, work: () => Promise<T>) => {
      expect(name).toBe(accountLockName(wallet.address));
      if (held) throw Error("Another tab is enrolling");
      held = true;
      try {
        return await work();
      } finally {
        held = false;
      }
    },
  };
  return {
    create: () =>
      (options.createSession ?? createPerplSession)(
        wallet.address,
        optionsForApp,
      ),
    saved,
    withOwnerLock: <T>(work: () => Promise<T>) =>
      optionsForApp.lock(accountLockName(wallet.address), work),
    get enrolls() {
      return enrolls;
    },
    get submits() {
      return submits;
    },
    get calls() {
      return calls;
    },
  };
}
const sign = (data: SessionTypedData): Promise<Hex> =>
  wallet.signTypedData(data);

describe("Perpl session boundary", () => {
  it("prevents pre-aborted signed reads and cancels delayed read/history transport without losing session access", async () => {
    let started!: () => void;
    let activeSignal: AbortSignal | undefined;
    const h = harness({
      readWait: (signal) => {
        activeSignal = signal;
        started();
        return new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
      },
    });
    const app = h.create();
    await app.prepare();
    await app.enroll(sign);
    const before = h.calls;
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(app.read("wallet", cancelled.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(
      app.history("fills", undefined, cancelled.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(h.calls).toBe(before);
    for (const history of [false, true]) {
      const controller = new AbortController();
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const pending = history
        ? app.history("fills", undefined, controller.signal)
        : app.read("orders", controller.signal);
      const rejected = expect(pending).rejects.toMatchObject({
        name: "AbortError",
      });
      await ready;
      controller.abort();
      await rejected;
      expect(activeSignal!.aborted).toBe(true);
      expect(app.status().state).toBe("active");
    }
  });
  it("enrolls with both cryptographic proofs, signs fresh read requests and keeps credentials out of reload storage", async () => {
    for (const ipCidrs of [null, []]) {
      const h = harness({
        enrolled: (info) => {
          info.ip_cidrs = ipCidrs;
        },
      });
      const app = h.create();
      expect((await app.prepare()).state).toBe("ready");
      expect((await app.enroll(sign)).state).toBe("active");
      expect((await app.verify()).recentFillCount).toBe(0);
      await app.verify();
      for (const route of ["wallet", "positions", "orders"] as const)
        await app.read(route);
      for (const route of [
        "order-history",
        "fills",
        "account-history",
        "position-history",
      ] as const) {
        await app.history(route);
        await app.history(route, "opaque+/=cursor");
      }
      const beforeSubmit = h.calls;
      await expect(
        app.submit(
          JSON.stringify({
            d: [
              {
                rq: 18,
                acc: 1057,
                mkt: 32,
                t: 1,
                p: 250000,
                s: 20,
                lv: 300,
                fl: 4,
                mnp: 50,
                lb: 120,
              },
            ],
          }),
        ),
      ).resolves.toBeDefined();
      expect(h.calls).toBe(beforeSubmit + 1);
      expect(h.submits).toBe(1);
      expect(app.identity()).toMatchObject({
        owner: wallet.address,
        chainId: 10143,
      });
      expect(sessionSaved(h.saved)).toEqual([String(app.status().expiresAt)]);
      const reloaded = h.create();
      expect(reloaded.status().state).toBe("unavailable");
      await expect(reloaded.prepare()).rejects.toThrow("unexpired");
      const clock = vi
        .spyOn(Date, "now")
        .mockReturnValue(app.status().expiresAt!);
      try {
        await expect(app.verify()).rejects.toThrow("No active session");
        expect(reloaded.status().state).toBe("idle");
      } finally {
        clock.mockRestore();
      }
      app.dispose();
      await expect(app.verify()).rejects.toThrow("changed");
      expect(h.enrolls).toBe(1);
    }
  });

  it("rejects substituted authority, keys, domain and signing schema before a wallet request", async () => {
    const changes: ((data: Record<string, unknown>) => void)[] = [
      (d) => {
        (d.domain as Record<string, unknown>).chainId = 143;
      },
      ...Object.entries({
        signer: `0x${"2".repeat(40)}`,
        publicKey: "wrong-key",
        scope: "7",
        expiresAt: "0",
        origin: "https://other.example",
        builderId: "1",
        maxBuilderFeePer100K: "1",
        statement: "Different authority",
      }).map(([k, v]) => (d: Record<string, unknown>) => {
        (d.message as Record<string, unknown>)[k] = v;
      }),
      (d) => {
        (d.types as Record<string, unknown>).Permit = [];
      },
    ];
    for (const change of changes) {
      const h = harness({ change });
      const app = h.create();
      await expect(app.prepare()).rejects.toThrow();
      expect(h.enrolls).toBe(0);
      expect(sessionSaved(h.saved).length).toBe(0);
    }
  });

  it("blocks mismatched enrollment metadata without disclosing credentials or retrying", async () => {
    for (const [field, value] of Object.entries({
      api_key: "secret\ninvalid",
      address: `0x${"2".repeat(40)}`,
      scope_mask: 7,
      expires_at: 0,
      origin: "https://unexpected.example",
      label: "unexpected-label",
      ip_cidrs: ["192.0.2.1/32"],
      builder_id: 1,
      max_builder_fee_per_100k: 1,
    })) {
      const h = harness({
        enrolled: (info) => {
          info[field] = value;
        },
      });
      const app = h.create();
      await app.prepare();
      await expect(app.enroll(sign)).rejects.toThrow(
        `Enrollment response did not match the reviewed session (${field}). The key may still be active until expiry.`,
      );
      expect(app.status().state).toBe("unavailable");
      await expect(app.verify()).rejects.toThrow("No active session");
      await expect(h.create().prepare()).rejects.toThrow("unexpired");
      expect(h.enrolls).toBe(1);
      expect(sessionSaved(h.saved)).toEqual([String(app.status().expiresAt)]);
    }
  });

  it("preserves transient read access but turns authorization rejection into explicit replacement recovery", async () => {
    let failure: number | undefined;
    const h = harness({ readFailure: () => failure });
    const app = h.create();
    await app.prepare();
    await app.enroll(sign);
    const marker = sessionSaved(h.saved);
    const identity = app.identity();
    for (const status of [429, 502, 503]) {
      failure = status;
      await expect(app.verify()).rejects.toThrow(`HTTP ${status}`);
      expect(app.identity()).toEqual(identity);
      expect(app.status().state).toBe("active");
    }
    failure = 401;
    await expect(app.read("wallet")).rejects.toThrow("Restore session access");
    expect(app.identity()).toBeNull();
    expect(app.status().state).toBe("unavailable");
    expect(sessionSaved(h.saved)).toEqual(marker);
    await expect(app.prepare()).rejects.toThrow("unexpired");
    failure = undefined;
    await app.prepare({ replaceUnavailable: true });
    expect(h.enrolls).toBe(1); // Explicit review alone never enrolls again.
    await app.enroll(sign);
    failure = 403;
    await expect(app.history("fills")).rejects.toThrow(
      "Restore session access",
    );
    expect(app.status().state).toBe("unavailable");
    expect(h.enrolls).toBe(2);
  });
  it("keeps ambiguous enrollment blocked after reload and rejects overlapping confirmations", async () => {
    const h = harness({ loseEnrollment: true });
    const app = h.create();
    await app.prepare();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = app.enroll(async (data) => {
      await waiting;
      return sign(data);
    });
    await expect(app.enroll(sign)).rejects.toThrow("Another tab");
    release();
    await expect(first).rejects.toThrow("Lost response");
    expect(h.create().status().state).toBe("unavailable");
    await expect(app.enroll(sign)).rejects.toThrow("fresh");
    expect(h.enrolls).toBe(1);
  });

  it("requires explicit replacement review and rejects a competing tab's superseded review", async () => {
    const h = harness();
    const original = h.create();
    await original.prepare();
    await original.enroll(sign);
    await expect(
      original.prepare({ replaceUnavailable: true }),
    ).rejects.toThrow("unexpired");
    const previousExpiry = original.status().expiresAt!;
    original.dispose();
    const replacement = h.create();
    const competing = h.create();
    await expect(replacement.prepare()).rejects.toThrow("unexpired");
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1000);
    try {
      const review = await replacement.prepare({ replaceUnavailable: true });
      expect(review.replacesExpiresAt).toBe(previousExpiry);
      await expect(
        replacement.enroll(async () => {
          throw Error("Rejected");
        }),
      ).rejects.toThrow("Rejected");
      expect(sessionSaved(h.saved)).toEqual([String(previousExpiry)]);
      await competing.prepare({ replaceUnavailable: true });
      await competing.enroll(sign);
      await expect(replacement.enroll(sign)).rejects.toThrow("fresh");
      expect(competing.status().state).toBe("active");
      expect(h.create().status().state).toBe("unavailable");
      expect(sessionSaved(h.saved)).toEqual([
        String(competing.status().expiresAt),
      ]);
      expect(h.enrolls).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });

  it("does not submit after rejection, wrong signer, storage failure or disposal during signing", async () => {
    const h = harness();
    const app = h.create();
    await app.prepare();
    await expect(
      app.enroll(async () => {
        throw Error("Rejected");
      }),
    ).rejects.toThrow("Rejected");
    const other = privateKeyToAccount(`0x${"0".repeat(63)}2`);
    await expect(
      app.enroll((data) => other.signTypedData(data)),
    ).rejects.toThrow("selected");
    await expect(
      app.enroll(async (data) => {
        app.dispose();
        return sign(data);
      }),
    ).rejects.toThrow("changed");
    expect(h.enrolls).toBe(0);
    expect(sessionSaved(h.saved).length).toBe(0);
    const f = harness();
    const blocked = f.create();
    await blocked.prepare();
    f.saved.set = () => {
      throw Error("Disk blocked");
    };
    await expect(blocked.enroll(sign)).rejects.toThrow("Disk blocked");
    expect(f.enrolls).toBe(0);
  });
});
