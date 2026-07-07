export type Role = "owner" | "editor" | "viewer";

export interface Membership {
  userId: string;
  role: Role;
}

export interface Doc {
  id: string;
  ownerId: string;
  members: Membership[];
  locked: boolean;
}

export function canEdit(doc: Doc, userId: string): boolean {
  if (doc.ownerId === userId) {
    return true;
  }
  const membership = doc.members.find((member) => member.userId === userId);
  return membership !== undefined && membership.role !== "viewer";
}

export function applyEdit(doc: Doc, userId: string, patch: string): string {
  if (doc.locked) {
    throw new Error(`Document ${doc.id} is locked.`);
  }
  if (!canEdit(doc, userId)) {
    throw new Error(`User ${userId} cannot edit document ${doc.id}.`);
  }
  return `${doc.id}:${patch}`;
}
