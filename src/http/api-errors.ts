import type { FastifyReply, FastifyRequest } from "fastify";
import { AcademicError } from "../domain/academic.js";
import { EventError } from "../domain/events.js";
import { PlanError } from "../domain/plans.js";
import { RevisionHeaderError } from "../domain/revision.js";
import {
  AuthorizationHeaderError,
  UnauthorizedError,
} from "../plugins/auth.js";

export function sendApiError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  let status = 500;
  let code = "internal_error";
  let message = "Internal server error";
  let fields: Record<string, string> | undefined;
  if (
    error instanceof EventError ||
    error instanceof RevisionHeaderError ||
    error instanceof AcademicError ||
    error instanceof PlanError
  ) {
    status = error.statusCode;
    code = error.code;
    message = error.message;
    if (
      error instanceof EventError ||
      error instanceof AcademicError ||
      error instanceof PlanError
    )
      fields = error.fields;
  } else if (
    error instanceof UnauthorizedError ||
    error instanceof AuthorizationHeaderError
  ) {
    status = error.statusCode;
    code = status === 401 ? "unauthorized" : "invalid_request";
    message =
      status === 401
        ? "Authentication required"
        : "Invalid Authorization header";
  } else if (
    error instanceof Error &&
    "statusCode" in error &&
    typeof error.statusCode === "number" &&
    error.statusCode < 500
  ) {
    status = error.statusCode;
    code = "invalid_request";
    message = "Request validation failed";
  } else {
    request.log.error(error);
  }
  const body = {
    error: {
      code,
      message,
      ...(fields ? { fields } : {}),
      requestId: request.id,
    },
  };
  const response = reply
    .code(status)
    .header("content-type", "application/json; charset=utf-8");
  if (error instanceof PlanError && error.retryAfterSeconds !== undefined)
    response.header("retry-after", String(error.retryAfterSeconds));
  return response.send(JSON.stringify(body));
}
