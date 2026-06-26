(() => {
  "use strict";

  const app = document.getElementById("app");
  const ALL_AI_TYPES = ["Reader", "Binary", "Balanced", "Aggressive", "Cautious"];
  const store = {
    code: localStorage.getItem("st_room") || "",
    playerId: localStorage.getItem("st_player") || "",
    token: localStorage.getItem("st_token") || "",
    state: null,
    source: null,
    lobbyPlayerCount: null,
    lobbyAiTypes: null,
    selectedAction: "add",
    selected: new Set(),
    selectedGuess: null,
    lowLikely: new Set(),
    error: "",
  };

  store.lowLikely = loadLowLikely();
  app.addEventListener("click", handleClick);
  app.addEventListener("change", handleChange);
  connectIfReady();
  render();

  async function api(path, body) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  function saveSession(data) {
    store.code = data.code;
    store.playerId = data.playerId;
    store.token = data.token;
    localStorage.setItem("st_room", store.code);
    localStorage.setItem("st_player", store.playerId);
    localStorage.setItem("st_token", store.token);
    store.lowLikely = loadLowLikely();
    connectIfReady(true);
  }

  function connectIfReady(force = false) {
    if (!store.code || !store.playerId || !store.token) return;
    if (store.source && !force) return;
    if (store.source) store.source.close();
    store.source = new EventSource(`/events/${store.code}?playerId=${encodeURIComponent(store.playerId)}&token=${encodeURIComponent(store.token)}`);
    store.source.addEventListener("state", (event) => {
      store.state = JSON.parse(event.data);
      store.error = "";
      render();
    });
    store.source.onerror = () => {
      store.error = "Disconnected. Refresh or rejoin if this stays stuck.";
      render();
    };
  }

  async function handleClick(event) {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    const seq = target.dataset.seq;
    try {
      if (action === "create-room") {
        const name = document.getElementById("player-name").value;
        saveSession(await api("/api/rooms", { name }));
        return;
      }
      if (action === "join-room") {
        const name = document.getElementById("join-name").value;
        const code = document.getElementById("join-code").value.trim().toUpperCase();
        saveSession(await api(`/api/rooms/${code}/join`, { name }));
        return;
      }
      if (action === "leave-room") {
        if (store.source) store.source.close();
        localStorage.removeItem("st_room");
        localStorage.removeItem("st_player");
        localStorage.removeItem("st_token");
        Object.assign(store, { code: "", playerId: "", token: "", state: null, source: null, lowLikely: new Set() });
        render();
        return;
      }
      if (action === "start-game") {
        const playerCount = store.lobbyPlayerCount || Number(document.getElementById("mp-player-count").value);
        const aiTypes = store.lobbyAiTypes || [1, 2, 3].map((index) => document.getElementById(`mp-ai-${index}`).value);
        await api(`/api/rooms/${store.code}/start`, { playerId: store.playerId, token: store.token, playerCount, aiTypes });
        return;
      }
      if (action === "new-game") {
        await api(`/api/rooms/${store.code}/new-game`, { playerId: store.playerId, token: store.token });
        return;
      }
      if (action === "back-to-lobby") {
        await api(`/api/rooms/${store.code}/lobby`, { playerId: store.playerId, token: store.token });
        return;
      }
      if (action === "copy-link") {
        await navigator.clipboard.writeText(`${location.origin}${location.pathname}?room=${store.code}`);
        store.error = "Room link copied.";
        render();
        return;
      }
      if (action === "select-action") {
        store.selectedAction = target.dataset.kind;
        store.selected = new Set();
        store.selectedGuess = null;
        render();
        return;
      }
      if (action === "toggle-seq" && seq) {
        toggleSeq(seq);
        render();
        return;
      }
      if (action === "toggle-lowlikely" && seq) {
        toggleLowLikely(seq);
        render();
        return;
      }
      if (action === "quick-fill") {
        quickFill(false);
        render();
        return;
      }
      if (action === "quick-fill-table") {
        quickFill(true);
        render();
        return;
      }
      if (action === "select-all-verify") {
        selectAllVerify();
        render();
        return;
      }
      if (action === "deselect-all-verify") {
        store.selected = new Set();
        render();
        return;
      }
      if (action === "submit-action") {
        await submitAction();
        return;
      }
    } catch (error) {
      store.error = error.message;
      render();
    }
  }

  function handleChange(event) {
    if (event.target.id === "mp-player-count") {
      store.lobbyPlayerCount = Number(event.target.value);
      render();
    }
    if (event.target.id?.startsWith("mp-ai-")) {
      const index = Number(event.target.id.replace("mp-ai-", "")) - 1;
      const source = store.lobbyAiTypes || store.state?.aiTypes || ["Reader", "Binary", "Balanced"];
      store.lobbyAiTypes = [...source];
      store.lobbyAiTypes[index] = event.target.value;
      render();
    }
  }

  function toggleSeq(seq) {
    if (store.selectedAction === "submit") {
      store.selectedGuess = store.selectedGuess === seq ? null : seq;
      return;
    }
    if (store.selected.has(seq)) store.selected.delete(seq);
    else {
      if (store.selectedAction === "add" && store.selected.size >= store.state.addAmount) return;
      store.selected.add(seq);
    }
  }

  function quickFill(uncoveredOnly) {
    const state = store.state;
    const table = currentTableSet();
    const addable = sortAddableForChoice(state.viewer.candidate.filter((seq) => !state.viewer.book.includes(seq)))
      .filter((seq) => !store.selected.has(seq))
      .filter((seq) => !uncoveredOnly || !table.has(seq));
    const pools = [
      addable.filter((seq) => !store.lowLikely.has(seq)),
      addable.filter((seq) => store.lowLikely.has(seq)),
    ];
    pools.forEach((pool) => {
      while (store.selected.size < state.addAmount && pool.length > 0) {
        const index = Math.floor(Math.random() * pool.length);
        store.selected.add(pool.splice(index, 1)[0]);
      }
    });
  }

  function toggleLowLikely(seq) {
    if (store.lowLikely.has(seq)) store.lowLikely.delete(seq);
    else store.lowLikely.add(seq);
    saveLowLikely();
  }

  function selectAllVerify() {
    const candidateSet = new Set(store.state.viewer.candidate);
    store.state.viewer.book
      .filter((seq) => candidateSet.has(seq))
      .forEach((seq) => store.selected.add(seq));
  }

  function loadLowLikely() {
    const key = lowLikelyStorageKey();
    if (!key) return new Set();
    try {
      return new Set(JSON.parse(localStorage.getItem(key) || "[]"));
    } catch {
      return new Set();
    }
  }

  function saveLowLikely() {
    const key = lowLikelyStorageKey();
    if (!key) return;
    localStorage.setItem(key, JSON.stringify([...store.lowLikely]));
  }

  function lowLikelyStorageKey() {
    if (!store.code || !store.playerId) return "";
    return `st_low_likely_${store.code}_${store.playerId}`;
  }

  async function submitAction() {
    const type = store.selectedAction;
    const action = { type };
    if (type === "add") action.sequences = [...store.selected];
    if (type === "verifyMine") action.selection = [...store.selected];
    if (type === "submit") action.guess = store.selectedGuess;
    await api(`/api/rooms/${store.code}/action`, { playerId: store.playerId, token: store.token, action });
    store.selected = new Set();
    store.selectedGuess = null;
  }

  function render() {
    if (!store.state) {
      app.innerHTML = renderHome();
      return;
    }
    if (store.state.phase === "lobby") {
      app.innerHTML = renderLobby();
      return;
    }
    app.innerHTML = renderGame();
  }

  function renderHome() {
    return `
      <section class="setup-screen">
        <div class="setup-card">
          <div class="brand setup-brand">
            <div class="mark" aria-hidden="true"></div>
            <div><h1>Sequence Table Online</h1><span>X=4 multiplayer prototype</span></div>
          </div>
          ${store.error ? `<div class="private-line">${escapeHtml(store.error)}</div>` : ""}
          <div class="mode-grid">
            <div class="mode-field mp-form">
              <span>Create</span>
              <input id="player-name" placeholder="Your name" />
              <button class="primary" data-action="create-room">Create Room</button>
            </div>
            <div class="mode-field mp-form">
              <span>Join</span>
              <input id="join-name" placeholder="Your name" />
              <input id="join-code" placeholder="Room code" value="${new URLSearchParams(location.search).get("room") || ""}" />
              <button class="accent" data-action="join-room">Join Room</button>
            </div>
          </div>
        </div>
      </section>
    `;
  }

  function renderLobby() {
    const state = store.state;
    const viewer = state.players.find((player) => player.id === state.viewerId);
    const isHost = state.hostId === state.viewerId;
    const humanCount = state.players.filter((player) => player.type === "human").length;
    const playerCount = Math.max(store.lobbyPlayerCount || state.playerCount, humanCount);
    const aiTypes = store.lobbyAiTypes || state.aiTypes;
    return `
      ${renderHeader()}
      <main class="multiplayer-layout">
        <section class="mp-panel">
          <div class="panel-head">
            <div><h2>Lobby</h2><div class="panel-subtitle">Send this code to friends</div></div>
            <div class="room-code">${state.code}</div>
          </div>
          <div class="action-buttons">
            <button class="accent copy-link" data-action="copy-link">Copy Room Link</button>
            <button class="quiet" data-action="leave-room">Leave</button>
          </div>
          <div class="rank-list">
            ${state.players.map((player) => `<div class="rank-row"><strong>${escapeHtml(player.name)}</strong><span>${escapeHtml(player.personality)} ${player.connected ? "online" : "offline"}</span></div>`).join("")}
          </div>
        </section>
        <aside class="mp-panel">
          <div class="panel-head"><div><h2>Start</h2><div class="panel-subtitle">X=4, ${viewer.host ? "host controls" : "waiting for host"}</div></div></div>
          <label class="mode-field" for="mp-player-count"><span>Seats</span>
            <select id="mp-player-count" ${isHost ? "" : "disabled"}>
              ${[2, 3, 4].map((count) => `<option value="${count}" ${count === playerCount ? "selected" : ""} ${count < humanCount ? "disabled" : ""}>${count}</option>`).join("")}
            </select>
          </label>
          <div class="ai-seat-grid">
            ${[1, 2, 3].map((index) => `
              <label class="mode-field" for="mp-ai-${index}">
                <span>${["AI 1", "AI 2", "AI 3"][index - 1]}</span>
                <select id="mp-ai-${index}" ${isHost ? "" : "disabled"}>
                  ${ALL_AI_TYPES.map((type) => `<option value="${type}" ${type === (aiTypes[index - 1] || "Balanced") ? "selected" : ""}>${type}</option>`).join("")}
                </select>
              </label>
            `).join("")}
          </div>
          ${isHost ? `<button class="primary" data-action="start-game">Start Game</button>` : `<div class="mp-wait">Waiting for host.</div>`}
        </aside>
      </main>
    `;
  }

  function renderGame() {
    const state = store.state;
    return `
      ${renderHeader()}
      <section class="status-strip">
        <div class="status-item"><div class="label">Room</div><div class="value">${state.code}</div></div>
        <div class="status-item"><div class="label">Round</div><div class="value">${state.roundNumber}</div></div>
        <div class="status-item"><div class="label">Candidates</div><div class="value">${state.viewer.candidate.length} / ${state.allSequences.length}</div></div>
        <div class="status-item"><div class="label">Status</div><div class="value">${state.viewer.ranked ? `#${state.viewer.rank}` : state.viewer.pending ? "Submitted" : "Choose"}</div></div>
      </section>
      <main class="multiplayer-layout">
        <section class="table-stage">
          ${state.players.map((player) => renderPlayer(player)).join("")}
          <div class="center-table">
            <div class="center-title"><div><h2>${state.phase === "ended" ? "Puzzle Complete" : "Hidden sequence"}</h2><div class="answer-mask">${renderAnswerMask()}</div></div></div>
            <div class="action-feed">${state.publicFeed.map((line) => `<div class="feed-line">${escapeHtml(line)}</div>`).join("")}</div>
          </div>
        </section>
        <aside class="action-panel">
          ${state.phase === "ended" ? renderResult() : renderActionPanel()}
        </aside>
      </main>
    `;
  }

  function renderHeader() {
    return `
      <header class="topbar">
        <div class="brand"><div class="mark" aria-hidden="true"></div><div><h1>Sequence Table Online</h1><span>X=4 realtime room</span></div></div>
        <div class="settings"><a class="quiet button-link" href="./index.html">Solo</a></div>
      </header>
    `;
  }

  function renderPlayer(player) {
    const isViewer = player.id === store.state.viewerId;
    const bookPreview = isViewer ? sortOwnBookForSelection(player.book).slice(0, 20) : player.book.slice(-20);
    return `
      <div class="player-panel ${isViewer ? "is-human" : ""} ${player.ranked ? "is-ranked" : ""}">
        <div class="player-head"><div><div class="player-name">${escapeHtml(player.name)}</div><span class="badge">${escapeHtml(player.personality)}</span></div><div class="score">${player.score}</div></div>
        <div class="player-meta">
          <div class="mini-stat"><strong>${player.book.length}</strong><span>Book</span></div>
          <div class="mini-stat"><strong>${player.ranked ? `${player.tied ? "Tie " : ""}#${player.rank}` : player.skipNext ? "Skip" : "Live"}</strong><span>Status</span></div>
          <div class="mini-stat"><strong>${escapeHtml(player.lastAction)}</strong><span>Action</span></div>
        </div>
        <div class="book-preview">${bookPreview.map((seq) => renderPreviewChip(seq, isViewer)).join("") || `<span class="badge">Empty</span>`}</div>
      </div>
    `;
  }

  function renderActionPanel() {
    const state = store.state;
    if (state.viewer.ranked) return `<div class="mp-wait">You finished. Waiting for the table.</div>${renderPrivateLog()}`;
    if (state.viewer.skipNext) return `<div class="mp-wait">Skipping this round.</div>${renderPrivateLog()}`;
    if (state.viewer.pending) return `<div class="mp-wait">Action submitted. Waiting for other players.</div>${renderPrivateLog()}`;
    return `
      <div class="panel-head"><div><h2>${actionLabel(store.selectedAction)}</h2><div class="panel-subtitle">Pick and submit your round action.</div></div></div>
      <div class="mp-action-tabs">
        ${["add", "verifyMine", "verifyTable", "submit"].map((type) => `<button class="${store.selectedAction === type ? "primary" : "quiet"}" data-action="select-action" data-kind="${type}">${actionLabel(type)}</button>`).join("")}
      </div>
      ${renderActionBody()}
      ${renderPrivateLog()}
    `;
  }

  function renderActionBody() {
    if (store.selectedAction === "verifyTable") {
      return `<div class="empty-note">Check all public books and skip your next round.</div><button class="primary" data-action="submit-action">Check Table</button>`;
    }
    const state = store.state;
    const table = currentTableSet();
    let sequences = [];
    let tools = "";
    if (store.selectedAction === "add") {
      sequences = sortAddableForChoice(state.viewer.candidate.filter((seq) => !state.viewer.book.includes(seq)));
      const uncovered = sequences.filter((seq) => !table.has(seq)).length;
      const covered = sequences.length - uncovered;
      tools = `
        <div class="book-tools">
          <button class="accent" data-action="quick-fill">Quick Fill</button>
          <button class="accent" data-action="quick-fill-table">Fill Not On Table</button>
        </div>
        <div class="book-tools compact-tools">
          <span class="badge">${uncovered} not on table</span>
          <span class="badge">${covered} already on table</span>
          <span class="badge">${store.lowLikely.size} low likely</span>
        </div>
      `;
    } else if (store.selectedAction === "verifyMine") {
      sequences = sortOwnBookForSelection(state.viewer.book);
      tools = `
        <div class="book-tools">
          <button class="accent" data-action="select-all-verify">Select All</button>
          <button class="quiet" data-action="deselect-all-verify">Deselect All</button>
        </div>
      `;
    } else {
      sequences = sortCandidatesForChoice(state.viewer.candidate);
    }
    return `
      ${tools}
      <div class="mp-seq-grid">
        ${sequences.map((seq) => {
          const selected = store.selectedAction === "submit" ? store.selectedGuess === seq : store.selected.has(seq);
          const disabled = store.selectedAction === "verifyMine" && !state.viewer.candidate.includes(seq);
          return renderSequenceCell(seq, selected, disabled);
        }).join("") || `<div class="empty-note">No available sequences.</div>`}
      </div>
      <button class="primary" data-action="submit-action">Submit ${actionLabel(store.selectedAction)}</button>
    `;
  }

  function renderPrivateLog() {
    return `<div class="private-log mp-private-log">${store.state.viewer.privateLog.slice(0, 12).map((line) => `<div class="private-line">${escapeHtml(line)}</div>`).join("")}</div>`;
  }

  function renderResult() {
    const result = store.state.puzzleResult;
    const isHost = store.state.hostId === store.state.viewerId;
    return `
      <div class="panel-head"><div><h2>Puzzle Complete</h2><div class="panel-subtitle">Answer ${result.answer} / ${result.roundsUsed} rounds</div></div></div>
      <div class="rank-list">
        ${result.ranks.map((rank) => `<div class="rank-row"><strong>${rank.tied ? `Tie #${rank.rank}` : `#${rank.rank}`} ${escapeHtml(rank.name)}</strong><span>R${rank.finishRound} / +${rank.points}</span></div>`).join("")}
      </div>
      ${isHost ? `
        <div class="action-buttons">
          <button class="primary" data-action="new-game">New Game</button>
          <button class="quiet" data-action="back-to-lobby">Back to Lobby</button>
        </div>
      ` : `<div class="mp-wait">Waiting for host.</div>`}
      ${renderPrivateLog()}
    `;
  }

  function currentTableSet() {
    const set = new Set();
    store.state.players.forEach((player) => player.book.forEach((seq) => set.add(seq)));
    return set;
  }

  function renderSequenceCell(seq, selected, disabled = false) {
    const lowLikely = store.lowLikely.has(seq);
    const tableCovered = currentTableSet().has(seq);
    const chipClasses = disabled ? "grey disabled" : "bright selectable";
    const actionAttr = disabled ? "" : `data-action="toggle-seq" data-seq="${seq}"`;
    const disabledAttr = disabled ? "disabled" : "";
    return `
      <div class="seq-cell ${lowLikely ? "is-lowlikely" : ""} ${tableCovered ? "is-covered" : "is-uncovered"}">
        <button class="seq-chip ${chipClasses} ${selected ? "selected" : ""}" ${actionAttr} ${disabledAttr}>${escapeHtml(seq)}</button>
        ${disabled ? "" : `<button class="likelihood-toggle ${lowLikely ? "active" : ""}" data-action="toggle-lowlikely" data-seq="${seq}" title="Toggle low likely" aria-label="Toggle low likely ${seq}">L</button>`}
      </div>
    `;
  }

  function renderPreviewChip(seq, isViewer) {
    const candidateSet = new Set(store.state.viewer.candidate);
    const live = !isViewer || candidateSet.has(seq);
    const lowLikely = isViewer && store.lowLikely.has(seq);
    return `<span class="seq-chip ${live ? "bright" : "grey"} ${lowLikely ? "lowlikely-chip" : ""}">${escapeHtml(seq)}</span>`;
  }

  function sortOwnBookForSelection(book) {
    const candidateSet = new Set(store.state.viewer.candidate);
    return [...book].sort((left, right) => {
      const leftLive = candidateSet.has(left) ? 0 : 1;
      const rightLive = candidateSet.has(right) ? 0 : 1;
      if (leftLive !== rightLive) return leftLive - rightLive;
      const lowCompare = compareLowLikely(left, right);
      if (lowCompare) return lowCompare;
      return book.indexOf(left) - book.indexOf(right);
    });
  }

  function sortAddableForChoice(sequences) {
    const tableSet = currentTableSet();
    return [...sequences].sort((left, right) => {
      const lowCompare = compareLowLikely(left, right);
      if (lowCompare) return lowCompare;
      const leftCovered = tableSet.has(left) ? 1 : 0;
      const rightCovered = tableSet.has(right) ? 1 : 0;
      if (leftCovered !== rightCovered) return leftCovered - rightCovered;
      return sequenceIndex(left) - sequenceIndex(right);
    });
  }

  function sortCandidatesForChoice(sequences) {
    return [...sequences].sort((left, right) => compareLowLikely(left, right) || sequenceIndex(left) - sequenceIndex(right));
  }

  function compareLowLikely(left, right) {
    const leftLow = store.lowLikely.has(left) ? 1 : 0;
    const rightLow = store.lowLikely.has(right) ? 1 : 0;
    return leftLow - rightLow;
  }

  function sequenceIndex(seq) {
    return store.state.allSequences.indexOf(seq);
  }

  function renderAnswerMask() {
    const answer = store.state.puzzleResult?.answer || "????";
    return answer.split("").map((digit) => `<span class="digit-tile">${store.state.phase === "ended" ? digit : "?"}</span>`).join("");
  }

  function actionLabel(type) {
    return { add: "Add", verifyMine: "Verify Mine", verifyTable: "Verify Table", submit: "Submit" }[type] || "Action";
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
})();
