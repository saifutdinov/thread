import type { Mic } from './mic';

export type MicRequest = {
  controller: AbortController;
  raw?: MediaStreamTrack;
  mic?: Mic;
  committing?: boolean;
};

// Calls keep their own pending sets and committing rules. Only cancellation
// of the request's owned resources is shared; it also works before preparation.
export function cancelMicRequest(request: MicRequest) {
  request.controller.abort();
  request.raw?.stop();
  request.mic?.close();
}
