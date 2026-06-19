/** Drain a Lesto response body (string, bytes, or stream) to text. */
export async function text(response: { body: unknown }): Promise<string> {
  return new Response(response.body as BodyInit).text();
}
