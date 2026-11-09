export class GatewayError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly type = 'invalid_request_error',
  ) {
    super(message);
  }
}

export function errorBody(error: GatewayError, requestId: string) {
  return {
    error: {
      message: error.message,
      type: error.type,
      code: error.code,
      request_id: requestId,
    },
  };
}

export function normalizeError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  const code = (error as { code?: string })?.code;
  if (code === 'FST_ERR_CTP_BODY_TOO_LARGE')
    return new GatewayError(
      413,
      'request_too_large',
      'Request body exceeds the configured limit',
    );
  if (code?.startsWith('FST_ERR_CTP_') || error instanceof SyntaxError)
    return new GatewayError(
      400,
      'invalid_request',
      'Expected a valid JSON request body',
    );
  return new GatewayError(
    500,
    'internal_error',
    'Internal server error',
    'server_error',
  );
}
