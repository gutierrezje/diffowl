import { describe, expect, it } from "vitest";
import { buildExperimentEnvironment } from "./environment.js";

describe("buildExperimentEnvironment", () => {
  it("keeps the narrow inherited allowlist and removes credential-like values", () => {
    const environment = buildExperimentEnvironment(
      {
        MOCK_APP_SERVER_MODE: "immediate",
        MOCK_CLI_STDERR_VALUE: "visible-control",
        MOCK_OPENAI_API_KEY: "mock-api-secret",
        MOCK_SECRET: "mock-secret",
        OPENAI_API_KEY: "override-secret",
      },
      {
        PATH: "/bin",
        Path: "C:\\Windows\\System32",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        HOME: "/tmp/home",
        PATHOLOGY: "do-not-inherit",
        HOMEBREW_PREFIX: "do-not-inherit",
        USER_NOTE: "do-not-inherit",
        TMP_CACHE: "do-not-inherit",
        LC_ALL: "C",
        XDG_CONFIG_HOME: "/tmp/config",
        SSL_CERT_FILE: "/tmp/cert.pem",
        REVIEW_SENTINEL: "do-not-inherit",
        API_TOKEN: "secret",
        MOCK_INHERITED_SECRET: "inherited-secret",
        SSH_AUTH_SOCK: "/tmp/socket",
      },
    );
    expect(environment).toMatchObject({
      PATH: "/bin",
      HOME: "/tmp/home",
      LC_ALL: "C",
      XDG_CONFIG_HOME: "/tmp/config",
      SSL_CERT_FILE: "/tmp/cert.pem",
      MOCK_APP_SERVER_MODE: "immediate",
      MOCK_CLI_STDERR_VALUE: "visible-control",
    });
    if (process.platform === "win32") {
      expect(environment).toHaveProperty("PATHEXT", ".COM;.EXE;.BAT;.CMD");
      expect(environment).toHaveProperty("Path", "C:\\Windows\\System32");
    } else {
      expect(environment).not.toHaveProperty("PATHEXT");
      expect(environment).not.toHaveProperty("Path");
    }
    expect(environment).not.toHaveProperty("REVIEW_SENTINEL");
    expect(environment).not.toHaveProperty("PATHOLOGY");
    expect(environment).not.toHaveProperty("HOMEBREW_PREFIX");
    expect(environment).not.toHaveProperty("USER_NOTE");
    expect(environment).not.toHaveProperty("TMP_CACHE");
    expect(environment).not.toHaveProperty("API_TOKEN");
    expect(environment).not.toHaveProperty("OPENAI_API_KEY");
    expect(environment).not.toHaveProperty("MOCK_OPENAI_API_KEY");
    expect(environment).not.toHaveProperty("MOCK_SECRET");
    expect(environment).not.toHaveProperty("MOCK_INHERITED_SECRET");
    expect(environment).not.toHaveProperty("SSH_AUTH_SOCK");
  });
});
