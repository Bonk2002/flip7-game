const express = require("express");
const http = require("http");
const cors = require("cors");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const PORT = process.env.PORT || 3001;
const TARGET_SCORE = 200;
const ROUND_RESTART_DELAY = 4500;
const MAX_PLAYERS = 8;

const REVEAL_MS = 850;
const FLY_MS = 900;
const BETWEEN_DEALS_MS = 350;

const lobbies = {};

let globalCardId = 1;
let globalEventId = 1;

function nextCardId() {
  return `c_${globalCardId++}`;
}

function nextEventId() {
  return `e_${globalEventId++}`;
}

function createNumberCard(value) {
  return {
    id: nextCardId(),
    kind: "number",
    value,
    label: String(value),
  };
}

function createActionCard(action) {
  const labels = {
    SECOND_CHANCE: "Second Chance",
    DRAW_3: "Zieh 3",
    FREEZE: "Freeze",
  };

  return {
    id: nextCardId(),
    kind: "action",
    action,
    label: labels[action] || action,
  };
}

function createBonusCard(bonus) {
  const labels = {
    PLUS_2: "+2",
    PLUS_4: "+4",
    PLUS_6: "+6",
    PLUS_8: "+8",
    PLUS_10: "+10",
    MULTIPLY_2: "x2",
  };

  return {
    id: nextCardId(),
    kind: "bonus",
    bonus,
    label: labels[bonus] || bonus,
  };
}

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function createDeck() {
  const deck = [];

  for (let value = 1; value <= 12; value++) {
    for (let count = 0; count < value; count++) {
      deck.push(createNumberCard(value));
    }
  }

  for (let i = 0; i < 3; i++) deck.push(createActionCard("SECOND_CHANCE"));
  for (let i = 0; i < 3; i++) deck.push(createActionCard("DRAW_3"));
  for (let i = 0; i < 3; i++) deck.push(createActionCard("FREEZE"));

  deck.push(createBonusCard("PLUS_2"));
  deck.push(createBonusCard("PLUS_4"));
  deck.push(createBonusCard("PLUS_6"));
  deck.push(createBonusCard("PLUS_8"));
  deck.push(createBonusCard("PLUS_10"));
  deck.push(createBonusCard("MULTIPLY_2"));

  return shuffle(deck);
}

function generateLobbyCode(length = 5) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";

  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return code;
}

function makePlayer({ id, name, isHost = false }) {
  return {
    id,
    name,
    isHost,
    connected: true,
    cards: [],
    bonusCards: [],
    hasSecondChance: false,
    stopped: false,
    stoppedByChoice: false,
    busted: false,
    frozen: false,
    completedSevenCards: false,
    lastEffect: null,
    effectTick: 0,
    totalScore: 0,
  };
}

function setPlayerEffect(player, effect) {
  player.lastEffect = effect;
  player.effectTick = (player.effectTick || 0) + 1;
}

function setLobbyEvent(lobby, type, text, playerId = null, meta = null) {
  lobby.lastEvent = {
    id: nextEventId(),
    type,
    text,
    playerId,
    meta,
    ts: Date.now(),
  };
}

function getCurrentPlayer(lobby) {
  if (!lobby.players.length) return null;
  if (typeof lobby.currentPlayerIndex !== "number") return null;
  return lobby.players[lobby.currentPlayerIndex] || null;
}

function getNumberCards(player) {
  return player.cards.filter((card) => card.kind === "number");
}

function getVisibleCardCount(player) {
  return (player.cards?.length || 0) + (player.bonusCards?.length || 0);
}

function calculateRoundScore(player) {
  const numberSum = getNumberCards(player).reduce((sum, card) => sum + card.value, 0);

  let plus = 0;
  let multiply2 = false;

  for (const card of player.bonusCards) {
    if (card.bonus === "PLUS_2") plus += 2;
    if (card.bonus === "PLUS_4") plus += 4;
    if (card.bonus === "PLUS_6") plus += 6;
    if (card.bonus === "PLUS_8") plus += 8;
    if (card.bonus === "PLUS_10") plus += 10;
    if (card.bonus === "MULTIPLY_2") multiply2 = true;
  }

  let total = numberSum + plus;
  if (multiply2) total *= 2;
  if (player.completedSevenCards) total += 15;

  return total;
}

function getActivePlayers(lobby) {
  return lobby.players.filter((p) => !p.stopped && !p.busted);
}

