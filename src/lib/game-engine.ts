import { getRedis } from "./redis";
import { publishEvent, getGamePlayers, type GamePlayer } from "./game-state";
import { db } from "../db/client";
import { blackCards, whiteCards, gameSessions, gameRounds } from "../db/schema";
import { inArray, eq } from "drizzle-orm";

const TTL = 86400;

export interface GameConfig {
  totalRounds: number;
  maxPlayers: number;
  packIds: number[];
  houseRules: {
    randoCardrissian: boolean;
    happyEnding: boolean;
    packingHeat: boolean;
  };
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export async function loadDecksIntoRedis(
  roomCode: string,
  config: GameConfig
): Promise<void> {
  const redis = getRedis();

  const [blacks, whites] = await Promise.all([
    db
      .select({ id: blackCards.id })
      .from(blackCards)
      .where(inArray(blackCards.packId, config.packIds)),
    db
      .select({ id: whiteCards.id })
      .from(whiteCards)
      .where(inArray(whiteCards.packId, config.packIds)),
  ]);

  const shuffledBlacks = shuffle(blacks.map((c) => String(c.id)));
  const shuffledWhites = shuffle(whites.map((c) => String(c.id)));

  const blackKey = `game:${roomCode}:deck:black`;
  const whiteKey = `game:${roomCode}:deck:white`;

  await redis
    .multi()
    .del(blackKey)
    .del(whiteKey)
    .rpush(blackKey, ...shuffledBlacks)
    .rpush(whiteKey, ...shuffledWhites)
    .expire(blackKey, TTL)
    .expire(whiteKey, TTL)
    .exec();
}

export async function dealHands(roomCode: string): Promise<void> {
  const redis = getRedis();
  const players = await getGamePlayers(roomCode);

  for (const [playerId, player] of Object.entries(players)) {
    if (player.isSpectator) continue;
    const handKey = `game:${roomCode}:hand:${playerId}`;
    const existing = await redis.scard(handKey);
    const needed = 7 - existing;
    if (needed <= 0) continue;

    const cards = await redis.lrange(`game:${roomCode}:deck:white`, 0, needed - 1);
    await redis.ltrim(`game:${roomCode}:deck:white`, needed, -1);
    if (cards.length > 0) {
      await redis
        .multi()
        .sadd(handKey, ...cards)
        .expire(handKey, TTL)
        .exec();
    }
  }
}

async function dealPendingPlayers(roomCode: string): Promise<void> {
  const redis = getRedis();
  const players = await getGamePlayers(roomCode);

  for (const [playerId, player] of Object.entries(players)) {
    if (!player.isPending || player.isSpectator) continue;

    const cards = await redis.lrange(`game:${roomCode}:deck:white`, 0, 6);
    await redis.ltrim(`game:${roomCode}:deck:white`, 7, -1);
    const handKey = `game:${roomCode}:hand:${playerId}`;
    if (cards.length > 0) {
      await redis
        .multi()
        .sadd(handKey, ...cards)
        .expire(handKey, TTL)
        .exec();
    }

    player.isPending = false;
    await redis.hset(
      `game:${roomCode}:players`,
      playerId,
      JSON.stringify(player)
    );
  }
}

export async function startRound(roomCode: string): Promise<void> {
  const redis = getRedis();

  await dealPendingPlayers(roomCode);
  await dealHands(roomCode);

  const metaRaw = await redis.hgetall(`game:${roomCode}`);
  const currentRound = Number(metaRaw.currentRound ?? 0);
  const nextRound = currentRound + 1;
  const config: GameConfig = JSON.parse(metaRaw.config ?? "{}");
  const totalRounds = Number(metaRaw.totalRounds ?? 8);

  const players = await getGamePlayers(roomCode);
  const activePlayers = Object.entries(players).filter(([, p]) => !p.isSpectator);
  const czarIdx = Number(metaRaw.czarIndex ?? 0) % activePlayers.length;
  const nextCzarIdx = (czarIdx + 1) % activePlayers.length;
  const [czarId] = activePlayers[czarIdx];

  let blackCardId: string;
  if (config.houseRules?.happyEnding && nextRound === totalRounds) {
    blackCardId = await getHaikuCardId();
  } else {
    const drawn = await redis.lpop(`game:${roomCode}:deck:black`);
    if (!drawn) throw new Error("No black cards remaining");
    blackCardId = drawn;
  }

  const [card] = await db
    .select({ text: blackCards.text, pick: blackCards.pick })
    .from(blackCards)
    .where(inArray(blackCards.id, [Number(blackCardId)]));

  if (config.houseRules?.packingHeat && card.pick > 1) {
    for (const [playerId] of activePlayers) {
      if (playerId === czarId) continue;
      const extra = await redis.lpop(`game:${roomCode}:deck:white`);
      if (extra) {
        await redis.sadd(`game:${roomCode}:hand:${playerId}`, extra);
      }
    }
  }

  await redis
    .multi()
    .hset(`game:${roomCode}`, {
      currentRound: String(nextRound),
      czarIndex: String(nextCzarIdx),
      status: "active",
    })
    .del(`game:${roomCode}:round`)
    .hset(`game:${roomCode}:round`, {
      blackCardId,
      czarId,
      winnerId: "",
    })
    .expire(`game:${roomCode}:round`, TTL)
    .exec();

  await publishEvent(roomCode, "round:started", {
    roundNum: nextRound,
    blackCard: { id: Number(blackCardId), text: card.text, pick: card.pick },
    czarId,
  });

  if (config.houseRules?.randoCardrissian) {
    const { playRandoCard } = await import("./rando");
    await playRandoCard(roomCode, card.pick);
  }
}

async function getHaikuCardId(): Promise<string> {
  const { like } = await import("drizzle-orm");
  const [haiku] = await db
    .select({ id: blackCards.id })
    .from(blackCards)
    .where(like(blackCards.text, "%Haiku%"))
    .limit(1);

  if (haiku) return String(haiku.id);

  const [injected] = await db
    .insert(blackCards)
    .values({ packId: 1, text: "Make a haiku.", pick: 3 })
    .onConflictDoNothing()
    .returning();
  return String(injected.id);
}

function getSubmissionsFromHash(hash: Record<string, string>): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(hash)) {
    if (key.startsWith("sub:")) {
      result[key.slice(4)] = JSON.parse(value);
    }
  }
  return result;
}

