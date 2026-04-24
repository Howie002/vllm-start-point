import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { proxyUrl, models, prompts, maxTokens, temperature } =
    await req.json();

  const encoder = new TextEncoder();
  const transform = new TransformStream<Uint8Array, Uint8Array>();
  const writer = transform.writable.getWriter();

  const send = (obj: object) =>
    writer.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

  (async () => {
    const wallStart = Date.now();
    try {
      await Promise.all(
        (prompts as string[]).map(async (prompt: string, i: number) => {
          const modelList = models as string[];
          const model = modelList[i % modelList.length];
          const t0 = Date.now();
          try {
            const res = await fetch(`${proxyUrl}/chat/completions`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer none",
              },
              body: JSON.stringify({
                model,
                messages: [{ role: "user", content: prompt }],
                max_tokens: maxTokens,
                temperature,
              }),
              signal: AbortSignal.timeout(180_000),
            });
            const backend =
              res.headers.get("x-litellm-model-api-base") ?? "unknown";
            const data = await res.json();
            if (!res.ok) {
              await send({
                idx: i,
                backend,
                elapsed: Date.now() - t0,
                tokens: 0,
                text: "",
                error: data?.error?.message ?? `HTTP ${res.status}`,
              });
              return;
            }
            await send({
              idx: i,
              model,
              backend,
              elapsed: Date.now() - t0,
              tokens: data.usage?.completion_tokens ?? 0,
              text: data.choices?.[0]?.message?.content?.trim() ?? "",
              error: null,
            });
          } catch (e) {
            await send({
              idx: i,
              model,
              backend: null,
              elapsed: Date.now() - t0,
              tokens: 0,
              text: "",
              error: String(e),
            });
          }
        })
      );
    } finally {
      await send({ done: true, wallMs: Date.now() - wallStart });
      await writer.close();
    }
  })();

  return new Response(transform.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
