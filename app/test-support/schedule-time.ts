import { ProtocolError } from '../shared/protocol.ts';

const hour = 3600000;
const minute = 60000, day = 86400000;
export const maxScheduleTime = 253370764799999;
function zoneClock(zone: string) {
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
  catch { throw new ProtocolError(422, 'schedule_zone_invalid', 'Invalid home device time zone.'); }
  return (at: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(at).map(part => [part.type, part.value]));
    return Date.UTC(Number(parts.year), Number(parts.month)-1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  };
}

export function onceCandidate(spec: { date: string; time: string }, zone: string) {
  const wanted = Date.parse(`${spec.date}T${spec.time}:00.000Z`), local = zoneClock(zone);
  const offset = (at: number) => local(at) - Math.floor(at/1000)*1000;
  const offsets = new Set<number>(), gaps: { at: number; before: number; after: number }[] = [];
  // Four days cover IANA offsets, folds and whole-date skips around this wall time.
  let previousAt = wanted-48*hour, previousOffset = offset(previousAt); offsets.add(previousOffset);
  for (let at = previousAt+6*hour; at <= wanted+48*hour; at += 6*hour) {
    const currentOffset = offset(at); offsets.add(currentOffset);
    if (currentOffset !== previousOffset) {
      let low = previousAt, high = at;
      while (high-low > 1000) {
        const middle = Math.floor((low+high)/2000)*1000;
        if (offset(middle) === previousOffset) low=middle; else high=middle;
      }
      gaps.push({ at: high, before: local(high-1000), after: local(high) });
    }
    previousAt=at; previousOffset=currentOffset;
  }
  const candidates = [...offsets].map(value=>wanted-value).filter(at=>local(at)===wanted).sort((a,b)=>a-b);
  let at = candidates[0];
  if (at === undefined) {
    const gap = gaps.find(gap=>wanted>gap.before&&wanted<gap.after);
    if (!gap) throw new ProtocolError(422,'schedule_time_invalid','Scheduled time cannot be mapped.');
    at=gap.at+Math.ceil(gap.after/60000)*60000-gap.after;
  }
  return { at, localDateTime: new Date(local(at)).toISOString().slice(0,16), candidateIndex: 0 };
}

type Cron = { fields: number[][]; dayRestricted: boolean; weekdayRestricted: boolean };
const invalidCron = () => new ProtocolError(400,'invalid_schedule','Invalid cron expression.');
export function parseCronExpression(value: unknown): Cron {
  if(typeof value!=='string'||value.length>256)throw invalidCron();
  const fields=value.trim().split(/\s+/);
  if(fields.length!==5||fields.some(field=>!field))throw invalidCron();
  const values=fields.map((field,index)=>{
    const [min,max]=[[0,59],[0,23],[1,31],[1,12],[0,6]][index],values=new Set<number>();
    for(const item of field.split(',')){
      const match=/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(item);
      if(!match)throw invalidCron();
      const step=match[2]===undefined?1:Number(match[2]);
      if(!Number.isSafeInteger(step)||step<1||step>max)throw invalidCron();
      const range=match[1]==='*'?[min,max]:match[1].split('-').map(Number);
      const start=range[0],end=range[1]??(match[2]===undefined?start:max);
      if(start<min||end>max||start>end)throw invalidCron();
      for(let at=start;at<=end;at+=step)values.add(at);
    }
    return [...values].sort((a,b)=>a-b);
  });
  return {fields:values,dayRestricted:fields[2]!=='*',weekdayRestricted:fields[4]!=='*'};
}
type Candidate = {at:number;localDateTime:string;candidateIndex:number};
// Scan UTC segments so midnight folds and date-line changes remain in UTC order.
export function* cronCandidates(expression: string, zone: string, after: number, through=after+1825*day): Generator<Candidate> {
  const spec=parseCronExpression(expression),local=zoneClock(zone),limit=Math.min(maxScheduleTime,through);
  const offset=(at:number)=>local(at)-Math.floor(at/1000)*1000;
  let start=Math.floor(after/hour)*hour-48*hour,previousOffset=offset(start),foldUntil=0;
  function* segment(from:number,to:number,zoneOffset:number,foldEnd:number) {
    if(to<=after)return;
    const first=Math.floor((from+zoneOffset)/day)*day,last=Math.floor((to-1+zoneOffset)/day)*day;
    for(let date=first;date<=last;date+=day){
      const wallDate=new Date(date),dayMatch=spec.fields[2].includes(wallDate.getUTCDate()),weekdayMatch=spec.fields[4].includes(wallDate.getUTCDay());
      const matchesDay=spec.dayRestricted&&spec.weekdayRestricted?dayMatch||weekdayMatch:spec.dayRestricted?dayMatch:weekdayMatch;
      if(!spec.fields[3].includes(wallDate.getUTCMonth()+1)||!matchesDay)continue;
      for(const h of spec.fields[1])for(const m of spec.fields[0]){
        const wall=date+h*hour+m*minute,at=wall-zoneOffset;
        if(at>after&&at>=from&&at<to&&at<=limit)yield {at,localDateTime:new Date(wall).toISOString().slice(0,16),candidateIndex:at<foldEnd?1:0};
      }
    }
  }
  while(start<=limit){
    const end=Math.min(start+6*hour,limit+1),currentOffset=offset(end);
    if(currentOffset!==previousOffset){
      let low=Math.floor(start/1000),high=Math.ceil(end/1000);
      while(high-low>1){const middle=Math.floor((low+high)/2);if(offset(middle*1000)===previousOffset)low=middle;else high=middle;}
      const transition=high*1000;
      yield* segment(start,transition,previousOffset,foldUntil);
      if(currentOffset<previousOffset)foldUntil=transition+previousOffset-currentOffset;
      yield* segment(transition,end,currentOffset,foldUntil);
    }else yield* segment(start,end,previousOffset,foldUntil);
    start=end;previousOffset=currentOffset;
  }
}
export function validateCron(expression:string,zone:string,after:number): Candidate {
  let first:Candidate|undefined,previous:number|undefined;
  for(const candidate of cronCandidates(expression,zone,after-5*minute,after+1825*day)){
    if(previous!==undefined&&candidate.at-previous<5*minute)throw new ProtocolError(400,'invalid_schedule','Cron interval must be at least five minutes.');
    if(candidate.at>after)first??=candidate;
    previous=candidate.at;
  }
  if(!first)throw new ProtocolError(422,'schedule_unsatisfiable','Cron has no occurrence within 1,825 days.');
  return first;
}
