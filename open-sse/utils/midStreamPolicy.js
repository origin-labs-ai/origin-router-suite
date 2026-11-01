// What a stream that dies AFTER `HTTP 200` was already sent should tell the client.
//
// The status code can no longer change, so the only choices are an error frame or
// a clean terminal frame. The owner's rule for this gateway is that a client must
// never receive an API error: a truncated-but-valid answer beats an exception that
// aborts an agent run (and beats a classifier that then reports the model as
// unavailable). The operator can flip it back to the strict behaviour from Settings.
let silent = true;

export function setMidStreamSilent(value) {
  silent = value === true;
}

export function isMidStreamSilent() {
  return silent;
}
