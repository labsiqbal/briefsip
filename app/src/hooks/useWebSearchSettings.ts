import { useEffect, useState } from 'react';
import { readJson } from '../http';

export const webSearchSettingsPath = '/api/settings/web-search';
export type WebSearchConfig = { url: string | null; managed: boolean };

export function useWebSearchSettings() {
  const [settings, setSettings] = useState<WebSearchConfig | null>(null);
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void fetch(webSearchSettingsPath, { signal: controller.signal })
      .then(response => readJson<WebSearchConfig>(response))
      .then(value => {
        if (!controller.signal.aborted) setSettings(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadError('Web search settings could not load. Reopen General to retry.');
      });
    return () => controller.abort();
  }, []);
  return { settings, setSettings, loadError };
}