function findNextActivePlayerIndex(lobby, startIndex) {
  if (!lobby.players.length) return -1;

  for (let step = 1; step <= lobby.players.length; step++) {
    const index = (startIndex + step) % lobby.players.length;
    const player = lobby.players[index];

    if (player && !player.stopped && !player.busted) {
      return index;
    }
  }

  return -1;
}

function drawFromDeck(lobby) {
  if (!lobby.deck.length) return null;
  return lobby.deck.pop();
}

function discardCard(lobby, card) {
  if (card) {
    lobby.discard.push(card);
  }
}

function getValidFreezeTargets(lobby) {
  return lobby.players.filter((p) => !p.busted && !p.stopped);
}

function queueFollowUpAction(lobby, playerId, actionType) {
  lobby.followUpActions.push({
    playerId,
    actionType,
  });
}

function getPublicLobbyState(code) {
  const lobby = lobbies[code];
  if (!lobby) return null;

  const currentPlayer = getCurrentPlayer(lobby);

  return {
    code: lobby.code,
    phase: lobby.phase,
    hostId: lobby.hostId,
    targetScore: TARGET_SCORE,
    roundNumber: lobby.roundNumber,
    currentPlayerId: currentPlayer ? currentPlayer.id : null,
    currentPlayerIndex:
      typeof lobby.currentPlayerIndex === "number" ? lobby.currentPlayerIndex : 0,
    deckCount: lobby.deck.length,
    winnerId: lobby.winnerId || null,
    winnerName: lobby.winnerName || null,
    lastEvent: lobby.lastEvent || null,
    processing: !!lobby.processing,
    pendingAction: lobby.pendingAction
      ? {
          type: lobby.pendingAction.type,
          playerId: lobby.pendingAction.playerId,
          remaining: lobby.pendingAction.remaining || 0,
          selections: lobby.pendingAction.selections || [],
        }
      : null,
    animationState: lobby.animationState || null,
    players: lobby.players.map((player) => ({
      id: player.id,
      name: player.name,
      isHost: player.isHost,
      connected: player.connected,
      cards: player.cards,
      bonusCards: player.bonusCards,
      hasSecondChance: player.hasSecondChance,
      stopped: player.stopped,
      stoppedByChoice: player.stoppedByChoice,
      busted: player.busted,
      frozen: player.frozen,
      totalScore: player.totalScore,
      lastEffect: player.lastEffect,
      effectTick: player.effectTick,
      completedSevenCards: !!player.completedSevenCards,
      roundScorePreview: player.busted ? 0 : calculateRoundScore(player),
      numberCardCount: getNumberCards(player).length,
      visibleCardCount: getVisibleCardCount(player),
    })),
  };
}

function emitLobbyUpdate(code) {
  const state = getPublicLobbyState(code);
  if (!state) return;
  io.to(code).emit("lobby_updated", state);
}

function getNextRoundStarterIndex(lobby) {
  if (!lobby.players.length) return 0;
  return (lobby.nextStarterIndex || 0) % lobby.players.length;
}

function initializeRound(lobby) {
  lobby.phase = "round";
  lobby.roundNumber += 1;
  lobby.deck = createDeck();
  lobby.discard = [];
  lobby.pendingAction = null;
  lobby.followUpActions = [];
  lobby.animationState = null;
  lobby.processing = false;
  lobby.turnShouldAdvanceAfterResolution = false;
  lobby.winnerId = null;
  lobby.winnerName = null;

  lobby.players.forEach((player) => {
    player.cards = [];
    player.bonusCards = [];
    player.hasSecondChance = false;
    player.stopped = false;
    player.stoppedByChoice = false;
    player.busted = false;
    player.frozen = false;
    player.completedSevenCards = false;
    player.lastEffect = null;
    player.effectTick = 0;
    player.connected = true;
  });

  lobby.currentPlayerIndex = getNextRoundStarterIndex(lobby);
  setLobbyEvent(lobby, "round_start", `Runde ${lobby.roundNumber} startet.`, null);
}

