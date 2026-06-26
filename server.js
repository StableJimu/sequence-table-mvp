const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PAGE_SIZE = 24;
const ADD_AMOUNT = 3;
const SCORE_TARGET = 15;
const DIGITS = ["1", "2", "3", "4"];
const SCORE = { 2: [5, 0], 3: [5, 3, 0], 4: [5, 3, 2, 0] };
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
const AI_SUBMIT_THRESHOLDS = { Aggressive: 4, Balanced: 3, Reader: 3, Cautious: 2, Binary: 2 };
const AI_NAMES = ["Mina", "Sol", "Beck"];
const AI_TYPES = ["Reader", "Binary", "Balanced"];
const ALL_SEQUENCES = permutations(DIGITS);
const rooms = new Map();

function permutations(items) {
  if (items.length === 1) return items;
  const result = [];
  items.forEach((item, index) => {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    permutations(rest).forEach((perm) => result.push(item + perm));
  });
  return result;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100000) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

function roomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return rooms.has(code) ? roomCode() : code;
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function createRoom(hostName) {
  const code = roomCode();
  const host = createHuman(0, hostName || "Host", true);
  const room = {
    code,
    hostId: host.id,
    playerCount: 2,
    scoreTarget: SCORE_TARGET,
    aiTypes: [...AI_TYPES],
    players: [host],
    phase: "lobby",
    roundNumber: 0,
    answer: "",
    ranks: [],
    publicEliminated: new Set(),
    publicFeed: [`Room ${code} created.`],
    publicSignals: [],
    pendingActions: new Map(),
    snapshotBooks: new Map(),
    roundReady: new Set(),
    clients: new Map(),
    puzzleResult: null,
    matchResult: null,
  };
  rooms.set(code, room);
  return { room, player: host };
}

function createHuman(seat, name, host = false) {
  return {
    id: id("p"),
    token: id("tok"),
    name: sanitizeName(name || `Player ${seat + 1}`),
    type: "human",
    personality: host ? "Host" : "Human",
    host,
    seat,
    score: 0,
    connected: true,
    book: [],
    candidate: new Set(ALL_SEQUENCES),
    skipNext: false,
    ranked: false,
    rank: null,
    finishRound: null,
    tied: false,
    lastAction: "Ready",
    privateLog: [],
    tableChecks: 0,
  };
}

function createAi(seat, name, aiType) {
  return {
    id: id("ai"),
    token: "",
    name,
    type: "ai",
    personality: aiType,
    host: false,
    seat,
    score: 0,
    connected: true,
    book: [],
    candidate: new Set(ALL_SEQUENCES),
    skipNext: false,
    ranked: false,
    rank: null,
    finishRound: null,
    tied: false,
    lastAction: "Ready",
    privateLog: [],
    tableChecks: 0,
  };
}

function sanitizeName(value) {
  return String(value || "Player").trim().slice(0, 18) || "Player";
}

function authRoom(code, playerId, token) {
  const room = rooms.get(String(code || "").toUpperCase());
  if (!room) return { error: "Room not found" };
  const player = room.players.find((item) => item.id === playerId && item.token === token);
  if (!player) return { error: "Invalid player token" };
  return { room, player };
}

function joinRoom(code, name) {
  const room = rooms.get(String(code || "").toUpperCase());
  if (!room) return { error: "Room not found" };
  if (room.phase !== "lobby") return { error: "Game already started" };
  const humans = room.players.filter((player) => player.type === "human");
  if (humans.length >= 4) return { error: "Room is full" };
  const usedSeats = new Set(room.players.map((player) => player.seat));
  let seat = 0;
  while (usedSeats.has(seat)) seat += 1;
  const player = createHuman(seat, name || `Player ${humans.length + 1}`);
  room.players.push(player);
  room.playerCount = Math.max(room.playerCount, room.players.filter((item) => item.type === "human").length);
  room.publicFeed.unshift(`${player.name} joined.`);
  broadcast(room);
  return { room, player };
}

