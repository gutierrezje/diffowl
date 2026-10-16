import { fileURLToPath } from "node:url";

// Child Git commands inherit this environment; repository-local configuration
// remains available to the hook and worktree integration tests.
export const gitTestEnvironment = {
  GIT_CONFIG_GLOBAL: fileURLToPath(new URL("./gitconfig", import.meta.url)),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "0",
  GIT_CONFIG_PARAMETERS: "",
  GIT_TEMPLATE_DIR: "",
};
