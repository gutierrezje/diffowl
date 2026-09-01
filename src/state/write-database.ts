import {
  closeStateDatabase,
  openStateDatabase,
  type OpenStateDatabaseOptions,
  type StateDatabase,
} from "./db.js";
import { reconcileStaleReviewExecutions } from "./review-execution-reconciliation.js";

export async function openStateDatabaseForWrite(
  diffOwlDir: string,
  options: OpenStateDatabaseOptions = {},
): Promise<StateDatabase> {
  const state = await openStateDatabase(diffOwlDir, options);
  try {
    await reconcileStaleReviewExecutions(state);
    return state;
  } catch (error) {
    closeStateDatabase(state);
    throw error;
  }
}
