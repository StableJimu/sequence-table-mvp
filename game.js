(() => {
  "use strict";

  const DEFAULT_COMMIT_TIME = 30;
  const PAGE_SIZE = 20;
  const ADD_BY_LENGTH = { 3: 2, 4: 3, 5: 10 };
  const SCORE_BY_PLAYERS = {
    2: [5, 0],
    3: [5, 3, 0],
    4: [5, 3, 2, 0],
  };
  const AI_TUNING = {
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
  const AI_SUBMIT_THRESHOLDS = {
    Aggressive: 4,
    Balanced: 3,
    Cautious: 2,
  };
  const AI_FINISH_ROUND_LIMIT_MULTIPLIER = 20;
  const AI_NAMES = ["Mina", "Sol", "Beck"];
  const AI_PERSONALITIES = ["Balanced", "Cautious", "Aggressive"];

  let allSequences = [];
  const app = document.getElementById("app");

  let audioContext = null;

  const state = {
    config: {
      playerCount: 4,
      sequenceLength: 4,
      target: 15,
      sound: true,
    },
    players: [],
    answer: "",
    puzzleNumber: 0,
    roundNumber: 0,
    ranks: [],
    publicEliminated: new Set(),
    phase: "setup",
    actionStartedAt: 0,
    snapshotBooks: new Map(),
    pendingActions: new Map(),
    publicFeed: [],
    puzzleResult: null,
    gameWinner: null,
    lowLikely: new Set(),
    ui: {
      actionPage: 0,
      drawerOpen: false,
      aiLogsOpen: false,
      resultModalOpen: false,
      drawerPage: 0,
      selectedAdd: new Set(),
      selectedVerify: new Set(),
      selectedSubmit: null,
      humanChoice: null,
    },
  };

  app.addEventListener("click", handleClick);
  app.addEventListener("change", handleChange);

  render();

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

  function startNewGame() {
    allSequences = permutations(digitsForLength(state.config.sequenceLength));
    state.players = createPlayers(state.config.playerCount);
    state.puzzleNumber = 0;
    state.roundNumber = 0;
    state.publicFeed = [];
    state.puzzleResult = null;
    state.gameWinner = null;
    state.lowLikely = new Set();
    state.ui.drawerOpen = false;
    state.ui.aiLogsOpen = false;
    state.ui.resultModalOpen = false;
    state.phase = "setup";
    startNewPuzzle();
  }

  function createPlayers(count) {
    const players = [
      createPlayer("p0", "You", "human", "Human"),
    ];
    for (let index = 1; index < count; index += 1) {
      players.push(createPlayer(`p${index}`, AI_NAMES[index - 1], "ai", AI_PERSONALITIES[index - 1]));
    }
    return players;
  }

  function createPlayer(id, name, type, personality) {
    return {
      id,
      name,
      type,
      personality,
      score: 0,
      book: [],
      candidate: new Set(allSequences),
      skipNext: false,
      ranked: false,
      rank: null,
      lastAction: "Ready",
      privateLog: [],
      tableChecks: 0,
    };
  }

  function startNewPuzzle() {
    state.puzzleNumber += 1;
    state.roundNumber = 0;
    state.answer = sampleOne(allSequences);
    state.ranks = [];
    state.publicEliminated = new Set();
    state.pendingActions = new Map();
    state.snapshotBooks = new Map();
    state.puzzleResult = null;
    state.gameWinner = null;
    state.lowLikely = new Set();
    state.ui.drawerOpen = false;
    state.ui.aiLogsOpen = false;
    state.ui.resultModalOpen = false;
    state.publicFeed = [`Puzzle ${state.puzzleNumber} begins.`];

    state.players.forEach((player) => {
      player.book = [];
      player.candidate = new Set(allSequences);
      player.skipNext = false;
      player.ranked = false;
      player.rank = null;
      player.lastAction = "Ready";
      player.privateLog = [];
      player.tableChecks = 0;
    });

    startChoicePhase();
  }

  function startChoicePhase({ advanceRound = true } = {}) {
    if (advanceRound) {
      state.roundNumber += 1;
    }
    state.phase = "choice";
    state.actionStartedAt = 0;
    state.pendingActions = new Map();
    state.snapshotBooks = new Map(state.players.map((player) => [player.id, [...player.book]]));
    resetActionUi();

    state.players.forEach((player) => {
      if (player.ranked) {
        player.lastAction = `Rank ${player.rank}`;
      } else if (player.skipNext) {
        player.lastAction = "Skipping";
      } else {
        player.lastAction = "Choosing";
      }
    });

    render();
  }

  function startActionPhase() {
    state.phase = "action";
    state.actionStartedAt = Date.now();
    state.pendingActions = new Map();
    resetActionUi(false);

    state.players.forEach((player) => {
      if (player.ranked) {
        state.pendingActions.set(player.id, { type: "ranked" });
        return;
      }

      if (player.skipNext) {
        player.lastAction = "Skipped";
        state.pendingActions.set(player.id, { type: "skip" });
        return;
      }

      if (player.type === "human") {
        const choice = state.ui.humanChoice || "add";
        player.lastAction = actionTitle(choice);
        state.pendingActions.set(player.id, { type: choice, committed: false });
        return;
      }

      const action = chooseAiAction(player);
      player.lastAction = actionTitle(action.type);
      state.pendingActions.set(player.id, action);
    });

    const humanAction = getHumanPendingAction();
    if (!humanAction || humanAction.type === "ranked" || humanAction.type === "skip") {
      window.setTimeout(resolveRound, 650);
      render();
      return;
    }

    render();
  }

  function resetActionUi(clearChoice = true) {
    state.ui.actionPage = 0;
    state.ui.drawerPage = 0;
    state.ui.selectedAdd = new Set();
    state.ui.selectedVerify = new Set();
    state.ui.selectedSubmit = null;
    if (clearChoice) {
      state.ui.humanChoice = null;
    }
  }

  function chooseAiAction(player) {
    const candidateList = sequencesFromSet(player.candidate);
    const candidateCount = candidateList.length;
    const addAmount = currentAddAmount();
    const ownLive = player.book.filter((seq) => player.candidate.has(seq));
    const options = [];

    if (candidateCount <= 1) {
      addPrivateLog(player, `${roundLabel()}: decision forced Submit; 1 candidate left.`);
      return {
        type: "submit",
        guess: candidateList[0],
        commitTime: randomInt(3, 26),
        committed: true,
      };
    }

    const submitThreshold = AI_SUBMIT_THRESHOLDS[player.personality] || AI_SUBMIT_THRESHOLDS.Balanced;
    if (candidateCount <= submitThreshold) {
      options.push({
        action: {
          type: "submit",
          guess: sampleOne(candidateList),
          commitTime: randomInt(3, 26),
          committed: true,
        },
        value: scoreAiSubmit(candidateCount, submitThreshold),
      });
    }

    const verifySelection = chooseAiVerifySelection(ownLive, candidateCount);
    if (verifySelection.length > 0 && verifySelection.length < candidateCount) {
      options.push({
        action: {
          type: "verifyMine",
          selection: verifySelection,
          committed: true,
        },
        value: scoreAiVerifyOwn(verifySelection.length, candidateCount),
      });
    }

    const tableSet = getSnapshotTableSet();
    const tableLive = [...tableSet].filter((seq) => player.candidate.has(seq));
    const tableValue = scoreAiVerifyTable(tableLive.length, candidateCount, addAmount);
    if (tableValue > 0 && tableLive.length > 0 && tableLive.length < candidateCount) {
      options.push({
        action: {
          type: "verifyTable",
          committed: true,
        },
        value: tableValue,
      });
    }

    const addable = candidateList.filter((seq) => !player.book.includes(seq));
    if (addable.length > 0) {
      const addCount = Math.min(addAmount, addable.length);
      options.push({
        action: {
          type: "add",
          sequences: sampleMany(addable, addCount),
          committed: true,
        },
        value: scoreAiAdd(addCount, addable.length, addAmount),
      });
    }

    if (options.length === 0) {
      addPrivateLog(player, `${roundLabel()}: decision fallback Submit; ${candidateCount} candidates.`);
      return {
        type: "submit",
        guess: sampleOne(candidateList),
        commitTime: randomInt(3, 26),
        committed: true,
      };
    }

    const choice = chooseSoftmaxOption(options, aiSoftmaxTemperature(candidateCount));
    addPrivateLog(
      player,
      `${roundLabel()}: decision C=${candidateCount}, own=${ownLive.length}; ${formatAiDecisionOptions(options)} -> ${actionTitle(choice.type)}.`,
    );
    if (choice.type === "verifyTable") {
      player.tableChecks += 1;
    }
    return choice;
  }

  function chooseAiVerifySelection(ownLive, candidateCount) {
    if (ownLive.length === 0 || candidateCount <= 1) return [];
    const targetSize = Math.max(1, Math.floor(candidateCount / 2));
    if (ownLive.length <= targetSize) return [...ownLive];
    return sampleMany(ownLive, targetSize);
  }

  function scoreAiAdd(addCount, addableCount, addAmount) {
    if (addCount <= 0 || addableCount <= 0) return 0;
    const rawValue = addCount * allSequences.length / addableCount;
    return Math.min(rawValue, addAmount * AI_TUNING.addCapMultiplier);
  }

  function scoreAiVerifyOwn(selectionCount, candidateCount) {
    if (selectionCount <= 0 || selectionCount >= candidateCount) return 0;
    const expectedSplit = expectedSplitValue(selectionCount, candidateCount);
    const coverage = selectionCount / candidateCount;
    const ramp = clamp(
      (coverage - AI_TUNING.verifyOwnCoverageRampStart) /
        (AI_TUNING.verifyOwnCoverageRampEnd - AI_TUNING.verifyOwnCoverageRampStart),
      0,
      1,
    );
    const coverageMultiplier =
      AI_TUNING.verifyOwnCoverageFloor + (1 - AI_TUNING.verifyOwnCoverageFloor) * ramp;
    return expectedSplit * AI_TUNING.verifyOwnScale * coverageMultiplier;
  }

  function scoreAiVerifyTable(tableLiveCount, candidateCount, addAmount) {
    if (tableLiveCount <= 0 || tableLiveCount >= candidateCount) return 0;
    const expectedSplit = expectedSplitValue(tableLiveCount, candidateCount);
    const skipPenalty = addAmount * AI_TUNING.verifyTableSkipPenaltyPerAdd;
    return Math.max(0, expectedSplit * AI_TUNING.verifyTableScale - skipPenalty);
  }

  function scoreAiSubmit(candidateCount, submitThreshold) {
    return AI_TUNING.submitBase + Math.max(0, submitThreshold - candidateCount + 1) * AI_TUNING.submitStep;
  }

  function expectedSplitValue(selectionCount, candidateCount) {
    return 2 * selectionCount * (candidateCount - selectionCount) / candidateCount;
  }

  function aiSoftmaxTemperature(candidateCount) {
    return Math.max(
      AI_TUNING.softmaxBaseTemperature,
      candidateCount * AI_TUNING.softmaxCandidateTemperature,
    );
  }

  function chooseSoftmaxOption(options, temperature) {
    const maxValue = Math.max(...options.map((option) => option.value));
    const weighted = options.map((option) => ({
      ...option,
      weight: Math.exp((option.value - maxValue) / temperature),
    }));
    const totalWeight = weighted.reduce((sum, option) => sum + option.weight, 0);
    let cursor = Math.random() * totalWeight;
    for (const option of weighted) {
      cursor -= option.weight;
      if (cursor <= 0) return option.action;
    }
    return weighted[weighted.length - 1].action;
  }

  function commitHumanAction(reason) {
    const action = getHumanPendingAction();
    if (!action || action.committed) return;

    const human = getHuman();
    const elapsed = state.actionStartedAt ? Math.max(0, (Date.now() - state.actionStartedAt) / 1000) : 0;
    const addAmount = currentAddAmount();

    if (action.type === "add") {
      const addable = getHumanAddable();
      const picked = [...state.ui.selectedAdd].filter((seq) => addable.includes(seq));
      const missing = addAmount - picked.length;
      const filled = missing > 0
        ? [...picked, ...sampleMany(addable.filter((seq) => !picked.includes(seq)), missing)]
        : picked.slice(0, addAmount);
      action.sequences = filled;
      action.committed = true;
    }

    if (action.type === "verifyMine") {
      const allowed = new Set(human.book.filter((seq) => human.candidate.has(seq)));
      action.selection = [...state.ui.selectedVerify].filter((seq) => allowed.has(seq));
      action.committed = true;
    }

    if (action.type === "verifyTable") {
      action.committed = true;
    }

    if (action.type === "submit") {
      action.guess = state.ui.selectedSubmit;
      action.commitTime = elapsed;
      action.committed = true;
    }

    playCue("submit");
    resolveRound();
  }

  function resolveRound() {
    if (state.phase !== "action") return;

    state.phase = "reveal";

    const tableSet = getSnapshotTableSet();
    const correctSubmissions = [];
    const publicWrong = [];
    const addBatches = [];
    const feed = [];

    state.players.forEach((player) => {
      const action = state.pendingActions.get(player.id);
      if (!action || action.type === "ranked") return;

      if (action.type === "skip") {
        player.skipNext = false;
        feed.push(`${player.name} skipped.`);
        addPrivateLog(player, `${roundLabel()}: skipped.`);
        return;
      }

      if (action.type === "add") {
        const sequences = unique(action.sequences || []).filter((seq) => allSequences.includes(seq));
        addBatches.push({ player, sequences });
        feed.push(`${player.name} added ${sequences.length}.`);
        addPrivateLog(player, `${roundLabel()}: added ${formatSequenceList(sequences)}.`);
        return;
      }

      if (action.type === "verifyMine") {
        const selection = unique(action.selection || []).filter((seq) => player.book.includes(seq));
        applyVerification(player, selection, "Verify Mine", feed);
        return;
      }

      if (action.type === "verifyTable") {
        applyTableVerification(player, tableSet, feed);
        player.skipNext = true;
        return;
      }

      if (action.type === "submit") {
        if (!action.guess) {
          feed.push(`${player.name} submitted nothing.`);
          addPrivateLog(player, `${roundLabel()}: Submit no selection.`);
          return;
        }

        if (action.guess === state.answer) {
          correctSubmissions.push({
            player,
            commitTime: action.commitTime ?? DEFAULT_COMMIT_TIME,
          });
          feed.push(`${player.name} submitted correctly.`);
          addPrivateLog(player, `${roundLabel()}: submitted ${action.guess} correctly.`);
        } else {
          publicWrong.push(action.guess);
          player.candidate.delete(action.guess);
          player.skipNext = true;
          feed.push(`${player.name} missed with ${action.guess}.`);
          addPrivateLog(player, `${roundLabel()}: submitted ${action.guess}; wrong, skip next.`);
        }
      }
    });

    unique(publicWrong).forEach((seq) => {
      state.publicEliminated.add(seq);
      state.players.forEach((player) => {
        const before = player.candidate.size;
        player.candidate.delete(seq);
        if (player.candidate.size !== before && player.type === "ai") {
          addPrivateLog(player, `${roundLabel()}: public miss ${seq} removed from candidates.`);
        }
      });
    });

    addBatches.forEach(({ player, sequences }) => {
      sequences.forEach((seq) => {
        if (!player.book.includes(seq)) {
          player.book.push(seq);
        }
      });
    });

    correctSubmissions
      .sort((a, b) => a.commitTime - b.commitTime || playerSeatIndex(a.player.id) - playerSeatIndex(b.player.id))
      .forEach(({ player }) => assignRank(player));

    state.publicFeed = [...feed, ...state.publicFeed].slice(0, 8);

    const human = getHuman();
    if (human.rank === 1) {
      finishRemainingAisByPlay();
      endPuzzle("human-win-ai-finished");
      return;
    }

    if (state.ranks.length >= state.players.length - 1) {
      autoResolveRemainingPlayers();
      endPuzzle("all-paid-ranks");
      return;
    }

    playCue(correctSubmissions.length > 0 ? "correct" : publicWrong.length > 0 ? "wrong" : "reveal");
    render();
  }

  function applyVerification(player, selection, label, feed) {
    if (selection.length === 0) {
      feed.push(`${player.name} verified nothing.`);
      addPrivateLog(player, `${roundLabel()}: ${label} no selection.`);
      return;
    }

    const selectedSet = new Set(selection);
    const before = player.candidate.size;
    const yes = selectedSet.has(state.answer);
    if (yes) {
      player.candidate = intersectSets(player.candidate, selectedSet);
    } else {
      selection.forEach((seq) => player.candidate.delete(seq));
    }
    const after = player.candidate.size;
    feed.push(`${player.name} verified own book.`);
    addPrivateLog(
      player,
      `${roundLabel()}: ${label} ${selection.length} -> ${yes ? "YES" : "NO"} (${before} to ${after}); ${formatSequenceList(selection)}.`,
    );
    if (player.type === "human") {
      playCue(yes ? "yes" : "no");
    }
  }

  function applyTableVerification(player, tableSet, feed) {
    const before = player.candidate.size;
    const yes = tableSet.has(state.answer);
    if (yes) {
      player.candidate = intersectSets(player.candidate, tableSet);
    } else {
      tableSet.forEach((seq) => player.candidate.delete(seq));
    }
    const after = player.candidate.size;
    feed.push(`${player.name} checked the table.`);
    addPrivateLog(player, `${roundLabel()}: Verify Table ${tableSet.size} -> ${yes ? "YES" : "NO"} (${before} to ${after}).`);
    if (player.type === "human") {
      playCue(yes ? "yes" : "no");
    }
  }

  function assignRank(player) {
    if (player.ranked) return;
    player.ranked = true;
    player.rank = state.ranks.length + 1;
    player.lastAction = `Rank ${player.rank}`;
    state.ranks.push(player.id);
  }

  function autoResolveRemainingPlayers() {
    const remaining = state.players.filter((player) => !player.ranked);
    remaining
      .sort((a, b) => aiResolveScore(a) - aiResolveScore(b))
      .forEach((player) => assignRank(player));
  }

  function finishRemainingAisByPlay() {
    const maxExtraRounds = Math.max(120, allSequences.length * AI_FINISH_ROUND_LIMIT_MULTIPLIER);
    let extraRounds = 0;

    while (state.players.some((player) => player.type === "ai" && !player.ranked) && extraRounds < maxExtraRounds) {
      extraRounds += 1;
      state.roundNumber += 1;
      const snapshotBooks = new Map(state.players.map((player) => [player.id, [...player.book]]));
      const tableSet = tableSetFromSnapshot(snapshotBooks);
      const feed = [];
      const publicWrong = [];
      const addBatches = [];
      const correctSubmissions = [];

      state.players.forEach((player) => {
        if (player.type !== "ai" || player.ranked) return;

        if (player.skipNext) {
          player.skipNext = false;
          player.lastAction = "Skipped";
          addPrivateLog(player, `${roundLabel()}: skipped during AI finish.`);
          feed.push(`${player.name} skipped.`);
          return;
        }

        const action = chooseAiAction(player);
        player.lastAction = actionTitle(action.type);

        if (action.type === "add") {
          const sequences = unique(action.sequences || []).filter((seq) => allSequences.includes(seq));
          addBatches.push({ player, sequences });
          addPrivateLog(player, `${roundLabel()}: added ${formatSequenceList(sequences)} during AI finish.`);
          feed.push(`${player.name} added ${sequences.length}.`);
          return;
        }

        if (action.type === "verifyMine") {
          const selection = unique(action.selection || []).filter((seq) => player.book.includes(seq));
          applyVerification(player, selection, "Verify Mine", feed);
          return;
        }

        if (action.type === "verifyTable") {
          applyTableVerification(player, tableSet, feed);
          player.skipNext = true;
          return;
        }

        if (action.type === "submit") {
          if (action.guess === state.answer) {
            correctSubmissions.push({
              player,
              commitTime: action.commitTime ?? DEFAULT_COMMIT_TIME,
            });
            addPrivateLog(player, `${roundLabel()}: submitted ${action.guess} correctly during AI finish.`);
            feed.push(`${player.name} submitted correctly.`);
          } else if (action.guess) {
            publicWrong.push(action.guess);
            player.candidate.delete(action.guess);
            player.skipNext = true;
            addPrivateLog(player, `${roundLabel()}: submitted ${action.guess}; wrong during AI finish, skip next.`);
            feed.push(`${player.name} missed with ${action.guess}.`);
          }
        }
      });

      unique(publicWrong).forEach((seq) => {
        state.publicEliminated.add(seq);
        state.players.forEach((player) => {
          const before = player.candidate.size;
          player.candidate.delete(seq);
          if (player.type === "ai" && player.candidate.size !== before) {
            addPrivateLog(player, `${roundLabel()}: public miss ${seq} removed from candidates during AI finish.`);
          }
        });
      });

      addBatches.forEach(({ player, sequences }) => {
        sequences.forEach((seq) => {
          if (!player.book.includes(seq)) {
            player.book.push(seq);
          }
        });
      });

      correctSubmissions
        .sort((a, b) => a.commitTime - b.commitTime || playerSeatIndex(a.player.id) - playerSeatIndex(b.player.id))
        .forEach(({ player }) => assignRank(player));

      state.publicFeed = [...feed, ...state.publicFeed].slice(0, 8);
    }

    const unresolvedAis = state.players.filter((player) => player.type === "ai" && !player.ranked);
    if (unresolvedAis.length > 0) {
      unresolvedAis.forEach((player) => {
        addPrivateLog(player, `${roundLabel()}: normal AI finish limit reached; switching to exact endgame search.`);
      });
      finishRemainingAisByExactSearch(unresolvedAis);
    }
  }

  function finishRemainingAisByExactSearch(players) {
    const maxForcedRounds = Math.max(60, allSequences.length * 4);
    let forcedRounds = 0;

    while (players.some((player) => !player.ranked) && forcedRounds < maxForcedRounds) {
      forcedRounds += 1;
      state.roundNumber += 1;
      const feed = [];

      players.forEach((player) => {
        if (player.ranked) return;

        if (player.skipNext) {
          player.skipNext = false;
          player.lastAction = "Skipped";
          addPrivateLog(player, `${roundLabel()}: skipped during exact endgame search.`);
          feed.push(`${player.name} skipped.`);
          return;
        }

        const candidates = sequencesFromSet(player.candidate);
        if (candidates.length <= 1) {
          const guess = state.answer;
          player.candidate = new Set([state.answer]);
          player.lastAction = "Submit";
          addPrivateLog(player, `${roundLabel()}: decision exact finish C=${player.candidate.size}; Submit=forced -> Submit.`);
          addPrivateLog(player, `${roundLabel()}: submitted ${guess} correctly during exact endgame search.`);
          feed.push(`${player.name} submitted correctly.`);
          assignRank(player);
          return;
        }

        const liveOwn = candidates.filter((seq) => player.book.includes(seq));
        const missing = candidates.filter((seq) => !player.book.includes(seq));
        if (liveOwn.length === 0 && missing.length > 0) {
          const sequences = missing.slice(0, currentAddAmount());
          sequences.forEach((seq) => player.book.push(seq));
          player.lastAction = "Add";
          addPrivateLog(player, `${roundLabel()}: decision exact finish C=${candidates.length}, own=0; Add(${sequences.length})=forced -> Add.`);
          addPrivateLog(player, `${roundLabel()}: added ${formatSequenceList(sequences)} during exact endgame search.`);
          feed.push(`${player.name} added ${sequences.length}.`);
          return;
        }

        const target = Math.max(1, Math.floor(candidates.length / 2));
        const selection = liveOwn.slice(0, Math.min(target, liveOwn.length));
        player.lastAction = "Verify Mine";
        addPrivateLog(
          player,
          `${roundLabel()}: decision exact finish C=${candidates.length}, own=${liveOwn.length}; Verify Mine(${selection.length})=forced -> Verify Mine.`,
        );
        applyVerification(player, selection, "Verify Mine", feed);
      });

      state.publicFeed = [...feed, ...state.publicFeed].slice(0, 8);
    }

    players
      .filter((player) => !player.ranked)
      .forEach((player) => {
        player.candidate = new Set([state.answer]);
        player.lastAction = "Submit";
        addPrivateLog(player, `${roundLabel()}: exact endgame search hit guardrail; answer kept as only candidate.`);
        addPrivateLog(player, `${roundLabel()}: submitted ${state.answer} correctly during exact endgame search.`);
        assignRank(player);
      });
  }

  function aiResolveScore(player) {
    const liveOwn = player.book.filter((seq) => player.candidate.has(seq)).length;
    const jitter = Math.random() * 0.35;
    return player.candidate.size - liveOwn * 0.08 + jitter;
  }

  function endPuzzle(reason) {
    const scoring = SCORE_BY_PLAYERS[state.players.length];
    const resultRanks = state.ranks.map((playerId, index) => {
      const player = state.players.find((candidate) => candidate.id === playerId);
      const points = scoring[index] || 0;
      player.score += points;
      return {
        playerId,
        name: player.name,
        points,
        rank: index + 1,
      };
    });

    const topScore = Math.max(...state.players.map((player) => player.score));
    state.gameWinner = topScore >= state.config.target
      ? state.players.find((player) => player.score === topScore)
      : null;
    state.puzzleResult = {
      reason,
      answer: state.answer,
      ranks: resultRanks,
    };
    state.phase = state.gameWinner ? "gameEnd" : "roundEnd";
    state.ui.resultModalOpen = true;
    playCue(state.gameWinner ? "win" : "correct");
    render();
  }

  function handleClick(event) {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    unlockAudio();

    const action = target.dataset.action;
    const seq = target.dataset.seq;

    if (action === "start-game") {
      playCue("select");
      startNewGame();
      return;
    }

    if (action === "change-mode") {
      state.phase = "setup";
      state.ui.drawerOpen = false;
      state.ui.aiLogsOpen = false;
      state.ui.resultModalOpen = false;
      state.puzzleResult = null;
      state.gameWinner = null;
      playCue("select");
      render();
      return;
    }

    if (action === "new-game") {
      playCue("select");
      startNewGame();
      return;
    }

    if (action === "next-round") {
      playCue("select");
      startChoicePhase();
      return;
    }

    if (action === "next-puzzle") {
      playCue("select");
      startNewPuzzle();
      return;
    }

    if (action === "choose") {
      if (state.phase !== "choice" || !humanCanAct()) return;
      state.ui.humanChoice = target.dataset.choice;
      playCue("select");
      startActionPhase();
      return;
    }

    if (action === "continue-skip") {
      if (state.phase !== "choice" || humanCanAct()) return;
      playCue("select");
      startActionPhase();
      return;
    }

    if (action === "back-to-choice") {
      if (state.phase !== "action") return;
      const pending = getHumanPendingAction();
      if (pending?.committed) return;
      playCue("select");
      startChoicePhase({ advanceRound: false });
      return;
    }

    if (action === "open-candidates") {
      state.ui.drawerOpen = true;
      state.ui.aiLogsOpen = false;
      state.ui.drawerPage = 0;
      playCue("select");
      render();
      return;
    }

    if (action === "close-drawer") {
      state.ui.drawerOpen = false;
      playCue("select");
      render();
      return;
    }

    if (action === "open-ai-logs") {
      if (!isReviewPhase()) return;
      state.ui.aiLogsOpen = true;
      state.ui.drawerOpen = false;
      state.ui.resultModalOpen = false;
      playCue("select");
      render();
      return;
    }

    if (action === "close-ai-logs") {
      state.ui.aiLogsOpen = false;
      playCue("select");
      render();
      return;
    }

    if (action === "review-table") {
      if (!isReviewPhase()) return;
      state.ui.resultModalOpen = false;
      playCue("select");
      render();
      return;
    }

    if (action === "page") {
      const pageTarget = target.dataset.target;
      const direction = Number(target.dataset.direction);
      if (pageTarget === "action") state.ui.actionPage += direction;
      if (pageTarget === "drawer") state.ui.drawerPage += direction;
      playCue("select");
      render();
      return;
    }

    if (action === "toggle-add" && seq) {
      toggleLimitedSelection(state.ui.selectedAdd, seq, currentAddAmount());
      playCue("tick");
      render();
      return;
    }

    if (action === "toggle-verify" && seq) {
      toggleSetValue(state.ui.selectedVerify, seq);
      playCue("tick");
      render();
      return;
    }

    if (action === "toggle-submit" && seq) {
      state.ui.selectedSubmit = state.ui.selectedSubmit === seq ? null : seq;
      playCue("tick");
      render();
      return;
    }

    if (action === "toggle-lowlikely" && seq) {
      toggleSetValue(state.lowLikely, seq);
      playCue("tick");
      render();
      return;
    }

    if (action === "quick-fill") {
      quickFillAdd();
      playCue("add");
      render();
      return;
    }

    if (action === "quick-fill-uncovered") {
      quickFillAdd({ uncoveredOnly: true });
      playCue("add");
      render();
      return;
    }

    if (action === "select-all-verify") {
      getHuman().book
        .filter((candidate) => getHuman().candidate.has(candidate))
        .forEach((candidate) => state.ui.selectedVerify.add(candidate));
      playCue("select");
      render();
      return;
    }

    if (action === "deselect-all-verify") {
      state.ui.selectedVerify = new Set();
      playCue("select");
      render();
      return;
    }

    if (action === "confirm-action") {
      commitHumanAction("manual");
    }
  }

  function handleChange(event) {
    const target = event.target;
    if (target.id === "player-count") {
      state.config.playerCount = Number(target.value);
      render();
    }

    if (target.id === "sequence-length") {
      state.config.sequenceLength = Number(target.value);
      render();
    }

    if (target.id === "score-target") {
      state.config.target = clamp(Number(target.value) || 15, 5, 30);
      target.value = state.config.target;
      render();
    }

    if (target.id === "sound-toggle") {
      state.config.sound = target.checked;
      if (state.config.sound) {
        unlockAudio();
        playCue("select");
      }
      render();
    }
  }

  function quickFillAdd({ uncoveredOnly = false } = {}) {
    const tableSet = getCurrentTableSet();
    const addable = getHumanAddable()
      .filter((seq) => !state.ui.selectedAdd.has(seq))
      .filter((seq) => !uncoveredOnly || !tableSet.has(seq));
    const needed = currentAddAmount() - state.ui.selectedAdd.size;
    sampleMany(addable, needed).forEach((seq) => state.ui.selectedAdd.add(seq));
  }

  function render() {
    if (state.phase === "setup") {
      app.innerHTML = renderSetupScreen();
      return;
    }

    app.innerHTML = `
      ${renderTopbar()}
      ${renderStatusStrip()}
      <main class="game-grid">
        <section class="table-stage">
          ${renderSeat("top")}
          ${renderSeat("left")}
          ${renderCenterTable()}
          ${renderSeat("right")}
          ${renderSeat("bottom")}
        </section>
        ${renderActionPanel()}
      </main>
      ${state.ui.drawerOpen ? renderCandidateDrawer() : ""}
      ${state.ui.aiLogsOpen ? renderAiLogsDrawer() : ""}
      ${isReviewPhase() && state.ui.resultModalOpen ? renderRoundModal() : ""}
    `;
  }

  function renderSetupScreen() {
    const sequenceCount = factorial(state.config.sequenceLength);
    return `
      <section class="setup-screen">
        <div class="setup-card">
          <div class="brand setup-brand">
            <div class="mark" aria-hidden="true"></div>
            <div>
              <h1>Sequence Table</h1>
              <span>Local prototype</span>
            </div>
          </div>
          <div class="mode-grid">
            <label class="mode-field" for="player-count">
              <span>Players</span>
              <select id="player-count">
                ${[2, 3, 4].map((count) => `<option value="${count}" ${count === state.config.playerCount ? "selected" : ""}>${count}</option>`).join("")}
              </select>
            </label>
            <label class="mode-field" for="sequence-length">
              <span>Length</span>
              <select id="sequence-length">
                ${[3, 4, 5].map((length) => `<option value="${length}" ${length === state.config.sequenceLength ? "selected" : ""}>${length}</option>`).join("")}
              </select>
            </label>
            <label class="mode-field" for="score-target">
              <span>Target</span>
              <input id="score-target" type="number" min="5" max="30" step="1" value="${state.config.target}" />
            </label>
          </div>
          <div class="mode-summary">
            <div class="mini-stat"><strong>${sequenceCount}</strong><span>Candidates</span></div>
            <div class="mini-stat"><strong>${currentAddAmount()}</strong><span>Add</span></div>
            <div class="mini-stat"><strong>${SCORE_BY_PLAYERS[state.config.playerCount].join("/")}</strong><span>Score</span></div>
          </div>
          <div class="action-buttons setup-actions">
            <button class="primary" data-action="start-game">Start Game</button>
            <label class="setting" for="sound-toggle">Sound
              <input id="sound-toggle" type="checkbox" ${state.config.sound ? "checked" : ""} />
            </label>
          </div>
        </div>
      </section>
    `;
  }

  function renderTopbar() {
    return `
      <header class="topbar">
        <div class="brand">
          <div class="mark" aria-hidden="true"></div>
          <div>
            <h1>Sequence Table</h1>
            <span>X=${state.config.sequenceLength} · ${state.players.length} players · target ${state.config.target}</span>
          </div>
        </div>
        <div class="settings">
          <label class="setting" for="sound-toggle">Sound
            <input id="sound-toggle" type="checkbox" ${state.config.sound ? "checked" : ""} />
          </label>
          <button class="quiet" data-action="change-mode">Change Mode</button>
          <button class="quiet" data-action="new-game">Restart</button>
        </div>
      </header>
    `;
  }

  function renderStatusStrip() {
    const human = getHuman();
    return `
      <section class="status-strip">
        <div class="status-item">
          <div class="label">Puzzle</div>
          <div class="value">${state.puzzleNumber} / Round ${state.roundNumber}</div>
        </div>
        <div class="status-item">
          <div class="label">Phase</div>
          <div class="value">${phaseLabel()}</div>
        </div>
        <div class="status-item">
          <div class="label">Add</div>
          <div class="value">${currentAddAmount()} sequences</div>
        </div>
        <div class="status-item">
          <div class="label">Candidates</div>
          <div class="value">${human.candidate.size} / ${allSequences.length}</div>
        </div>
      </section>
    `;
  }

  function renderSeat(position) {
    const player = playerForSeat(position);
    if (!player) {
      return `<aside class="seat seat-${position}"><div class="player-panel is-empty"></div></aside>`;
    }
    return `
      <aside class="seat seat-${position}">
        ${renderPlayerPanel(player)}
      </aside>
    `;
  }

  function renderPlayerPanel(player) {
    const isHuman = player.type === "human";
    const bookPreview = isHuman ? sortOwnBookForSelection(player.book, player).slice(0, 20) : player.book.slice(-20);
    return `
      <div class="player-panel ${isHuman ? "is-human" : ""} ${player.ranked ? "is-ranked" : ""}">
        <div class="player-head">
          <div>
            <div class="player-name">${escapeHtml(player.name)}</div>
            <span class="badge">${escapeHtml(player.personality)}</span>
          </div>
          <div class="score">${player.score}</div>
        </div>
        <div class="player-meta">
          <div class="mini-stat"><strong>${player.book.length}</strong><span>Book</span></div>
          <div class="mini-stat"><strong>${player.ranked ? `#${player.rank}` : player.skipNext ? "Skip" : "Live"}</strong><span>Status</span></div>
          <div class="mini-stat"><strong>${escapeHtml(player.lastAction)}</strong><span>Action</span></div>
        </div>
        <div class="book-preview">
          ${bookPreview.length > 0
            ? bookPreview.map((seq) => renderPreviewChip(player, seq)).join("")
            : `<span class="badge">Empty book</span>`}
        </div>
      </div>
    `;
  }

  function renderPreviewChip(player, seq) {
    let chipClass = "";
    if (player.type === "human") {
      chipClass = player.candidate.has(seq) ? "bright" : "grey";
    } else if (state.publicEliminated.has(seq)) {
      chipClass = "public-grey";
    }
    return `<span class="seq-chip ${chipClass}">${seq}</span>`;
  }

  function renderCenterTable() {
    return `
      <section class="center-table">
        <div class="center-title">
          <div>
            <h2>${centerTitle()}</h2>
            <div class="answer-mask">
              ${state.phase === "roundEnd" || state.phase === "gameEnd"
                ? state.answer.split("").map((digit) => `<span class="digit-tile">${digit}</span>`).join("")
                : "?".repeat(state.config.sequenceLength).split("").map((digit) => `<span class="digit-tile">${digit}</span>`).join("")}
            </div>
          </div>
          <button class="accent" data-action="open-candidates">Candidates</button>
        </div>
        <div class="action-feed">
          ${state.publicFeed.map((line) => `<div class="feed-line">${escapeHtml(line)}</div>`).join("")}
        </div>
      </section>
    `;
  }

  function renderActionPanel() {
    if (state.phase === "choice") return renderChoicePanel();
    if (state.phase === "action") return renderLiveActionPanel();
    if (state.phase === "reveal") return renderRevealPanel();
    return renderWaitingPanel();
  }

  function renderChoicePanel() {
    const human = getHuman();
    if (!humanCanAct()) {
      return `
        <aside class="action-panel">
          <div class="panel-head">
            <div>
              <h2>Skipped</h2>
              <div class="panel-subtitle">The table resolves without your action.</div>
            </div>
          </div>
          <div class="action-buttons">
            <button class="primary" data-action="continue-skip">Resolve Skip</button>
          </div>
          ${renderPrivateLog()}
        </aside>
      `;
    }

    return `
      <aside class="action-panel">
        <div class="panel-head">
          <div>
            <h2>Choose Action</h2>
            <div class="panel-subtitle">Pick one action.</div>
          </div>
          <span class="badge">${human.candidate.size} candidates</span>
        </div>
        <div class="choice-grid">
          <button class="choice-button primary" data-action="choose" data-choice="add">
            <strong>Add ${currentAddAmount()}</strong>
            <span>From candidate book</span>
          </button>
          <button class="choice-button accent" data-action="choose" data-choice="verifyMine">
            <strong>Verify Mine</strong>
            <span>Check selected own book</span>
          </button>
          <button class="choice-button quiet" data-action="choose" data-choice="verifyTable">
            <strong>Verify Table</strong>
            <span>Skip next turn</span>
          </button>
          <button class="choice-button danger" data-action="choose" data-choice="submit">
            <strong>Submit</strong>
            <span>Final candidate</span>
          </button>
        </div>
        ${renderPrivateLog()}
      </aside>
    `;
  }

  function renderLiveActionPanel() {
    const action = getHumanPendingAction();
    if (!action || action.type === "skip" || action.type === "ranked") {
      return `
        <aside class="action-panel">
          <div class="panel-head">
            <div>
              <h2>Resolving</h2>
              <div class="panel-subtitle">AI actions are resolving.</div>
            </div>
          </div>
          ${renderPrivateLog()}
        </aside>
      `;
    }

    if (action.type === "add") return renderAddPanel();
    if (action.type === "verifyMine") return renderVerifyMinePanel();
    if (action.type === "verifyTable") return renderVerifyTablePanel();
    if (action.type === "submit") return renderSubmitPanel();
    return renderWaitingPanel();
  }

  function renderAddPanel() {
    const addable = getHumanAddable();
    const page = clampPage(state.ui.actionPage, addable.length);
    state.ui.actionPage = page;
    const picked = state.ui.selectedAdd.size;
    const tableSet = getCurrentTableSet();
    const uncovered = addable.filter((seq) => !tableSet.has(seq)).length;
    const covered = addable.length - uncovered;
    return `
      <aside class="action-panel">
        ${renderPanelHeader(`Add ${currentAddAmount()}`, "Uncovered table candidates are listed first.", `${picked}/${currentAddAmount()} selected`)}
        <div class="book-tools">
          <button class="quiet" data-action="back-to-choice">Back</button>
          <button class="accent" data-action="quick-fill">Quick Fill ${currentAddAmount()}</button>
          <button class="accent" data-action="quick-fill-uncovered">Fill Not On Table</button>
          <button class="primary" data-action="confirm-action">Commit Add</button>
        </div>
        <div class="book-tools compact-tools">
          <span class="badge">${uncovered} not on table</span>
          <span class="badge">${covered} already on table</span>
          <span class="badge">${state.lowLikely.size} low likely</span>
        </div>
        ${renderSequenceGrid(addable, page, "add", state.ui.selectedAdd)}
        ${renderPager("action", page, addable.length)}
        ${renderPrivateLog()}
      </aside>
    `;
  }

  function renderVerifyMinePanel() {
    const human = getHuman();
    const book = sortOwnBookForSelection(human.book, human);
    const page = clampPage(state.ui.actionPage, book.length);
    state.ui.actionPage = page;
    return `
      <aside class="action-panel">
        ${renderPanelHeader("Verify Mine", "Select bright entries from your own book.", `${state.ui.selectedVerify.size} selected`)}
        <div class="book-tools">
          <button class="quiet" data-action="back-to-choice">Back</button>
          <button class="accent" data-action="select-all-verify">Select All</button>
          <button class="quiet" data-action="deselect-all-verify">Deselect All</button>
          <button class="primary" data-action="confirm-action">Verify</button>
        </div>
        ${renderOwnBookGrid(book, page)}
        ${renderPager("action", page, book.length)}
        ${renderPrivateLog()}
      </aside>
    `;
  }

  function renderVerifyTablePanel() {
    const tableSet = getSnapshotTableSet();
    const human = getHuman();
    const liveOnTable = [...tableSet].filter((seq) => human.candidate.has(seq)).length;
    return `
      <aside class="action-panel">
        ${renderPanelHeader("Verify Table", "Check the public table and skip next turn.", `${liveOnTable} live table candidates`)}
        <div class="book-tools">
          <button class="quiet" data-action="back-to-choice">Back</button>
          <button class="primary" data-action="confirm-action">Check Table</button>
        </div>
        <div class="empty-note">Public table size: ${tableSet.size}</div>
        ${renderPrivateLog()}
      </aside>
    `;
  }

  function renderSubmitPanel() {
    const candidates = sortCandidatesForChoice(sequencesFromSet(getHuman().candidate));
    const page = clampPage(state.ui.actionPage, candidates.length);
    state.ui.actionPage = page;
    return `
      <aside class="action-panel">
        ${renderPanelHeader("Submit", "Pick one final answer.", state.ui.selectedSubmit || "No selection")}
        <div class="book-tools">
          <button class="quiet" data-action="back-to-choice">Back</button>
          <button class="danger" data-action="confirm-action" ${state.ui.selectedSubmit ? "" : "disabled"}>Submit Guess</button>
        </div>
        ${renderSequenceGrid(candidates, page, "submit", new Set(state.ui.selectedSubmit ? [state.ui.selectedSubmit] : []))}
        ${renderPager("action", page, candidates.length)}
        ${renderPrivateLog()}
      </aside>
    `;
  }

  function renderPanelHeader(title, subtitle, badge) {
    return `
      <div class="panel-head">
        <div>
          <h2>${escapeHtml(title)}</h2>
          <div class="panel-subtitle">${escapeHtml(subtitle)}</div>
        </div>
        <span class="badge">${escapeHtml(badge)}</span>
      </div>
    `;
  }

  function renderRevealPanel() {
    return `
      <aside class="action-panel">
        <div class="panel-head">
          <div>
            <h2>Round Reveal</h2>
            <div class="panel-subtitle">Public actions are shown.</div>
          </div>
        </div>
        <div class="action-buttons">
          <button class="primary" data-action="next-round">Next Round</button>
          <button class="accent" data-action="open-candidates">Candidates</button>
        </div>
        ${renderPrivateLog()}
      </aside>
    `;
  }

  function renderWaitingPanel() {
    if (isReviewPhase()) {
      const isGameOver = state.phase === "gameEnd";
      return `
        <aside class="action-panel">
          <div class="panel-head">
            <div>
              <h2>${isGameOver ? "Game Review" : "Puzzle Review"}</h2>
              <div class="panel-subtitle">Answer ${state.puzzleResult?.answer || state.answer}</div>
            </div>
            <span class="badge">${state.ranks.length}/${state.players.length} ranked</span>
          </div>
          <div class="action-buttons">
            <button class="accent" data-action="open-ai-logs">AI Logs</button>
            <button class="quiet" data-action="open-candidates">Candidates</button>
            ${isGameOver
              ? `<button class="primary" data-action="new-game">New Game</button>`
              : `<button class="primary" data-action="next-puzzle">Next Puzzle</button>`}
          </div>
          ${renderPrivateLog()}
        </aside>
      `;
    }

    return `
      <aside class="action-panel">
        <div class="panel-head">
          <div>
            <h2>Table</h2>
            <div class="panel-subtitle">Local MVP</div>
          </div>
        </div>
        ${renderPrivateLog()}
      </aside>
    `;
  }

  function renderSequenceGrid(list, page, mode, selectedSet) {
    if (list.length === 0) {
      return `<div class="empty-note">No candidates available.</div>`;
    }

    const pageItems = list.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
    const actionByMode = {
      add: "toggle-add",
      submit: "toggle-submit",
      drawer: "",
    };
    return `
      <div class="grid-book">
        ${pageItems.map((seq) => {
          const selected = selectedSet.has(seq);
          const lowLikely = state.lowLikely.has(seq);
          const tableCovered = getCurrentTableSet().has(seq);
          const actionAttr = actionByMode[mode]
            ? `data-action="${actionByMode[mode]}" data-seq="${seq}"`
            : "";
          const mainAction = actionAttr
            ? `<button class="seq-chip bright selectable ${selected ? "selected" : ""}" ${actionAttr}>${seq}</button>`
            : `<div class="seq-chip bright">${seq}</div>`;
          return `
            <div class="seq-cell ${lowLikely ? "is-lowlikely" : ""} ${tableCovered ? "is-covered" : "is-uncovered"}">
              ${mainAction}
              <button class="likelihood-toggle ${lowLikely ? "active" : ""}" data-action="toggle-lowlikely" data-seq="${seq}">
                ${lowLikely ? "Low" : "Mark"}
              </button>
            </div>
          `;
        }).join("")}
      </div>
    `;
  }

  function renderOwnBookGrid(book, page) {
    if (book.length === 0) {
      return `<div class="empty-note">Own book is empty.</div>`;
    }

    const human = getHuman();
    const pageItems = book.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
    return `
      <div class="grid-book">
        ${pageItems.map((seq) => {
          const live = human.candidate.has(seq);
          const selected = state.ui.selectedVerify.has(seq);
          const lowLikely = state.lowLikely.has(seq);
          const attrs = live ? `data-action="toggle-verify" data-seq="${seq}"` : "";
          return `
            <div class="seq-cell ${lowLikely ? "is-lowlikely" : ""}">
              <button class="seq-chip ${live ? "bright selectable" : "grey disabled"} ${selected ? "selected" : ""}" ${attrs} ${live ? "" : "disabled"}>${seq}</button>
              ${live ? `<button class="likelihood-toggle ${lowLikely ? "active" : ""}" data-action="toggle-lowlikely" data-seq="${seq}">${lowLikely ? "Low" : "Mark"}</button>` : ""}
            </div>
          `;
        }).join("")}
      </div>
    `;
  }

  function renderPager(target, page, total) {
    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    return `
      <div class="pager">
        <button class="quiet" data-action="page" data-target="${target}" data-direction="-1" ${page <= 0 ? "disabled" : ""}>Prev</button>
        <span>${page + 1} / ${pageCount}</span>
        <button class="quiet" data-action="page" data-target="${target}" data-direction="1" ${page >= pageCount - 1 ? "disabled" : ""}>Next</button>
      </div>
    `;
  }

  function renderPrivateLog() {
    const lines = getHuman().privateLog.slice(0, 4);
    if (lines.length === 0) return "";
    return `
      <div class="private-log">
        ${lines.map((line) => `<div class="private-line">${escapeHtml(line)}</div>`).join("")}
      </div>
    `;
  }

  function renderCandidateDrawer() {
    const candidates = sortCandidatesForChoice(sequencesFromSet(getHuman().candidate));
    const page = clampPage(state.ui.drawerPage, candidates.length);
    state.ui.drawerPage = page;
    const lowLikely = candidates.filter((seq) => state.lowLikely.has(seq)).length;
    return `
      <div class="drawer-backdrop">
        <section class="drawer">
          <div class="panel-head">
            <div>
              <h2>Candidate Book</h2>
              <div class="panel-subtitle">${candidates.length} bright candidates, ${lowLikely} marked low likely</div>
            </div>
            <button class="quiet" data-action="close-drawer">Close</button>
          </div>
          <div class="book-tools">
            <span class="badge">X=${state.config.sequenceLength}</span>
            <span class="badge">All private</span>
            <span class="badge">Mark moves to back</span>
          </div>
          ${renderSequenceGrid(candidates, page, "drawer", new Set())}
          ${renderPager("drawer", page, candidates.length)}
        </section>
      </div>
    `;
  }

  function renderAiLogsDrawer() {
    const aiPlayers = state.players.filter((player) => player.type === "ai");
    return `
      <div class="drawer-backdrop">
        <section class="drawer log-drawer">
          <div class="panel-head">
            <div>
              <h2>AI Logs</h2>
              <div class="panel-subtitle">Private decisions revealed after the puzzle ends</div>
            </div>
            <button class="quiet" data-action="close-ai-logs">Close</button>
          </div>
          <div class="ai-log-grid">
            ${aiPlayers.map((player) => `
              <section class="ai-log-panel">
                <div class="player-head">
                  <div>
                    <div class="player-name">${escapeHtml(player.name)}</div>
                    <span class="badge">${escapeHtml(player.personality)}</span>
                  </div>
                  <div class="score">#${player.rank || "-"}</div>
                </div>
                <div class="player-meta">
                  <div class="mini-stat"><strong>${player.candidate.size}</strong><span>Candidates</span></div>
                  <div class="mini-stat"><strong>${player.book.length}</strong><span>Book</span></div>
                  <div class="mini-stat"><strong>${escapeHtml(player.lastAction)}</strong><span>Final</span></div>
                </div>
                <div class="ai-log-lines">
                  ${player.privateLog.length > 0
                    ? player.privateLog.map((line) => `<div class="private-line">${escapeHtml(line)}</div>`).join("")
                    : `<div class="empty-note">No hidden log entries.</div>`}
                </div>
              </section>
            `).join("")}
          </div>
        </section>
      </div>
    `;
  }

  function renderRoundModal() {
    const isGameOver = state.phase === "gameEnd";
    const title = isGameOver ? `${state.gameWinner.name} wins` : "Puzzle Complete";
    return `
      <div class="round-modal">
        <section class="modal-card">
          <div class="panel-head">
            <div>
              <h2>${escapeHtml(title)}</h2>
              <div class="panel-subtitle">Answer ${state.puzzleResult.answer}</div>
            </div>
            <span class="badge">Target ${state.config.target}</span>
          </div>
          <div class="rank-list">
            ${state.puzzleResult.ranks.map((rank) => `
              <div class="rank-row">
                <strong>#${rank.rank} ${escapeHtml(rank.name)}</strong>
                <span>+${rank.points}</span>
              </div>
            `).join("")}
          </div>
          <div class="action-buttons">
            <button class="accent" data-action="review-table">Review Table</button>
            <button class="quiet" data-action="open-ai-logs">AI Logs</button>
            ${isGameOver
              ? `<button class="primary" data-action="new-game">New Game</button>`
              : `<button class="primary" data-action="next-puzzle">Next Puzzle</button>`}
          </div>
        </section>
      </div>
    `;
  }

  function humanCanAct() {
    const human = getHuman();
    return !human.ranked && !human.skipNext;
  }

  function isReviewPhase() {
    return state.phase === "roundEnd" || state.phase === "gameEnd";
  }

  function getHuman() {
    return state.players[0];
  }

  function getHumanPendingAction() {
    return state.pendingActions.get(getHuman().id);
  }

  function getHumanAddable() {
    const human = getHuman();
    return sortAddableForChoice(sequencesFromSet(human.candidate).filter((seq) => !human.book.includes(seq)));
  }

  function getSnapshotTableSet() {
    return tableSetFromSnapshot(state.snapshotBooks);
  }

  function getCurrentTableSet() {
    const tableSet = new Set();
    state.players.forEach((player) => {
      player.book.forEach((seq) => tableSet.add(seq));
    });
    return tableSet;
  }

  function tableSetFromSnapshot(snapshotBooks) {
    const tableSet = new Set();
    snapshotBooks.forEach((book) => {
      book.forEach((seq) => tableSet.add(seq));
    });
    return tableSet;
  }

  function currentAddAmount() {
    return ADD_BY_LENGTH[state.config.sequenceLength] || 3;
  }

  function factorial(value) {
    let result = 1;
    for (let index = 2; index <= value; index += 1) {
      result *= index;
    }
    return result;
  }

  function playerForSeat(position) {
    const map = {
      bottom: state.players[0],
      top: state.players[1],
      left: state.players[2],
      right: state.players[3],
    };
    return map[position] || null;
  }

  function playerSeatIndex(playerId) {
    return state.players.findIndex((player) => player.id === playerId);
  }

  function phaseLabel() {
    const labels = {
      choice: "Choose Action",
      action: "Take Action",
      reveal: "Reveal",
      roundEnd: "Puzzle End",
      gameEnd: "Game End",
    };
    return labels[state.phase] || "Ready";
  }

  function centerTitle() {
    if (state.phase === "roundEnd" || state.phase === "gameEnd") return "Answer revealed";
    if (state.ranks.length > 0) {
      return `${state.ranks.length} ranked`;
    }
    return "Hidden sequence";
  }

  function actionTitle(type) {
    const labels = {
      add: "Add",
      verifyMine: "Verify Mine",
      verifyTable: "Verify Table",
      submit: "Submit",
      skip: "Skip",
    };
    return labels[type] || "Action";
  }

  function sortOwnBookForSelection(book, player) {
    return [...book].sort((left, right) => {
      const leftLive = player.candidate.has(left) ? 0 : 1;
      const rightLive = player.candidate.has(right) ? 0 : 1;
      if (leftLive !== rightLive) return leftLive - rightLive;
      const leftLow = state.lowLikely.has(left) ? 1 : 0;
      const rightLow = state.lowLikely.has(right) ? 1 : 0;
      if (leftLow !== rightLow) return leftLow - rightLow;
      return book.indexOf(left) - book.indexOf(right);
    });
  }

  function sortAddableForChoice(sequences) {
    const tableSet = getCurrentTableSet();
    return [...sequences].sort((left, right) => {
      const leftLow = state.lowLikely.has(left) ? 1 : 0;
      const rightLow = state.lowLikely.has(right) ? 1 : 0;
      if (leftLow !== rightLow) return leftLow - rightLow;
      const leftCovered = tableSet.has(left) ? 1 : 0;
      const rightCovered = tableSet.has(right) ? 1 : 0;
      if (leftCovered !== rightCovered) return leftCovered - rightCovered;
      return allSequences.indexOf(left) - allSequences.indexOf(right);
    });
  }

  function sortCandidatesForChoice(sequences) {
    return [...sequences].sort((left, right) => {
      const leftLow = state.lowLikely.has(left) ? 1 : 0;
      const rightLow = state.lowLikely.has(right) ? 1 : 0;
      if (leftLow !== rightLow) return leftLow - rightLow;
      return allSequences.indexOf(left) - allSequences.indexOf(right);
    });
  }

  function sequencesFromSet(set) {
    return allSequences.filter((seq) => set.has(seq));
  }

  function intersectSets(left, right) {
    const result = new Set();
    left.forEach((value) => {
      if (right.has(value)) result.add(value);
    });
    return result;
  }

  function unique(items) {
    return [...new Set(items)];
  }

  function toggleSetValue(set, value) {
    if (set.has(value)) set.delete(value);
    else set.add(value);
  }

  function toggleLimitedSelection(set, value, limit) {
    if (set.has(value)) {
      set.delete(value);
      return;
    }
    if (set.size >= limit) return;
    set.add(value);
  }

  function sampleOne(items) {
    return items[Math.floor(Math.random() * items.length)];
  }

  function sampleMany(items, count) {
    const pool = [...items];
    const result = [];
    while (pool.length > 0 && result.length < count) {
      const index = Math.floor(Math.random() * pool.length);
      result.push(pool.splice(index, 1)[0]);
    }
    return result;
  }

  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function clampPage(page, total) {
    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    return clamp(page, 0, pageCount - 1);
  }

  function addPrivateLog(player, line) {
    player.privateLog.unshift(line);
  }

  function roundLabel() {
    return `R${state.roundNumber}`;
  }

  function formatSequenceList(sequences, limit = 8) {
    if (!sequences || sequences.length === 0) return "none";
    const shown = sequences.slice(0, limit).join(", ");
    const remaining = sequences.length - limit;
    return remaining > 0 ? `${shown}, +${remaining} more` : shown;
  }

  function formatAiDecisionOptions(options) {
    return options
      .map((option) => {
        const action = option.action;
        const size =
          action.type === "add" ? action.sequences?.length :
          action.type === "verifyMine" ? action.selection?.length :
          null;
        const suffix = size ? `(${size})` : "";
        return `${actionTitle(action.type)}${suffix}=${option.value.toFixed(1)}`;
      })
      .join(", ");
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function unlockAudio() {
    if (!state.config.sound || audioContext) return;
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return;
    audioContext = new Context();
  }

  function playCue(name) {
    if (!state.config.sound) return;
    unlockAudio();
    if (!audioContext) return;

    const cues = {
      tick: [[440, 0.035, "square", 0.04]],
      select: [[520, 0.05, "triangle", 0.045]],
      add: [[360, 0.05, "triangle", 0.05], [520, 0.045, "triangle", 0.04]],
      submit: [[220, 0.06, "sawtooth", 0.035], [330, 0.06, "triangle", 0.04]],
      yes: [[560, 0.08, "triangle", 0.05], [760, 0.11, "triangle", 0.045]],
      no: [[190, 0.12, "sine", 0.05]],
      correct: [[420, 0.08, "triangle", 0.05], [620, 0.08, "triangle", 0.05], [840, 0.12, "triangle", 0.045]],
      wrong: [[170, 0.12, "sawtooth", 0.035]],
      reveal: [[310, 0.06, "triangle", 0.04], [410, 0.06, "triangle", 0.035]],
      win: [[420, 0.08, "triangle", 0.05], [620, 0.08, "triangle", 0.05], [860, 0.16, "triangle", 0.05]],
    };

    let offset = 0;
    (cues[name] || cues.select).forEach(([freq, duration, type, gain]) => {
      playTone(freq, duration, type, gain, offset);
      offset += duration * 0.72;
    });
  }

  function playTone(frequency, duration, type, gainValue, offset) {
    const now = audioContext.currentTime + offset;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(gainValue, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);
  }
})();
