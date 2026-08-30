import { describe, expect, it } from "vitest";
import { buildCursorEnvironment } from "./environment.js";

describe("buildCursorEnvironment", () => {
  it("keeps Cursor runtime state and test controls without forwarding credentials", () => {
    const environment = buildCursorEnvironment(
      {
        MOCK_CURSOR_MODE: "success",
        MOCK_CURSOR_API_KEY: "mock-secret",
        CURSOR_API_KEY: "cursor-secret",
      },
      {
        PATH: "/bin",
        HOME: "/tmp/home",
        XDG_CONFIG_HOME: "/tmp/config",
        LANG: "en_US.UTF-8",
        OPENAI_API_KEY: "openai-secret",
        API_TOKEN: "token-secret",
        SSH_AUTH_SOCK: "/tmp/socket",
        REVIEW_SENTINEL: "do-not-inherit",
      },
    );

    expect(environment).toMatchObject({
      PATH: "/bin",
      HOME: "/tmp/home",
      XDG_CONFIG_HOME: "/tmp/config",
      LANG: "en_US.UTF-8",
      MOCK_CURSOR_MODE: "success",
    });
    expect(environment).not.toHaveProperty("CURSOR_API_KEY");
    expect(environment).not.toHaveProperty("MOCK_CURSOR_API_KEY");
    expect(environment).not.toHaveProperty("OPENAI_API_KEY");
    expect(environment).not.toHaveProperty("API_TOKEN");
    expect(environment).not.toHaveProperty("SSH_AUTH_SOCK");
    expect(environment).not.toHaveProperty("REVIEW_SENTINEL");
  });
});
