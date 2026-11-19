import { useEffect, useState } from 'react';

export function useExpiry(expiresAt: number | undefined) {
  const [expiredAt, setExpiredAt] = useState<number>();
  useEffect(() => {
    if (expiresAt === undefined) return;
    const timer = window.setTimeout(() => setExpiredAt(expiresAt), Math.max(0, expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [expiresAt]);
  return expiresAt !== undefined && expiresAt === expiredAt;
}