function endRound(lobby) {
  lobby.phase = "round_end";
  lobby.pendingAction = null;
  lobby.followUpActions = [];
  lobby.animationState = null;
  lobby.processing = false;
  lobby.turnShouldAdvanceAfterResolution = false;

  lobby.players.forEach((player) => {
    if (!player.busted) {
      player.totalScore += calculateRoundScore(player);
    }
  });

  const winnerCandidates = lobby.players
    .filter((player) => player.totalScore >= TARGET_SCORE && player.stoppedByChoice)
    .sort((a, b) => b.totalScore - a.totalScore);

  if (winnerCandidates.length > 0) {
    const winner = winnerCandidates[0];
    lobby.phase = "game_over";
    lobby.winnerId = winner.id;
    lobby.winnerName = winner.name;

    setPlayerEffect(winner, "winner");
    setLobbyEvent(
      lobby,
      "game_over",
      `${winner.name} gewinnt mit ${winner.totalScore} Punkten!`,
      winner.id
    );
    emitLobbyUpdate(lobby.code);
    return;
  }

  if (lobby.players.length > 0) {
    lobby.nextStarterIndex = (getNextRoundStarterIndex(lobby) + 1) % lobby.players.length;
  }

  setLobbyEvent(lobby, "round_end", "Runde beendet. Neue Runde startet gleich.", null);
  emitLobbyUpdate(lobby.code);

  setTimeout(() => {
    if (!lobbies[lobby.code]) return;
    if (lobby.phase === "game_over") return;

    initializeRound(lobby);
    emitLobbyUpdate(lobby.code);
  }, ROUND_RESTART_DELAY);
}

function nextTurn(lobby) {
  const activePlayers = getActivePlayers(lobby);

  if (!activePlayers.length) {
    endRound(lobby);
    return;
  }

  const nextIndex = findNextActivePlayerIndex(lobby, lobby.currentPlayerIndex);
  if (nextIndex === -1) {
    endRound(lobby);
    return;
  }

  lobby.currentPlayerIndex = nextIndex;
}

function maybeCompleteSevenCards(lobby, player) {
  if (player.completedSevenCards) return;
  if (getNumberCards(player).length < 7) return;

  player.completedSevenCards = true;
  player.stopped = true;
  player.stoppedByChoice = true;
  setPlayerEffect(player, "winner");
  setLobbyEvent(
    lobby,
    "flip7",
    `${player.name} hat 7 Zahlenkarten gesammelt und bekommt +15 Punkte!`,
    player.id
  );
}

function eliminateByFreeze(lobby, target, sourceName, sourceId) {
  target.stopped = true;
  target.stoppedByChoice = false;
  target.frozen = true;
  target.hasSecondChance = false;
  setPlayerEffect(target, "freeze");
  setLobbyEvent(
    lobby,
    "freeze",
    `${sourceName} friert ${target.name} ein. Die Runde für ${target.name} endet sofort.`,
    target.id,
    { sourcePlayerId: sourceId, targetPlayerId: target.id }
  );
}

function resolveNumberCard(lobby, player, card) {
  player.cards.push(card);

  const sameNumbers = getNumberCards(player).filter((c) => c.value === card.value);

  if (sameNumbers.length > 1) {
    if (player.hasSecondChance) {
      player.hasSecondChance = false;
      player.cards = player.cards.filter((c) => c.id !== card.id);
      discardCard(lobby, card);
      setPlayerEffect(player, "second-chance");
      setLobbyEvent(
        lobby,
        "second_chance_used",
        `${player.name} nutzt Second Chance und rettet sich.`,
        player.id
      );
      return;
    }

    player.busted = true;
    setPlayerEffect(player, "bust");
    setLobbyEvent(lobby, "bust", `${player.name} ist bust!`, player.id);
    return;
  }

  maybeCompleteSevenCards(lobby, player);
}

function findSecondChanceRecipient(lobby, sourcePlayerId) {
  const sourceIndex = lobby.players.findIndex((p) => p.id === sourcePlayerId);
  if (sourceIndex === -1) return null;

  for (let step = 1; step < lobby.players.length; step++) {
    const idx = (sourceIndex + step) % lobby.players.length;
    const player = lobby.players[idx];

    if (!player) continue;
    if (player.id === sourcePlayerId) continue;
    if (player.busted) continue;
    if (player.hasSecondChance) continue;

    return player;
  }

  return null;
}