function startGame(room, player, config) {
  if (room.hostId !== player.id) return { error: "Only host can start" };
  if (room.phase !== "lobby") return { error: "Game already started" };
  const humanCount = room.players.filter((item) => item.type === "human").length;
  room.playerCount = clamp(Number(config.playerCount) || room.playerCount, Math.max(2, humanCount), 4);
  room.aiTypes = Array.isArray(config.aiTypes) ? config.aiTypes.slice(0, 3) : room.aiTypes;
  room.players = room.players.filter((item) => item.type === "human");
  while (room.players.length < room.playerCount) {
    const seat = room.players.length;
    room.players.push(createAi(seat, AI_NAMES[seat - 1] || `AI ${seat}`, room.aiTypes[seat - 1] || AI_TYPES[seat - 1] || "Balanced"));
  }
  room.players.sort((left, right) => left.seat - right.seat);
  startPuzzle(room);
  return {};
}

function newGame(room, player) {
  if (room.hostId !== player.id) return { error: "Only host can start a new game" };
  if (room.phase !== "gameOver") return { error: "Match is not finished yet" };
  room.players.forEach((item) => {
    item.score = 0;
  });
  room.matchResult = null;
  startPuzzle(room);
  return {};
}

function readyNextRound(room, player) {
  if (player.type !== "human") return { error: "Only human players can ready up" };
  if (room.phase !== "between") return { error: "Next puzzle is not waiting for ready checks" };
  room.roundReady.add(player.id);
  player.lastAction = "Ready";
  const humans = room.players.filter((item) => item.type === "human");
  const allReady = humans.every((item) => room.roundReady.has(item.id));
  if (allReady) {
    room.publicFeed.unshift("All human players are ready.");
    startPuzzle(room);
    return { started: true };
  }
  room.publicFeed.unshift(`${player.name} is ready for the next puzzle.`);
  return { started: false };
}

function backToLobby(room, player) {
  if (room.hostId !== player.id) return { error: "Only host can return to lobby" };
  const humans = room.players.filter((item) => item.type === "human");
  room.players = humans
    .sort((left, right) => left.seat - right.seat)
    .map((item, index) => {
      item.seat = index;
      item.score = 0;
      item.book = [];
      item.candidate = new Set(ALL_SEQUENCES);
      item.skipNext = false;
      item.ranked = false;
      item.rank = null;
      item.finishRound = null;
      item.tied = false;
      item.lastAction = "Ready";
      item.privateLog = [];
      item.tableChecks = 0;
      return item;
    });
  room.playerCount = clamp(Math.max(2, room.players.length), 2, 4);
  room.phase = "lobby";
  room.roundNumber = 0;
  room.answer = "";
  room.ranks = [];
  room.publicEliminated = new Set();
  room.publicSignals = [];
  room.pendingActions = new Map();
  room.snapshotBooks = new Map();
  room.roundReady = new Set();
  room.puzzleResult = null;
  room.matchResult = null;
  room.publicFeed = ["Returned to lobby."];
  return {};
}

function startPuzzle(room) {
  room.phase = "active";
  room.roundNumber = 0;
  room.answer = sampleOne(ALL_SEQUENCES);
  room.ranks = [];
  room.publicEliminated = new Set();
  room.publicSignals = [];
  room.pendingActions = new Map();
  room.roundReady = new Set();
  room.puzzleResult = null;
  room.matchResult = null;
  room.publicFeed = ["Puzzle begins."];
  room.players.forEach((player) => {
    player.book = [];
    player.candidate = new Set(ALL_SEQUENCES);
    player.skipNext = false;
    player.ranked = false;
    player.rank = null;
    player.finishRound = null;
    player.tied = false;
    player.lastAction = "Ready";
    player.privateLog = [];
    player.tableChecks = 0;
  });
  startRound(room);
}

