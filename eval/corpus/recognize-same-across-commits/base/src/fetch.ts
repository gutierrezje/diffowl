export async function fetchData(url: string) {
  const response = await fetch(url);
  return response.ok;
}
