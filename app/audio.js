// audio.js: tones and earcons, all made with WebAudio oscillators (no sound files).
let ctx = null
let master = null
const settings = { tones: true, earcons: true }
export const audioSettings = settings

export function unlockAudio() {
  // iOS: let the page make sound even when the ring/silent switch is on silent.
  try { if (navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback' } catch {}
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return null
    ctx = new AC()
    master = ctx.createGain()
    master.gain.value = 0.5
    master.connect(ctx.destination)
  }
  if (ctx.state === 'suspended') ctx.resume()
  return ctx
}

function note(freq, start, dur, { type = 'sine', vol = 0.6 } = {}) {
  const o = ctx.createOscillator()
  const g = ctx.createGain()
  o.type = type
  o.frequency.value = freq
  const a = 0.006 // short fade in and out so tones never click
  g.gain.setValueAtTime(0, start)
  g.gain.linearRampToValueAtTime(vol, start + a)
  g.gain.setValueAtTime(vol, Math.max(start + a, start + dur - a))
  g.gain.linearRampToValueAtTime(0, start + dur)
  o.connect(g).connect(master)
  o.start(start)
  o.stop(start + dur + 0.02)
  return o
}

// A held tone for the tap pad: starts now, stops when stop() is called.
export function startTone(freq = 650) {
  if (!settings.tones || !unlockAudio()) return { stop() {} }
  const o = ctx.createOscillator()
  const g = ctx.createGain()
  o.type = 'sine'
  o.frequency.value = freq
  const t = ctx.currentTime
  g.gain.setValueAtTime(0, t)
  g.gain.linearRampToValueAtTime(0.6, t + 0.006)
  o.connect(g).connect(master)
  o.start(t)
  const began = t
  return {
    stop(minMs = 0) {
      const end = Math.max(ctx.currentTime, began + minMs / 1000)
      g.gain.setValueAtTime(0.6, end)
      g.gain.linearRampToValueAtTime(0, end + 0.008)
      o.stop(end + 0.03)
    },
  }
}

// Play one symbol ('.' or '-') at a given unit length.
export function playSymbol(sym, unitMs, freq = 650) {
  if (!settings.tones || !unlockAudio()) return
  note(freq, ctx.currentTime + 0.01, ((sym === '-' ? 3 : 1) * unitMs) / 1000)
}

// Play a list of tokens ('.', '-', '|', ' '); returns the total time in ms.
export function playTokens(tokens, unitMs, freq = 650, onSymbol) {
  if (!unlockAudio()) return 0
  let t = 0
  for (const tok of tokens) {
    if (tok === '.' || tok === '-') {
      const len = tok === '-' ? 3 : 1
      if (settings.tones) note(freq, ctx.currentTime + 0.05 + (t * unitMs) / 1000, (len * unitMs) / 1000)
      if (onSymbol) setTimeout(() => onSymbol(tok), 50 + t * unitMs)
      t += len + 1
    } else if (tok === '|') t += 2
    else if (tok === ' ') t += 6
  }
  return t * unitMs + 50
}

const earconShapes = {
  sent: [[523, 0, 0.07], [784, 0.08, 0.1]], // up: C5 then G5
  received: [[880, 0, 0.06], [660, 0.07, 0.06], [880, 0.14, 0.1]], // a bright little "ding-a-ding"
  joined: [[392, 0, 0.08], [523, 0.09, 0.08], [659, 0.18, 0.14]], // rising chord
  left: [[659, 0, 0.08], [523, 0.09, 0.08], [392, 0.18, 0.16]], // falling chord
  right: [[660, 0, 0.06], [990, 0.07, 0.12]],
  wrong: [[220, 0, 0.12], [196, 0.13, 0.16]],
  learned: [[523, 0, 0.07], [659, 0.08, 0.07], [784, 0.16, 0.07], [1047, 0.24, 0.16]],
}

export function earcon(name) {
  if (!settings.earcons || !unlockAudio()) return
  const shape = earconShapes[name]
  if (!shape) return
  const t0 = ctx.currentTime + 0.02
  for (const [f, s, d] of shape) note(f, t0 + s, d, { type: 'triangle', vol: 0.45 })
}
