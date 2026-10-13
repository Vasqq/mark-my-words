import type {
  Dispatch,
  SetStateAction,
  MutableRefObject,
  ReactNode,
  CSSProperties,
} from "react";
export type Side = "long" | "short";
/** Bounded display/chart coordinates, never protocol calculation inputs. */
export type Market = {
  id: string;
  name: string;
  tick: number;
  lot: number;
  dp: number;
  qdp: number;
  chg: number;
};
export type Marks = Record<string, number>;
export type Draft = {
  market: string;
  side: Side;
  goal: number;
  target: number;
  stop: number;
  lev: number;
  rev: number;
};
export type Calculation = {
  m: Market;
  M: number;
  d: number;
  errors: Partial<
    Record<"lev" | "target" | "goal" | "stop" | "budget", string>
  >;
  ok: boolean;
} & Partial<
  Record<
    | "ceil"
    | "q"
    | "n"
    | "E"
    | "bound"
    | "notional"
    | "margin"
    | "entryFee"
    | "top"
    | "required"
    | "C"
    | "gross"
    | "exitFeeT"
    | "netT"
    | "liq"
    | "buf"
    | "sLo"
    | "sHi"
    | "grossS"
    | "netS"
    | "shortfall"
    | "gMax"
    | "tLim"
    | "reqGoalSize"
    | "overshoot",
    number
  >
>;
export type Trigger = { price: number; status: string; next?: number };
export type Position = {
  market: string;
  side: Side;
  q: number;
  E: number;
  C: number;
  entryFee: number;
  F: number;
  goal: number;
  lev: number;
  tp: Trigger;
  sl: Trigger;
  status: string;
  at: number;
  fEv?: number;
  merged?: boolean;
};
export type ExitReason = "tp" | "sl" | "liq" | "manual";
export type HistoryEntry = {
  market: string;
  side: Side;
  q: number;
  E: number;
  exit: number;
  gross: number;
  net: number;
  reason: ExitReason;
  at: number;
};
export type Result = {
  market: string;
  side: Side;
  reason: ExitReason;
  exit: number;
  net: number;
  ret: number;
  E: number;
  tp: number;
  sl: number;
  at: number;
};
export type Step = { label: string; st: string };
export type RunTo = MutableRefObject<{ market: string; price: number } | null>;
export type MarksSetter = Dispatch<SetStateAction<Marks>>;
export type User = {
  method: string;
  label: string;
  addr: string;
  embedded: boolean;
  ext?: string;
};
export type SignRequest = {
  title: string;
  desc?: string;
  fn?: string;
  to?: string;
  tap?: boolean;
  amt?: number;
  rows?: string[][];
};
export type Answer = boolean | number | "tap";
export type Modal = {
  k: string;
  need?: number;
  req?: SignRequest;
  resolve: (value: Answer) => void;
};
export type OneTap = { until: number; cap: number };
export type Toast = { id: number; t: ReactNode; kind: string };
export type Theme = Record<string, string>;
export type Layout = { padT: number; padB: number; xR: number; nowX: number };
export type ChartLevels = {
  side: Side;
  T: number;
  S: number;
  E: number;
  liq: number;
  q: number;
};
export type ChartProps = {
  market: string;
  mark: number;
  lv: ChartLevels;
  pos?: Position | null;
  T: Theme;
  onTarget: (value: number, drag?: boolean) => void;
  onStop: (value: number, drag?: boolean) => void;
  onAmend: (which: "tp" | "sl", price: number, y: number) => void;
  layout: (width: number, height: number) => Layout;
  pnlAxis?: boolean;
  tf?: string;
};
export type ChartCurrent = Omit<ChartProps, "lv" | "T"> &
  Omit<ChartLevels, "side"> & {
    d: number;
    theme: Theme;
    m: Market;
    tf: string;
  };
export type ChartState = {
  rng: Record<string, number[]>;
  rngT?: Record<string, number>;
  /** The live seed last applied per market, so a seed is applied once. */
  seed?: Record<string, readonly unknown[]>;
  hx: number | null;
  hist: Record<string, number[]>;
  times?: Record<string, number[]>;
  disp: number;
  last: number;
  dom: [number, number] | null;
  drag: { k: string; start: number; v: number } | null;
  hover: number | null;
  W: number;
  H: number;
  t0: number;
  Y: (value: number) => number;
  pOf: (y: number) => number;
  L?: Layout;
};
export type SliderProps = {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  onCommit?: () => void;
  color: string;
  badge?: ReactNode;
  label: string;
  valuetext?: string;
  disabled?: boolean;
  marks?: number[];
};
export type EditorProps = {
  value: number;
  rawValue?: string;
  onRawCommit?: (raw: string) => void;
  onRawPreview?: (raw: string) => void;
  onCommit: (v: number) => void;
  onPreview?: (v: number) => void;
  prefix?: string;
  label: string;
  dp?: number;
  focus?: boolean;
};
export type OverlayProps = {
  children?: ReactNode;
  onClose: () => void;
  label?: string;
  title?: string;
  anchor?: HTMLElement;
  width?: number;
};
export type PerplStyle = CSSProperties & Record<`--${string}`, string | number>;

