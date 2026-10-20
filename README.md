# Tap Party 📳

Morse code chat with your friends, right in the browser. Open a room, share the link, and tap a big pad: a short tap is a dot, a long press is a dash. Friends hear your taps as tones, feel them as buzzes, and get the decoded words read out by their screen reader. There is a Learn mode for the letters and a Braille view.

Live: https://2three1y.github.io/tap-party/

Built only from repos [2three1y](https://github.com/2three1y) has starred. See CREDITS below.

## How it works

- No server and no accounts. Rooms use trystero: browsers find each other through public Nostr relays, then talk directly over WebRTC.
- The room link has the room code in it, for example `#/room/tea-moss-zebra`. Anyone with the link can join.
- Everything is plain HTML, CSS and JavaScript, so GitHub Pages can host it. No build step is needed to run it.

## Using it

- **Tap pad**: short tap for a dot, hold for a dash. With VoiceOver or TalkBack, double-tap for a dot and double-tap and hold for a dash. With a keyboard, focus the pad and press Space or Enter, short or long. The `.` and `-` keys also work on the pad.
- **Dot, Dash, End letter, Space, Delete letter** buttons do the same things one at a time, so nothing depends on timing.
- A pause ends the letter (you can turn that off in Settings and use End letter instead). Each letter is read out as you go.
- **Send message** sends what you tapped. Friends hear an earcon and get the words read out. While you tap, friends hear each dot and dash live, each friend at their own pitch.
- Earcons: sent (two notes up), received (a quick ding-a-ding), friend joined (three notes up), friend left (three notes down).
- **Learn**: letters in the order Google's morse-learn teaches them. Get a letter right twice and the next one unlocks, then short practice words.
- **Braille**: your message and every message in Unicode braille, uncontracted, with the number sign for digits.
- **Settings**: your name, speed (slow, normal, fast), letter ending by pause, spoken letters and symbols, tones, earcons, haptics, live taps, and playing each new message as Morse.

## Accessibility

- Real buttons, links, form labels and headings. Each page change moves focus to the page's heading.
- One live region for every announcement.
- Respects Reduce Motion. Nothing flashes.
- Times use the 24-hour clock.

## Haptics, honestly

- Android (Chrome): buzzes work for your own taps and for friends' taps, once you have touched the page.
- iPhone: there is no vibration API, so web-haptics clicks a hidden iOS switch to make the Taptic Engine tick. iOS only allows that during your own tap, so you feel your own taps, but probably not your friends'. This has not been tried on a real iPhone yet.

## Files

- `index.html`, `styles.css`, `app/`: the app.
- `vendor/`: the starred libraries, each with a note at the top if it was changed.
- `credits.json`: the source for the credits.
- `licenses/`: the full licence text for each starred repo used.
- `tools/build-credits.mjs`: writes the CREDITS section below and the in-app Credits page from credits.json.
- `tools/check-starred.mjs`: checks that every credited repo is in `starred.txt` (or asks GitHub with `--live`).

```
node tools/build-credits.mjs
node tools/check-starred.mjs
```

## CREDITS

<!-- CREDITS:START -->
Every library in Tap Party comes from a repo [2three1y](https://github.com/2three1y) has starred. 7 starred repos went in.

### trystero

- Repo: [dmotz/trystero](https://github.com/dmotz/trystero)
- Author: Dan Motzenbecker
- License: MIT ([full text](licenses/trystero.txt))
- Used for: Rooms with no server. Browsers find each other through public Nostr relays, then send taps and messages straight to each other over WebRTC.
- Files: vendor/trystero/core/ (npm @trystero-p2p/core 0.26.0); vendor/trystero/nostr/index.mjs (npm @trystero-p2p/nostr 0.26.0)
- Changes: None to the code. Source map comments were removed because the maps are not included.
- Notice: Copyright (c) 2021 Dan Motzenbecker. MIT License.

### morse-learn

- Repo: [googlecreativelab/morse-learn](https://github.com/googlecreativelab/morse-learn)
- Author: Google Inc. (made by Tania Finlayson and Use All Five with Google Creative Lab)
- License: Apache-2.0 ([full text](licenses/morse-learn.txt))
- Used for: Learn mode: the Morse letter table, the order letters are taught in (E, T, A, I, M, S…), the rule that a letter counts as learned after 2 right answers, and the practice word list.
- Files: vendor/morse-learn/morse-learn-data.mjs
- Changes: Pieces of scripts/morse-dictionary.js, scripts/words.js, scripts/game-state.js and scripts/config.js were combined into one ES module. The reverse lookup table is now built from englishToMorse, because the original had a typo for the letter V. The file says so at the top.
- Notice: Copyright 2018 Google Inc. Licensed under the Apache License, Version 2.0. This is not an officially supported Google product. The morse-learn repo has no NOTICE file; its copyright notice and licence are kept in the file and in licenses/morse-learn.txt.

### web-haptics

- Repo: [lochie/web-haptics](https://github.com/lochie/web-haptics)
- Author: Lochie Axon
- License: MIT ([full text](licenses/web-haptics.txt))
- Used for: Haptics. On Android it uses navigator.vibrate. On iPhone, which has no navigator.vibrate, it clicks a hidden iOS switch control so the Taptic Engine ticks.
- Files: vendor/web-haptics/index.mjs and chunk-4NSAIXAB.mjs (npm web-haptics 0.0.6)
- Changes: None.
- Notice: Copyright (c) 2025 Lochie Axon. MIT License.

### braille

- Repo: [Nonemoticoner/braille](https://github.com/Nonemoticoner/braille)
- Author: Nonemoticoner
- License: MIT ([full text](licenses/braille.txt))
- Used for: Braille view: turns decoded text into Unicode braille cells.
- Files: vendor/braille/braille.mjs (npm braille 1.1.0)
- Changes: module.exports was changed to an ES module export. app/braille-text.js adds the number sign and the Unified English Braille punctuation cells before calling it.
- Notice: Copyright (c) 2015 Nonemoticoner. MIT License.

### tabbable

- Repo: [focus-trap/tabbable](https://github.com/focus-trap/tabbable)
- Author: David Clark and the focus-trap contributors
- License: MIT ([full text](licenses/tabbable.txt))
- Used for: Finds the buttons and fields inside a dialog, so Tab and Shift+Tab stay inside it.
- Files: vendor/tabbable/index.esm.js (npm tabbable 6.5.0)
- Changes: None to the code. The source map comment was removed.
- Notice: Copyright (c) 2015 David Clark. MIT License.

### a11y-dialog

- Repo: [KittyGiraudel/a11y-dialog](https://github.com/KittyGiraudel/a11y-dialog)
- Author: Kitty Giraudel
- License: MIT ([full text](licenses/a11y-dialog.txt))
- Used for: The Settings dialog and the Leave room dialog: focus moves in and back out, Escape closes, and the rest of the page is hidden from screen readers while it is open.
- Files: vendor/a11y-dialog/a11y-dialog.esm.js (npm a11y-dialog 8.1.5)
- Changes: The published build bundles a package called focusable-selectors, which is not starred. That part was removed and the focus trap now uses tabbable instead. The file says so at the top.
- Notice: Copyright (c) 2025 Kitty Giraudel. MIT License.

### dart-bip340

- Repo: [nbd-wtf/dart-bip340](https://github.com/nbd-wtf/dart-bip340)
- Author: fiatjaf
- License: MIT ([full text](licenses/dart-bip340.txt))
- Used for: Nostr relays only accept signed events. trystero normally signs them with @noble/secp256k1, which is not starred, so Tap Party signs with a JavaScript port of this repo's BIP-340 Schnorr code instead.
- Files: vendor/bip340-schnorr/bip340-schnorr.mjs
- Changes: Ported from Dart to JavaScript. The curve maths that the Dart code takes from pointycastle is written from scratch. It passes the official BIP-340 signing test vectors.
- Notice: Copyright 2021 fiatjaf. MIT License.

### Looked at, not used

- hainguyents13/mechvibes: Its sound packs come from many people and none of them states its own licence, so they are not safe to reuse. Every tone and earcon in Tap Party is made with WebAudio oscillators instead, with no sound files at all.
- paulmillr/noble-secp256k1: trystero's Nostr strategy depends on it, but it is not starred, so it is replaced by the dart-bip340 port above.
- KittyGiraudel/focusable-selectors: Bundled inside a11y-dialog's published build, but not starred, so it was swapped for tabbable.

### Used only for testing

- [dequelabs/axe-core](https://github.com/dequelabs/axe-core) (MPL-2.0): Ran an automated accessibility check during testing. It is not part of the site.
<!-- CREDITS:END -->

## License

Tap Party's own code is MIT licensed (see LICENSE). Each starred repo keeps its own licence (see licenses/ and NOTICE).
