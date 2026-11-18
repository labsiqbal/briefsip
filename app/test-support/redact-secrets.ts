export function redactSecrets(text: string, secrets: string[], streaming = false) {
  for (const secret of secrets.filter(Boolean).sort((a,b) => b.length-a.length)) { text = text.split(secret).join('[REDACTED]'); const escaped=JSON.stringify(secret).slice(1,-1); if(escaped!==secret)text=text.split(escaped).join('[REDACTED]'); }
  if (streaming) for (const secret of secrets.filter(Boolean)) for (let size = Math.min(secret.length-1,text.length); size > 0; size--) if (text.endsWith(secret.slice(0,size))) { text = text.slice(0,-size); break; }
  return text;
}