function startRound(room) {
  room.roundNumber += 1;
  room.phase = "active";
  room.pendingActions = new Map();
  room.snapshotBooks = new Map(room.players.map((player) => [player.id, [...player.book]]));
  room.players.forEach((player) => {
    if (player.ranked) {
      player.lastAction = rankLabel(player);
      room.pendingActions.set(player.id, { type: "ranked" });
      return;
    }
    if (player.skipNext) {
      player.lastAction = "Skipped";
      room.pendingActions.set(player.id, { type: "skip" });
      return;
    }
    if (player.type === "ai") {
      const action = chooseAiAction(room, player);
      player.lastAction = actionTitle(action.type);
      room.pendingActions.set(player.id, action);
      return;
    }
    player.lastAction = "Choosing";
  });
  room.publicFeed.unshift(`Round ${room.roundNumber}.`);
  maybeResolveRound(room);
  broadcast(room);
}

function submitPlayerAction(room, player, payload) {
  if (room.phase !== "active") return { error: "Room is not active" };
  if (player.ranked) return { error: "You already finished" };
  if (player.skipNext) return { error: "You are skipping this round" };
  if (room.pendingActions.has(player.id)) return { error: "Action already submitted" };

  const action = normalizeAction(room, player, payload);
  if (action.error) return action;
  player.lastAction = actionTitle(action.type);
  room.pendingActions.set(player.id, action);
  room.publicFeed.unshift(`${player.name} chose ${actionTitle(action.type)}.`);
  maybeResolveRound(room);
  broadcast(room);
  return {};
}

function normalizeAction(room, player, payload) {
  const type = payload.type;
  if (type === "add") {
    const addable = sequencesFromSet(player.candidate).filter((seq) => !player.book.includes(seq));
    const set = new Set(addable);
    const sequences = unique(Array.isArray(payload.sequences) ? payload.sequences : [])
      .filter((seq) => set.has(seq))
      .slice(0, ADD_AMOUNT);
    if (sequences.length === 0) return { error: "Choose at least one sequence to add" };
    return { type, sequences, committed: true };
  }
  if (type === "verifyMine") {
    const allowed = new Set(player.book.filter((seq) => player.candidate.has(seq)));
    const selection = unique(Array.isArray(payload.selection) ? payload.selection : []).filter((seq) => allowed.has(seq));
    if (selection.length === 0) return { error: "Choose at least one sequence to verify" };
    return { type, selection, committed: true };
  }
  if (type === "verifyTable") return { type, committed: true };
  if (type === "submit") {
    if (!player.candidate.has(payload.guess)) return { error: "Guess must be in your candidate book" };
    return { type, guess: payload.guess, committed: true };
  }
  return { error: "Unknown action" };
}

function maybeResolveRound(room) {
  const liveHumans = room.players.filter((player) => player.type === "human" && !player.ranked && !player.skipNext);
  const allHumansReady = liveHumans.every((player) => room.pendingActions.has(player.id));
  if (!allHumansReady) return;
  resolveRound(room);
}