export async function submitCards(
  roomCode: string,
  playerId: string,
  cardIds: string[]
): Promise<{ allPlayed: boolean }> {
  const redis = getRedis();

  const handKey = `game:${roomCode}:hand:${playerId}`;
  for (const cardId of cardIds) {
    const inHand = await redis.sismember(handKey, cardId);
    if (!inHand) throw new Error(`Card ${cardId} not in hand`);
  }

  // Use individual hash fields (sub:{playerId}) to avoid concurrent-write race conditions.
  const subField = `sub:${playerId}`;
  const existing = await redis.hget(`game:${roomCode}:round`, subField);
  if (existing) throw new Error("Already submitted this round");

  await redis.srem(handKey, ...cardIds);
  await redis.hset(`game:${roomCode}:round`, subField, JSON.stringify(cardIds));

  await publishEvent(roomCode, "card:played", { playerId });

  const [players, czarId, roundHash] = await Promise.all([
    getGamePlayers(roomCode),
    redis.hget(`game:${roomCode}:round`, "czarId"),
    redis.hgetall(`game:${roomCode}:round`),
  ]);
  const submissions = getSubmissionsFromHash(roundHash);
  const nonCzarPlayers = Object.entries(players).filter(
    ([id, p]) => !p.isSpectator && !p.isPending && id !== czarId
  );
  const allPlayed = nonCzarPlayers.length > 0 && nonCzarPlayers.every(([id]) => submissions[id]);

  if (allPlayed) {
    // Atomic guard: only the first caller publishes all:played
    const claimed = await redis.hsetnx(`game:${roomCode}:round`, "allPlayedFired", "1");
    if (claimed) {
      const allCardIds = Object.values(submissions).flat().map(Number);
      const cardRows = await db
        .select({ id: whiteCards.id, text: whiteCards.text })
        .from(whiteCards)
        .where(inArray(whiteCards.id, allCardIds));
      const textMap = Object.fromEntries(cardRows.map((c) => [c.id, c.text]));

      const anonymized = Object.entries(submissions).map(([, cards], idx) => ({
        submissionId: `sub_${idx}`,
        cards: cards.map((id) => ({ id: Number(id), text: textMap[Number(id)] ?? "" })),
      }));
      await publishEvent(roomCode, "all:played", { submissions: anonymized });
    }
  }

  return { allPlayed };
}

