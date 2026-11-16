import Fastify from 'fastify';
import { Readable } from 'node:stream';
const app = Fastify({ logger: true });
app.get('/health', async () => ({ ok: true }));
app.get('/v1/models', async () => ({
  object: 'list',
  data: [{ id: 'mock-model', object: 'model' }],
}));
app.post('/v1/chat/completions', async (request, reply) => {
  const body = request.body as {
    model?: string;
    stream?: boolean;
    stream_options?: { include_usage?: boolean };
    messages?: Array<{ content: string }>;
  };
  if (body.stream) {
    const base = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? 'mock-model',
    };
    async function* chunks() {
      const event = (choices: unknown[], usage?: unknown) =>
        `data: ${JSON.stringify({ ...base, choices, ...(usage ? { usage } : {}) })}\n\n`;
      yield event([
        { index: 0, delta: { role: 'assistant' }, finish_reason: null },
      ]);
      yield event([
        {
          index: 0,
          delta: {
            content: body.messages?.at(-1)?.content ?? 'Hello from mock worker',
          },
          finish_reason: null,
        },
      ]);
      yield event([{ index: 0, delta: {}, finish_reason: 'stop' }]);
      if (body.stream_options?.include_usage)
        yield event([], {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
        });
      yield 'data: [DONE]\n\n';
    }
    return reply.type('text/event-stream').send(Readable.from(chunks()));
  }
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    model: body.model ?? 'mock-model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: body.messages?.at(-1)?.content ?? 'Hello from mock worker',
        },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
});
await app.listen({ port: Number(process.env.PORT ?? 8081), host: '0.0.0.0' });