function resolveSecondChanceCard(lobby, player, card) {
  discardCard(lobby, card);

  if (!player.hasSecondChance) {
    player.hasSecondChance = true;
    setPlayerEffect(player, "second-chance");
    setLobbyEvent(
      lobby,
      "second_chance_gain",
      `${player.name} erhält eine Second Chance.`,
      player.id
    );
    return;
  }

  const recipient = findSecondChanceRecipient(lobby, player.id);

  if (recipient) {
    recipient.hasSecondChance = true;
    setPlayerEffect(recipient, "second-chance");
    setLobbyEvent(
      lobby,
      "second_chance_transfer",
      `${player.name} gibt die zusätzliche Second Chance an ${recipient.name} weiter.`,
      recipient.id
    );
    return;
  }

  setLobbyEvent(
    lobby,
    "second_chance_discard",
    `Die zusätzliche Second Chance von ${player.name} verfällt.`,
    player.id
  );
}

function resolveBonusCard(lobby, player, card) {
  player.bonusCards.push(card);
  setPlayerEffect(player, "bonus");
  setLobbyEvent(lobby, "bonus", `${player.name} zieht ${card.label}.`, player.id);
}

function startPendingFreeze(lobby, player, card) {
  discardCard(lobby, card);

  lobby.pendingAction = {
    type: "FREEZE",
    playerId: player.id,
    selections: [],
  };

  setPlayerEffect(player, "action");
  setLobbyEvent(
    lobby,
    "freeze_select",
    `${player.name} muss ein Freeze-Ziel auswählen.`,
    player.id
  );

  const validTargets = getValidFreezeTargets(lobby);
  if (validTargets.length === 1 && validTargets[0].id === player.id) {
    completeFreezeSelection(lobby, player.id);
  }
}

function startPendingDraw3(lobby, player, card) {
  discardCard(lobby, card);

  lobby.pendingAction = {
    type: "DRAW_3",
    playerId: player.id,
    remaining: 3,
    selections: [],
  };

  setPlayerEffect(player, "action");
  setLobbyEvent(
    lobby,
    "draw3_select",
    `${player.name} verteilt 3 Karten. Wähle Ziel 1, Ziel 2 und Ziel 3 nacheinander.`,
    player.id
  );
}

function resolveCardImmediate(lobby, player, card, options = {}) {
  if (lobby.phase !== "round") return;

  const { deferPlayableAction = false } = options;

  if (card.kind === "number") {
    resolveNumberCard(lobby, player, card);
    return;
  }

  if (card.kind === "bonus") {
    resolveBonusCard(lobby, player, card);
    return;
  }

  if (card.kind === "action") {
    if (card.action === "SECOND_CHANCE") {
      resolveSecondChanceCard(lobby, player, card);
      return;
    }

    if (card.action === "FREEZE") {
      if (deferPlayableAction) {
        discardCard(lobby, card);
        queueFollowUpAction(lobby, player.id, "FREEZE");
        setLobbyEvent(
          lobby,
          "freeze_queued",
          `${player.name} erhält Freeze. Es wird direkt nach der aktuellen Zieh-3-Kette ausgespielt.`,
          player.id
        );
      } else {
        startPendingFreeze(lobby, player, card);
      }
      return;
    }

    if (card.action === "DRAW_3") {
      if (deferPlayableAction) {
        discardCard(lobby, card);
        queueFollowUpAction(lobby, player.id, "DRAW_3");
        setLobbyEvent(
          lobby,
          "draw3_queued",
          `${player.name} erhält Zieh 3. Es wird direkt nach der aktuellen Zieh-3-Kette ausgespielt.`,
          player.id
        );
      } else {
        startPendingDraw3(lobby, player, card);
      }
    }
  }
}

function setAnimationState(lobby, animationState) {
  lobby.animationState = animationState;
  emitLobbyUpdate(lobby.code);
}

function clearAnimationState(lobby) {
  lobby.animationState = null;
  emitLobbyUpdate(lobby.code);
}

function animateRevealToPlayer(lobby, { sourcePlayerId = null, targetPlayerId, card, mode = "draw" }, onDone) {
  if (!lobbies[lobby.code]) return;

  setAnimationState(lobby, {
    id: nextEventId(),
    mode,
    sourcePlayerId,
    targetPlayerId,
    card,
  });

  setTimeout(() => {
    if (!lobbies[lobby.code]) return;
    clearAnimationState(lobby);

    setTimeout(() => {
      if (!lobbies[lobby.code]) return;
      onDone?.();
    }, 80);
  }, REVEAL_MS + FLY_MS);
}

