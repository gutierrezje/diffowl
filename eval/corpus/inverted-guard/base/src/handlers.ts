import { applyEdit, type Doc } from "./access.js";

export interface EditRequest {
  userId: string;
  patch: string;
}

interface EditResponse {
  body: string;
}

export function handleEditRequest(doc: Doc, request: EditRequest): EditResponse {
  const revision = applyEdit(doc, request.userId, request.patch);
  return { body: revision };
}
