import { applyEdit, type Doc } from "./access.js";

export interface EditRequest {
  userId: string;
  patch: string;
}

export function handleEditRequest(doc: Doc, request: EditRequest): { body: string } {
  const revision = applyEdit(doc, request.userId, request.patch);
  return { body: revision };
}
