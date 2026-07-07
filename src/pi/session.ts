/**
 * SPIKE(pi-backend): thin wrapper around the pi coding agent SDK.
 *
 * This is the only module that imports @earendil-works packages. Everything
 * else in src/pi/ talks to the PiReviewSession interface so tests (and a
 * potential future backend abstraction) never touch the real SDK.
 */

export interface PiSessionRequest {
  /** Repository root the review tools operate in. */
  directory: string;
  /** provider/model string, same format as DiffOwlConfig.model. */
  model: string;
  systemPrompt: string;
  /** Allowlist of pi tool names. Empty array means no tools. */
  tools: string[];
  /** pi thinking level; omitted lets pi pick its default. */
  thinkingLevel?: string;
}

export interface PiReviewSession {
  sessionId: string;
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  /** Snapshot of agent state messages (pi-ai Message shapes, treated as unknown). */
  messages(): unknown[];
}

export type CreatePiReviewSession = (request: PiSessionRequest) => Promise<PiReviewSession>;

export async function createPiReviewSession(request: PiSessionRequest): Promise<PiReviewSession> {
  const sdk = await import("@earendil-works/pi-coding-agent");

  const authStorage = sdk.AuthStorage.create();
  const modelRegistry = sdk.ModelRegistry.create(authStorage);

  const separator = request.model.indexOf("/");
  if (separator <= 0 || separator === request.model.length - 1) {
    throw new Error(`Invalid model "${request.model}"; expected provider/model format.`);
  }
  const providerID = request.model.slice(0, separator);
  const modelID = request.model.slice(separator + 1);

  const model = modelRegistry.find(providerID, modelID);
  if (!model) {
    throw new Error(
      `pi does not know the model "${request.model}". ` +
        `Check provider/model spelling, or register it in ~/.pi/agent/models.json.`,
    );
  }

  const loader = new sdk.DefaultResourceLoader({
    cwd: request.directory,
    agentDir: sdk.getAgentDir(),
    systemPromptOverride: () => request.systemPrompt,
    // Prevent APPEND_SYSTEM.md from ~/.pi/agent or <cwd>/.pi leaking into reviews.
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();

  const { session } = await sdk.createAgentSession({
    cwd: request.directory,
    model,
    ...(request.thinkingLevel !== undefined
      ? {
          thinkingLevel: request.thinkingLevel as
            | "off"
            | "minimal"
            | "low"
            | "medium"
            | "high"
            | "xhigh",
        }
      : {}),
    // An empty allowlist must not fall back to pi's default tool set.
    ...(request.tools.length > 0 ? { tools: request.tools } : { noTools: "all" as const }),
    resourceLoader: loader,
    sessionManager: sdk.SessionManager.inMemory(request.directory),
    authStorage,
    modelRegistry,
  });

  return {
    sessionId: session.sessionId,
    subscribe: (listener) => session.subscribe(listener),
    prompt: (text) => session.prompt(text),
    abort: () => session.abort(),
    dispose: () => session.dispose(),
    messages: () => [...session.state.messages],
  };
}

export async function getInstalledPiVersion(): Promise<string | null> {
  try {
    const sdk = await import("@earendil-works/pi-coding-agent");
    return typeof sdk.VERSION === "string" ? sdk.VERSION : null;
  } catch {
    return null;
  }
}
