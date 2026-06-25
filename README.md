# Sequence Table MVP

A small local prototype for a social deduction-style sequence guessing game.

Players sit around a shared table and race to identify one hidden permutation, such as `3142`. Each player keeps a public book of sequences they have added, while each player also has a private candidate book that tracks what they still believe could be the answer.

The current MVP is a static browser app with one human player and one to three rule-based AI opponents.

## Run Locally

Open `index.html` in a browser.

No install step is required for the game itself. It is plain HTML, CSS, and JavaScript.

## Game Modes

- Players: 2 to 4
- Sequence length: 3, 4, or 5
- Default mode: 4 players, length 4
- Score target: configurable in the start screen

Add amount depends on sequence length:

- Length 3: add 2 sequences
- Length 4: add 3 sequences
- Length 5: add 10 sequences

## How To Play

Each puzzle has one hidden answer. On your turn, choose one action:

1. Add sequences from your private candidate book into your public book.
2. Verify any selected live sequences in your own book.
3. Verify the whole public table, then skip your next turn.
4. Submit one final guess, then skip your next turn if it is wrong.

Verification only returns whether the answer is inside the checked set. It does not reveal which sequence is correct.

When verification returns yes, your private candidate book shrinks to the checked set. When it returns no, those checked sequences are removed. Wrong public submissions are removed from every player's candidate book.

When the human player wins a puzzle, the AI players keep playing until they all find the real key. The end screen lets you inspect AI logs and review their decisions.

## AI Players

The AI does not peek at the answer or at another player's private candidate book. It only uses information that the player would fairly know:

- Its own public book
- Its private candidate book
- Public books on the table
- Public wrong submissions
- Its own previous verification results

Each turn, the AI scores possible actions:

- Add is valuable when the AI has useful candidates that are not in its book yet.
- Verify Mine is valuable when its own book can split the candidate pool, ideally near a half split.
- Verify Table is valuable when the public table can split the candidate pool enough to justify skipping next turn.
- Submit is considered when the candidate pool is small, with different thresholds for aggressive, balanced, and cautious AI personalities.

The AI chooses between scored actions with a softmax, so higher-value actions are more likely but not perfectly deterministic.

## AI Tuning

The AI is not trained live in the browser. Its action values were tuned with lightweight self-play simulation.

Run the baseline evaluator:

```bash
node tools/ai-selfplay.js
```

Run the search tuner:

```bash
node tools/ai-selfplay.js search
```

The tuner mutates constants such as verify value, table-check value, skip penalty, submit threshold value, and softmax temperature. It then runs many simulated games and keeps constants that improve average finish time while controlling reckless wrong submissions.

The tuned constants are copied into `game.js` as `AI_TUNING`.
