import { requireAuth } from '@/lib/auth';
import { health, store } from '@/lib/store';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const denied = await requireAuth(request);
  if (denied) return denied;

  const encoder = new TextEncoder();
  let listener: ((event: string, data: unknown) => void) | null = null;
  let keepAlive: ReturnType<typeof setInterval> | null = null;

  function cleanUp() {
    if (listener) store.listeners.delete(listener);
    if (keepAlive) clearInterval(keepAlive);
    listener = null;
    keepAlive = null;
  }

  const stream = new ReadableStream({
    start(controller) {
      function write(text: string) {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanUp();
        }
      }

      function send(event: string, data: unknown) {
        write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }

      send('health', health());
      if (store.latest) send('reading', store.latest);

      listener = send;
      store.listeners.add(listener);
      keepAlive = setInterval(() => write(': ping\n\n'), 25000);

      request.signal.addEventListener('abort', () => {
        cleanUp();
        try {
          controller.close();
        } catch {}
      });
    },
    cancel: cleanUp,
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