function resolveRound(room) {
  const tableSet = getSnapshotTableSet(room);
  const correctSubmissions = [];
  const publicWrong = [];
  const addBatches = [];
  const feed = [];

  room.players.forEach((player) => {
    const action = room.pendingActions.get(player.id);
    if (!action || action.type === "ranked") return;
    if (action.type === "skip") {
      player.skipNext = false;
      feed.push(`${player.name} skipped.`);
      addPrivateLog(player, `R${room.roundNumber}: skipped.`);
      return;
    }
    if (action.type === "add") {
      const sequences = unique(action.sequences || []).filter((seq) => ALL_SEQUENCES.includes(seq));
      addBatches.push({ player, sequences });
      feed.push(`${player.name} added ${sequences.length}.`);
      addPrivateLog(player, `R${room.roundNumber}: added ${formatSequenceList(sequences)}.`);
      return;
    }
    if (action.type === "verifyMine") {
      applyVerification(room, player, unique(action.selection || []), "Verify Mine", feed);
      return;
    }
    if (action.type === "verifyTable") {
      applyTableVerification(room, player, tableSet, feed);
      player.skipNext = true;
      return;
    }
    if (action.type === "submit") {
      if (action.guess === room.answer) {
        correctSubmissions.push(player);
        feed.push(`${player.name} submitted correctly.`);
        addPrivateLog(player, `R${room.roundNumber}: submitted ${action.guess} correctly.`);
      } else if (action.guess) {
        publicWrong.push(action.guess);
        player.candidate.delete(action.guess);
        player.skipNext = true;
        feed.push(`${player.name} missed with ${action.guess}.`);
        addPrivateLog(player, `R${room.roundNumber}: submitted ${action.guess}; wrong, skip next.`);
      }
    }
  });

  recordPublicRoundSignals(room, tableSet, addBatches);
  unique(publicWrong).forEach((seq) => {
    room.publicEliminated.add(seq);
    room.players.forEach((player) => player.candidate.delete(seq));
  });
  addBatches.forEach(({ player, sequences }) => {
    sequences.forEach((seq) => {
      if (!player.book.includes(seq)) player.book.push(seq);
    });
  });
  assignTieRank(room, correctSubmissions);
  room.publicFeed = [...feed, ...room.publicFeed].slice(0, 16);

  if (room.players.every((player) => player.ranked)) {
    endPuzzle(room);
    return;
  }
  startRound(room);
}

function applyVerification(room, player, selection, label, feed) {
  const selectedSet = new Set(selection);
  const before = player.candidate.size;
  const yes = selectedSet.has(room.answer);
  if (yes) player.candidate = intersectSets(player.candidate, selectedSet);
  else selection.forEach((seq) => player.candidate.delete(seq));
  feed.push(`${player.name} verified own book.`);
  addPrivateLog(player, `R${room.roundNumber}: ${label} ${selection.length} -> ${yes ? "YES" : "NO"} (${before} to ${player.candidate.size}); ${formatSequenceList(selection)}.`);
}

function applyTableVerification(room, player, tableSet, feed) {
  const before = player.candidate.size;
  const yes = tableSet.has(room.answer);
  if (yes) player.candidate = intersectSets(player.candidate, tableSet);
  else tableSet.forEach((seq) => player.candidate.delete(seq));
  feed.push(`${player.name} checked the table.`);
  addPrivateLog(player, `R${room.roundNumber}: Verify Table ${tableSet.size} -> ${yes ? "YES" : "NO"} (${before} to ${player.candidate.size}).`);
}

function recordPublicRoundSignals(room, tableSet, addBatches) {
  const addSizes = new Map(addBatches.map(({ player, sequences }) => [player.id, sequences.length]));
  room.players.forEach((player) => {
    const action = room.pendingActions.get(player.id);
    if (!action || action.type === "ranked" || action.type === "skip") return;
    if (action.type === "add") {
      const amount = addSizes.get(player.id) || 0;
      room.publicSignals.filter((signal) => signal.playerId === player.id).forEach((signal) => {
        signal.addsAfter += amount;
      });
    }
    if (action.type === "verifyMine") {
      room.publicSignals.filter((signal) => signal.playerId === player.id).forEach((signal) => {
        signal.selfChecksAfter += 1;
      });
    }
    if (action.type === "verifyTable") {
      room.publicSignals.push({
        playerId: player.id,
        round: room.roundNumber,
        tableSet: new Set(tableSet),
        addsAfter: 0,
        selfChecksAfter: 0,
      });
    }
  });
}

function assignTieRank(room, players) {
  const finishing = unique(players).filter((player) => player && !player.ranked);
  if (finishing.length === 0) return;
  const rank = room.ranks.length + 1;
  const tied = finishing.length > 1;
  finishing.sort((left, right) => left.seat - right.seat).forEach((player) => {
    player.ranked = true;
    player.rank = rank;
    player.finishRound = room.roundNumber;
    player.tied = tied;
    player.lastAction = tied ? `Rank ${rank} Tie` : `Rank ${rank}`;
    room.ranks.push(player.id);
    addPrivateLog(player, `R${room.roundNumber}: finished rank ${rank}${tied ? " tie" : ""}.`);
  });
}

