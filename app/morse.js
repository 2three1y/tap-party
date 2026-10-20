// morse.js: Morse tables and helpers for Tap Party.
// Letters and the teaching order come from googlecreativelab/morse-learn
// (Apache-2.0, see vendor/morse-learn/morse-learn-data.mjs). Digits and the
// few punctuation marks below are the standard international Morse values.
import { englishToMorse } from '../vendor/morse-learn/morse-learn-data.mjs'

export const toMorse = {
  ...englishToMorse,
  '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-',
  '5': '.....', '6': '-....', '7': '--...', '8': '---..', '9': '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', '!': '-.-.--', '/': '-..-.',
}
export const fromMorse = Object.fromEntries(Object.entries(toMorse).map(([k, v]) => [v, k]))

const charNames = { '.': 'period', ',': 'comma', '?': 'question mark', '!': 'exclamation mark', '/': 'slash', ' ': 'space' }
export const charName = (c) => charNames[c] || c.toUpperCase()

// "dot dash" style words for a code like ".-"
export const spell = (code) => [...code].map((s) => (s === '.' ? 'dot' : 'dash')).join(' ')

export const textToCode = (text) =>
  [...text.toLowerCase()].map((c) => (c === ' ' ? ' ' : toMorse[c] || '')).filter((x) => x !== '').join('|')
// Returns a list of tokens: '.', '-', '|' (gap between letters), ' ' (gap between words)
export const codeTokens = (text) => {
  const out = []
  const words = text.toLowerCase().trim().split(/\s+/).filter(Boolean)
  words.forEach((w, wi) => {
    if (wi) out.push(' ')
    const letters = [...w].map((c) => toMorse[c]).filter(Boolean)
    letters.forEach((code, li) => { if (li) out.push('|'); out.push(...code) })
  })
  return out
}
export const cleanText = (text) => [...text.toLowerCase()].filter((c) => c === ' ' || toMorse[c]).join('').replace(/\s+/g, ' ').trim()
