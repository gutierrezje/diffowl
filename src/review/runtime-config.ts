import type { DiffOwlConfig } from "../config.js";
import type { ReasoningSelection } from "./reasoning.js";

export type EffectiveReviewConfig = DiffOwlConfig & {
  model: string;
  reasoning: ReasoningSelection;
};
