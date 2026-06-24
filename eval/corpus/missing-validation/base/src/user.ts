export function loadUser(id: string) {
  if (!id) {
    throw new Error("id is required");
  }
  return { id };
}
