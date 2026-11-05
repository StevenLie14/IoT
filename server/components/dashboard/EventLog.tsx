import { formatTime } from '@/lib/client/format';
import type { LogEvent } from '@/lib/client/types';

function describe(event: LogEvent) {
  return [event.name, event.value, event.detail]
    .filter((part) => part !== null && part !== undefined && part !== '')
    .join(' · ');
}

export default function EventLog({ events }: { events: LogEvent[] }) {
  return (
    <section className="panel">
      <header>
        <h2>Event log</h2>
        <span className="muted">{events.length > 0 ? `latest ${events.length}` : ''}</span>
      </header>
      <div className="log">
        <table>
          <tbody>
            {events.length === 0 && (
              <tr>
                <td className="empty" colSpan={3}>No events yet.</td>
              </tr>
            )}
            {events.map((event, index) => (
              <tr key={`${event.epoch}-${index}`}>
                <td className="time">{formatTime(event.epoch)}</td>
                <td className="type"><span className={`t-${event.type}`}>{event.type}</span></td>
                <td>{describe(event)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
