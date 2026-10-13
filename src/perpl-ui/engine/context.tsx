import { createContext, useContext } from "react";
import type { PerplEngine } from "./types";
const Engine = createContext<PerplEngine | null>(null);
export const EngineProvider = Engine.Provider;
export function useEngine() {
  const value = useContext(Engine);
  if (!value) throw Error("Missing Perpl engine");
  return value;
}