/** Explicit observation states: missing never means zero or flat. */
export type Observation<T> =
  | {
      state: "observed";
      value: T;
      source: string;
      at: number;
      stale: boolean;
      range?: { from: number; to: number };
    }
  | { state: "loading" | "unavailable" | "failed"; reason: string };
export type CommandOutcome = {
  state: "accepted" | "pending" | "unknown" | "rejected" | "unavailable";
  reason?: string;
  operationId?: string;
};
export type CompleteCalculation = Omit<Calculation, "m"> & {
  m: Market;
} & Required<
    Pick<
      Calculation,
      | "ceil"
      | "q"
      | "n"
      | "E"
      | "bound"
      | "notional"
      | "margin"
      | "entryFee"
      | "top"
      | "required"
      | "C"
      | "gross"
      | "exitFeeT"
      | "netT"
      | "liq"
      | "buf"
      | "sLo"
      | "sHi"
      | "grossS"
      | "netS"
      | "shortfall"
      | "gMax"
      | "tLim"
      | "reqGoalSize"
      | "overshoot"
    >
  >;
export interface Identity {
  user: User | null;
  login(): Promise<Answer>;
  logout(): void;
  oneTap: OneTap | null;
  tapOn(): boolean;
  fund(need: number): Promise<Answer>;
  ask(
    k: string,
    extra?: Partial<Omit<Modal, "k" | "resolve">>,
  ): Promise<Answer>;
  modal: Modal | null;
}
export interface Book {
  result:
    | (Pick<Result, "market" | "side" | "reason" | "net" | "at"> &
        Partial<Result>)
    | null;
  toasts: Toast[];
  steps: Step[] | null;
  clearResult(): void;
  open(dr: Draft, q: CompleteCalculation): Promise<void>;
  close(mk: string, frac: number): Promise<void>;
  margin(mk: string, amt: number): Promise<void>;
  amend(mk: string, which: "tp" | "sl", price: number): Promise<void>;
  toast(t: ReactNode, kind?: string): void;
}
/** Imported exposure may have no app goal, known entry fees or registered exits. */
export type ObservedPosition = Omit<
  Position,
  "goal" | "entryFee" | "F" | "lev" | "tp" | "sl" | "E" | "C"
