import type { IncomingMessage } from 'node:http';
import { ProtocolError } from '../protocol.ts';
import { slug, type HubAuthority } from './project-authority.ts';

export const notFound = () => new ProtocolError(404, 'resource_not_found', 'Resource not found.');
export function exactHost(value: unknown): string {
  if (typeof value !== 'string' || value.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(value) || value.split('.').some(label => label.length > 63)) throw notFound();
  return value;
}
export function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const values: string[] = [];
  for (let i = 0; i < request.rawHeaders.length; i += 2) if (request.rawHeaders[i].toLowerCase() === name) values.push(request.rawHeaders[i + 1]);
  if (values.length > 1) throw notFound();
  return values[0];
}

export function createHostGateway(authority: HubAuthority, config: { accountsHost: string; domain: string; trustedGatewayAddresses?: string[] }) {
  const accountsHost = exactHost(config.accountsHost), domain = exactHost(config.domain);
  if (accountsHost !== `accounts.${domain}`) throw new Error('Central accounts host must be accounts.<domain>.');
  const trusted = new Set(config.trustedGatewayAddresses ?? []);
  function project(host: string, accountId: string, expectedProjectId?: string) {
    registered(host);
    if (host === accountsHost) throw notFound();
    return authority.resolveProject(host, accountId, expectedProjectId);
  }
  function registered(host: string) {
    exactHost(host);
    if (host === accountsHost) return host;
    const address = host.slice(0, -(domain.length + 1));
    try { if (host !== `${address}.${domain}` || address === 'hub-origin' || address.startsWith('xn--')) throw notFound(); slug(address); }
    catch { throw notFound(); }
    if (!authority.one("SELECT 1 FROM host_bindings h JOIN projects p ON p.id=h.project_id WHERE h.host=? AND h.active=1 AND p.status='active'", host)) throw notFound();
    return host;
  }
  return {
    accountsHost, project, registered,
    resolve(request: IncomingMessage) {
      const host = singleHeader(request, 'host');
      if (!host) throw notFound();
      exactHost(host);
      // RFC Forwarded is deliberately unsupported. Only one explicitly trusted X-Forwarded-Host is usable.
      if (singleHeader(request, 'forwarded') !== undefined) throw notFound();
      const forwarded = singleHeader(request, 'x-forwarded-host');
      if (forwarded !== undefined && !trusted.has(request.socket.remoteAddress ?? '')) throw notFound();
      return registered(forwarded === undefined ? host : exactHost(forwarded));
    },
  };
}
export type HostGateway = ReturnType<typeof createHostGateway>;