function finishResolutionAndAdvanceTurnIfNeeded(lobby) {
  if (!lobbies[lobby.code]) return;

  if (lobby.phase !== "round") {
    emitLobbyUpdate(lobby.code);
    return;
  }

  if (lobby.pendingAction) {
    emitLobbyUpdate(lobby.code);
    return;
  }

  if (lobby.followUpActions.length > 0) {
    startNextFollowUpAction(lobby);
    emitLobbyUpdate(lobby.code);
    return;
  }

  if (lobby.turnShouldAdvanceAfterResolution) {
    lobby.turnShouldAdvanceAfterResolution = false;
    nextTurn(lobby);
  }

  emitLobbyUpdate(lobby.code);
}

function performAnimatedDrawForCurrentPlayer(lobby, player) {
  const card = drawFromDeck(lobby);
  if (!card) {
    endRound(lobby);
    return;
  }

  lobby.processing = true;

  setPlayerEffect(player, "draw");
  setLobbyEvent(lobby, "draw", `${player.name} zieht eine Karte.`, player.id);

  animateRevealToPlayer(
    lobby,
    {
      sourcePlayerId: null,
      targetPlayerId: player.id,
      card,
      mode: "draw",
    },
    () => {
      if (!lobbies[lobby.code]) return;

      resolveCardImmediate(lobby, player, card, { deferPlayableAction: false });
      lobby.processing = false;
      finishResolutionAndAdvanceTurnIfNeeded(lobby);
    }
  );
}

function processDraw3Distribution(lobby, actionPlayerId, selections, index = 0) {
  if (!lobbies[lobby.code]) return;

  if (lobby.phase !== "round") {
    emitLobbyUpdate(lobby.code);
    return;
  }

  if (index >= selections.length) {
    lobby.processing = false;
    finishResolutionAndAdvanceTurnIfNeeded(lobby);
    return;
  }

  const targetId = selections[index];
  const sourcePlayer = lobby.players.find((p) => p.id === actionPlayerId);
  const targetPlayer = lobby.players.find((p) => p.id === targetId);

  if (!sourcePlayer || !targetPlayer || targetPlayer.busted || targetPlayer.stopped) {
    processDraw3Distribution(lobby, actionPlayerId, selections, index + 1);
    return;
  }

  const card = drawFromDeck(lobby);
  if (!card) {
    endRound(lobby);
    return;
  }

  lobby.processing = true;
  setLobbyEvent(
    lobby,
    "draw3_resolve",
    `${sourcePlayer.name} verteilt Karte ${index + 1} an ${targetPlayer.name}.`,
    sourcePlayer.id,
    {
      sourcePlayerId: sourcePlayer.id,
      targetPlayerIds: [targetPlayer.id],
      step: index + 1,
    }
  );

  animateRevealToPlayer(
    lobby,
    {
      sourcePlayerId: sourcePlayer.id,
      targetPlayerId: targetPlayer.id,
      card,
      mode: "deal",
    },
    () => {
      if (!lobbies[lobby.code]) return;

      resolveCardImmediate(lobby, targetPlayer, card, { deferPlayableAction: true });

      setTimeout(() => {
        if (!lobbies[lobby.code]) return;
        processDraw3Distribution(lobby, actionPlayerId, selections, index + 1);
      }, BETWEEN_DEALS_MS);
    }
  );
}

function startNextFollowUpAction(lobby) {
  if (!lobby.followUpActions.length) return false;
  if (lobby.pendingAction) return false;

  const next = lobby.followUpActions.shift();
  const player = lobby.players.find((p) => p.id === next.playerId);

  if (!player || player.busted || player.stopped) {
    return startNextFollowUpAction(lobby);
  }

  if (next.actionType === "FREEZE") {
    lobby.pendingAction = {
      type: "FREEZE",
      playerId: player.id,
      selections: [],
    };

    setPlayerEffect(player, "action");
    setLobbyEvent(
      lobby,
      "freeze_select",
      `${player.name} spielt jetzt sein erhaltenes Freeze aus.`,
      player.id
    );

    const validTargets = getValidFreezeTargets(lobby);
    if (validTargets.length === 1 && validTargets[0].id === player.id) {
      completeFreezeSelection(lobby, player.id);
    }

    return true;
  }

  if (next.actionType === "DRAW_3") {
    lobby.pendingAction = {
      type: "DRAW_3",
      playerId: player.id,
      remaining: 3,
      selections: [],
    };

    setPlayerEffect(player, "action");
    setLobbyEvent(
      lobby,
      "draw3_select",
      `${player.name} spielt jetzt sein erhaltenes Zieh 3 aus.`,
      player.id
    );

    return true;
  }

  return false;
}

