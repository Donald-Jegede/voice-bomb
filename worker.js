const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

const TURN_TIME = 20;
const MIN_ROUNDS = 5;
const MAX_ROUNDS = 250;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    /*
      Voice transcription
    */
    if (request.method === "POST" && url.pathname === "/") {
      return handleTranscription(request, env);
    }

    /*
      Multiplayer room

      Supports:
      /room?room=ABCD
      /room/ABCD
    */
    if (
      url.pathname === "/room" ||
      url.pathname.startsWith("/room/")
    ) {
      return handleRoom(request, env);
    }

    return json({
      error: "Not found"
    }, 404);
  }
};

/* =========================================================
   VOICE TRANSCRIPTION
========================================================= */

async function handleTranscription(request, env) {
  try {
    if (!env.GROQ_API_KEY) {
      return json({
        error: "GROQ_API_KEY is missing from Worker secrets."
      }, 500);
    }

    const incoming = await request.formData();
    const file = incoming.get("file");

    if (!file) {
      return json({
        error: "No audio file was uploaded."
      }, 400);
    }

    if (!(file instanceof File)) {
      return json({
        error: "Uploaded audio is not a valid file."
      }, 400);
    }

    if (file.size === 0) {
      return json({
        error: "The audio file is empty."
      }, 400);
    }

    const audioBuffer = await file.arrayBuffer();
    const contentType = file.type || "audio/webm";

    const filename = getSafeFilename(
      file.name,
      contentType
    );

    const groqForm = new FormData();

    const audioFile = new File(
      [audioBuffer],
      filename,
      {
        type: contentType
      }
    );

    groqForm.append("file", audioFile);
    groqForm.append("model", "whisper-large-v3");
    groqForm.append("language", "en");
    groqForm.append("response_format", "json");

    groqForm.append(
      "prompt",
      "The user is saying exactly one English word for a word game. Return only the spoken word."
    );

    const groqResponse = await fetch(
      GROQ_URL,
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${env.GROQ_API_KEY}`
        },
        body: groqForm
      }
    );

    const raw = await groqResponse.text();

    let data;

    try {
      data = JSON.parse(raw);
    } catch {
      return json({
        error: "Groq returned invalid JSON.",
        groqStatus: groqResponse.status
      }, 502);
    }

    if (!groqResponse.ok) {
      console.error(
        "Groq transcription error:",
        data
      );

      return json({
        error:
          data?.error?.message ||
          "Groq could not process the audio.",
        groqStatus:
          groqResponse.status
      }, groqResponse.status);
    }

    const text =
      typeof data.text === "string"
        ? data.text.trim()
        : "";

    if (!text) {
      return json({
        success: false,
        text: "",
        error: "No speech was detected."
      });
    }

    return json({
      success: true,
      text
    });

  } catch (error) {
    console.error(
      "Transcription Worker error:",
      error
    );

    return json({
      error:
        error?.message ||
        "Transcription failed."
    }, 500);
  }
}

/* =========================================================
   ROOM ROUTER
========================================================= */

async function handleRoom(request, env) {
  const url = new URL(request.url);

  let roomId = "";

  if (url.pathname.startsWith("/room/")) {
    roomId =
      url.pathname
        .slice("/room/".length)
        .split("/")[0];
  }

  if (!roomId) {
    roomId =
      url.searchParams.get("room") || "";
  }

  roomId = roomId
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 50);

  if (!roomId) {
    roomId = "default";
  }

  const id =
    env.GAME_ROOM.idFromName(roomId);

  const room =
    env.GAME_ROOM.get(id);

  return room.fetch(request);
}

/* =========================================================
   DURABLE OBJECT
========================================================= */

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    this.sessions = new Map();
    this.players = new Map();

    this.game = {
      started: false,
      hostId: null,

      rounds: MIN_ROUNDS,
      currentRound: 0,

      score: {},
      streak: {},

      usedWords: [],

      chunk: null,

      timeLeft: TURN_TIME,

      gameOver: false
    };

    this.loaded = this.loadState();
  }

  async loadState() {
    const saved =
      await this.state.storage.get("game");

    if (saved) {
      this.game = {
        ...this.game,
        ...saved
      };
    }
  }

  async fetch(request) {
    await this.loaded;

    const upgrade =
      request.headers.get("Upgrade");

    console.log(
      "GameRoom request:",
      request.method,
      new URL(request.url).pathname,
      "Upgrade:",
      upgrade
    );

    if (
      upgrade &&
      upgrade.toLowerCase() === "websocket"
    ) {
      return this.handleWebSocket(request);
    }

    if (request.method === "GET") {
      return this.roomStatus();
    }

    return new Response(
      "GameRoom",
      {
        status: 200,
        headers: corsHeaders()
      }
    );
  }

  /* =======================================================
     WEBSOCKET
  ======================================================= */

  async handleWebSocket(request) {
    let pair;

    try {
      pair = new WebSocketPair();
    } catch (error) {
      console.error(
        "Failed to create WebSocketPair:",
        error
      );

      return new Response(
        "WebSocket is not available.",
        {
          status: 500
        }
      );
    }

    const client = pair[0];
    const server = pair[1];

    const url = new URL(request.url);

    const requestedPlayerId =
      url.searchParams.get("player");

    const requestedName =
      url.searchParams.get("name");

    const playerId =
      requestedPlayerId ||
      crypto.randomUUID();

    try {
      server.accept();
    } catch (error) {
      console.error(
        "WebSocket accept failed:",
        error
      );

      return new Response(
        "WebSocket connection failed.",
        {
          status: 500
        }
      );
    }

    /*
      Don't duplicate a player if the client reconnects
      using the same player ID.

      IMPORTANT:
      If an old socket closes after a new socket has
      replaced it, the old socket must NOT remove the
      player from the room.
    */

    const player = {
      id: playerId,
      name:
        sanitizeName(
          requestedName ||
          `Player ${this.players.size + 1}`
        ),
      joinedAt: Date.now()
    };

    const oldSocket =
      this.sessions.get(playerId);

    if (oldSocket && oldSocket !== server) {
      try {
        oldSocket.close(
          1000,
          "Reconnected"
        );
      } catch {}
    }

    this.players.set(
      playerId,
      player
    );

    this.sessions.set(
      playerId,
      server
    );

    if (!this.game.hostId) {
      this.game.hostId =
        playerId;

      await this.saveGame();
    }

    console.log(
      "Player connected:",
      player.name,
      playerId
    );

    this.send(
      server,
      {
        type: "welcome",

        player,

        isHost:
          this.game.hostId === playerId,

        game:
          this.getGameState(),

        players:
          this.getPlayers()
      }
    );

    this.broadcast({
      type: "players",
      players:
        this.getPlayers(),
      hostId:
        this.game.hostId
    }, playerId);

    server.addEventListener(
      "message",
      event => {
        this.handleMessage(
          playerId,
          event.data
        ).catch(error => {
          console.error(
            "Message handler error:",
            error
          );
        });
      }
    );

    /*
      IMPORTANT RECONNECT FIX

      Only remove the player if THIS socket is still
      the current socket for that player.

      This prevents an old connection's close event
      from deleting a newly reconnected player.
    */
    server.addEventListener(
      "close",
      event => {
        console.log(
          "Player disconnected:",
          playerId,
          event.code,
          event.reason
        );

        if (
          this.sessions.get(playerId) ===
          server
        ) {
          this.removePlayer(
            playerId
          ).catch(console.error);
        } else {
          console.log(
            "Ignoring stale socket close:",
            playerId
          );
        }
      }
    );

    /*
      Same protection for socket errors.
    */
    server.addEventListener(
      "error",
      error => {
        console.error(
          "WebSocket error:",
          error
        );

        if (
          this.sessions.get(playerId) ===
          server
        ) {
          this.removePlayer(
            playerId
          ).catch(console.error);
        } else {
          console.log(
            "Ignoring stale socket error:",
            playerId
          );
        }
      }
    );

    return new Response(
      null,
      {
        status: 101,
        webSocket: client
      }
    );
  }

  /* =======================================================
     MESSAGES
  ======================================================= */

  async handleMessage(
    playerId,
    raw
  ) {
    let message;

    try {
      message =
        JSON.parse(raw);
    } catch {
      return;
    }

    if (!message?.type) {
      return;
    }

    /* PING */

    if (message.type === "ping") {
      this.send(
        this.sessions.get(playerId),
        {
          type: "pong"
        }
      );

      return;
    }

    /* SET NAME */

    if (message.type === "setName") {
      const player =
        this.players.get(playerId);

      if (!player) {
        return;
      }

      const name =
        sanitizeName(
          message.name
        );

      if (name) {
        player.name = name;
      }

      this.broadcast({
        type: "players",
        players:
          this.getPlayers(),
        hostId:
          this.game.hostId
      });

      return;
    }

    /* NEW GAME */

    if (message.type === "newGame") {
      if (
        playerId !==
        this.game.hostId
      ) {
        this.sendError(
          playerId,
          "Only the host can start a game."
        );

        return;
      }

      let rounds =
        Number(message.rounds);

      if (!Number.isFinite(rounds)) {
        rounds = MIN_ROUNDS;
      }

      rounds =
        clampRounds(rounds);

      await this.startNewGame(
        rounds
      );

      this.broadcast({
        type: "gameStarted",
        game:
          this.getGameState()
      });

      return;
    }

    /* SET ROUNDS */

    if (message.type === "setRounds") {
      if (
        playerId !==
        this.game.hostId
      ) {
        this.sendError(
          playerId,
          "Only the host can change the rounds."
        );

        return;
      }

      if (this.game.started) {
        this.sendError(
          playerId,
          "You can't change rounds while a game is running."
        );

        return;
      }

      let rounds =
        Number(message.rounds);

      if (!Number.isFinite(rounds)) {
        rounds = MIN_ROUNDS;
      }

      rounds =
        clampRounds(rounds);

      this.game.rounds =
        rounds;

      await this.saveGame();

      this.broadcast({
        type: "roundsChanged",
        rounds
      });

      return;
    }

    /* SET CHUNK */

    if (message.type === "setChunk") {
      if (
        playerId !==
        this.game.hostId
      ) {
        return;
      }

      const chunk =
        normalizeChunk(
          message.chunk
        );

      if (!chunk) {
        return;
      }

      this.game.chunk =
        chunk;

      await this.saveGame();

      this.broadcast({
        type: "chunkChanged",
        chunk
      });

      return;
    }

    /* WORD */

    if (message.type === "word") {
      await this.handleWord(
        playerId,
        message.word
      );

      return;
    }

    /* GAME OVER */

    if (message.type === "gameOver") {
      if (
        playerId !==
        this.game.hostId
      ) {
        return;
      }

      await this.finishGame(
        message.reason ||
        "host"
      );

      return;
    }
  }

  /* =======================================================
     WORD
  ======================================================= */

  async handleWord(
    playerId,
    rawWord
  ) {
    if (
      !this.game.started ||
      this.game.gameOver
    ) {
      return;
    }

    const word =
      normalizeServerWord(
        rawWord
      );

    if (!word) {
      return;
    }

    const chunk =
      this.game.chunk;

    if (!chunk) {
      return;
    }

    /* DUPLICATE */

    if (
      this.game.usedWords.includes(
        word
      )
    ) {
      this.send(
        this.sessions.get(playerId),
        {
          type: "wordResult",
          success: false,
          reason: "duplicate",
          word
        }
      );

      return;
    }

    /* MISSING CHUNK */

    if (
      !word.includes(chunk)
    ) {
      this.send(
        this.sessions.get(playerId),
        {
          type: "wordResult",
          success: false,
          reason: "missingChunk",
          word,
          chunk
        }
      );

      return;
    }

    /* ACCEPT WORD */

    this.game.usedWords.push(
      word
    );

    if (
      typeof this.game.score[playerId] !==
      "number"
    ) {
      this.game.score[playerId] = 0;
    }

    if (
      typeof this.game.streak[playerId] !==
      "number"
    ) {
      this.game.streak[playerId] = 0;
    }

    const points =
      10 +
      Math.min(
        this.game.streak[playerId] * 2,
        20
      );

    this.game.score[playerId] +=
      points;

    this.game.streak[playerId]++;

    const completedRound =
      this.game.currentRound;

    /* LAST ROUND */

    if (
      completedRound >=
      this.game.rounds
    ) {
      await this.saveGame();

      this.broadcast({
        type: "wordAccepted",
        playerId,
        word,
        points,

        currentRound:
          completedRound,

        totalRounds:
          this.game.rounds,

        game:
          this.getGameState()
      });

      await this.finishGame(
        "roundsComplete"
      );

      return;
    }

    /* NEXT ROUND */

    this.game.currentRound++;

    this.game.chunk =
      randomChunk();

    this.game.timeLeft =
      TURN_TIME;

    await this.saveGame();

    this.broadcast({
      type: "wordAccepted",

      playerId,
      word,
      points,

      currentRound:
        this.game.currentRound,

      totalRounds:
        this.game.rounds,

      nextChunk:
        this.game.chunk,

      timeLeft:
        TURN_TIME,

      game:
        this.getGameState()
    });
  }

  /* =======================================================
     START GAME
  ======================================================= */

  async startNewGame(rounds) {
    rounds =
      clampRounds(rounds);

    this.game.started =
      true;

    this.game.gameOver =
      false;

    this.game.rounds =
      rounds;

    this.game.currentRound =
      1;

    this.game.usedWords =
      [];

    this.game.score =
      {};

    this.game.streak =
      {};

    this.game.timeLeft =
      TURN_TIME;

    this.game.chunk =
      randomChunk();

    for (
      const playerId of
      this.players.keys()
    ) {
      this.game.score[playerId] =
        0;

      this.game.streak[playerId] =
        0;
    }

    await this.saveGame();
  }

  /* =======================================================
     FINISH GAME
  ======================================================= */

  async finishGame(reason) {
    this.game.started =
      false;

    this.game.gameOver =
      true;

    this.game.timeLeft =
      0;

    await this.saveGame();

    this.broadcast({
      type: "gameOver",

      reason,

      game:
        this.getGameState()
    });
  }

  /* =======================================================
     REMOVE PLAYER
  ======================================================= */

  async removePlayer(playerId) {
    if (
      !this.players.has(playerId)
    ) {
      return;
    }

    this.sessions.delete(
      playerId
    );

    this.players.delete(
      playerId
    );

    delete this.game.score[playerId];
    delete this.game.streak[playerId];

    if (
      this.game.hostId ===
      playerId
    ) {
      const nextPlayer =
        this.players.keys().next();

      if (!nextPlayer.done) {
        this.game.hostId =
          nextPlayer.value;

        const socket =
          this.sessions.get(
            nextPlayer.value
          );

        if (socket) {
          this.send(
            socket,
            {
              type: "becameHost",
              hostId:
                nextPlayer.value
            }
          );
        }
      } else {
        this.game.hostId =
          null;
      }
    }

    await this.saveGame();

    this.broadcast({
      type: "playerLeft",

      playerId,

      players:
        this.getPlayers(),

      hostId:
        this.game.hostId
    });
  }

  /* =======================================================
     STATE
  ======================================================= */

  getPlayers() {
    return [
      ...this.players.values()
    ].map(player => ({
      id: player.id,
      name: player.name,

      isHost:
        player.id ===
        this.game.hostId
    }));
  }

  getGameState() {
    return {
      ...this.game,

      players:
        this.getPlayers()
    };
  }

  roomStatus() {
    return json({
      players:
        this.getPlayers(),

      game:
        this.getGameState()
    });
  }

  async saveGame() {
    await this.state.storage.put(
      "game",
      this.game
    );
  }

  /* =======================================================
     SOCKET HELPERS
  ======================================================= */

  send(socket, data) {
    if (!socket) {
      return;
    }

    try {
      if (
        socket.readyState ===
        WebSocket.OPEN
      ) {
        socket.send(
          JSON.stringify(data)
        );
      }
    } catch (error) {
      console.error(
        "Socket send error:",
        error
      );
    }
  }

  sendError(
    playerId,
    error
  ) {
    this.send(
      this.sessions.get(playerId),
      {
        type: "error",
        error
      }
    );
  }

  broadcast(
    data,
    exceptPlayerId = null
  ) {
    const message =
      JSON.stringify(data);

    for (
      const [
        playerId,
        socket
      ] of this.sessions
    ) {
      if (
        playerId ===
        exceptPlayerId
      ) {
        continue;
      }

      try {
        if (
          socket.readyState ===
          WebSocket.OPEN
        ) {
          socket.send(message);
        }
      } catch (error) {
        console.error(
          "Broadcast error:",
          error
        );
      }
    }
  }
}

/* =========================================================
   CHUNKS
========================================================= */

const TWO_LETTER_CHUNKS = [
  "st","tr","ch","sh","th","ph","wh",
  "bl","br","cl","cr","dr","fl","fr",
  "gl","gr","pl","pr","sc","sk","sl",
  "sm","sn","sp","sw","tw","wr","ck",
  "ng","nd","nt","nk","mp","ll","ss",
  "oo","ee","ea","ou","ow","ai","ay",
  "oa","oi","oy","ar","er","ir","or",
  "ur","an","en","in","on","un","at",
  "et","it","ot","ut","re","le","me","ne"
];

const THREE_LETTER_CHUNKS = [
  "ing","and","the","ion","ere","ate",
  "ent","est","for","her","his","not",
  "are","was","all","out","one","our",
  "you","but","can","had","has","new",
  "too","get","day","man","top","car",
  "dog","cat"
];

function randomChunk() {
  const useThree =
    Math.random() < 0.25;

  const list =
    useThree
      ? THREE_LETTER_CHUNKS
      : TWO_LETTER_CHUNKS;

  return list[
    Math.floor(
      Math.random() *
      list.length
    )
  ];
}

function normalizeChunk(chunk) {
  if (
    typeof chunk !== "string"
  ) {
    return "";
  }

  return chunk
    .toLowerCase()
    .replace(
      /[^a-z]/g,
      ""
    )
    .slice(0, 3);
}

/* =========================================================
   WORD NORMALIZATION
========================================================= */

function normalizeServerWord(text) {
  if (
    typeof text !== "string"
  ) {
    return "";
  }

  return text
    .toLowerCase()
    .replace(
      /[^a-z'-]/g,
      ""
    )
    .replace(
      /^'+|'+$/g,
      ""
    )
    .trim()
    .slice(0, 50);
}

/* =========================================================
   ROUND HELPERS
========================================================= */

function clampRounds(value) {
  return Math.max(
    MIN_ROUNDS,
    Math.min(
      MAX_ROUNDS,
      Math.round(value)
    )
  );
}

/* =========================================================
   PLAYER HELPERS
========================================================= */

function sanitizeName(name) {
  const cleaned =
    String(name || "")
      .trim()
      .replace(
        /[^a-zA-Z0-9 _-]/g,
        ""
      )
      .slice(0, 20);

  return cleaned ||
    "Player";
}

/* =========================================================
   FILE HELPERS
========================================================= */

function getSafeFilename(
  originalName,
  contentType
) {
  let extension = ".webm";

  if (
    contentType.includes("mp4")
  ) {
    extension = ".mp4";
  } else if (
    contentType.includes("mpeg")
  ) {
    extension = ".mp3";
  } else if (
    contentType.includes("wav")
  ) {
    extension = ".wav";
  } else if (
    contentType.includes("ogg")
  ) {
    extension = ".ogg";
  }

  return `recording${extension}`;
}

/* =========================================================
   CORS
========================================================= */

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",

    "Access-Control-Allow-Methods":
      "GET, POST, OPTIONS",

    "Access-Control-Allow-Headers":
      "Content-Type",

    "Access-Control-Max-Age":
      "86400"
  };
}

/* =========================================================
   JSON
========================================================= */

function json(
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(data),
    {
      status,

      headers: {
        "Content-Type":
          "application/json; charset=utf-8",

        ...corsHeaders()
      }
    }
  );
}