import { useEffect, useRef, useState } from 'react';
type Connection = { id: string; name: string; url: string; hasToken: boolean; enabled: number; revision: number };
type Tool = { name: string; description?: string; inputSchema: unknown };
type Detail = Connection & { tools: Tool[]; grant: { revision: number; tools: string[] } };
type Command = { path: string; body: Record<string, unknown> & { id: string } };
const storage = 'briefsip:mcp-command';
function restore(raw: string | null): Command | null {
  if (raw === null) return null;
  if (raw.length > 16000) throw new Error('Data pemulihan MCP terlalu besar.');
  const value = JSON.parse(raw), uuid = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
  if (!value || typeof value.path !== 'string' || !new RegExp(`^/api/(mcp(?:/${uuid})?|agents/${uuid}/mcp/${uuid})$`, 'i').test(value.path) || !value.body || typeof value.body !== 'object' || !new RegExp(`^${uuid}$`, 'i').test(value.body.id) || Object.keys(value.body).some(key => !['id', 'test', 'revision', 'enabled', 'connectionRevision', 'tools'].includes(key))) throw new Error('Data pemulihan MCP tidak valid.');
  return value;
}
export function McpPanel({ agents, request, onClose }: { agents: { id: string; name: string }[]; request: <T>(path: string, body?: unknown) => Promise<T>; onClose: () => void }) {
  const [recovery] = useState(() => { try { return { command: restore(sessionStorage.getItem(storage)), invalid: false }; } catch { return { command: null, invalid: true }; } });
  const [pending, setPending] = useState(recovery.command), [invalid, setInvalid] = useState(recovery.invalid);
  const [page, setPage] = useState<{ items: Connection[]; next_after: string | null } | null>(null), [cursors, setCursors] = useState(['']);
  const [agent, setAgent] = useState(agents[0]?.id ?? ''), [selected, setSelected] = useState(''), [detail, setDetail] = useState<Detail | null>(null), [tools, setTools] = useState<string[]>([]);
  const [name, setName] = useState(''), [url, setUrl] = useState(''), [token, setToken] = useState('');
  const [tested, setTested] = useState<{ id: string; tools: Tool[]; expires: number } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const generation = useRef(0), reads = useRef(0), flight = useRef(false), heading = useRef<HTMLHeadingElement>(null);
  const locked = busy || !!pending || invalid, after = cursors.at(-1)!;
  useEffect(() => { heading.current?.focus(); return () => { generation.current++; }; }, []);
  useEffect(() => { heading.current?.focus(); }, [after, selected]);
  useEffect(() => {
    let stopped = false; const current = ++reads.current; setPage(null); setDetail(null); setError('');
    void Promise.all([request<NonNullable<typeof page>>(`/api/mcp${after ? `?after=${after}` : ''}`), selected && agent ? request<Detail>(`/api/mcp/${selected}?agent=${agent}`) : Promise.resolve(null)]).then(([page, detail]) => { if (!stopped && current === reads.current) { setPage(page); setDetail(detail); setTools(detail?.grant.tools ?? []); } }).catch(error => { if (!stopped && current === reads.current) setError(error.message); });
    return () => { stopped = true; };
  }, [after, selected, agent, refresh]);
  async function test() {
    if (flight.current || locked) return;
    const current = generation.current; flight.current = true; setBusy(true); setError(''); setTested(null);
    try { const result = await request<NonNullable<typeof tested>>('/api/mcp/test', { id: crypto.randomUUID(), name, url, token }); if (current === generation.current) { setTested(result); setToken(''); } }
    catch (error) { if (current === generation.current) setError(error instanceof Error ? error.message : 'Uji koneksi gagal.'); }
    finally { flight.current = false; if (current === generation.current) setBusy(false); }
  }
  async function execute(command: Command) {
    if (flight.current || busy || invalid) return;
    const current = generation.current;
    try {
      restore(JSON.stringify(command)); sessionStorage.setItem(storage, JSON.stringify(command)); setPending(command); setBusy(true); flight.current = true; reads.current++; setError('');
      await request(command.path, command.body);
      if (current !== generation.current) return;
      if (sessionStorage.getItem(storage) === JSON.stringify(command)) sessionStorage.removeItem(storage);
      setPending(null); setTested(null); setRefresh(value => value + 1); heading.current?.focus();
    } catch (error) { if (current === generation.current) setError(error instanceof Error ? error.message : 'Perubahan belum terkonfirmasi. Coba lagi.'); }
    finally { flight.current = false; if (current === generation.current) setBusy(false); }
  }
  return <section className="setup workflow-panel"><h1 ref={heading} tabIndex={-1}>Koneksi MCP</h1>
    <p>Hubungkan layanan eksternal, lalu pilih tool yang boleh digunakan tiap agent dalam percakapan privat. Tool dapat mengubah data di layanan tujuan.</p>
    <div className="form-actions"><button className="secondary" onClick={onClose}>Kembali ke percakapan</button><button className="secondary" disabled={busy} onClick={() => setRefresh(value => value + 1)}>Muat ulang koneksi</button></div>
    {error && <p role="alert" className="error">{error}</p>}{invalid && <p role="alert">Pemulihan MCP tidak dapat dibaca.</p>}{pending && <p className="notice">Perubahan belum terkonfirmasi. <button disabled={busy} onClick={() => void execute(pending)}>Coba perubahan lagi</button></p>}
    {(pending || invalid) && <button className="secondary" disabled={busy} onClick={() => { if (!window.confirm('Abaikan permintaan tersimpan? Perubahan mungkin sudah berhasil. Periksa daftar setelah dimuat ulang.')) return; try { sessionStorage.removeItem(storage); setPending(null); setInvalid(false); setRefresh(value => value + 1); } catch { setError('Penyimpanan browser belum dapat diubah.'); } }}>Abaikan pemulihan</button>}
    <form onSubmit={event => { event.preventDefault(); void test(); }}><fieldset disabled={locked}><legend>Koneksi baru</legend>
      <label>Nama<input required maxLength={80} value={name} onChange={event => { setName(event.target.value); setTested(null); }} /></label>
      <label>URL Streamable HTTP<input required type="url" maxLength={2000} value={url} onChange={event => { setUrl(event.target.value); setTested(null); }} /></label>
      <label>Token Bearer, jika diperlukan<input type="password" autoComplete="off" maxLength={4096} value={token} onChange={event => { setToken(event.target.value); setTested(null); }} /></label>
      <p className="muted">Token disimpan terenkripsi pada host ini. URL tersimpan tidak dapat diganti; buat koneksi baru untuk URL atau token berbeda. OAuth belum tersedia.</p><button>Uji koneksi</button>
      {tested && <><p role="status">Uji berhasil. {tested.tools.length} tool ditemukan. Hasil uji berlaku 10 menit.</p><ul className="routine-list">{tested.tools.map(tool => <li key={tool.name}><strong>{tool.name}</strong><p>{tool.description}</p></li>)}</ul><button type="button" onClick={() => void execute({ path: '/api/mcp', body: { id: crypto.randomUUID(), test: tested.id } })}>Simpan koneksi teruji</button></>}
    </fieldset></form>
    <h2>Koneksi tersimpan</h2>{!page ? !error && <p role="status">Memuat koneksi...</p> : page.items.length ? <ul className="routine-list">{page.items.map(row => <li key={row.id}><strong>{row.name}</strong><p>{row.url}</p><p>{row.enabled ? 'Aktif' : 'Nonaktif'} · {row.hasToken ? 'Token tersimpan' : 'Tanpa token'}</p><button className="secondary" disabled={locked || !agent} onClick={() => { generation.current++; reads.current++; setDetail(null); setSelected(row.id); setRefresh(value => value + 1); }}>Atur izin {row.name}</button><button className="secondary" disabled={locked} onClick={() => void execute({ path: `/api/mcp/${row.id}`, body: { id: crypto.randomUUID(), revision: row.revision, enabled: !row.enabled } })}>{row.enabled ? 'Nonaktifkan' : 'Aktifkan'} {row.name}</button></li>)}</ul> : <p>Belum ada koneksi pada halaman ini.</p>}
    <div className="form-actions"><button className="secondary" disabled={locked || cursors.length < 2} onClick={() => { generation.current++; setCursors(value => value.slice(0, -1)); }}>Sebelumnya</button><button className="secondary" disabled={locked || !page?.next_after} onClick={() => { generation.current++; setCursors(value => [...value, page!.next_after!]); }}>Berikutnya</button></div>
    <label>Agent<select value={agent} disabled={locked} onChange={event => { generation.current++; reads.current++; setDetail(null); setAgent(event.target.value); }}>{agents.map(item => <option key={item.id} value={item.id}>{item.name.length > 24 ? item.name.slice(0, 21) + '...' : item.name}</option>)}</select><span className="flow-selected-name muted">{agents.find(item => item.id === agent)?.name}</span></label>
    {detail && <form onSubmit={event => { event.preventDefault(); if (!locked && window.confirm('Izinkan tool terpilih bertindak untuk agent ini? Efek di layanan eksternal dapat tetap terjadi setelah tugas dibatalkan.')) void execute({ path: `/api/agents/${agent}/mcp/${detail.id}`, body: { id: crypto.randomUUID(), revision: detail.grant.revision, connectionRevision: detail.revision, tools } }); }}><fieldset disabled={locked}><legend>Izin {detail.name}</legend><p>Perubahan katalog memerlukan koneksi baru dan izin baru. Koneksi nonaktif tidak dapat dipanggil.</p>{detail.tools.map(tool => <div key={tool.name}><label className="member-option"><input type="checkbox" checked={tools.includes(tool.name)} onChange={event => setTools(value => event.target.checked ? [...value, tool.name] : value.filter(name => name !== tool.name))} />{tool.name}</label><p>{tool.description}</p><details><summary>Parameter {tool.name}</summary><pre className="skill-file-content" tabIndex={0} role="region" aria-label={`Parameter ${tool.name}`}>{JSON.stringify(tool.inputSchema, null, 2)}</pre></details></div>)}<button>Simpan izin tool</button></fieldset></form>}
  </section>;
}
