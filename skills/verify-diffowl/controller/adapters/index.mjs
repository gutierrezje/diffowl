import { cliAdapter } from "./cli.mjs";
import { codexAdapter } from "./codex.mjs";
import { opencodeAdapter } from "./opencode.mjs";

const adapters = new Map(
  [cliAdapter, codexAdapter, opencodeAdapter].map((adapter) => [adapter.surface, adapter]),
);

export function getAdapter(surface) {
  return adapters.get(surface);
}

export function listAdapters() {
  return [...adapters.values()];
}
