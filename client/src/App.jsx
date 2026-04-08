import { useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";
import {
  formatBadges,
  getCardClass,
  getPlayerEffectClass,
  getSeatPosition,
} from "./gameHelpers";
import "./styles.css";

const socket = io();

function Card({ card }) {
  return (
    <div className={getCardClass(card)}>
      <div className="cardLabel">{card.label}</div>

      {card.kind === "action" && card.action === "FREEZE" && (
        <div className="cardIcon">❄</div>
      )}

      {card.kind === "action" && card.action === "DRAW_3" && (
        <div className="cardIcon">➜➜➜</div>
      )}

      {card.kind === "action" && card.action === "SECOND_CHANCE" && (
        <div className="cardIcon">❤</div>
      )}

      {card.kind === "bonus" && card.bonus === "MULTIPLY_2" && (
        <div className="cardIcon">✦</div>
      )}
    </div>
  );
}

function PlayerSeat({ player, index, total, isCurrentPlayer }) {
  const seatStyle = getSeatPosition(index, total);
  const badges = formatBadges(player);

  return (
    <div
      className={[
        "playerSeat",
        isCurrentPlayer ? "activeSeat" : "",
        player.busted ? "isBusted" : "",
        player.stopped ? "isStopped" : "",
        player.frozen ? "isFrozen" : "",
        getPlayerEffectClass(player),
      ].join(" ")}
      style={seatStyle}
      data-player-id={player.id}
    >
      <div className="seatInner">
        <div className="seatHeader">
          <div className="seatName">
            {player.name} {player.isHost ? "👑" : ""}
          </div>
          <div className="seatScore">{player.totalScore} P</div>
        </div>

        <div className="seatSubline">
          Runde: {player.roundScorePreview || 0} · Zahlen: {player.numberCardCount}/7
        </div>

        {badges.length > 0 && (
          <div className="badgeRow">
            {badges.map((badge) => (
              <span className="badge" key={badge}>
                {badge}
              </span>
            ))}
          </div>
        )}

        {player.hasSecondChance && (
          <div className="heartToken" title="Second Chance">
            ❤
          </div>
        )}

        {player.stopped && (
          <div className="lockToken" title="Gestoppt">
            🔒
          </div>
        )}

        {player.busted && <div className="bustX">✕</div>}

        <div className="tableCards">
          {player.cards.length === 0 && player.bonusCards.length === 0 && (
            <div className="emptyCards">Keine Karten</div>
          )}

          {player.cards.map((card) => (
            <Card key={card.id} card={card} />
          ))}

          {player.bonusCards.map((card) => (
            <Card key={card.id} card={card} />
          ))}
        </div>
      </div>
    </div>
  );
}

function PendingOverlay({ lobby, isMyTurn }) {
  if (!lobby?.pendingAction || !isMyTurn) return null;

  const action = lobby.pendingAction;

  if (action.type === "FREEZE") {
    return (
      <div className="overlayPanel">
        <h3>Freeze wählen</h3>
        <p>Wähle einen aktiven Spieler.</p>
        <div className="targetGrid">
          {lobby.players
            .filter((player) => !player.busted && !player.stopped)
            .map((player) => (
              <button
                key={player.id}
                className="targetBtn freezeTargetBtn"
                onClick={() =>
                  socket.emit("select_freeze_target", {
                    targetPlayerId: player.id,
                  })
                }
              >
                ❄ {player.name}
              </button>
            ))}
        </div>
      </div>
    );
  }

  if (action.type === "DRAW_3") {
    return (
      <div className="overlayPanel">
        <h3>Zieh 3 verteilen</h3>
        <p>Noch zu verteilen: {action.remaining}</p>
        <p className="overlaySmall">
          Frei verteilbar an dich oder andere aktive Spieler.
        </p>

        <div className="selectedTargets">
          {action.selections.map((id, index) => {
            const player = lobby.players.find((p) => p.id === id);
            return (
              <span className="targetChip" key={`${id}-${index}`}>
                {player ? player.name : "?"}
              </span>
            );
          })}
        </div>

        <div className="targetGrid">
          {lobby.players
            .filter((player) => !player.busted && !player.stopped)
            .map((player) => (
              <button
                key={player.id}
                className="targetBtn draw3TargetBtn"
                onClick={() =>
                  socket.emit("add_draw3_target", {
                    targetPlayerId: player.id,
                  })
                }
              >
                🃏 {player.name}
              </button>
            ))}
        </div>
      </div>
    );
  }

  return null;
}

function Draw3FlightLayer({ lobby }) {
  const event = lobby?.lastEvent;
  if (!event || event.type !== "draw3_resolve" || !event.meta?.targetPlayerIds?.length) {
    return null;
  }

  return (
    <div className="flightLayer">
      {event.meta.targetPlayerIds.map((targetId, index) => (
        <div
          key={`${event.id}-${targetId}-${index}`}
          className="flyingCard"
          style={{ animationDelay: `${index * 0.35}s` }}
        />
      ))}
    </div>
  );
}

export default function App() {
  const [playerName, setPlayerName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [lobby, setLobby] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    function onLobbyUpdated(data) {
      setLobby(data);
      setError("");
    }

    function onErrorMessage(message) {
      setError(message);
    }

    socket.on("lobby_updated", onLobbyUpdated);
    socket.on("error_message", onErrorMessage);

    return () => {
      socket.off("lobby_updated", onLobbyUpdated);
      socket.off("error_message", onErrorMessage);
    };
  }, []);

  function createLobby() {
    const cleanName = playerName.trim();
    if (!cleanName) {
      setError("Bitte gib einen Namen ein.");
      return;
    }
    socket.emit("create_lobby", { playerName: cleanName });
  }

  function joinLobby() {
    const cleanName = playerName.trim();
    const cleanCode = joinCode.trim().toUpperCase();

    if (!cleanName) {
      setError("Bitte gib einen Namen ein.");
      return;
    }

    if (!cleanCode) {
      setError("Bitte gib einen Lobby-Code ein.");
      return;
    }

    socket.emit("join_lobby", {
      playerName: cleanName,
      code: cleanCode,
    });
  }

  function startGame() {
    if (!lobby) return;
    socket.emit("start_game", { code: lobby.code });
  }

  function drawCard() {
    socket.emit("draw_card");
  }

  function stopTurn() {
    socket.emit("stop_turn");
  }

  function restartGame() {
    socket.emit("restart_game");
  }

  const isHost = useMemo(() => {
    if (!lobby) return false;
    return lobby.hostId === socket.id;
  }, [lobby]);

  const currentPlayer = useMemo(() => {
    if (!lobby || !Array.isArray(lobby.players)) return null;
    return lobby.players.find((player) => player.id === lobby.currentPlayerId) || null;
  }, [lobby]);

  const isMyTurn = currentPlayer?.id === socket.id;

  const inGame = useMemo(() => {
    if (!lobby) return false;
    return (
      lobby.phase === "round" ||
      lobby.phase === "round_end" ||
      lobby.phase === "game_over"
    );
  }, [lobby]);

  const hasPendingActionForMe =
    !!lobby?.pendingAction && lobby.pendingAction.playerId === socket.id;

  return (
    <div className="page">
      {!lobby && (
        <div className="startWrap">
          <div className="startCard">
            <h1>Flip 7 Online</h1>
            <p className="subline">Multiplayer Tisch-Version</p>

            <input
              type="text"
              placeholder="Dein Name"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              maxLength={20}
            />

            <div className="buttonRow">
              <button className="primaryBtn" onClick={createLobby}>
                Lobby erstellen
              </button>
            </div>

            <div className="joinSection">
              <input
                type="text"
                placeholder="Lobby-Code"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                maxLength={5}
              />
              <button className="secondaryBtn" onClick={joinLobby}>
                Beitreten
              </button>
            </div>

            {error && <p className="errorText">{error}</p>}
          </div>
        </div>
      )}

      {lobby && !inGame && (
        <div className="startWrap">
          <div className="startCard">
            <h1>Lobby: {lobby.code}</h1>
            <p className="subline">Spieler: {lobby.players.length} / 8</p>

            <div className="lobbyPlayerList">
              {lobby.players.map((player) => (
                <div className="lobbyPlayer" key={player.id}>
                  {player.name} {player.isHost ? "👑" : ""}
                </div>
              ))}
            </div>

            {isHost && (
              <button className="primaryBtn" onClick={startGame}>
                Spiel starten
              </button>
            )}

            {!isHost && <p className="waitingText">Warte auf den Host ...</p>}

            {error && <p className="errorText">{error}</p>}
          </div>
        </div>
      )}

      {lobby && inGame && (
        <div className="gamePage">
          <div className="topBar">
            <div className="topInfo">
              <div>
                Lobby: <strong>{lobby.code}</strong>
              </div>
              <div>
                Runde: <strong>{lobby.roundNumber}</strong>
              </div>
              <div>
                Ziel: <strong>{lobby.targetScore}</strong>
              </div>
            </div>

            {lobby.lastEvent && (
              <div className={`eventToast event-${lobby.lastEvent.type}`}>
                {lobby.lastEvent.text}
              </div>
            )}
          </div>

          <div className="tableWrap">
            <div className="roundTable">
              {lobby.players.map((player, index) => (
                <PlayerSeat
                  key={`${player.id}-${player.effectTick}-${player.cards.length}-${player.bonusCards.length}-${player.totalScore}`}
                  player={player}
                  index={index}
                  total={lobby.players.length}
                  isCurrentPlayer={player.id === lobby.currentPlayerId}
                />
              ))}

              <div className="tableCenter">
                <div className="activePlayerTitle">Aktiver Spieler</div>
                <div className="activePlayerName">
                  {currentPlayer ? currentPlayer.name : "-"}
                </div>

                <button
                  className={[
                    "deckButton",
                    isMyTurn && lobby.phase === "round" && !hasPendingActionForMe
                      ? "deckClickable"
                      : "",
                  ].join(" ")}
                  onClick={drawCard}
                  disabled={!isMyTurn || lobby.phase !== "round" || hasPendingActionForMe}
                  title={
                    isMyTurn && lobby.phase === "round"
                      ? "Karte ziehen"
                      : "Nicht dein Zug"
                  }
                >
                  <div className="deckBack">
                    <span>FLIP 7</span>
                  </div>
                  <div className="deckCount">{lobby.deckCount}</div>
                </button>

                {lobby.phase === "round" && !hasPendingActionForMe && !isMyTurn && currentPlayer && (
                  <div className="waitLabel">Warte auf {currentPlayer.name}</div>
                )}

                {lobby.phase === "round_end" && (
                  <div className="waitLabel">Neue Runde startet gleich ...</div>
                )}

                {lobby.phase === "game_over" && (
                  <div className="winnerPanel">
                    <div className="winnerTitle">Gewinner</div>
                    <div className="winnerName">{lobby.winnerName}</div>

                    {isHost && (
                      <button className="primaryBtn" onClick={restartGame}>
                        Neues Spiel
                      </button>
                    )}
                  </div>
                )}
              </div>

              <PendingOverlay lobby={lobby} isMyTurn={isMyTurn} />
              <Draw3FlightLayer lobby={lobby} />
            </div>
          </div>

          {lobby.phase === "round" && (
            <div className="bottomControls">
              <button
                className="stopBtn"
                onClick={stopTurn}
                disabled={!isMyTurn || hasPendingActionForMe}
              >
                STOP
              </button>
            </div>
          )}

          {error && <p className="errorText gameError">{error}</p>}
        </div>
      )}
    </div>
  );
}