function endPuzzle(room) {
  const scoring = SCORE[room.players.length];
  const rankedPlayers = room.ranks.map((playerId) => room.players.find((player) => player.id === playerId));
  const resultRanks = [];
  let cursor = 0;
  while (cursor < rankedPlayers.length) {
    const group = rankedPlayers.filter((player) => player.rank === rankedPlayers[cursor].rank);
    const points = group.length === room.players.length
      ? 2
      : Math.floor(group.reduce((sum, _player, index) => sum + (scoring[rankedPlayers[cursor].rank - 1 + index] || 0), 0) / group.length + 0.5);
    group.forEach((player) => {
      player.score += points;
      resultRanks.push({
        playerId: player.id,
        name: player.name,
        points,
        rank: player.rank,
        tied: group.length > 1,
        finishRound: player.finishRound,
      });
    });
    cursor += group.length;
  }
  const standings = [...room.players]
    .sort((left, right) => right.score - left.score || left.seat - right.seat)
    .map((player) => ({
      playerId: player.id,
      name: player.name,
      score: player.score,
      type: player.type,
    }));
  const topScore = standings[0]?.score || 0;
  const matchComplete = topScore >= room.scoreTarget;
  room.phase = matchComplete ? "gameOver" : "between";
  room.roundReady = new Set();
  room.puzzleResult = {
    answer: room.answer,
    roundsUsed: Math.max(...room.players.map((player) => player.finishRound || 0)),
    ranks: resultRanks,
    standings,
    scoreTarget: room.scoreTarget,
    matchComplete,
  };
  room.matchResult = matchComplete
    ? {
        scoreTarget: room.scoreTarget,
        winners: standings.filter((player) => player.score === topScore),
        standings,
      }
    : null;
  room.publicFeed.unshift(`Puzzle complete. Answer ${room.answer}.`);
  if (matchComplete) room.publicFeed.unshift(`Match complete at ${topScore} points.`);
  else room.publicFeed.unshift("Waiting for every human player to ready up.");
  broadcast(room);
}

function chooseAiAction(room, player) {
  if (player.personality === "Binary") return chooseBinaryAiAction(room, player);
  return chooseHeuristicAiAction(room, player);
}

function chooseHeuristicAiAction(room, player) {
  const candidateList = sequencesFromSet(player.candidate);
  const candidateCount = candidateList.length;
  const ownLive = player.book.filter((seq) => player.candidate.has(seq));
  const options = [];
  if (candidateCount <= 1) return aiSubmit(candidateList[0]);
  const threshold = AI_SUBMIT_THRESHOLDS[player.personality] || AI_SUBMIT_THRESHOLDS.Balanced;
  if (candidateCount <= threshold) {
    options.push({ action: aiSubmit(sampleOne(candidateList)), value: scoreAiSubmit(candidateCount, threshold) });
  }
  const verifySelection = chooseAiVerifySelection(ownLive, candidateCount);
  if (verifySelection.length > 0 && verifySelection.length < candidateCount) {
    options.push({ action: { type: "verifyMine", selection: verifySelection, committed: true }, value: scoreAiVerifyOwn(verifySelection.length, candidateCount) });
  }
  const tableSet = getSnapshotTableSet(room);
  const tableLive = [...tableSet].filter((seq) => player.candidate.has(seq));
  const tableValue = scoreAiVerifyTable(tableLive.length, candidateCount);
  if (tableValue > 0 && tableLive.length > 0 && tableLive.length < candidateCount) {
    options.push({ action: { type: "verifyTable", committed: true }, value: tableValue });
  }
  const addable = candidateList.filter((seq) => !player.book.includes(seq));
  if (addable.length > 0) {
    const addCount = Math.min(ADD_AMOUNT, addable.length);
    options.push({ action: { type: "add", sequences: sampleMany(addable, addCount), committed: true }, value: scoreAiAdd(addCount, addable.length) });
  }
  const choice = options.length ? chooseSoftmaxOption(options, aiSoftmaxTemperature(candidateCount)) : aiSubmit(sampleOne(candidateList));
  addPrivateLog(player, `R${room.roundNumber}: AI ${player.personality} chose ${actionTitle(choice.type)}.`);
  if (choice.type === "verifyTable") player.tableChecks += 1;
  return choice;
}