function completeFreezeSelection(lobby, targetPlayerId) {
  const action = lobby.pendingAction;
  if (!action || action.type !== "FREEZE") return false;

  const sourcePlayer = lobby.players.find((p) => p.id === action.playerId);
  const target = lobby.players.find((p) => p.id === targetPlayerId);

  if (!sourcePlayer || !target) return false;

  eliminateByFreeze(lobby, target, sourcePlayer.name, sourcePlayer.id);
  lobby.pendingAction = null;
  finishResolutionAndAdvanceTurnIfNeeded(lobby);
  return true;
}

function completeDraw3SelectionAndStart(lobby) {
  const action = lobby.pendingAction;
  if (!action || action.type !== "DRAW_3") return false;

  const sourcePlayer = lobby.players.find((p) => p.id === action.playerId);
  if (!sourcePlayer) return false;

  const selections = [...action.selections];

  // WICHTIGER FIX:
  // Das Auswahlmenü wird sofort geschlossen, bevor die Verteilung startet.
  lobby.pendingAction = null;
  lobby.processing = true;

  setLobbyEvent(
    lobby,
    "draw3_resolve",
    `${sourcePlayer.name} beginnt jetzt die Verteilung der 3 Karten.`,
    sourcePlayer.id,
    {
      sourcePlayerId: sourcePlayer.id,
      targetPlayerIds: selections,
      step: 0,
    }
  );

  emitLobbyUpdate(lobby.code);

  setTimeout(() => {
    if (!lobbies[lobby.code]) return;
    processDraw3Distribution(lobby, sourcePlayer.id, selections, 0);
  }, 150);

  return true;
}

