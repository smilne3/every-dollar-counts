import { useSyncExternalStore } from 'react'

// True when the app was launched from the home screen (#21) rather than in a browser tab.
// On iOS that app has its own cookies and storage, apart from the browser's, so a flow that leaves
// the app and expects to come back to the same storage (a magic link, Plaid's bank login) breaks
// inside it.
//
// `display-mode: standalone` is the standard check; `navigator.standalone` is iOS's own flag, and
// older iOS sets only that one. The server snapshot is false, so SSR and hydration agree, and the
// client snapshot then reads the real mode (the same pattern as app/auth/auth-code-error).
const QUERY = '(display-mode: standalone)'

function subscribe(onChange: () => void) {
  const mq = window.matchMedia?.(QUERY)
  mq?.addEventListener('change', onChange)
  return () => mq?.removeEventListener('change', onChange)
}

function isStandalone() {
  const ios = (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  return ios || window.matchMedia?.(QUERY).matches === true
}

export function useIsStandalone() {
  return useSyncExternalStore(subscribe, isStandalone, () => false)
}
