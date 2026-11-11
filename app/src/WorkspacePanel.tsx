import { useEffect, useRef, useState } from 'react';

type Location = { path: string; file: boolean; after?: string; offset?: number; digest?: string };
type Page = { path: string; entries?: { name: string; kind: string }[]; next_after?: string | null; text?: string; digest?: string; next_offset?: number | null };

export function WorkspacePanel({ agent, request, onClose }: { agent: { id: string; name: string }; request: <T>(path: string) => Promise<T>; onClose: () => void }) {
  const [locations,setLocations] = useState<Location[]>([{path:'',file:false}]);
  const [page,setPage] = useState<Page | null>(null), [error,setError] = useState(''), [reload,setReload] = useState(0);
  const [downloading,setDownloading] = useState(false), [downloadError,setDownloadError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null), generation = useRef(0);
  const location = locations[locations.length-1];
  useEffect(() => {
    const current = ++generation.current; setPage(null); setError(''); setDownloading(false); setDownloadError(''); heading.current?.focus();
    const params = new URLSearchParams({path:location.path});
    if(location.after !== undefined)params.set('after',location.after);
    if(location.offset !== undefined)params.set('offset',String(location.offset));
    if(location.digest !== undefined)params.set('digest',location.digest);
    void request<Page>(`/api/agents/${agent.id}/workspace/${location.file?'file':'entries'}?${params}`).then(value => {
      if(current === generation.current)setPage(value);
    }).catch(reason => {if(current === generation.current)setError(reason instanceof Error ? reason.message : 'Workspace belum dapat dimuat. Coba lagi.');});
    return () => {generation.current++;};
  },[agent.id,location,reload,request]);
  function open(next:Location){generation.current++;setPage(null);setError('');setLocations(value=>[...value,next]);}
  function back(){generation.current++;setPage(null);setError('');setLocations(value=>value.slice(0,-1));}
  async function download() {
    if(downloading)return;
    const current=generation.current;setDownloading(true);setDownloadError('');
    try {
      const response=await fetch(`/api/agents/${agent.id}/workspace/download?${new URLSearchParams({path:location.path})}`);
      if(!response.ok)throw new Error((await response.json()).error);
      const blob=await response.blob();if(current!==generation.current)return;
      const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=location.path.split('/').pop()!;
      document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    } catch(reason) {if(current===generation.current)setDownloadError(reason instanceof TypeError?'Unduhan terputus. Periksa koneksi, lalu coba lagi.':reason instanceof Error?reason.message:'Unduhan gagal. Coba lagi.');}
    finally {if(current===generation.current)setDownloading(false);}
  }
  return <section className="setup workspace-files">
    <h1 ref={heading} tabIndex={-1}>File workspace {agent.name}</h1>
    <p className="muted">File lokal yang dihubungkan pemilik host. Preview hanya baca; membuka file di sini tidak mengirim isinya ke model.</p>
    <div className="form-actions"><button className="secondary" onClick={onClose}>Kembali ke percakapan</button><button className="secondary" disabled={locations.length<2} onClick={back}>Sebelumnya</button><button className="secondary" onClick={()=>{generation.current++;setPage(null);setError('');setLocations([{path:'',file:false}]);}}>Direktori utama</button><button className="secondary" onClick={()=>{generation.current++;setPage(null);setError('');setLocations(value=>[...value.slice(0,-1),{path:location.path,file:location.file}]);setReload(value=>value+1);}}>Muat ulang dari awal</button></div>
    <h2>{location.path || 'Direktori utama'}</h2>
    {location.file && <><button className="secondary" aria-disabled={downloading} aria-busy={downloading} onClick={()=>void download()}>{downloading?'Menyiapkan unduhan...':'Unduh file asli'}</button><p className="muted">Teks atau binary, maksimum 10 MiB. File diunduh dari versi saat ini.</p>{downloadError&&<p className="error" role="alert">{downloadError}</p>}</>}
    {error ? <p className="error" role="alert">{error}</p> : !page ? <p role="status">Memuat workspace...</p> : location.file ? <>
      <p className="muted">Mulai karakter {(location.offset??0)+1}. Maksimum 8000 karakter per halaman.</p>
      <pre className="skill-file-content" tabIndex={0} role="region" aria-label={`Isi ${location.path}`}>{page.text || '(File kosong)'}</pre>
      <button className="secondary" disabled={page.next_offset == null} onClick={()=>open({...location,offset:page.next_offset!,digest:page.digest})}>Teks berikutnya</button>
    </> : <>
      {page.entries?.length ? <ul className="workspace-entry-list">{page.entries.map(entry=><li key={entry.name}><button className="secondary" disabled={!['file','directory'].includes(entry.kind)||/[\x00-\x1f\x7f\\]/.test(entry.name)} onClick={()=>open({path:[location.path,entry.name].filter(Boolean).join('/'),file:entry.kind==='file'})}>{entry.name}<span className="muted">{entry.kind==='directory'?'Direktori':entry.kind==='file'?'File':'Tidak didukung'}</span></button></li>)}</ul> : <p>Direktori kosong pada halaman ini.</p>}
      <button className="secondary" disabled={!page.next_after} onClick={()=>open({...location,after:page.next_after!})}>Entri berikutnya</button>
    </>}
  </section>;
}
