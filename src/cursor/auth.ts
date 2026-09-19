/** Use the SDK's public credential store; Cursor CLI login is separate. */
export async function loginCursor(onLoginUrl: (url: string) => void): Promise<void> {
  const { Cursor } = await import("@cursor/sdk");
  await Cursor.auth.login({
    apiKeyName: "DiffOwl",
    onLoginUrl,
    signal: AbortSignal.timeout(180_000),
  });
}

export async function cursorAuthStatus(): Promise<string> {
  if (process.env["CURSOR_API_KEY"]?.trim()) return "API key provided by CURSOR_API_KEY";
  const { Cursor } = await import("@cursor/sdk");
  const result = await Cursor.auth.status();
  return result.status === "logged-in"
    ? "Signed in to the Cursor SDK"
    : "Not signed in; run `diffowl cursor login`";
}
