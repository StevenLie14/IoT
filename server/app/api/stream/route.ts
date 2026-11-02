// Live updates for the dashboard (Server-Sent Events)
import { requireAuth } from '@/lib/auth';
import { health, store } from '@/lib/store';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
  const denied = await requireAuth(req); if (denied) return denied;
  const enc = new TextEncoder();
  let listener: ((event: string, data: unknown) => void) | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (listener) store.listeners.delete(listener);
    if (ping) clearInterval(ping);
    listener = null; ping = null;
  };
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try { controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { stop(); }
      };
      send('health', health());
      if (store.latest) send('reading', store.latest);
      listener = send;
      store.listeners.add(listener);
      ping = setInterval(() => { try { controller.enqueue(enc.encode(': ping\n\n')); } catch { stop(); } }, 25000);
      req.signal.addEventListener('abort', () => { stop(); try { controller.close(); } catch { /* already closed */ } });
    },
    cancel: stop,
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',   // stops Nginx from holding back the live events
    },
  });
}
