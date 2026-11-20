import { canonicalJson, closedObject, digestCommand, existingRevision, id, ProtocolError, revision, sha256 } from '../shared/protocol.ts';

export type Ownership = { authorityGeneration: string; deviceGeneration: number; taskId: string; executorGeneration: number };

export type ActionContext = { snapshotRef: { v: 1; taskId: string; snapshotId: string; revision: number; digest: string }; snapshot: Record<string,unknown> & { taskRevision: number } };

export type ResultRef = { v: 1; taskId: string; actionId: string; digest: string; size: number; encoding: 'canonical-json-v1' };

export function canonicalToolDigest(value: unknown) {
  const payload = closedObject(value, ['toolCall','expectedRevision','fileInput'], 'CanonicalTool');
  const call = closedObject(payload.toolCall, ['id','function'], 'toolCall'), fn = closedObject(call.function, ['name','arguments'], 'toolCall.function');
  if (typeof call.id !== 'string' || !call.id || call.id.length > 200 || /[\u0000-\u001f\u007f]/.test(call.id) || typeof fn.name !== 'string' || !fn.name || fn.name.length > 160 || typeof fn.arguments !== 'string' || fn.arguments.length > 20000) throw new ProtocolError(400, 'invalid_tool_call', 'Invalid tool call.');
  revision(payload.expectedRevision, 'expectedRevision');
  return digestCommand(['minarbot-canonical-tool-v1', call, payload.expectedRevision, payload.fileInput ?? null]);
}

export type JournalEntry = {
  taskId: string; actionId: string; sequence: number; executorGeneration: number; actionKind: string;
  payloadDigest: string; intentDigest: string; bindingId?: string; bindingRevision?: number; grantRevision: number;
  state: string; effectStatus: string; resultDigest?: string; resultRef?: ResultRef; journalSequence: number;
};

export function journalEntryBody(sourceAuthority: string, sourceDeviceId: string, sourceDeviceGeneration: number, entry: JournalEntry) {
  return ['minarbot-journal-entry-v1',sourceAuthority,sourceDeviceId,sourceDeviceGeneration,entry.taskId,entry.actionId,entry.sequence,entry.executorGeneration,entry.actionKind,entry.payloadDigest,entry.intentDigest,entry.bindingId??null,entry.bindingRevision??null,entry.grantRevision,entry.state,entry.effectStatus,entry.resultDigest??null,entry.resultRef??null,entry.journalSequence];
}

export function reconcileCommandDigest(taskId:string,body:Record<string,unknown>) {
  return digestCommand(['minarbot-task-reconcile-v1',taskId,{requestId:body.requestId,actionId:body.actionId,ownership:body.ownership,payloadDigest:body.payloadDigest,state:body.state,effectStatus:body.effectStatus,journalSequence:body.journalSequence,resultDigest:body.resultDigest??null,resultRef:body.resultRef??null,uncertainReason:body.uncertainReason??null,resultContentDigest:body.resultContentDigest??(body.resultContent===undefined?null:sha256(canonicalJson(body.resultContent))),noMarkerEvidence:body.noMarkerEvidence??null,stopEvidence:body.stopEvidence??null}]);
}

export type StopEvidence = {
  v: 1; sourceAuthority: string; taskId: string; actionId: string; sourceDeviceId: string; sourceDeviceGeneration: number; executorGeneration: number;
  bootId: string; processId: number; processStart: string; lockId: string; observationBootId: string; observation: 'process_exited' | 'boot_changed';
  children: { processId: number; processStart: string; processGroupId: number }[]; observedAt: number; journalDigest: string; signature: string;
};

export function stopEvidenceBody(stop: Omit<StopEvidence, 'signature'>) {
  return ['minarbot-stop-evidence-v1',stop.sourceAuthority,stop.taskId,stop.actionId,stop.sourceDeviceId,stop.sourceDeviceGeneration,stop.executorGeneration,stop.bootId,stop.processId,stop.processStart,stop.lockId,stop.observationBootId,stop.observation,stop.children.map(child=>[child.processId,child.processStart,child.processGroupId]),stop.observedAt,stop.journalDigest];
}

export function recoveryEnvelopeBody(recoveryGeneration: string, requestId: string, envelope: { sourceAuthority: string; sourceDeviceId: string; sourceDeviceGeneration: number; watermark: number; entries: (JournalEntry & { signature: string })[]; stopEvidence: StopEvidence[] }) {
  return ['minarbot-recovery-envelope-v1', recoveryGeneration, requestId, envelope.sourceAuthority, envelope.sourceDeviceId, envelope.sourceDeviceGeneration, envelope.watermark,
    envelope.entries.map(entry => [entry.taskId,entry.actionId,entry.sequence,entry.executorGeneration,entry.actionKind,entry.payloadDigest,entry.intentDigest,entry.bindingId??null,entry.bindingRevision??null,entry.grantRevision,entry.state,entry.effectStatus,entry.resultDigest??null,entry.resultRef??null,entry.journalSequence,entry.signature]),
    envelope.stopEvidence.map(stop => [stop.taskId,stop.actionId,stop.journalDigest,stop.signature])];
}

export function parseOwnership(value: unknown): Ownership {
  const d = closedObject(value, ['authorityGeneration','deviceGeneration','taskId','executorGeneration']);
  return { authorityGeneration: id(d.authorityGeneration), deviceGeneration: existingRevision(d.deviceGeneration), taskId: id(d.taskId), executorGeneration: existingRevision(d.executorGeneration) };
}
