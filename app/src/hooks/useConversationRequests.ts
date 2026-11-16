import { useEffect, useRef } from 'react';

export function useConversationRequests() {
  const navigation = useRef(0), loadVersion = useRef(0);
  useEffect(() => () => { navigation.current++; loadVersion.current++; }, []);
  return { navigation, loadVersion };
}