function chooseBinaryAiAction(room, player) {
  const candidateList = sequencesFromSet(player.candidate);
  const candidateCount = candidateList.length;
  const ownLive = player.book.filter((seq) => player.candidate.has(seq));
  const addable = candidateList.filter((seq) => !player.book.includes(seq));
  if (candidateCount <= 1) return aiSubmit(candidateList[0]);
  if (candidateCount <= AI_SUBMIT_THRESHOLDS.Binary) return aiSubmit(sampleOne(candidateList));
  const target = Math.max(1, Math.floor(candidateCount / 2));
  if (ownLive.length > 0 && (ownLive.length >= Math.ceil(target * 0.75) || addable.length === 0)) {
    addPrivateLog(player, `R${room.roundNumber}: binary verifies near half.`);
    return { type: "verifyMine", selection: ownLive.slice(0, Math.min(target, ownLive.length)), committed: true };
  }
  if (addable.length > 0) {
    const addCount = Math.min(ADD_AMOUNT, addable.length, Math.max(1, target - ownLive.length));
    addPrivateLog(player, `R${room.roundNumber}: binary adds toward half.`);
    return { type: "add", sequences: addable.slice(0, addCount), committed: true };
  }
  return aiSubmit(sampleOne(candidateList));
}

function aiSubmit(guess) {
  return { type: "submit", guess, committed: true };
}

function chooseAiVerifySelection(ownLive, candidateCount) {
  if (ownLive.length === 0 || candidateCount <= 1) return [];
  const targetSize = Math.max(1, Math.floor(candidateCount / 2));
  if (ownLive.length <= targetSize) return [...ownLive];
  return sampleMany(ownLive, targetSize);
}

function scoreAiAdd(addCount, addableCount) {
  if (addCount <= 0 || addableCount <= 0) return 0;
  return Math.min(addCount * ALL_SEQUENCES.length / addableCount, ADD_AMOUNT * AI_TUNING.addCapMultiplier);
}

function scoreAiVerifyOwn(selectionCount, candidateCount) {
  if (selectionCount <= 0 || selectionCount >= candidateCount) return 0;
  const expectedSplit = 2 * selectionCount * (candidateCount - selectionCount) / candidateCount;
  const coverage = selectionCount / candidateCount;
  const ramp = clamp((coverage - AI_TUNING.verifyOwnCoverageRampStart) / (AI_TUNING.verifyOwnCoverageRampEnd - AI_TUNING.verifyOwnCoverageRampStart), 0, 1);
  return expectedSplit * AI_TUNING.verifyOwnScale * (AI_TUNING.verifyOwnCoverageFloor + (1 - AI_TUNING.verifyOwnCoverageFloor) * ramp);
}

function scoreAiVerifyTable(tableLiveCount, candidateCount) {
  if (tableLiveCount <= 0 || tableLiveCount >= candidateCount) return 0;
  const expectedSplit = 2 * tableLiveCount * (candidateCount - tableLiveCount) / candidateCount;
  return Math.max(0, expectedSplit * AI_TUNING.verifyTableScale - ADD_AMOUNT * AI_TUNING.verifyTableSkipPenaltyPerAdd);
}

function scoreAiSubmit(candidateCount, submitThreshold) {
  return AI_TUNING.submitBase + Math.max(0, submitThreshold - candidateCount + 1) * AI_TUNING.submitStep;
}

function aiSoftmaxTemperature(candidateCount) {
  return Math.max(AI_TUNING.softmaxBaseTemperature, candidateCount * AI_TUNING.softmaxCandidateTemperature);
}

