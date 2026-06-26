# Sequence Table

Sequence Table is a small social deduction race about finding one hidden sequence.

Each player has a public book of guessed sequences. Everyone can inspect every public book, but each player also has a private candidate book that only shows what they personally still believe could be the answer.

On each round, players choose one action:

1. Add sequences from their private candidate book into their public book.
2. Verify selected sequences in their own public book.
3. Verify the whole table, then skip the next round.
4. Submit one final guess, then skip the next round if wrong.

Verification only says whether the answer is inside the checked set. It never reveals the exact sequence unless a final guess is correct. Wrong public submissions remove that sequence from every player's candidate book.

## Play Online

Solo version, deployed directly on GitHub Pages:

https://stablejimu.github.io/sequence-table-mvp/

Online multiplayer version, deployed on Render:

https://sequence-table.onrender.com/

## Modes

Solo mode:

- 2 to 4 total players
- 1 human plus rule-based AI opponents
- Sequence length 3, 4, or 5
- Configurable score target

Online multiplayer:

- X=4 only for now
- 2 to 4 seats
- Human players can join by room link or room code
- Empty seats are filled by configurable AI players
- Match target is 15 points
- After each puzzle, every human player must ready up before the next puzzle starts

## Scoring

Each puzzle ranks players by when they find the answer.

- 2 players: `5 / 0`
- 3 players: `5 / 3 / 0`
- 4 players: `5 / 3 / 2 / 0`

Ties split the points for the tied placements, rounded to the nearest whole point. If everyone ties, everyone gets 2 points.

In online multiplayer, the match ends automatically after a puzzle when at least one player reaches 15 total points.

## How To Play

Use Add to place possible answers into your public book. This gives you material to verify later, but also gives opponents more public information.

Use Verify Mine to check any live entries in your own public book. A yes result shrinks your private candidate book to that checked set. A no result removes the checked set.

Use Verify Table to check every unique sequence currently visible on the table. This can be powerful, but costs your next round.

Use Submit when your candidate book is small enough to risk a final answer. A wrong submit is public and removes that sequence for everyone.

The useful social layer comes from watching what other players add, verify, and submit. Their choices can imply what their private candidate book probably contains.

## AI Players

AI players do not peek at the answer or at hidden human information. They use:

- Their own candidate book
- Their own public book
- Public table books
- Public wrong submissions
- Their own verification results
- Public action patterns

The AI scores possible actions each round:

- Add is useful when the AI needs more candidates in its own book.
- Verify Mine is useful when it can split the candidate pool.
- Verify Table is useful when the public table gives a strong split despite the skip cost.
- Submit is considered when the candidate pool is small.

The AI then chooses with softmax-style randomness, so strong actions are favored without making every AI turn deterministic.

Current AI types:

- Balanced: general value-scored strategy
- Aggressive: submits earlier
- Cautious: submits later
- Binary: benchmark strategy that adds toward a half split, then verifies
- Reader: uses simple public inference from visible opponent behavior

## AI Tuning

The AI is not trained live in the browser. The current constants were tuned with lightweight self-play simulations.

Run baseline simulations:

```bash
node tools/ai-selfplay.js
```

Run parameter search:

```bash
node tools/ai-selfplay.js search
```

The search mutates action-value constants such as add value, verify value, table-check value, skip penalty, submit value, and softmax temperature. Better parameter sets are chosen by simulated finish speed and reduced reckless wrong submits.

## Run Locally

Solo static build:

```text
open index.html
```

Multiplayer Node server:

```bash
npm start
```

Then open:

```text
http://localhost:3000/
```

The multiplayer server owns the hidden answer, verification results, private candidate books, AI turns, room state, and ready checks.

