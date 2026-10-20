// haptics.js: buzzes through lochie/web-haptics.
// On Android, web-haptics uses navigator.vibrate. iPhones have no
// navigator.vibrate, so web-haptics clicks a hidden iOS "switch" checkbox,
// which makes the Taptic Engine tick. That only works during a tap or key
// press of your own, so on iPhone you feel your own taps, not your friends'.
import { WebHaptics } from '../vendor/web-haptics/index.mjs'

const settings = { on: true }
export const hapticSettings = settings
let haptics = null
const get = () => (haptics ??= new WebHaptics())

export const canVibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'

export function buzzSymbol(sym, unitMs) {
  if (!settings.on) return
  try {
    get().trigger(sym === '-' ? [{ duration: Math.min(3 * unitMs, 1000), intensity: 1 }] : [{ duration: Math.max(unitMs, 30), intensity: 0.7 }])
  } catch {}
}

export function buzz(preset) {
  if (!settings.on) return
  try { get().trigger(preset) } catch {}
}
