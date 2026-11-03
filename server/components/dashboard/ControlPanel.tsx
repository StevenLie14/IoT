'use client';

import { useEffect, useState } from 'react';
import { SignedOutError, post } from '@/lib/client/api';
import type { Command, LogEvent, Reading } from '@/lib/client/types';

type Props = {
  reading: Reading | null;
  latestEvent: LogEvent | null;
  deviceOnline: boolean;
};

// A command waiting for the ESP32 to confirm it, either by a new reading (isDone)
// or by a matching event (confirmedBy), within RESPONSE_TIMEOUT_MS
type Pending = {
  key: string;
  command: Command;
  isDone: (reading: Reading) => boolean;
  confirmedBy: (event: LogEvent) => boolean;
  doneMessage: string;
  eventBefore?: LogEvent | null;
};

type Message = { text: string; kind: 'ok' | 'error' | '' };

const RESPONSE_TIMEOUT_MS = 10000;
const WORKING_STATES = ['draining', 'settling', 'filling'];

const changeRequest: Pending = {
  key: 'change',
  command: { cmd: 'change' },
  isDone: (reading) => WORKING_STATES.includes(reading.state ?? ''),
  confirmedBy: (event) => event.type === 'state' && WORKING_STATES.includes(event.name ?? ''),
  doneMessage: 'Water change is running',
};

// Manual pump test: 3 s run, or until the float when toFloat is true
function testRequest(pump: 'drain' | 'fill', toFloat = false): Pending {
  const target = pump === 'drain' ? 'the bottom float' : 'the top float';
  return {
    key: toFloat ? `${pump}_float` : pump,
    command: toFloat ? { cmd: `${pump}_float` } : { cmd: pump, sec: 3 },
    isDone: (reading) => reading[pump] === 1,
    confirmedBy: (event) => event.type === 'actuator' && event.name === pump && event.value === 1,
    doneMessage: `${pump === 'drain' ? 'Drain' : 'Fill'} pump is running${toFloat ? ` until ${target}` : ''}`,
  };
}

// Turns automatic water change or demo timing on/off
function modeRequest(mode: 'auto' | 'demo', on: boolean): Pending {
  return {
    key: mode,
    command: { cmd: mode, on },
    isDone: (reading) => Boolean(reading[mode]) === on,
    confirmedBy: (event) => event.type === 'mode' && event.name === mode && Boolean(event.value) === on,
    doneMessage: `${mode === 'auto' ? 'Automatic water change' : 'Demo timing'} is ${on ? 'on' : 'off'}`,
  };
}

const stopRequest: Pending = {
  key: 'stop',
  command: { cmd: 'stop' },
  isDone: (reading) => !reading.drain && !reading.fill,
  confirmedBy: (event) => event.type === 'state' && event.name === 'idle',
  doneMessage: 'Pumps stopped',
};

