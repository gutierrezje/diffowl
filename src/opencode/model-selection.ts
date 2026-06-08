export type ModelSelection =
  | { type: "selected"; model: string }
  | { type: "kept"; model: string }
  | { type: "invalid" };

export function canSelectModelInteractively(
  inputIsTTY: boolean | undefined,
  outputIsTTY: boolean | undefined,
): boolean {
  return inputIsTTY === true && outputIsTTY === true;
}

export function selectModel(
  models: string[],
  currentModel: string,
  answer: string,
  allowKeepCurrent: boolean,
): ModelSelection {
  const trimmed = answer.trim();
  if (trimmed === "") {
    if (allowKeepCurrent) return { type: "kept", model: currentModel };
    if (models.length === 0) return { type: "invalid" };
    return { type: "selected", model: models[0]! };
  }

  if (!/^\d+$/.test(trimmed)) return { type: "invalid" };
  const selection = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(selection) || selection < 1 || selection > models.length) {
    return { type: "invalid" };
  }

  return { type: "selected", model: models[selection - 1]! };
}
