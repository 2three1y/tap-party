// braille-text.js: print text to Unicode braille with Nonemoticoner/braille.
// The braille module maps Braille ASCII to Unicode braille cells. Before
// handing text to it, this file adds the number sign before digits (1 to 0
// become a to j) and swaps in the Unified English Braille cells for . , ? and !
// so the result reads as uncontracted (grade 1) braille. No capital signs.
import braille from '../vendor/braille/braille.mjs'

const digitLetters = { 1: 'A', 2: 'B', 3: 'C', 4: 'D', 5: 'E', 6: 'F', 7: 'G', 8: 'H', 9: 'I', 0: 'J' }
// In Braille ASCII, '4' is dots 2-5-6 (period), '1' is dot 2 (comma),
// '8' is dots 2-3-6 (question mark), '6' is dots 2-3-5 (exclamation mark).
const punct = { '.': '4', ',': '1', '?': '8', '!': '6', '/': '/' }

export function toBraille(text) {
  let ascii = ''
  let inNumber = false
  for (const ch of String(text)) {
    if (/[0-9]/.test(ch)) {
      if (!inNumber) ascii += '#'
      inNumber = true
      ascii += digitLetters[ch]
      continue
    }
    inNumber = false
    ascii += punct[ch] ?? ch
  }
  return braille.toBraille(ascii)
}
