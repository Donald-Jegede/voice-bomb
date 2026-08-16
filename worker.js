const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    if (url.pathname === "/room") {
      return handleRoom(request, env);
    }

    if (request.method === "POST" && url.pathname === "/") {
      return handleTranscription(request, env);
    }

    return json({ error: "Not found" }, 404);
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

    groqForm.append(
      "file",
      audioFile
    );

    groqForm.append(
      "model",
      "whisper-large-v3"
    );

    groqForm.append(
      "language",
      "en"
    );

    groqForm.append(
      "response_format",
      "json"
    );

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

  let roomId =
    url.searchParams.get("room") || "default";

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
      score: {},
      streak: {},
      usedWords: [],
      chunk: null,
      timeLeft: 20,
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

    const playerId =
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

    const player = {
      id: playerId,
      name:
        `Player ${this.players.size + 1}`,
      joinedAt: Date.now()
    };

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
          this.getGameState()
      }
    );

    this.broadcast(
      {
        type: "playerJoined",
        player,
        players:
          this.getPlayers(),
        hostId:
          this.game.hostId
      },
      playerId
    );

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

    server.addEventListener(
      "close",
      event => {
        console.log(
          "Player disconnected:",
          playerId,
          event.code,
          event.reason
        );

        this.removePlayer(
          playerId
        ).catch(console.error);
      }
    );

    server.addEventListener(
      "error",
      error => {
        console.error(
          "WebSocket error:",
          error
        );

        this.removePlayer(
          playerId
        ).catch(console.error);
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

    if (message.type === "ping") {
      this.send(
        this.sessions.get(playerId),
        {
          type: "pong"
        }
      );

      return;
    }

    if (message.type === "setName") {
      const player =
        this.players.get(playerId);

      if (!player) {
        return;
      }

      const name =
        String(
          message.name || ""
        )
        .trim()
        .slice(0, 20);

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

    if (message.type === "newGame") {
      if (
        playerId !==
        this.game.hostId
      ) {
        this.sendError(
          playerId,
          "Only the host can start a new game."
        );

        return;
      }

      this.startNewGame();

      this.broadcast({
        type: "gameStarted",
        game:
          this.getGameState()
      });

      return;
    }

    if (message.type === "setChunk") {
      if (
        playerId !==
        this.game.hostId
      ) {
        return;
      }

      const chunk =
        String(
          message.chunk || ""
        )
        .toLowerCase()
        .replace(/[^a-z]/g, "")
        .slice(0, 3);

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

    if (message.type === "word") {
      await this.handleWord(
        playerId,
        message.word
      );

      return;
    }

    if (message.type === "gameOver") {
      if (
        playerId !==
        this.game.hostId
      ) {
        return;
      }

      this.game.gameOver =
        true;

      this.game.started =
        false;

      await this.saveGame();

      this.broadcast({
        type: "gameOver",
        game:
          this.getGameState()
      });
    }
  }

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

    if (!word.includes(chunk)) {
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

    this.game.usedWords.push(
      word
    );

    if (
      !this.game.score[playerId]
    ) {
      this.game.score[playerId] = 0;
    }

    if (
      !this.game.streak[playerId]
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

    await this.saveGame();

    this.broadcast({
      type: "wordAccepted",
      playerId,
      word,
      points,
      game:
        this.getGameState()
    });
  }

  startNewGame() {
    this.game.started = true;
    this.game.gameOver = false;

    this.game.usedWords = [];
    this.game.score = {};
    this.game.streak = {};

    this.game.timeLeft = 20;
    this.game.chunk = randomChunk();

    for (
      const playerId of
      this.players.keys()
    ) {
      this.game.score[playerId] = 0;
      this.game.streak[playerId] = 0;
    }

    this.saveGame().catch(
      console.error
    );
  }

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
        this.game.hostId = null;
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

  getPlayers() {
    return [
      ...this.players.values()
    ].map(player => ({
      id: player.id,
      name: player.name
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
   HELPERS
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