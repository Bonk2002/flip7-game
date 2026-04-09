export function getSeatPosition(index, total) {
  const angle = (-90 + (360 / total) * index) * (Math.PI / 180);

  const radiusByCount = {
    1: 0,
    2: 39,
    3: 40,
    4: 40,
    5: 41,
    6: 42,
    7: 42,
    8: 43,
  };

  const radius = radiusByCount[total] ?? 41;

  const x = 50 + Math.cos(angle) * radius;
  const y = 50 + Math.sin(angle) * radius;

  return {
    left: `${x}%`,
    top: `${y}%`,
  };
}

export function getNumberCardClass(value) {
  const map = {
    1: "num1",
    2: "num2",
    3: "num3",
    4: "num4",
    5: "num5",
    6: "num6",
    7: "num7",
    8: "num8",
    9: "num9",
    10: "num10",
    11: "num11",
    12: "num12",
  };

  return map[value] || "numDefault";
}

export function getCardClass(card) {
  if (!card) return "cardFace";

  if (card.kind === "number") {
    return `cardFace numberCard ${getNumberCardClass(card.value)}`;
  }

  if (card.kind === "action") {
    if (card.action === "FREEZE") {
      return "cardFace actionCard freezeCard";
    }

    if (card.action === "DRAW_3") {
      return "cardFace actionCard draw3Card";
    }

    if (card.action === "SECOND_CHANCE") {
      return "cardFace actionCard secondChanceCard";
    }
  }

  if (card.kind === "bonus") {
    if (card.bonus === "MULTIPLY_2") {
      return "cardFace bonusCard mult2Card";
    }

    return "cardFace bonusCard plusCard";
  }

  return "cardFace";
}

export function getPlayerEffectClass(player) {
  if (!player) return "";

  switch (player.lastEffect) {
    case "draw":
      return "seatDraw";
    case "freeze":
      return "seatFreeze";
    case "bust":
      return "seatBust";
    case "winner":
      return "seatWinner";
    case "bonus":
      return "seatBonus";
    case "second-chance":
      return "seatSecondChance";
    case "stop":
      return "seatStop";
    case "action":
      return "seatAction";
    default:
      return "";
  }
}

export function formatBadges(player) {
  const badges = [];

  if (player.isHost) badges.push("Host");
  if (player.frozen) badges.push("Frozen");
  if (player.completedSevenCards) badges.push("+15");
  if (player.busted) badges.push("Bust");

  return badges;
}
