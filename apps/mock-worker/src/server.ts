import Fastify from 'fastify';
const app = Fastify({ logger: true });
app.get('/health', async () => ({ ok: true }));
app.get('/v1/models', async () => ({
  object: 'list',
  data: [{ id: 'mock-model', object: 'model' }],
}));
app.post('/v1/chat/completions', async (request) => {
  const body = request.body as {
    model?: string;
    messages?: Array<{ content: string }>;
  };
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
