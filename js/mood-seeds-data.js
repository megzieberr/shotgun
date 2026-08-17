// Shotgun — mood seed data (transcribed from MOOD-SEEDS.md, 2026-08-17)
//
// AFRIKAANS-GREP EXEMPT FILE. This is data, not UI copy — her music, in her
// own words, some Afrikaans/Japanese/anything. The app itself stays
// English-only (see js/app.js, index.html); nothing in here is ever shown
// as interface chrome, only searched against and displayed back as literal
// song titles/artists once resolved.
//
// Shape per entry: { raw, bestGuess?, note?, unsure? }
//   - raw       her own words, verbatim from MOOD-SEEDS.md
//   - bestGuess the corrected "Title - Artist" string to search with, when
//               her spelling/casing needs fixing (undefined = raw is already
//               clean, search with it directly)
//   - note      a parenthetical she added for context (e.g. "(Hamilton)")
//               that is NOT part of the title/artist string — kept for
//               display, never fed into the search query
//   - unsure    true for every row she flagged UNSURE — js/seed-resolver.js
//               must NEVER auto-accept one of these regardless of match
//               score; it always queues for her review.
//
// Keyed identically to MOOD_PRESETS/MOOD_ORDER/MOOD_SEEDS in js/config.js.

export const MOOD_SEED_ENTRIES = {
  chilled: [
    { raw: 'The Bluebirds - Sasha Allen' },
    { raw: "It's Quiet Uptown - Renee Elise Goldsberry", note: 'Hamilton' },
    { raw: 'Iris - The Googoodolls', bestGuess: 'Iris - The Goo Goo Dolls' },
    { raw: 'Abyss - Yungblud' },
    { raw: 'Disappear Without a Trace - The Parlotones' },
    { raw: 'What Was I Made For - Billie Eilish', bestGuess: 'What Was I Made For? - Billie Eilish' },
    { raw: 'step into my life - Puwfu' },
    { raw: 'Confidence - Ocean Alley' },
  ],

  feelGood: [
    { raw: 'Devil in Disguise - Marino' },
    { raw: 'Magic in the hamptons - Social House', bestGuess: 'Magic in the Hamptons - Social House' },
    { raw: 'The room where it happens - Leslie Odom Jr', note: 'Hamilton' },
    { raw: 'Bling-bang-boom - Creepy nuts', bestGuess: 'Bling-Bang-Bang-Born - Creepy Nuts' },
    { raw: 'Otonoke - Creepy Nuts' },
    { raw: 'Takedown - Huntre/x', bestGuess: 'Takedown - HUNTR/X', note: 'KPop Demon Hunters' },
    { raw: 'Where is my mind - Pixies', bestGuess: 'Where Is My Mind? - Pixies' },
    { raw: 'One Last Breath - Creed' },
    { raw: 'Raak Taatie - Cream Machine' },
    { raw: 'Humble - Kendrick Lamar', bestGuess: 'HUMBLE. - Kendrick Lamar' },
    { raw: 'Tia Tamera - Doja Cat', bestGuess: 'Tia Tamera - Doja Cat feat. Rico Nasty' },
    { raw: 'Rasta Love - Protoje' },
    { raw: 'Roll Up - Emtee' },
    { raw: 'Bank Account - 21 Savage' },
    {
      raw: 'Martians Vs Goblins - The Game',
      bestGuess: 'Martians vs. Goblins - The Game feat. Lil Wayne, Tyler the Creator',
    },
    { raw: 'Nothing was the same - Misfit Solo' },
    { raw: 'Myself - Bazzi' },
  ],

  pumped: [
    { raw: 'Gozala - Ariis' },
    { raw: 'Gas Pedal - Harddope' },
    {
      raw: 'Cadilac Club Remix - Morgenshtern',
      bestGuess: 'Cadillac (remix) - MORGENSHTERN & Элджей',
      unsure: true,
    },
    { raw: 'Nasy Jamx - Coolzone', unsure: true },
    { raw: 'Interference - Chunda Munki' },
    { raw: 'Boss Bitch - Doja Cat' },
    { raw: 'Orgasmic - WonkyWilla' },
    { raw: "Four 15's VIP - Smoakland" },
    { raw: 'BIA - TroyBoi' },
    { raw: 'OG - TroyBoi' },
    { raw: 'pa$$ the time - Bronze', unsure: true },
    { raw: 'Le Passe Trappe - Chunda Monki', bestGuess: 'Le Passe Trappe - Chunda Munki' },
    { raw: 'Sicko Mode - Travis Scott', bestGuess: 'SICKO MODE - Travis Scott' },
    { raw: 'Gummo - 6ix9ine' },
    { raw: 'Billy - 6ix9ine' },
    { raw: 'Gooba - 6ix9ine', bestGuess: 'GOOBA - 6ix9ine' },
    { raw: 'No Weed - DC Young Fly' },
    { raw: 'Caracara - KO', unsure: true },
    { raw: 'Handsomer - Russ' },
    { raw: 'Satusfaction - Benny Benassi', bestGuess: 'Satisfaction - Benny Benassi' },
    { raw: 'Womaback - Lucas Brontk', unsure: true },
  ],

  sadGangster: [
    { raw: 'Psycho! - MASN' },
    { raw: 'Ransom - Lil Tecca' },
    { raw: 'leavemealone - Fred again', bestGuess: 'leavemealone - Fred again.. & Baby Keem' },
    { raw: 'Crew - shakkarr' },
    { raw: 'Outer space - Xcozso', unsure: true },
    { raw: 'Mercury: Retrograde - Ghostemane' },
    { raw: 'Doomsday - Juice World', bestGuess: 'Doomsday - Juice WRLD' },
    { raw: 'Bandit - Juice World', bestGuess: 'Bandit - Juice WRLD feat. YoungBoy NBA' },
    { raw: 'Love Sosa - Chief Keef' },
    { raw: 'Mistakes - sevenyBeats', unsure: true },
    { raw: '2055 - Sleepy Hallow' },
    { raw: 'Save that shit - Lil Peep', bestGuess: 'Save That Shit - Lil Peep' },
    { raw: 'Dying - Cold Hart' },
    { raw: 'Betrayed - Lil Xan' },
    { raw: 'Dealing - Soldier Kidd' },
    { raw: 'Do the Most - Juice World', bestGuess: 'Do the Most - Juice WRLD' },
    { raw: 'Walk Like A - Dee Watkins', unsure: true },
    { raw: 'Codeine Dreaming - Kodak Black', bestGuess: 'Codeine Dreaming - Kodak Black feat. Lil Wayne' },
    { raw: 'The Way I Feel - My Heartbrk', unsure: true },
    { raw: 'Go Hard 2.0 - Juice World', bestGuess: 'Go Hard 2.0 - Juice WRLD' },
    { raw: 'Look at Me! - XXXTentacion', bestGuess: 'Look At Me! - XXXTENTACION' },
    { raw: 'Locked up - Akon', bestGuess: 'Locked Up - Akon' },
    { raw: 'Drugs & Pain - Tyla Yaweh' },
    { raw: 'Moving on - Lil Peep', bestGuess: 'Moving On - Lil Peep' },
  ],

  headBumping: [
    { raw: 'Lights - Jack The Man', unsure: true },
    { raw: "What's up, people?! - Maximum the hormone", bestGuess: "What's up, people?! - Maximum The Hormone" },
    { raw: 'Peek a boo - Okay fine', unsure: true },
    { raw: 'Die very rough - Mario Judah', bestGuess: 'Die Very Rough - Mario Judah' },
    { raw: 'Sweet Dreans - Marilyn Manson', bestGuess: 'Sweet Dreams (Are Made of This) - Marilyn Manson' },
    { raw: 'One step closer - Linkin Park', bestGuess: 'One Step Closer - Linkin Park' },
    { raw: 'Walk - Pantera' },
  ],

  afrikaansRap: [
    { raw: 'Puff Puff - Jack Parrow', bestGuess: 'Puff Puff - Jack Parow' },
    { raw: 'Feite - Jack Parrow', bestGuess: 'Feite - Jack Parow' },
    { raw: 'Benjamin Franklyn - Luda G', unsure: true },
    { raw: '762 - 21 Promo & Pengii', unsure: true },
    { raw: 'Die laaste - Klein duiwel', note: 'moved here from Feel Good Vibes — her final lists rule' },
    { raw: "Noem My 'n Goen - Kro-Barz", unsure: true },
    { raw: 'Fases - Henru' },
  ],
};

// Artist wildcards: a mood can claim an artist's ENTIRE catalogue, not just
// the songs listed above (her ruling, MOOD-SEEDS.md). Resolved once via
// js/seed-resolver.js's resolveArtistWildcard() (search the artist, fetch
// their top tracks), cached forever in localStorage — never re-fetched.
export const ARTIST_WILDCARDS = {
  chilled: ['Billie Eilish', 'Taylor Swift'],
  sadGangster: ['Juice WRLD'],
};