io.on("connection", (socket) => {
  socket.on("create_lobby", ({ playerName }) => {
    try {
      const cleanName = String(playerName || "").trim().slice(0, 20);

      if (!cleanName) {
        socket.emit("error_message", "Bitte gib einen Namen ein.");
        return;
      }

      let code;
      do {
        code = generateLobbyCode();
      } while (lobbies[code]);

      lobbies[code] = {
        code,
        phase: "lobby",
        hostId: socket.id,
        roundNumber: 0,
        currentPlayerIndex: 0,
        nextStarterIndex: 0,
        deck: [],
        discard: [],
        players: [makePlayer({ id: socket.id, name: cleanName, isHost: true })],
        lastEvent: null,
        winnerId: null,
        winnerName: null,
        pendingAction: null,
        followUpActions: [],
        animationState: null,
        processing: false,
        turnShouldAdvanceAfterResolution: false,
      };

      socket.join(code);
      socket.data.lobbyCode = code;
      emitLobbyUpdate(code);
    } catch (error) {
      console.error("Fehler bei create_lobby:", error);
      socket.emit("error_message", "Lobby konnte nicht erstellt werden.");
    }
  });

  socket.on("join_lobby", ({ playerName, code }) => {
    try {
      const cleanName = String(playerName || "").trim().slice(0, 20);
      const cleanCode = String(code || "").trim().toUpperCase();

      if (!cleanName) {
        socket.emit("error_message", "Bitte gib einen Namen ein.");
        return;
      }

      if (!cleanCode || !lobbies[cleanCode]) {
        socket.emit("error_message", "Lobby nicht gefunden.");
        return;
      }

      const lobby = lobbies[cleanCode];

      if (lobby.phase !== "lobby") {
        socket.emit("error_message", "Das Spiel wurde bereits gestartet.");
        return;
      }

      if (lobby.players.length >= MAX_PLAYERS) {
        socket.emit("error_message", "Die Lobby ist voll.");
        return;
      }

      lobby.players.push(makePlayer({ id: socket.id, name: cleanName }));
      socket.join(cleanCode);
      socket.data.lobbyCode = cleanCode;

      emitLobbyUpdate(cleanCode);
    } catch (error) {
      console.error("Fehler bei join_lobby:", error);
      socket.emit("error_message", "Beitritt zur Lobby fehlgeschlagen.");
    }
  });

  socket.on("start_game", ({ code }) => {
    try {
      const cleanCode = String(code || "").trim().toUpperCase();
      const lobby = lobbies[cleanCode];

      if (!lobby) {
        socket.emit("error_message", "Lobby nicht gefunden.");
        return;
      }

      if (lobby.hostId !== socket.id) {
        socket.emit("error_message", "Nur der Host darf starten.");
        return;
      }

      if (lobby.players.length < 2) {
        socket.emit("error_message", "Mindestens 2 Spieler werden benötigt.");
        return;
      }

      initializeRound(lobby);
      emitLobbyUpdate(cleanCode);
    } catch (error) {
      console.error("Fehler bei start_game:", error);
      socket.emit("error_message", "Spiel konnte nicht gestartet werden.");
    }
  });

  socket.on("draw_card", () => {
    try {
      const code = socket.data.lobbyCode;
      const lobby = lobbies[code];

      if (!lobby) {
        socket.emit("error_message", "Lobby nicht gefunden.");
        return;
      }

      if (lobby.phase !== "round") {
        socket.emit("error_message", "Gerade kann keine Karte gezogen werden.");
        return;
      }

      if (lobby.pendingAction || lobby.processing || lobby.animationState) {
        socket.emit("error_message", "Warte, bis die aktuelle Aktion abgeschlossen ist.");
        return;
      }

      const currentPlayer = getCurrentPlayer(lobby);

      if (!currentPlayer) {
        socket.emit("error_message", "Kein aktiver Spieler gefunden.");
        return;
      }

      if (currentPlayer.id !== socket.id) {
        socket.emit("error_message", "Du bist gerade nicht am Zug.");
        return;
      }

      lobby.turnShouldAdvanceAfterResolution = true;
      performAnimatedDrawForCurrentPlayer(lobby, currentPlayer);
      emitLobbyUpdate(code);
    } catch (error) {
      console.error("Fehler bei draw_card:", error);
      socket.emit("error_message", "Karte konnte nicht gezogen werden.");
    }
  });

  socket.on("stop_turn", () => {
    try {
      const code = socket.data.lobbyCode;
      const lobby = lobbies[code];

      if (!lobby) {
        socket.emit("error_message", "Lobby nicht gefunden.");
        return;
      }

      if (lobby.phase !== "round") {
        socket.emit("error_message", "Gerade kannst du nicht stoppen.");
        return;
      }

      if (lobby.pendingAction || lobby.processing || lobby.animationState) {
        socket.emit("error_message", "Warte, bis die aktuelle Aktion abgeschlossen ist.");
        return;
      }

      const currentPlayer = getCurrentPlayer(lobby);

      if (!currentPlayer) {
        socket.emit("error_message", "Kein aktiver Spieler gefunden.");
        return;
      }

      if (currentPlayer.id !== socket.id) {
        socket.emit("error_message", "Du bist gerade nicht am Zug.");
        return;
      }

      currentPlayer.stopped = true;
      currentPlayer.stoppedByChoice = true;
      setPlayerEffect(currentPlayer, "stop");
      setLobbyEvent(lobby, "stop", `${currentPlayer.name} stoppt.`, currentPlayer.id);

      nextTurn(lobby);
      emitLobbyUpdate(code);
    } catch (error) {
      console.error("Fehler bei stop_turn:", error);
      socket.emit("error_message", "Stop konnte nicht verarbeitet werden.");
    }
  });

  socket.on("select_freeze_target", ({ targetPlayerId }) => {
    try {
      const code = socket.data.lobbyCode;
      const lobby = lobbies[code];
      if (!lobby || lobby.phase !== "round") return;

      const action = lobby.pendingAction;
      if (!action || action.type !== "FREEZE") {
        socket.emit("error_message", "Aktuell ist kein Freeze offen.");
        return;
      }

      if (action.playerId !== socket.id) {
        socket.emit("error_message", "Nur der betreffende Spieler darf das Ziel wählen.");
        return;
      }

      const target = lobby.players.find((p) => p.id === targetPlayerId);
      if (!target) {
        socket.emit("error_message", "Ungültiges Ziel.");
        return;
      }

      if (target.busted || target.stopped) {
        socket.emit("error_message", "Du kannst keinen gebusteten oder gestoppten Spieler freezen.");
        return;
      }

      completeFreezeSelection(lobby, targetPlayerId);
      emitLobbyUpdate(code);
    } catch (error) {
      console.error("Fehler bei select_freeze_target:", error);
      socket.emit("error_message", "Freeze-Ziel konnte nicht gesetzt werden.");
    }
  });

  socket.on("add_draw3_target", ({ targetPlayerId }) => {
    try {
      const code = socket.data.lobbyCode;
      const lobby = lobbies[code];
      if (!lobby || lobby.phase !== "round") return;

      const action = lobby.pendingAction;
      if (!action || action.type !== "DRAW_3") {
        socket.emit("error_message", "Aktuell ist kein Zieh-3 offen.");
        return;
      }

      if (action.playerId !== socket.id) {
        socket.emit("error_message", "Nur der betreffende Spieler darf verteilen.");
        return;
      }

      const target = lobby.players.find((p) => p.id === targetPlayerId);
      if (!target) {
        socket.emit("error_message", "Ungültiges Ziel.");
        return;
      }

      if (target.busted || target.stopped) {
        socket.emit("error_message", "Du kannst keine Karten an gebustete oder gestoppte Spieler verteilen.");
        return;
      }

      action.selections.push(targetPlayerId);
      action.remaining = Math.max(0, 3 - action.selections.length);

      if (action.remaining <= 0) {
        completeDraw3SelectionAndStart(lobby);
      } else {
        setLobbyEvent(
          lobby,
          "draw3_select",
          `${lobby.players.find((p) => p.id === action.playerId)?.name || "Spieler"} wählt Ziel ${action.selections.length + 1} von 3.`,
          action.playerId
        );
      }

      emitLobbyUpdate(code);
    } catch (error) {
      console.error("Fehler bei add_draw3_target:", error);
      socket.emit("error_message", "Ziel konnte nicht gesetzt werden.");
    }
  });

  socket.on("restart_game", () => {
    try {
      const code = socket.data.lobbyCode;
      const lobby = lobbies[code];
      if (!lobby) return;

      if (lobby.hostId !== socket.id) {
        socket.emit("error_message", "Nur der Host darf neu starten.");
        return;
      }

      lobby.players.forEach((player) => {
        player.totalScore = 0;
      });

      lobby.nextStarterIndex = 0;
      initializeRound(lobby);
      emitLobbyUpdate(code);
    } catch (error) {
      console.error("Fehler bei restart_game:", error);
      socket.emit("error_message", "Neustart fehlgeschlagen.");
    }
  });

  socket.on("disconnect", () => {
    try {
      const code = socket.data.lobbyCode;
      if (!code || !lobbies[code]) return;

      const lobby = lobbies[code];
      const leavingIndex = lobby.players.findIndex((p) => p.id === socket.id);
      if (leavingIndex === -1) return;

      lobby.players.splice(leavingIndex, 1);

      if (!lobby.players.length) {
        delete lobbies[code];
        return;
      }

      if (lobby.hostId === socket.id) {
        lobby.hostId = lobby.players[0].id;
        lobby.players.forEach((player, index) => {
          player.isHost = index === 0;
        });
      }

      if (leavingIndex < lobby.currentPlayerIndex) {
        lobby.currentPlayerIndex -= 1;
      } else if (leavingIndex === lobby.currentPlayerIndex) {
        if (lobby.currentPlayerIndex >= lobby.players.length) {
          lobby.currentPlayerIndex = 0;
        }
      }

      if (lobby.currentPlayerIndex < 0 || lobby.currentPlayerIndex >= lobby.players.length) {
        lobby.currentPlayerIndex = 0;
      }

      if (typeof lobby.nextStarterIndex !== "number" || lobby.nextStarterIndex >= lobby.players.length) {
        lobby.nextStarterIndex = 0;
      }

      if (lobby.pendingAction && lobby.pendingAction.playerId === socket.id) {
        lobby.pendingAction = null;
      }

      lobby.followUpActions = lobby.followUpActions.filter((a) => a.playerId !== socket.id);

      if (lobby.phase === "round") {
        const activePlayers = getActivePlayers(lobby);
        if (!activePlayers.length) {
          endRound(lobby);
          return;
        }
      }

      emitLobbyUpdate(code);
    } catch (error) {
      console.error("Fehler bei disconnect:", error);
    }
  });
});

const clientDistPath = path.join(__dirname, "../client/dist");
app.use(express.static(clientDistPath));

app.use((req, res) => {
  res.sendFile(path.join(clientDistPath, "index.html"));
});

server.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
