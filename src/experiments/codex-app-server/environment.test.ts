import { describe, expect, it } from "vitest";
import { buildExperimentEnvironment } from "./environment.js";

describe("buildExperimentEnvironment", () => {
  it("keeps the narrow inherited allowlist and removes credential-like values", () => {
    const environment = buildExperimentEnvironment(
      { MOCK_APP_SERVER_MODE: "immediate", OPENAI_API_KEY: "override-secret" },
      {
        PATH: "/bin",
        HOME: "/tmp/home",
        REVIEW_SENTINEL: "do-not-inherit",
        API_TOKEN: "secret",
        SSH_AUTH_SOCK: "/tmp/socket",
      },
    );
    expect(environment).toMatchObject({
      PATH: "/bin",
      HOME: "/tmp/home",
      MOCK_APP_SERVER_MODE: "immediate",
    });
    expect(environment).not.toHaveProperty("REVIEW_SENTINEL");
    expect(environment).not.toHaveProperty("API_TOKEN");
    expect(environment).not.toHaveProperty("OPENAI_API_KEY");
    expect(environment).not.toHaveProperty("SSH_AUTH_SOCK");
  });
});
