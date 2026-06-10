export type ReviewTarget =
  | { kind: "staged" }
  | { kind: "last-commit" }
  | { kind: "commit"; ref: string };
