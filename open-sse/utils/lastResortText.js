/**
 * The text of the last-resort completion the resilience layer answers with when no
 * provider served a request.
 *
 * It lives in its own module with no imports because three places need to agree on
 * the exact string: the router that emits it, the chat handler that passes it in,
 * and the dashboard model test that must recognise it and report failure. A model
 * test that counted this sentence as a normal answer would report a model nothing
 * served as working.
 */
export const LAST_RESORT_TEXT =
  "OriginRouter could not reach any provider for this request just now. " +
  "Send it again and it will be routed to whichever seat is free.";
