export const executionEnabled: boolean;
export function validateOrderBody(raw: unknown): string;

export const executionCapabilities: Readonly<
  Record<
    16 | 32,
    Readonly<
      Record<
        "Long" | "Short",
        Readonly<
          Record<"entry" | "protection" | "management" | "recovery", boolean>
        >
      >
    >
  >
>;
export function orderCapabilityEnabled(raw: string): boolean;