// Device controls: water change, stop, modes, and the maintenance pump tests
export default function ControlPanel({ reading, latestEvent, deviceOnline }: Props) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [message, setMessage] = useState<Message>({ text: '', kind: '' });

  // A pending command is confirmed by a new reading...
  useEffect(() => {
    if (pending && reading && pending.isDone(reading)) {
      setMessage({ text: pending.doneMessage, kind: 'ok' });
      setPending(null);
    }
  }, [reading, pending]);

  // ...or by a matching event, which usually arrives first
  useEffect(() => {
    if (!pending || !latestEvent || latestEvent === pending.eventBefore) return;
    if (pending.confirmedBy(latestEvent)) {
      setMessage({ text: pending.doneMessage, kind: 'ok' });
      setPending(null);
    }
  }, [latestEvent, pending]);

  // No confirmation in time: give up and tell the user
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => {
      setMessage({ text: 'No response from the ESP32. Check that it is online.', kind: 'error' });
      setPending(null);
    }, RESPONSE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  // Success messages disappear after 6 s; errors stay until the next action
  useEffect(() => {
    if (!message.text || message.kind === 'error') return;
    const timer = setTimeout(() => setMessage({ text: '', kind: '' }), 6000);
    return () => clearTimeout(timer);
  }, [message]);

  // Sends a command through /api/cmd; returns false and shows an error if it fails
  async function sendCommand(command: Command) {
    try {
      await post('/api/cmd', command);
      return true;
    } catch (err) {
      if (!(err instanceof SignedOutError)) {
        setMessage({ text: `Could not send: ${(err as Error).message}`, kind: 'error' });
      }
      return false;
    }
  }

  // Sends a command and waits for the device to confirm it (see Pending)
  async function request(next: Pending) {
    setPending({ ...next, eventBefore: latestEvent });
    setMessage({ text: 'Sent. Waiting for the ESP32...', kind: '' });
    const sent = await sendCommand(next.command);
    if (!sent) setPending(null);
  }

  // The buzzer is not reported back, so a beep is not tracked as pending
  async function beep() {
    const sent = await sendCommand({ cmd: 'beep' });
    if (sent) setMessage({ text: 'Beep sent', kind: 'ok' });
  }

  const isPending = (key: string) => pending?.key === key;
  const disabled = !deviceOnline;
  const changeRunning = WORKING_STATES.includes(reading?.state ?? '');
  const isIdle = !reading || reading.state === 'idle';
  const tankFull = Boolean(reading?.f_top);
  const tankLow = Boolean(reading?.f_bot);

  // Pump tests only when the device is online, idle and not busy with another command
  const canTest = !disabled && !pending && isIdle;
  const canDrain = canTest && !tankLow;
  const canFill = canTest && !tankFull;
  const lowTitle = 'Bottom float reached: the tank is already low';
  const fullTitle = 'Top float reached: the tank is already full';

  // While a mode change is pending, show the switch in its new position already
  const autoOn = isPending('auto') ? Boolean(pending?.command.on) : Boolean(reading?.auto);
  const demoOn = isPending('demo') ? Boolean(pending?.command.on) : Boolean(reading?.demo);

  // CSS class for a button: dims it while its command is pending
  function buttonClass(key: string, extra = '') {
    return ['btn', extra, isPending(key) ? 'is-pending' : ''].filter(Boolean).join(' ');
  }

  // One plain status line: quiet when nothing runs, highlighted when something does
  function statusLine() {
    if (!reading) return { text: 'Waiting for data', active: false };

    const parts: string[] = [];
    if (changeRunning) parts.push(`Water change: ${reading.state}`);

    if (isPending('drain') || isPending('drain_float')) parts.push('Starting drain pump');
    else if (reading.drain) parts.push('Drain pump running');

    if (isPending('fill') || isPending('fill_float')) parts.push('Starting fill pump');
    else if (reading.fill) parts.push('Fill pump running');

    if (reading.buzzer) parts.push('Buzzer on');

    if (parts.length === 0) return { text: 'Pumps idle', active: false };
    return { text: parts.join(' · '), active: true };
  }

  const status = statusLine();

  return (
    <div className="panel">
      <header>
        <h2>Control</h2>
      </header>
      <div className="body">
        <p className={`status-line ${status.active ? 'active' : ''}`}>
          <i className="dot" />{status.text}
        </p>

        {!deviceOnline && (
          <div className="offline-note">
            The ESP32 is offline, so commands are disabled. The status above updates as soon as it reconnects.
          </div>
        )}

        <div className="control-group">
          <span className="title">Water change</span>
          <div className="row">
            <button
              className={buttonClass('change')}
              disabled={disabled || !!pending || changeRunning}
              onClick={() => request(changeRequest)}
            >
              Start water change
            </button>
            <button
              className={buttonClass('stop', 'danger')}
              disabled={disabled}
              onClick={() => request(stopRequest)}
            >
              Stop
            </button>
          </div>
        </div>

        <div className="control-group">
          <span className="title">Mode</span>
          <div className="row" style={{ gap: 24 }}>
            <label className={`switch ${isPending('auto') ? 'is-pending' : ''}`}>
              <input
                type="checkbox"
                checked={autoOn}
                disabled={disabled || isPending('auto')}
                onChange={(event) => request(modeRequest('auto', event.target.checked))}
              />
              <i />
              Automatic water change
            </label>
            <label className={`switch ${isPending('demo') ? 'is-pending' : ''}`}>
              <input
                type="checkbox"
                checked={demoOn}
                disabled={disabled || isPending('demo')}
                onChange={(event) => request(modeRequest('demo', event.target.checked))}
              />
              <i />
              Demo timing
            </label>
          </div>
        </div>

        <details className="maintenance">
          <summary>Maintenance and pump tests</summary>
          <div className="row">
            <button
              className={buttonClass('drain', isIdle && reading?.drain ? 'active' : '')}
              disabled={!canDrain}
              onClick={() => request(testRequest('drain'))}
              title={tankLow ? lowTitle : undefined}
            >
              {isPending('drain') ? 'Starting drain' : 'Run drain 3 s'}
            </button>
            <button
              className={buttonClass('fill', isIdle && reading?.fill ? 'active' : '')}
              disabled={!canFill}
              onClick={() => request(testRequest('fill'))}
              title={tankFull ? fullTitle : undefined}
            >
              {isPending('fill') ? 'Starting fill' : 'Run fill 3 s'}
            </button>
            <button className="btn quiet" disabled={disabled} onClick={beep}>
              Beep
            </button>
          </div>
          <div className="row">
            <button
              className={buttonClass('drain_float')}
              disabled={!canDrain}
              onClick={() => request(testRequest('drain', true))}
              title={tankLow ? lowTitle : 'Run the drain pump until the bottom float'}
            >
              {isPending('drain_float') ? 'Starting drain' : 'Drain to bottom float'}
            </button>
            <button
              className={buttonClass('fill_float')}
              disabled={!canFill}
              onClick={() => request(testRequest('fill', true))}
              title={tankFull ? fullTitle : 'Run the fill pump until the top float'}
            >
              {isPending('fill_float') ? 'Starting fill' : 'Fill to top float'}
            </button>
          </div>
          {isIdle && tankFull && <p className="help">Fill is off: the top float says the tank is full.</p>}
          {isIdle && !tankFull && tankLow && <p className="help">Drain is off: the bottom float says the tank is low.</p>}
        </details>

        <div className={`feedback ${message.kind}`} role="status" aria-live="polite">
          {message.text}
        </div>
      </div>
    </div>
  );
}
