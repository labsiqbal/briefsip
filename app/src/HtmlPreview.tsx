import { useEffect, useRef, useState } from 'react';
export function HtmlPreview({ path, name, request }: { path: string; name: string; request: <T>(path: string) => Promise<T> }) {
  const [open, setOpen] = useState(false), [html, setHtml] = useState<string | null>(null), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const opener = useRef<HTMLButtonElement>(null), heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!open) return;
    let stopped = false; setHtml(null); setError(''); heading.current?.focus();
    void request<{ html: string }>(`${path}?preview=html`).then(result => { if (!stopped) setHtml(result.html); }).catch(error => { if (!stopped) setError(error instanceof Error ? error.message : 'Pratinjau belum termuat. Coba lagi.'); });
    return () => { stopped = true; };
  }, [open, path, refresh]);
  if (!/\.html?$/i.test(name)) return null;
  return <div className="html-preview"><button ref={opener} className="secondary" aria-expanded={open} onClick={() => setOpen(value => !value)}>Pratinjau visual: {name}</button>
    {open && <section aria-label={`Pratinjau ${name}`}><h3 ref={heading} tabIndex={-1}>{name}</h3><p>Tampilan dibatasi untuk keamanan. Script, form, tautan, gambar, resource luar, dan sebagian gaya dihapus. Buka-tutup bagian tetap berfungsi. Unduhan mempertahankan file asli. Jika tampilan kosong atau gagal dimuat, gunakan muat ulang.</p>
      <div className="form-actions routine-actions"><button className="secondary" onClick={() => { setOpen(false); opener.current?.focus(); }}>Tutup pratinjau</button><button className="secondary" onClick={() => setRefresh(n => n + 1)}>Muat ulang pratinjau</button></div>
      {error ? <p className="error" role="alert">{error}</p> : html === null ? <p role="status">Memuat pratinjau...</p> : <iframe title={`Pratinjau visual ${name}`} sandbox="" referrerPolicy="no-referrer" src={`${path}?preview=render`} />}
    </section>}
  </div>;
}