export async function pickWinner(
  roomCode: string,
  _czarPlayerId: string,
  winningSubmissionId: string
): Promise<void> {
  const redis = getRedis();
  const metaRaw = await redis.hgetall(`game:${roomCode}`);
  const currentRound = Number(metaRaw.currentRound ?? 1);
  const totalRounds = Number(metaRaw.totalRounds ?? 8);

  const roundHash = await redis.hgetall(`game:${roomCode}:round`);
  const submissions = getSubmissionsFromHash(roundHash);
  const submissionEntries = Object.entries(submissions);
  const submissionIdx = parseInt(winningSubmissionId.replace("sub_", ""), 10);
  const [winnerId, winningCards] = submissionEntries[submissionIdx];

  const players = await getGamePlayers(roomCode);
  const winner = players[winnerId];
  if (!winner) throw new Error("Winner not found");

  winner.score += 1;
  await redis.hset(`game:${roomCode}:players`, winnerId, JSON.stringify(winner));

  await publishEvent(roomCode, "czar:picked", {
    winnerId,
    winnerName: winner.name,
    submissionId: winningSubmissionId,
    winningCards: winningCards.map(Number),
  });

  const freshPlayers = await getGamePlayers(roomCode);
  const scores = Object.fromEntries(
    Object.entries(freshPlayers).map(([id, p]) => [id, p.score])
  );

  await publishEvent(roomCode, "round:ended", { scores });

  // Persist round to PostgreSQL
  const [session] = await db
    .select({ id: gameSessions.id })
    .from(gameSessions)
    .where(eq(gameSessions.roomCode, roomCode))
    .limit(1);

  const blackCardId = await redis.hget(`game:${roomCode}:round`, "blackCardId");

  // winnerId is the DB game_players.id (for human players) or "rando_cardrissian"
  const winnerDbId = /^\d+$/.test(winnerId) ? Number(winnerId) : null;

  await db.insert(gameRounds).values({
    sessionId: session.id,
    roundNum: currentRound,
    blackCardId: Number(blackCardId),
    winnerPlayerId: winnerDbId ?? undefined,
    completedAt: new Date(),
  });

  if (currentRound >= totalRounds) {
    await endGame(roomCode, session.id, freshPlayers);
  } else {
    const delay = Number(process.env.ROUND_DELAY_MS ?? 10_000);
    setTimeout(() => startRound(roomCode).catch(console.error), delay);
  }
}

async function endGame(
  roomCode: string,
  sessionId: number,
  players: Record<string, GamePlayer>
): Promise<void> {
  const redis = getRedis();

  await redis.hset(`game:${roomCode}`, "status", "ended");
  await db
    .update(gameSessions)
    .set({ status: "ended", endedAt: new Date() })
    .where(eq(gameSessions.id, sessionId));

  const finalScores = Object.fromEntries(
    Object.entries(players).map(([id, p]) => [id, { name: p.name, score: p.score }])
  );

  await publishEvent(roomCode, "game:ended", { finalScores });
}
