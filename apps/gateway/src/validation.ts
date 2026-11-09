import { z } from 'zod';
import {
  requestExtensionsSchema,
  type RequestExtensions,
} from '@gateway/shared';
import type { IncomingHttpHeaders } from 'node:http';
import { GatewayError } from './errors.js';

// Validate the envelope while retaining new SDK fields, tool messages and multimodal parts.
const messageSchema = z
  .object({
    role: z.enum([
      'system',
      'developer',
      'user',
      'assistant',
      'tool',
      'function',
    ]),
    content: z
      .union([
        z.string(),
        z.array(z.object({ type: z.string().min(1) }).passthrough()),
        z.null(),
      ])
      .optional(),
    tool_calls: z.array(z.object({}).passthrough()).optional(),
    function_call: z.object({}).passthrough().optional(),
  })
  .passthrough()
  .superRefine((message, ctx) => {
    if (
      message.content === undefined &&
      message.tool_calls === undefined &&
      message.function_call === undefined
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['content'],
        message: 'Content or a tool/function call is required',
      });
  });

export const chatBodySchema = z
  .object({
    model: z
      .string()
      .min(1)
      .refine((value) => value.trim().length > 0),
    messages: z.array(messageSchema).nonempty(),
    stream: z.boolean().optional(),
    // Validate gateway separately so a header can override the corresponding body value.
    gateway: z.record(z.unknown()).optional(),
  })
  .passthrough();
export type ChatBody = z.infer<typeof chatBodySchema>;

export function validateChatBody(body: unknown, maxMessages: number): ChatBody {
  const result = chatBodySchema.safeParse(body);
  if (!result.success)
    throw new GatewayError(
      400,
      'invalid_request',
      result.error.issues
        .map((issue) => `${issue.path.join('.') || '<body>'}: ${issue.message}`)
        .join('; '),
    );
  if (result.data.messages.length > maxMessages)
    throw new GatewayError(
      413,
      'request_too_large',
      `messages exceeds the limit of ${maxMessages}`,
    );
  return result.data;
}

export function normalizeExtensions(
  body: Pick<ChatBody, 'gateway'>,
  headers: IncomingHttpHeaders,
): RequestExtensions {
  const extensions: Record<string, unknown> = { ...body.gateway };
  const names = {
    priority: 'priority',
    task: 'task',
    cache: 'cache',
    timeoutMs: 'timeout-ms',
    routing: 'routing',
  } as const;
  for (const [field, suffix] of Object.entries(names)) {
    const header = headers[`x-gateway-${suffix}`];
    if (header === undefined) continue;
    if (typeof header !== 'string')
      throw new GatewayError(
        400,
        'invalid_request',
        `x-gateway-${suffix}: expected a single value`,
      );
    extensions[field] =
      field === 'timeoutMs' && /^[0-9]+$/.test(header)
        ? Number(header)
        : header;
  }
  const result = requestExtensionsSchema.safeParse(extensions);
  if (!result.success)
    throw new GatewayError(
      400,
      'invalid_request',
      result.error.issues
        .map((issue) => `gateway.${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    );
  if (
    result.data.timeoutMs !== undefined &&
    !Number.isSafeInteger(result.data.timeoutMs)
  )
    throw new GatewayError(
      400,
      'invalid_request',
      'gateway.timeoutMs: expected a safe integer',
    );
  return result.data;
}
