const DEFAULT_CONSTANTS = {
  addCapMultiplier: 2.2,
  verifyOwnScale: 0.97,
  verifyOwnCoverageFloor: 0.33,
  verifyOwnCoverageRampStart: 0.094,
  verifyOwnCoverageRampEnd: 0.295,
  verifyTableScale: 0.62,
  verifyTableSkipPenaltyPerAdd: 0.45,
  softmaxBaseTemperature: 2.05,
  softmaxCandidateTemperature: 0.039,
  submitBase: 7.14,
  submitStep: 1.03,
};

const ADD_BY_LENGTH = { 3: 2, 4: 3, 5: 10 };
const PERSONALITIES = ["Balanced", "Cautious", "Aggressive", "Balanced"];
const SUBMIT_THRESHOLDS = { Aggressive: 4, Balanced: 3, Cautious: 2 };
const MAX_TURNS = { 3: 12, 4: 40, 5: 80 };

function mulberry32(seed) {
  let value = seed >>> 0;
  return function random() {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function permutations(items) {
  if (items.length === 1) return items;
  const result = [];
  items.forEach((item, index) => {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    permutations(rest).forEach((perm) => result.push(item + perm));
  });
  return result;
}

function digitsForLength(length) {
  return Array.from({ length }, (_, index) => String(index + 1));
}

function sampleOne(items, random) {
  return items[Math.floor(random() * items.length)];
}

function sampleMany(items, count, random) {
  const pool = [...items];
  const result = [];
  while (pool.length > 0 && result.length < count) {
    const index = Math.floor(random() * pool.length);
    result.push(pool.splice(index, 1)[0]);
  }
  return result;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sequencesFromSet(allSequences, set) {
  return allSequences.filter((seq) => set.has(seq));
}

function expectedSplitValue(selectionCount, candidateCount) {
  return 2 * selectionCount * (candidateCount - selectionCount) / candidateCount;
}

function createPlayers(allSequences) {
  return Array.from({ length: 4 }, (_, index) => ({
    id: `p${index}`,
    personality: PERSONALITIES[index],
    book: [],
    candidate: new Set(allSequences),
    skipNext: false,
    ranked: false,
    rank: null,
    tableChecks: 0,
    wrongSubmits: 0,
    actions: { add: 0, verifyMine: 0, verifyTable: 0, submit: 0, skip: 0 },
  }));
}

function scoreAiAdd(addCount, addableCount, addAmount, allCount, constants) {
  if (addCount <= 0 || addableCount <= 0) return 0;
  const rawValue = addCount * allCount / addableCount;
  return Math.min(rawValue, addAmount * constants.addCapMultiplier);
}

function scoreAiVerifyOwn(selectionCount, candidateCount, constants) {
  if (selectionCount <= 0 || selectionCount >= candidateCount) return 0;
  const expectedSplit = expectedSplitValue(selectionCount, candidateCount);
  const coverage = selectionCount / candidateCount;
  const ramp = clamp(
    (coverage - constants.verifyOwnCoverageRampStart) /
      (constants.verifyOwnCoverageRampEnd - constants.verifyOwnCoverageRampStart),
    0,
    1,
  );
  const coverageMultiplier =
    constants.verifyOwnCoverageFloor + (1 - constants.verifyOwnCoverageFloor) * ramp;
  return expectedSplit * constants.verifyOwnScale * coverageMultiplier;
}

function scoreAiVerifyTable(tableLiveCount, candidateCount, addAmount, constants) {
  if (tableLiveCount <= 0 || tableLiveCount >= candidateCount) return 0;
  const expectedSplit = expectedSplitValue(tableLiveCount, candidateCount);
  const skipPenalty = addAmount * constants.verifyTableSkipPenaltyPerAdd;
  return Math.max(0, expectedSplit * constants.verifyTableScale - skipPenalty);
}

function scoreAiSubmit(candidateCount, submitThreshold, constants) {
  return constants.submitBase + Math.max(0, submitThreshold - candidateCount + 1) * constants.submitStep;
}

function chooseSoftmaxOption(options, temperature, random) {
  const maxValue = Math.max(...options.map((option) => option.value));
  const weighted = options.map((option) => ({
    ...option,
    weight: Math.exp((option.value - maxValue) / temperature),
  }));
  const totalWeight = weighted.reduce((sum, option) => sum + option.weight, 0);
  let cursor = random() * totalWeight;
  for (const option of weighted) {
    cursor -= option.weight;
    if (cursor <= 0) return option.action;
  }
  return weighted[weighted.length - 1].action;
}

function chooseAiVerifySelection(ownLive, candidateCount, random) {
  if (ownLive.length === 0 || candidateCount <= 1) return [];
  const targetSize = Math.max(1, Math.floor(candidateCount / 2));
  if (ownLive.length <= targetSize) return [...ownLive];
  return sampleMany(ownLive, targetSize, random);
}

function aiSoftmaxTemperature(candidateCount, constants) {
  return Math.max(
    constants.softmaxBaseTemperature,
    candidateCount * constants.softmaxCandidateTemperature,
  );
}

function chooseAiAction(player, context) {
  const {
    addAmount,
    allSequences,
    constants,
    random,
    snapshotBooks,
  } = context;
  const candidateList = sequencesFromSet(allSequences, player.candidate);
  const candidateCount = candidateList.length;
  const ownLive = player.book.filter((seq) => player.candidate.has(seq));
  const options = [];

  if (candidateCount <= 1) {
    return { type: "submit", guess: candidateList[0] };
  }

  const submitThreshold = SUBMIT_THRESHOLDS[player.personality] || SUBMIT_THRESHOLDS.Balanced;
  if (candidateCount <= submitThreshold) {
    options.push({
      action: { type: "submit", guess: sampleOne(candidateList, random) },
      value: scoreAiSubmit(candidateCount, submitThreshold, constants),
    });
  }

  const verifySelection = chooseAiVerifySelection(ownLive, candidateCount, random);
  if (verifySelection.length > 0 && verifySelection.length < candidateCount) {
    options.push({
      action: { type: "verifyMine", selection: verifySelection },
      value: scoreAiVerifyOwn(verifySelection.length, candidateCount, constants),
    });
  }

  const tableSet = new Set();
  snapshotBooks.forEach((book) => book.forEach((seq) => tableSet.add(seq)));
  const tableLive = [...tableSet].filter((seq) => player.candidate.has(seq));
  const tableValue = scoreAiVerifyTable(tableLive.length, candidateCount, addAmount, constants);
  if (tableValue > 0 && tableLive.length > 0 && tableLive.length < candidateCount) {
    options.push({
      action: { type: "verifyTable" },
      value: tableValue,
    });
  }

  const addable = candidateList.filter((seq) => !player.book.includes(seq));
  if (addable.length > 0) {
    const addCount = Math.min(addAmount, addable.length);
    options.push({
      action: { type: "add", sequences: sampleMany(addable, addCount, random) },
      value: scoreAiAdd(addCount, addable.length, addAmount, allSequences.length, constants),
    });
  }

  if (options.length === 0) {
    return { type: "submit", guess: sampleOne(candidateList, random) };
  }

  return chooseSoftmaxOption(options, aiSoftmaxTemperature(candidateCount, constants), random);
}

function applyVerification(player, selection, answer) {
  if (selection.length === 0) return;
  const selectedSet = new Set(selection);
  if (selectedSet.has(answer)) {
    player.candidate = intersectSets(player.candidate, selectedSet);
  } else {
    selection.forEach((seq) => player.candidate.delete(seq));
  }
}

function applyTableVerification(player, tableSet, answer) {
  if (tableSet.has(answer)) {
    player.candidate = intersectSets(player.candidate, tableSet);
  } else {
    tableSet.forEach((seq) => player.candidate.delete(seq));
  }
}

function intersectSets(left, right) {
  const result = new Set();
  left.forEach((value) => {
    if (right.has(value)) result.add(value);
  });
  return result;
}

function simulatePuzzle(constants, options) {
  const {
    length = 4,
    seed = 1,
  } = options;
  const random = mulberry32(seed);
  const allSequences = permutations(digitsForLength(length));
  const addAmount = ADD_BY_LENGTH[length];
  const answer = sampleOne(allSequences, random);
  const players = createPlayers(allSequences);
  let firstSolveTurn = null;
  let firstSolver = null;
  let totalWrongSubmits = 0;

  for (let turn = 1; turn <= MAX_TURNS[length]; turn += 1) {
    const snapshotBooks = new Map(players.map((player) => [player.id, [...player.book]]));
    const actions = new Map();

    players.forEach((player) => {
      if (player.ranked) return;
      if (player.skipNext) {
        player.skipNext = false;
        player.actions.skip += 1;
        return;
      }
      const action = chooseAiAction(player, {
        addAmount,
        allSequences,
        constants,
        random,
        snapshotBooks,
      });
      actions.set(player.id, action);
      player.actions[action.type] += 1;
    });

    const tableSet = new Set();
    snapshotBooks.forEach((book) => book.forEach((seq) => tableSet.add(seq)));
    const publicWrong = [];
    const addBatches = [];
    const correct = [];

    players.forEach((player) => {
      const action = actions.get(player.id);
      if (!action) return;

      if (action.type === "add") {
        addBatches.push({ player, sequences: action.sequences });
      } else if (action.type === "verifyMine") {
        applyVerification(player, action.selection.filter((seq) => player.book.includes(seq)), answer);
      } else if (action.type === "verifyTable") {
        applyTableVerification(player, tableSet, answer);
        player.skipNext = true;
        player.tableChecks += 1;
      } else if (action.type === "submit") {
        if (action.guess === answer) {
          correct.push(player);
        } else if (action.guess) {
          publicWrong.push(action.guess);
          player.candidate.delete(action.guess);
          player.skipNext = true;
          player.wrongSubmits += 1;
          totalWrongSubmits += 1;
        }
      }
    });

    [...new Set(publicWrong)].forEach((seq) => {
      players.forEach((player) => player.candidate.delete(seq));
    });

    addBatches.forEach(({ player, sequences }) => {
      sequences.forEach((seq) => {
        if (!player.book.includes(seq)) player.book.push(seq);
      });
    });

    if (correct.length > 0) {
      firstSolveTurn = turn;
      firstSolver = correct[0].id;
      break;
    }
  }

  const actionTotals = players.reduce((totals, player) => {
    Object.entries(player.actions).forEach(([action, count]) => {
      totals[action] = (totals[action] || 0) + count;
    });
    return totals;
  }, {});

  return {
    firstSolveTurn: firstSolveTurn || MAX_TURNS[length] + 1,
    firstSolver,
    totalWrongSubmits,
    actionTotals,
  };
}

function evaluate(constants, options = {}) {
  const {
    length = 4,
    games = 1000,
    seed = 1000,
  } = options;
  const turns = [];
  let wrongSubmits = 0;
  const actionTotals = {};

  for (let index = 0; index < games; index += 1) {
    const result = simulatePuzzle(constants, { length, seed: seed + index * 9973 });
    turns.push(result.firstSolveTurn);
    wrongSubmits += result.totalWrongSubmits;
    Object.entries(result.actionTotals).forEach(([action, count]) => {
      actionTotals[action] = (actionTotals[action] || 0) + count;
    });
  }

  turns.sort((left, right) => left - right);
  const mean = turns.reduce((sum, value) => sum + value, 0) / turns.length;
  const percentile = (p) => turns[Math.min(turns.length - 1, Math.floor(turns.length * p))];
  return {
    mean,
    p25: percentile(0.25),
    p50: percentile(0.5),
    p75: percentile(0.75),
    p90: percentile(0.9),
    wrongPerGame: wrongSubmits / games,
    actionShare: Object.fromEntries(Object.entries(actionTotals).map(([action, count]) => [
      action,
      count / Object.values(actionTotals).reduce((sum, value) => sum + value, 0),
    ])),
    score: mean + wrongSubmits / games * 0.35 + percentile(0.9) * 0.04,
  };
}

function mutateConstants(base, random, spread = 1) {
  const ranged = {
    addCapMultiplier: [2.2, 5.5],
    verifyOwnScale: [0.65, 1.35],
    verifyOwnCoverageFloor: [0.25, 0.75],
    verifyOwnCoverageRampStart: [0.05, 0.18],
    verifyOwnCoverageRampEnd: [0.25, 0.48],
    verifyTableScale: [0.38, 0.95],
    verifyTableSkipPenaltyPerAdd: [0.2, 0.75],
    softmaxBaseTemperature: [0.8, 3.2],
    softmaxCandidateTemperature: [0.015, 0.07],
    submitBase: [5.5, 13],
    submitStep: [0.6, 3.2],
  };
  const next = { ...base };
  Object.entries(ranged).forEach(([key, [min, max]]) => {
    const span = (max - min) * 0.3 * spread;
    const delta = (random() * 2 - 1) * span;
    next[key] = clamp(next[key] + delta, min, max);
  });
  if (next.verifyOwnCoverageRampEnd <= next.verifyOwnCoverageRampStart + 0.08) {
    next.verifyOwnCoverageRampEnd = next.verifyOwnCoverageRampStart + 0.08;
  }
  return next;
}

function search() {
  const random = mulberry32(424242);
  let best = { constants: DEFAULT_CONSTANTS, metrics: evaluate(DEFAULT_CONSTANTS, { length: 4, games: 1500, seed: 50000 }) };
  const candidates = [best];

  for (let round = 0; round < 4; round += 1) {
    const parents = candidates
      .sort((left, right) => left.metrics.score - right.metrics.score)
      .slice(0, 8);
    const spread = 1 / (round + 1);

    for (const parent of parents) {
      for (let index = 0; index < 18; index += 1) {
        const constants = mutateConstants(parent.constants, random, spread);
        const metrics = evaluate(constants, {
          length: 4,
          games: round < 2 ? 700 : 1200,
          seed: 70000 + round * 100000 + index * 3000,
        });
        candidates.push({ constants, metrics });
      }
    }

    best = candidates.sort((left, right) => left.metrics.score - right.metrics.score)[0];
    console.log(`round ${round + 1}`, JSON.stringify({ metrics: best.metrics, constants: best.constants }, null, 2));
  }

  const finalMetrics = {
    x3: evaluate(best.constants, { length: 3, games: 3000, seed: 300000 }),
    x4: evaluate(best.constants, { length: 4, games: 5000, seed: 400000 }),
    x5: evaluate(best.constants, { length: 5, games: 2500, seed: 500000 }),
  };
  console.log("BEST", JSON.stringify({ constants: best.constants, finalMetrics }, null, 2));
}

const command = process.argv[2] || "baseline";
if (command === "search") {
  search();
} else {
  const games = Number(process.argv[3] || 3000);
  console.log(JSON.stringify({
    x3: evaluate(DEFAULT_CONSTANTS, { length: 3, games, seed: 10000 }),
    x4: evaluate(DEFAULT_CONSTANTS, { length: 4, games, seed: 20000 }),
    x5: evaluate(DEFAULT_CONSTANTS, { length: 5, games: Math.max(500, Math.floor(games / 2)), seed: 30000 }),
  }, null, 2));
}
