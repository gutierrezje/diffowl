export async function syncProfile(userId: string, remoteUrl: string) {
  if (!userId) {
    throw new Error("userId is required");
  }

  const local = await loadLocal(userId);
  const response = await fetch(remoteUrl);
  if (!response.ok) {
    throw new Error(`remote sync failed: ${response.status}`);
  }

  return { id: local.id, remoteOk: true };
}

async function loadLocal(userId: string) {
  return { id: userId };
}
