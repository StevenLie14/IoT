'use client';

import { useEffect, useState } from 'react';
import { SignedOutError, post } from '@/lib/client/api';
import type { Command, LogEvent, Reading } from '@/lib/client/types';

type Props = {
  reading: Reading | null;
  latestEvent: LogEvent | null;
  deviceOnline: boolean;
};

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

export default function ControlPanel({ reading, latestEvent, deviceOnline }: Props) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [message, setMessage] = useState<Message>({ text: '', kind: '' });

  useEffect(() => {
    if (pending && reading && pending.isDone(reading)) {
      setMessage({ text: pending.doneMessage, kind: 'ok' });
      setPending(null);
    }
  }, [reading, pending]);

  useEffect(() => {
    if (!pending || !latestEvent || latestEvent === pending.eventBefore) return;
    if (pending.confirmedBy(latestEvent)) {
      setMessage({ text: pending.doneMessage, kind: 'ok' });
      setPending(null);
    }
  }, [latestEvent, pending]);

  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => {
      setMessage({ text: 'No response from the ESP32. Check that it is online.', kind: 'error' });
      setPending(null);
    }, RESPONSE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  useEffect(() => {
    if (!message.text || message.kind === 'error') return;
    const timer = setTimeout(() => setMessage({ text: '', kind: '' }), 6000);
    return () => clearTimeout(timer);
  }, [message]);

  async function sendCommand(command: Command) {
    try {
      await post('/api/cmd', command);
      return true;
    } catch (err) {
      if (!(err instanceof SignedOutError)) setMessage({ text: `Could not send: ${(err as Error).message}`, kind: 'error' });
      return false;
    }
  }

  async function request(next: Pending) {
    setPending({ ...next, eventBefore: latestEvent });
    setMessage({ text: 'Sent. Waiting for the ESP32...', kind: '' });
    const sent = await sendCommand(next.command);
    if (!sent) setPending(null);
  }

  async function beep() {
    if (await sendCommand({ cmd: 'beep' })) setMessage({ text: 'Beep sent', kind: 'ok' });
  }

  const isPending = (key: string) => pending?.key === key;
  const disabled = !deviceOnline;
  const changeRunning = WORKING_STATES.includes(reading?.state ?? '');
  const isIdle = !reading || reading.state === 'idle';
  const tankFull = Boolean(reading?.f_top);
  const tankLow = Boolean(reading?.f_bot);

  const autoOn = pending?.key === 'auto' ? Boolean(pending.command.on) : Boolean(reading?.auto);
  const demoOn = pending?.key === 'demo' ? Boolean(pending.command.on) : Boolean(reading?.demo);

  function actuatorState(isOn: boolean | undefined, waitingKey: string) {
    if (isPending(waitingKey)) return { className: 'actuator waiting', text: 'Starting' };
    if (!reading) return { className: 'actuator', text: '--' };
    return { className: isOn ? 'actuator on' : 'actuator', text: isOn ? 'On' : 'Off' };
  }

  const drain = actuatorState(Boolean(reading?.drain), 'drain');
  const fill = actuatorState(Boolean(reading?.fill), 'fill');
  const buzzerOn = Boolean(reading?.buzzer);

  const stateClass = WORKING_STATES.includes(reading?.state ?? '') ? 'actuator on' : 'actuator';

  return (
    <div className="panel">
      <header>
        <h2>Control</h2>
      </header>
      <div className="body">
        <div className="actuators">
          <div className={drain.className}>
            <span>Drain pump</span>
            <strong><i className="dot" /><b>{drain.text}</b></strong>
          </div>
          <div className={fill.className}>
            <span>Fill pump</span>
            <strong><i className="dot" /><b>{fill.text}</b></strong>
          </div>
          <div className={buzzerOn ? 'actuator on' : 'actuator'}>
            <span>Buzzer</span>
            <strong><i className="dot" /><b>{reading ? (buzzerOn ? 'On' : 'Off') : '--'}</b></strong>
          </div>
          <div className={stateClass}>
            <span>State</span>
            <strong><b>{reading?.state || '--'}</b></strong>
          </div>
        </div>

        {!deviceOnline && (
          <div className="offline-note">
            The ESP32 is offline, so commands are disabled. The status above updates as soon as it reconnects.
          </div>
        )}

        <div className="control-group">
          <span className="title">Water change</span>
          <div className="row">
            <button className={`btn ${isPending('change') ? 'is-pending' : ''}`} disabled={disabled || !!pending || changeRunning}
              onClick={() => request(changeRequest)}>
              Start water change
            </button>
            <button className={`btn danger ${isPending('stop') ? 'is-pending' : ''}`} disabled={disabled}
              onClick={() => request(stopRequest)}>
              Stop
            </button>
          </div>
        </div>

        <div className="control-group">
          <span className="title">Mode</span>
          <div className="row" style={{ gap: 24 }}>
            <label className={`switch ${isPending('auto') ? 'is-pending' : ''}`}>
              <input type="checkbox" checked={autoOn} disabled={disabled || isPending('auto')}
                onChange={(event) => request(modeRequest('auto', event.target.checked))} />
              <i />
              Automatic water change
            </label>
            <label className={`switch ${isPending('demo') ? 'is-pending' : ''}`}>
              <input type="checkbox" checked={demoOn} disabled={disabled || isPending('demo')}
                onChange={(event) => request(modeRequest('demo', event.target.checked))} />
              <i />
              Demo timing
            </label>
          </div>
        </div>

        <div className="control-group">
          <span className="title">Test</span>
          <div className="row">
            <button className={`btn ${isPending('drain') ? 'is-pending' : isIdle && reading?.drain ? 'active' : ''}`}
              disabled={disabled || !!pending || !isIdle || tankLow} onClick={() => request(testRequest('drain'))}
              title={tankLow ? 'Bottom float reached: the tank is already low' : undefined}>
              {isPending('drain') ? 'Starting drain' : 'Run drain 3 s'}
            </button>
            <button className={`btn ${isPending('fill') ? 'is-pending' : isIdle && reading?.fill ? 'active' : ''}`}
              disabled={disabled || !!pending || !isIdle || tankFull} onClick={() => request(testRequest('fill'))}
              title={tankFull ? 'Top float reached: the tank is already full' : undefined}>
              {isPending('fill') ? 'Starting fill' : 'Run fill 3 s'}
            </button>
            <button className="btn quiet" disabled={disabled} onClick={beep}>
              Beep
            </button>
          </div>
          <div className="row">
            <button className={`btn ${isPending('drain_float') ? 'is-pending' : ''}`}
              disabled={disabled || !!pending || !isIdle || tankLow} onClick={() => request(testRequest('drain', true))}
              title={tankLow ? 'Bottom float reached: the tank is already low' : 'Run the drain pump until the bottom float'}>
              {isPending('drain_float') ? 'Starting drain' : 'Drain to bottom float'}
            </button>
            <button className={`btn ${isPending('fill_float') ? 'is-pending' : ''}`}
              disabled={disabled || !!pending || !isIdle || tankFull} onClick={() => request(testRequest('fill', true))}
              title={tankFull ? 'Top float reached: the tank is already full' : 'Run the fill pump until the top float'}>
              {isPending('fill_float') ? 'Starting fill' : 'Fill to top float'}
            </button>
          </div>
          {isIdle && (tankFull || tankLow) && (
            <p className="help">
              {tankFull ? 'Fill is off: the top float says the tank is full.' : 'Drain is off: the bottom float says the tank is low.'}
            </p>
          )}
        </div>

        <div className={`feedback ${message.kind}`} role="status" aria-live="polite">
          {message.text}
        </div>
      </div>
    </div>
  );
}