> & {
  key: string;
  account?: string;
  nativeId?: bigint;
  goal?: number;
  entryFee?: number;
  F?: number;
  lev?: number;
  E?: number;
  C?: number;
  tp: { price?: number; status: string; next?: number };
  sl: { price?: number; status: string; next?: number };
};
export interface PerplEngine {
  kind: "demo" | "live";
  canEditMarket(market: string): boolean;
  liveControls?: ReactNode;
  authorityRevision?: number;
  invalidateReviews?(): void;
  sessionStatus?: import("../../perpl-session").SessionStatus;
  liveStatus?: string;
  settledHistory?: {
    id: string;
    market: string;
    side: Side;
    block: number;
    net: number;
  }[];
  linkedExits?: {
    id: number;
    market: string;
    marketId: 16 | 32;
    label: string;
  }[];
  reviewCancel?(id: number, marketId: 16 | 32): Promise<void>;
  recovery?: {
    id: string;
    management: boolean;
    phase: string;
    label: string;
  }[];
  discardRecovery?(id: string, management: boolean): Promise<void>;
  accountAmount?(raw: string): { coordinate?: number; label: string };
  transferRawAccount?(kind: string, amount: string): Promise<CommandOutcome>;
  executionAvailable?: boolean;
  prepareReview?(
    draft: Draft,
  ): Promise<
    { id: string; calculation: Calculation; expiresAt: number } | undefined
  >;
  confirmReview?(id: string, draft: Draft): Promise<CommandOutcome>;
  chartRanges?: Record<string, Observation<{ price: number; time: number }[]>>;
  loadChartRange?(market: string, tf: string): void;
  reviewClose?(market: string, percent: 25 | 50 | 100): Promise<void>;
  confirmClose?(id: string): Promise<CommandOutcome>;
  closeReview?: {
    id: string;
    expiresAt: number;
    market: string;
    q: number;
    n: number;
    entry: number;
    net?: number;
    back?: number;
    fees: number;
    bound: number;
    reason?: string;
  };
  reviewProtection?(
    market: string,
    which: "tp" | "sl",
    raw: string,
  ): Promise<void>;
  /** Live only. Moves an exit in one step; "acknowledge" leaves a review that needs the immediate-trigger tick. */
  moveProtection?(
    market: string,
    which: "tp" | "sl",
    raw: string,
  ): Promise<CommandOutcome | { state: "acknowledge"; id: string }>;
  confirmProtection?(id: string, immediate: boolean): Promise<CommandOutcome>;
  protectionReview?: { id: string; expiresAt: number; immediate: boolean };
  /** Live only. amount is dollars as typed. Resolves to the signed review's id. */
  reviewCollateral?(
    market: string,
    amount: string,
  ): Promise<string | undefined>;
  confirmCollateral?(id: string): Promise<CommandOutcome>;
  collateralReview?: {
    id: string;
    expiresAt: number;
    market: string;
    amount: number;
    before: number;
    after: number;
    left: number;
  };
  chartHistory?: Record<string, Observation<{ price: number; time: number }[]>>;
  /** Advances once per chart tick when the engine paces the live line itself. */
  markTick?: number;
  marks: Marks;
  markets: Record<string, Market>;
  bk: Book;
  px: Identity;
  refreshAccount(): void;
  exportAccountEvidence?: () => Promise<void>;
  copyAccountEvidence?: () => Promise<void>;
  accountEvidenceStatus?: string;
  ownerRecoveryAvailable?: boolean;
  reviewOwnerRecovery?: () => void;
  account: Observation<import("../../perpl-account").TestnetAccount>;
  positions: Observation<ObservedPosition[]>;
  balances: Observation<{ wallet: number; free: number; locked: number }>;
  demoNudge?(mk: string, action: "tp" | "sl" | number): void;
  history: Observation<HistoryEntry[]>;
  detailsReason?: string;
  publicReason?: string;
  initialDraft?: Draft;
  /**
   * Where a sentence lands on load, as fractions of the live price. `fresh` places a
   * first visit there; `repair` moves a saved target that loads inside the entry bound.
   */
  landing?: { fresh: boolean; repair: boolean; target: number; stop: number };
  draftValue?(current: Draft, field: "goal" | "target" | "stop"): string;
  editRawDraft?(
    current: Draft,
    field: "goal" | "target" | "stop",
    raw: string,
    commit: boolean,
  ): Draft;
  editDraft?(current: Draft, patch: Partial<Draft>): Draft;
  calculate(draft: Draft): {
    public: Observation<Calculation>;
    details: Observation<Calculation>;
  };
  gate(
    req: SignRequest,
    need?: number,
    offerTap?: () => void,
  ): Promise<boolean>;
  command(
    name: "fund" | "enroll" | "order" | "manage",
  ): Promise<CommandOutcome>;
  roundTick(p: number, m: Market): number;
  fixP(p: number, m: Market): number;
  seedLive(id: string): number[];
  genRange(id: string, tf: string): number[];
  tfChange(id: string, tf: string): number;
  positionMetrics(
    p: Position,
    mark: number,
  ): {
    gross?: number;
    net?: number;
    netAfterFunding?: number;
    effectiveLeverage?: number;
    liquidation?: number;
  };
  totalPositionNet?: number;
  reviewDebit(review: CompleteCalculation): number | undefined;
  amendPreview(
    p: Position,
    which: "tp" | "sl",
    price: number,
    mark: number,
  ): { gross?: number; immediate?: boolean; badStop?: boolean };
  stopBuffer(m: Market, mark: number): number | undefined;
  collateralPreview(
    p: Position,
    amount: number,
  ): {
    before?: number;
    after?: number;
    collateral?: number;
    leverageBefore?: number;
    leverageAfter?: number;
    remaining?: number;
  };
  closePreview(
    p: Position,
    mark: number,
    percent: number,
  ): {
    n?: number;
    q?: number;
    entry?: number;
    net?: number;
    back?: number;
    fees?: number;
  };
  fundingLabel(
    side: Side,
    market: string,
    mark: number,
    quantity: number,
  ): string;
  accountTotals: {
    value?: number;
    free?: number;
    locked?: number;
    wallet?: number;
  };
  transferAccount(
    kind: string,
    amount: number,
    gate: (req: SignRequest, need?: number) => Promise<boolean>,
  ): Promise<CommandOutcome>;
  exportWallet(): Promise<CommandOutcome>;
  logout(): void;
  authLayer: ReactNode;
  oneTapSheet(close: () => void): ReactNode;
}