function chooseSoftmaxOption(options, temperature) {
  const maxValue = Math.max(...options.map((option) => option.value));
  const weighted = options.map((option) => ({ ...option, weight: Math.exp((option.value - maxValue) / temperature) }));
  let cursor = Math.random() * weighted.reduce((sum, option) => sum + option.weight, 0);
  for (const option of weighted) {
    cursor -= option.weight;
    if (cursor <= 0) return option.action;
  }
  return weighted[weighted.length - 1].action;
}

function publicState(room, viewer) {
  const humans = room.players.filter((player) => player.type === "human");
  return {
    code: room.code,
    hostId: room.hostId,
    viewerId: viewer.id,
    playerCount: room.playerCount,
    scoreTarget: room.scoreTarget,
    aiTypes: room.aiTypes,
    phase: room.phase,
    roundNumber: room.roundNumber,
    addAmount: ADD_AMOUNT,
    allSequences: ALL_SEQUENCES,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      type: player.type,
      personality: player.personality,
      host: player.host,
      seat: player.seat,
      score: player.score,
      connected: player.connected,
      book: player.book,
      skipNext: player.skipNext,
      ranked: player.ranked,
      rank: player.rank,
      tied: player.tied,
      finishRound: player.finishRound,
      lastAction: player.lastAction,
    })),
    viewer: {
      candidate: [...viewer.candidate],
      book: viewer.book,
      privateLog: viewer.privateLog,
      pending: room.pendingActions.has(viewer.id),
      skipNext: viewer.skipNext,
      ranked: viewer.ranked,
      rank: viewer.rank,
    },
    nextReady: {
      count: humans.filter((player) => room.roundReady.has(player.id)).length,
      total: humans.length,
      viewerReady: room.roundReady.has(viewer.id),
      readyIds: humans.filter((player) => room.roundReady.has(player.id)).map((player) => player.id),
    },
    publicFeed: room.publicFeed,
    publicEliminated: [...room.publicEliminated],
    puzzleResult: ["between", "gameOver"].includes(room.phase) ? room.puzzleResult : null,
    matchResult: room.phase === "gameOver" ? room.matchResult : null,
  };
}

function broadcast(room) {
  room.clients.forEach((client, playerId) => {
    const player = room.players.find((item) => item.id === playerId);
    if (!player) return;
    client.write(`event: state\ndata: ${JSON.stringify(publicState(room, player))}\n\n`);
  });
}

function addPrivateLog(player, line) {
  player.privateLog.unshift(line);
}

function getSnapshotTableSet(room) {
  const tableSet = new Set();
  room.snapshotBooks.forEach((book) => book.forEach((seq) => tableSet.add(seq)));
  return tableSet;
}

function sequencesFromSet(set) {
  return ALL_SEQUENCES.filter((seq) => set.has(seq));
}

function intersectSets(left, right) {
  const result = new Set();
  left.forEach((value) => {
    if (right.has(value)) result.add(value);
  });
  return result;
}

function actionTitle(type) {
  return { add: "Add", verifyMine: "Verify Mine", verifyTable: "Verify Table", submit: "Submit", skip: "Skip" }[type] || "Action";
}

function rankLabel(player) {
  return player.tied ? `Tie #${player.rank}` : `#${player.rank}`;
}

