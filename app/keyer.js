// keyer.js: turns presses on the tap pad (or the Dot and Dash buttons) into letters.
import { fromMorse, spell, charName } from './morse.js'
import { startTone, playSymbol, unlockAudio } from './audio.js'
import { buzzSymbol } from './haptics.js'
import { announce } from './announcer.js'

export const speeds = {
  slow: { unit: 160, dashAt: 380, letterGap: 1600 },
  normal: { unit: 110, dashAt: 260, letterGap: 1000 },
  fast: { unit: 75, dashAt: 180, letterGap: 600 },
}

export const keyerSettings = {
  speed: 'slow',
  autoLetter: true,
  sayLetters: true,
  saySymbols: false,
}
export const timing = () => speeds[keyerSettings.speed] || speeds.slow

export class Keyer {
  constructor({ pad, onSymbol, onLetter, onUnknown, onChange, freq = 650 }) {
    this.pad = pad
    this.freq = freq
    this.onSymbol = onSymbol || (() => {})
    this.onLetter = onLetter || (() => {})
    this.onUnknown = onUnknown || (() => {})
    this.onChange = onChange || (() => {})
    this.current = ''
    this.pressAt = 0
    this.tone = null
    this.lastPointerEnd = 0
    this.timer = null
    this.bind()
  }

  bind() {
    const pad = this.pad
    pad.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return
      e.preventDefault()
      try { pad.setPointerCapture(e.pointerId) } catch {}
      this.pressStart()
    })
    pad.addEventListener('pointerup', () => { if (this.pressAt) { this.pressEnd(); this.lastPointerEnd = performance.now() } })
    pad.addEventListener('pointercancel', () => { if (this.pressAt) { this.pressEnd(); this.lastPointerEnd = performance.now() } })
    // VoiceOver and TalkBack double-tap often send only a click: that is a dot.
    pad.addEventListener('click', (e) => {
      e.preventDefault()
      if (performance.now() - this.lastPointerEnd < 600 || this.pressAt) return
      this.addSymbol('.')
    })
    // TalkBack double-tap-and-hold (and a right click) sends a long press: that is a dash.
    pad.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      if (this.pressAt || performance.now() - this.lastPointerEnd < 600) return
      this.addSymbol('-')
    })
    // Space or Enter on the pad: a short press is a dot, holding it is a dash.
    pad.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        if (!e.repeat && !this.pressAt) this.pressStart()
      } else if (e.key === '.') { e.preventDefault(); this.addSymbol('.') }
      else if (e.key === '-') { e.preventDefault(); this.addSymbol('-') }
    })
    pad.addEventListener('keyup', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        if (this.pressAt) { this.pressEnd(); this.lastPointerEnd = performance.now() }
      }
    })
    pad.addEventListener('blur', () => { if (this.pressAt) this.pressEnd() })
  }

  pressStart() {
    unlockAudio()
    clearTimeout(this.timer)
    this.pressAt = performance.now()
    this.pad.classList.add('is-down')
    this.tone = startTone(this.freq)
    buzzSymbol('.', timing().unit)
  }

  pressEnd() {
    const held = performance.now() - this.pressAt
    this.pressAt = 0
    this.pad.classList.remove('is-down')
    const sym = held >= timing().dashAt ? '-' : '.'
    if (this.tone) this.tone.stop(sym === '.' ? timing().unit : 0)
    this.tone = null
    if (sym === '-') buzzSymbol('-', timing().unit)
    this.push(sym)
  }

  // From the Dot and Dash buttons (or a click with no press time).
  addSymbol(sym) {
    unlockAudio()
    clearTimeout(this.timer)
    playSymbol(sym, timing().unit, this.freq)
    buzzSymbol(sym, timing().unit)
    this.push(sym)
  }

  push(sym) {
    this.current += sym
    if (keyerSettings.saySymbols) announce(sym === '.' ? 'dot' : 'dash')
    this.onSymbol(sym)
    this.onChange()
    this.schedule()
  }

  schedule() {
    clearTimeout(this.timer)
    if (keyerSettings.autoLetter && this.current) this.timer = setTimeout(() => this.endLetter(), timing().letterGap)
  }

  endLetter() {
    clearTimeout(this.timer)
    if (!this.current) return null
    const code = this.current
    this.current = ''
    const ch = fromMorse[code]
    if (ch) {
      if (keyerSettings.sayLetters) announce(charName(ch))
      this.onLetter(ch, code)
    } else {
      announce(`Not a letter: ${spell(code)}`)
      this.onUnknown(code)
    }
    this.onChange()
    return ch || null
  }

  clear() { clearTimeout(this.timer); this.current = ''; this.onChange() }
}
