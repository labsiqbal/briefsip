import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startAudioRecording } from './src/audio-recording.ts';

test('microphone lifecycle stops tracks, rejects oversized data and drops late permission after cancellation', async t => {
  const saved = new Map(['MediaRecorder','navigator','isSecureContext'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis,key)]));
  let trackStops = 0, resolvePermission!: (stream: MediaStream) => void, failStart = false;
  const stream = { getTracks: () => [{ stop: () => { trackStops++; } }] } as unknown as MediaStream;
  class Recorder {
    static last: Recorder;
    static isTypeSupported(type: string) { return type === 'audio/webm;codecs=opus'; }
    state = 'inactive'; mimeType = 'audio/webm;codecs=opus';
    ondataavailable?: (event: {data: Blob}) => void;
    onstop?: () => void; onerror?: () => void;
    constructor() { Recorder.last = this; }
    start() { if (failStart) throw new Error('start'); this.state = 'recording'; }
    stop() { this.state = 'inactive'; queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(['final']) }); this.onstop?.(); }); }
  }
  Object.defineProperty(globalThis,'MediaRecorder',{ configurable:true,value:Recorder });
  Object.defineProperty(globalThis,'isSecureContext',{ configurable:true,value:true });
  Object.defineProperty(globalThis,'navigator',{ configurable:true,value:{ mediaDevices:{ getUserMedia: (constraints: unknown) => { assert.deepEqual(constraints,{audio:true,video:false}); return new Promise<MediaStream>(resolve => { resolvePermission = resolve; }); } } } });
  const files: File[] = [], errors: string[] = [], states: string[] = [];
  const tick = () => new Promise(resolve => setImmediate(resolve));
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const late = startAudioRecording(state => states.push(state), file => files.push(file), error => errors.push(error));
    late.cancel(); resolvePermission(stream); await tick(); assert.equal(trackStops,1); assert.equal(files.length,0);
    const session = startAudioRecording(state => states.push(state), file => files.push(file), error => errors.push(error));
    resolvePermission(stream); await tick(); assert.equal(states.at(-1),'recording');
    Recorder.last.ondataavailable?.({data:new Blob(['first'])}); session.stop(); await tick();
    assert.equal(files.length,1); assert.equal(await files[0].text(),'firstfinal'); assert.match(files[0].name,/^Voice note \d+:\d{2}\.webm$/); assert.equal(states.at(-1),'idle'); assert(trackStops >= 2);
    startAudioRecording(state => states.push(state), file => files.push(file), error => errors.push(error)); resolvePermission(stream); await tick();
    Recorder.last.ondataavailable?.({data:new Blob([new Uint8Array(10*1024*1024+1)])}); await tick();
    assert.equal(files.length,1); assert.match(errors.at(-1)!,/10 MiB/); assert.equal(Recorder.last.state,'inactive');
    failStart = true;
    const before = trackStops;
    startAudioRecording(state => states.push(state), file => files.push(file), error => errors.push(error)); resolvePermission(stream); await tick();
    assert(trackStops > before); assert.equal(states.at(-1),'idle'); assert.equal(files.length,1);
    failStart = false;
    startAudioRecording(state => states.push(state), file => files.push(file), error => errors.push(error)); resolvePermission(stream); await tick();
    t.mock.timers.tick(5 * 60 * 1000); await tick(); assert.equal(files.length,2); assert.equal(states.at(-1),'idle');
    const discard = startAudioRecording(state => states.push(state), file => files.push(file), error => errors.push(error)); resolvePermission(stream); await tick();
    Recorder.last.ondataavailable?.({data:new Blob(['discard'])}); discard.cancel(); await tick(); assert.equal(files.length,2);
  } finally { for (const [key,value] of saved) { if(value) Object.defineProperty(globalThis,key,value); else Reflect.deleteProperty(globalThis,key); } }
});