function formatSequenceList(sequences, limit = 8) {
  if (!sequences || sequences.length === 0) return "none";
  const shown = sequences.slice(0, limit).join(", ");
  const remaining = sequences.length - limit;
  return remaining > 0 ? `${shown}, +${remaining} more` : shown;
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

function unique(items) {
  return [...new Set(items)];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/multiplayer.html" : url.pathname;
  const filePath = path.normalize(path.join(ROOT, requested));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json" };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "POST" && url.pathname === "/api/rooms") {
      const body = await readBody(req);
      const { room, player } = createRoom(body.name);
      return sendJson(res, 200, { code: room.code, playerId: player.id, token: player.token });
    }
    const joinMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{4})\/join$/);
    if (req.method === "POST" && joinMatch) {
      const body = await readBody(req);
      const result = joinRoom(joinMatch[1], body.name);
      if (result.error) return sendJson(res, 400, result);
      return sendJson(res, 200, { code: result.room.code, playerId: result.player.id, token: result.player.token });
    }
    const startMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{4})\/start$/);
    if (req.method === "POST" && startMatch) {
      const body = await readBody(req);
      const auth = authRoom(startMatch[1], body.playerId, body.token);
      if (auth.error) return sendJson(res, 401, auth);
      const result = startGame(auth.room, auth.player, body);
      if (result.error) return sendJson(res, 400, result);
      broadcast(auth.room);
      return sendJson(res, 200, { ok: true });
    }
    const newGameMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{4})\/new-game$/);
    if (req.method === "POST" && newGameMatch) {
      const body = await readBody(req);
      const auth = authRoom(newGameMatch[1], body.playerId, body.token);
      if (auth.error) return sendJson(res, 401, auth);
      const result = newGame(auth.room, auth.player);
      if (result.error) return sendJson(res, 400, result);
      broadcast(auth.room);
      return sendJson(res, 200, { ok: true });
    }
    const lobbyMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{4})\/lobby$/);
    if (req.method === "POST" && lobbyMatch) {
      const body = await readBody(req);
      const auth = authRoom(lobbyMatch[1], body.playerId, body.token);
      if (auth.error) return sendJson(res, 401, auth);
      const result = backToLobby(auth.room, auth.player);
      if (result.error) return sendJson(res, 400, result);
      broadcast(auth.room);
      return sendJson(res, 200, { ok: true });
    }
    const readyMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{4})\/ready-next$/);
    if (req.method === "POST" && readyMatch) {
      const body = await readBody(req);
      const auth = authRoom(readyMatch[1], body.playerId, body.token);
      if (auth.error) return sendJson(res, 401, auth);
      const result = readyNextRound(auth.room, auth.player);
      if (result.error) return sendJson(res, 400, result);
      if (!result.started) broadcast(auth.room);
      return sendJson(res, 200, { ok: true, started: Boolean(result.started) });
    }
    const actionMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{4})\/action$/);
    if (req.method === "POST" && actionMatch) {
      const body = await readBody(req);
      const auth = authRoom(actionMatch[1], body.playerId, body.token);
      if (auth.error) return sendJson(res, 401, auth);
      const result = submitPlayerAction(auth.room, auth.player, body.action || {});
      if (result.error) return sendJson(res, 400, result);
      return sendJson(res, 200, { ok: true });
    }
    const stateMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{4})\/state$/);
    if (req.method === "GET" && stateMatch) {
      const auth = authRoom(stateMatch[1], url.searchParams.get("playerId"), url.searchParams.get("token"));
      if (auth.error) return sendJson(res, 401, auth);
      return sendJson(res, 200, publicState(auth.room, auth.player));
    }
    const eventsMatch = url.pathname.match(/^\/events\/([A-Z0-9]{4})$/);
    if (req.method === "GET" && eventsMatch) {
      const auth = authRoom(eventsMatch[1], url.searchParams.get("playerId"), url.searchParams.get("token"));
      if (auth.error) return sendJson(res, 401, auth);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      auth.room.clients.set(auth.player.id, res);
      auth.player.connected = true;
      res.write(`event: state\ndata: ${JSON.stringify(publicState(auth.room, auth.player))}\n\n`);
      req.on("close", () => {
        auth.room.clients.delete(auth.player.id);
        auth.player.connected = false;
        broadcast(auth.room);
      });
      return;
    }
    return serveStatic(req, res);
  } catch (error) {
    return sendJson(res, 500, { error: error.message || "Server error" });
  }
});

server.listen(PORT, () => {
  console.log(`Sequence Table server listening on http://localhost:${PORT}`);
});
