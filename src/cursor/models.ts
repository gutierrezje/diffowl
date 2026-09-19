export async function listCursorModels(): Promise<{ id: string; name: string }[]> {
  const { Cursor } = await import("@cursor/sdk");
  const models = await Cursor.models.list();
  return models.map((model) => ({ id: model.id, name: model.displayName }));
}
