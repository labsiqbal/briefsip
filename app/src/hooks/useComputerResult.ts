import { useEffect, useState } from 'react';
import type { PanelRequest } from '../RightPanel';

export function useComputerResult(agent: string | undefined, url: string, request: PanelRequest) {
  const [state, setState] = useState('Opening page in Computer...');
  useEffect(() => {
    if (!agent) return;
    let current = true;
    void request(`/api/agents/${agent}/computer/open-url`, { url }).then(() => { if (current) setState(''); })
      .catch(error => { if (current) setState(error instanceof Error ? error.message : 'Page could not open in Computer.'); });
    return () => { current = false; };
  }, [agent, url, request]);
  return state;
}
