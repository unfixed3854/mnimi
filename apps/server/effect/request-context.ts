import { Context } from "effect";

export type RequestContextValue = {
  readonly headers: Headers;
  readonly userId?: string;
  readonly requestId: string;
  readonly signal: AbortSignal;
};

export class RequestContext extends Context.Tag(
  "@mnimi/server/RequestContext",
)<RequestContext, RequestContextValue>() {}
