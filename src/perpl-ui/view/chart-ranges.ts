export const TF: Record<
  string,
  {
    label: string;
    n: number;
    ms: number;
    k?: number;
    vol?: number;
  }
> = {
  live: {
    label: "Live",
    n: 160,
    ms: 600,
  },
  "1H": {
    label: "1H",
    n: 120,
    ms: 30e3,
    k: 0.12,
    vol: 0.0011,
  },
  "1D": {
    label: "1D",
    n: 144,
    ms: 600e3,
    k: 1,
    vol: 0.0026,
  },
  "1W": {
    label: "1W",
    n: 168,
    ms: 3600e3,
    k: -1.6,
    vol: 0.0062,
  },
};
