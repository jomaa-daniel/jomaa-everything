import type { IncomingMessage } from "node:http";

/** The bounded bytes of a request, shared by authorization and its handler. */
const bodies = new WeakMap<IncomingMessage, Promise<Buffer>>();

export class BodyLimitError extends Error {}

export async function requestBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  let pending = bodies.get(req);
  if (!pending) {
    pending = (async () => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > limit) throw new BodyLimitError("request body too large");
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    })();
    bodies.set(req, pending);
  }
  const bytes = await pending;
  if (bytes.length > limit) throw new BodyLimitError("request body too large");
  return bytes;
}
