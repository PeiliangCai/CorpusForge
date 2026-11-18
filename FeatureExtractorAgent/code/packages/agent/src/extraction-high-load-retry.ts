import { setTimeout as delay } from 'node:timers/promises';
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent,
  type AssistantMessageEventStream } from '@earendil-works/pi-ai';

export const PROVIDER_HIGH_LOAD_MESSAGE = 'Service load is too high, please try again later';

/** Retry only this unanswered physical response, before exposing any output to Pi.
 * Previously completed tool results remain in the same immutable request context.
 * The caller owns the shared retry allowance and every physical request budget.
 */
export async function retryUnansweredHighLoadResponse(
  request: () => AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
  options: { canRetry: () => boolean; onRetry: (error: AssistantMessage) => void;
    delayMs: () => number; signal?: AbortSignal },
): Promise<AssistantMessageEventStream> {
  let source = await request();
  const output = createAssistantMessageEventStream();
  void (async () => {
    let lastError: Extract<AssistantMessageEvent, { type: 'error' }> | undefined;
    try {
      while (true) {
        const pending: AssistantMessageEvent[] = [];
        let forwarded = false, retry = false;
        for await (const event of source) {
          if (event.type === 'start' && !forwarded) { pending.push(event); continue; }
          if (event.type === 'error' && !forwarded && event.error.errorMessage === PROVIDER_HIGH_LOAD_MESSAGE &&
              !options.signal?.aborted && options.canRetry()) {
            lastError = event; options.onRetry(event.error);
            await delay(options.delayMs(), undefined, { signal: options.signal });
            retry = true; break;
          }
          if (!forwarded) { pending.forEach(item => output.push(item)); forwarded = true; }
          output.push(event);
        }
        if (retry) { source = await request(); continue; }
        output.end(await source.result()); return;
      }
    } catch {
      // A budget stop or cancellation during a retry must never issue another
      // request. Its authoritative code remains in the budget/abort signal.
      if (lastError) output.push(lastError);
      output.end(lastError?.error ?? await source.result());
    }
  })();
  return output;
}
