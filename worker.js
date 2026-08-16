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

        /*
         * MULTIPLAYER
         *
         * Supports both:
         *
         * /room/ABCD
         *
         * and:
         *
         * /room?room=ABCD
         */
        if (url.pathname === "/room" || url.pathname.startsWith("/room/")) {
            return handleRoom(request, env);
        }

        /*
         * VOICE TRANSCRIPTION
         */
        if (request.method === "POST" && url.pathname === "/") {
            return handleTranscription(request, env);
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
   ROOM ROUTING
========================================================= */

async function handleRoom(request, env) {
    const url = new URL(request.url);

    let roomId = "";

    /*
     * New format:
     *
     * /room/ABCD
     */
    if (url.pathname.startsWith("/room/")) {
        roomId =
            url.pathname
                .slice("/room/".length)
                .split("/")[0];
    }

    /*
     * Old format:
     *
     * /room?room=ABCD
     */
    if (!roomId) {
        roomId =
            url.searchParams.get("room") || "";
    }

    roomId =
        String(roomId)
            .trim()
            .toUpperCase()
            .replace(/[^A-Z0-9_-]/g, "")
            .slice(0, 50);

    if (!roomId) {
        roomId = "DEFAULT";
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

            rounds: 5,
            currentRound: 0,

            score: {},
            streak: {},

            usedWords: [],

            chunk: null,

            timeLeft: 20,

            gameOver: false,

            roundComplete: false
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

        const url =
            new URL(request.url);

        /*
         * WebSocket
         */
        if (
            request.headers
                .get("Upgrade")
                ?.toLowerCase() === "websocket"
        ) {
            return this.handleWebSocket(request);
        }

        /*
         * Normal room status
         */
        if (request.method === "GET") {
            return this.roomStatus();
        }

        return new Response(
            "GameRoom",
            {
                status: 200
            }
        );
    }


    /* =====================================================
       WEBSOCKET
    ===================================================== */

    async handleWebSocket(request) {
        const pair =
            new WebSocketPair();

        const client =
            pair[0];

        const server =
            pair[1];

        server.accept();

        const url =
            new URL(request.url);

        /*
         * Allow the client to suggest
         * an ID/name, but generate one
         * if necessary.
         */
        let playerId =
            url.searchParams.get("player") ||
            url.searchParams.get("playerId") ||
            crypto.randomUUID();

        playerId =
            String(playerId)
                .replace(/[^a-zA-Z0-9_-]/g, "")
                .slice(0, 80);

        if (!playerId) {
            playerId =
                crypto.randomUUID();
        }

        /*
         * Avoid duplicate IDs.
         */
        if (this.players.has(playerId)) {
            playerId =
                crypto.randomUUID();
        }

        let playerName =
            url.searchParams.get("name") ||
            "Player";

        playerName =
            String(playerName)
                .trim()
                .slice(0, 20);

        if (!playerName) {
            playerName = "Player";
        }

        const player = {
            id: playerId,
            name: playerName,
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

        /*
         * First connected player becomes host.
         */
        const isNewHost =
            !this.game.hostId;

        if (isNewHost) {
            this.game.hostId =
                playerId;

            await this.saveGame();
        }

        /*
         * Send welcome.
         */
        this.send(
            server,
            {
                type: "welcome",
                player: {
                    id: playerId,
                    name: player.name
                },
                playerId,

                isHost:
                    this.game.hostId ===
                    playerId,

                hostId:
                    this.game.hostId,

                players:
                    this.getPlayers(),

                game:
                    this.getGameState()
            }
        );

        /*
         * Tell everyone else.
         */
        this.broadcast(
            {
                type: "playerJoined",
                player: {
                    id: playerId,
                    name: player.name
                },
                playerId,

                hostId:
                    this.game.hostId,

                players:
                    this.getPlayers()
            },
            playerId
        );

        /*
         * Tell the new player the current
         * room state if a game is already running.
         */
        if (this.game.started) {
            this.send(
                server,
                {
                    type: "gameState",
                    game:
                        this.getGameState()
                }
            );
        }

        server.addEventListener(
            "message",
            async event => {
                await this.handleMessage(
                    playerId,
                    event.data
                );
            }
        );

        server.addEventListener(
            "close",
            async () => {
                await this.removePlayer(
                    playerId
                );
            }
        );

        server.addEventListener(
            "error",
            async () => {
                await this.removePlayer(
                    playerId
                );
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


    /* =====================================================
       MESSAGE HANDLER
    ===================================================== */

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

        const type =
            String(message.type)
                .toLowerCase();


        /* ================================================
           SET NAME
        ================================================ */

        if (
            type === "setname"
        ) {
            const player =
                this.players.get(
                    playerId
                );

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
                    this.getPlayers()
            });

            return;
        }


        /* ================================================
           NEW GAME
        ================================================ */

        if (
            type === "new_game" ||
            type === "newgame"
        ) {
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

            let rounds =
                Number(
                    message.rounds
                );

            if (!Number.isFinite(rounds)) {
                rounds = 5;
            }

            rounds =
                Math.floor(rounds);

            /*
             * HARD LIMIT:
             * 5 minimum
             * 250 maximum
             */
            rounds =
                Math.max(
                    5,
                    Math.min(
                        250,
                        rounds
                    )
                );

            this.startNewGame(
                rounds
            );

            await this.saveGame();

            this.broadcast({
                type: "gameStarted",
                game:
                    this.getGameState()
            });

            return;
        }


        /* ================================================
           SET ROUNDS
        ================================================ */

        if (
            type === "setrounds"
        ) {
            if (
                playerId !==
                this.game.hostId
            ) {
                this.sendError(
                    playerId,
                    "Only the host can change the number of rounds."
                );

                return;
            }

            let rounds =
                Number(
                    message.rounds
                );

            if (!Number.isFinite(rounds)) {
                return;
            }

            rounds =
                Math.floor(rounds);

            rounds =
                Math.max(
                    5,
                    Math.min(
                        250,
                        rounds
                    )
                );

            this.game.rounds =
                rounds;

            await this.saveGame();

            this.broadcast({
                type: "roundsChanged",
                rounds
            });

            return;
        }


        /* ================================================
           WORD
        ================================================ */

        if (
            type === "word"
        ) {
            await this.handleWord(
                playerId,
                message.word
            );

            return;
        }


        /* ================================================
           GAME OVER
        ================================================ */

        if (
            type === "game_over"
        ) {
            if (
                playerId !==
                this.game.hostId
            ) {
                return;
            }

            await this.endGame(
                "bomb"
            );

            return;
        }


        /* ================================================
           GAME STATE REQUEST
        ================================================ */

        if (
            type === "request_state"
        ) {
            const socket =
                this.sessions.get(
                    playerId
                );

            this.send(
                socket,
                {
                    type: "gameState",
                    game:
                        this.getGameState()
                }
            );

            return;
        }
    }


    /* =====================================================
       START NEW GAME
    ===================================================== */

    startNewGame(rounds) {
        this.game.started = true;

        this.game.gameOver = false;

        this.game.roundComplete = false;

        this.game.rounds =
            Math.max(
                5,
                Math.min(
                    250,
                    Math.floor(rounds || 5)
                )
            );

        this.game.currentRound = 1;

        this.game.usedWords = [];

        this.game.score = {};

        this.game.streak = {};

        this.game.timeLeft = 20;

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
    }


    /* =====================================================
       WORD HANDLER
    ===================================================== */

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


        /* Duplicate */
        if (
            this.game.usedWords.includes(
                word
            )
        ) {
            this.send(
                this.sessions.get(
                    playerId
                ),
                {
                    type: "wordResult",
                    success: false,
                    reason: "duplicate",
                    word
                }
            );

            return;
        }


        /* Missing chunk */
        if (
            !word.includes(chunk)
        ) {
            this.send(
                this.sessions.get(
                    playerId
                ),
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


        /* Valid word */
        this.game.usedWords.push(
            word
        );

        if (
            !this.game.score[playerId]
        ) {
            this.game.score[playerId] =
                0;
        }

        if (
            !this.game.streak[playerId]
        ) {
            this.game.streak[playerId] =
                0;
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


        /*
         * Tell everybody about the word.
         */
        this.broadcast({
            type: "wordAccepted",

            playerId,

            name:
                this.players.get(
                    playerId
                )?.name || "Player",

            word,

            points,

            round:
                this.game.currentRound,

            game:
                this.getGameState()
        });


        /*
         * The current round is completed.
         */
        this.game.roundComplete =
            true;

        await this.saveGame();


        /*
         * If this was the FINAL round,
         * finish the game.
         */
        if (
            this.game.currentRound >=
            this.game.rounds
        ) {
            await this.finishRounds();
            return;
        }


        /*
         * Otherwise move to next round.
         */
        this.game.currentRound++;

        this.game.chunk =
            randomChunk();

        this.game.timeLeft =
            20;

        this.game.roundComplete =
            false;

        await this.saveGame();

        this.broadcast({
            type: "nextRound",

            round:
                this.game.currentRound,

            rounds:
                this.game.rounds,

            chunk:
                this.game.chunk,

            timeLeft:
                20,

            game:
                this.getGameState()
        });
    }


    /* =====================================================
       FINISH ROUNDS
    ===================================================== */

    async finishRounds() {
        this.game.started = false;

        this.game.gameOver = true;

        this.game.roundComplete = true;

        await this.saveGame();

        const winner =
            this.getWinner();

        this.broadcast({
            type: "roundsComplete",

            game:
                this.getGameState(),

            winner
        });
    }


    /* =====================================================
       BOMB EXPLOSION
    ===================================================== */

    async endGame(reason = "bomb") {
        this.game.started = false;

        this.game.gameOver = true;

        this.game.roundComplete = false;

        await this.saveGame();

        this.broadcast({
            type: "gameOver",

            reason,

            game:
                this.getGameState()
        });
    }


    /* =====================================================
       WINNER
    ===================================================== */

    getWinner() {
        let winner = null;

        let highestScore = -1;

        for (
            const player of
            this.players.values()
        ) {
            const score =
                this.game.score[player.id] || 0;

            if (
                score >
                highestScore
            ) {
                highestScore = score;

                winner = {
                    id: player.id,
                    name: player.name,
                    score
                };
            }
        }

        return winner;
    }


    /* =====================================================
       REMOVE PLAYER
    ===================================================== */

    async removePlayer(
        playerId
    ) {
        this.sessions.delete(
            playerId
        );

        this.players.delete(
            playerId
        );

        /*
         * Remove their score/streak.
         */
        delete this.game.score[playerId];

        delete this.game.streak[playerId];


        /*
         * Transfer host.
         */
        if (
            this.game.hostId ===
            playerId
        ) {
            const next =
                this.players.keys().next();

            if (!next.done) {
                this.game.hostId =
                    next.value;

                const socket =
                    this.sessions.get(
                        next.value
                    );

                if (socket) {
                    this.send(
                        socket,
                        {
                            type: "becameHost",
                            hostId:
                                next.value,
                            isHost: true
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


    /* =====================================================
       PLAYERS
    ===================================================== */

    getPlayers() {
        return [
            ...this.players.values()
        ].map(player => ({
            id: player.id,
            playerId: player.id,
            name: player.name,

            isHost:
                player.id ===
                this.game.hostId,

            host:
                player.id ===
                this.game.hostId
        }));
    }


    /* =====================================================
       GAME STATE
    ===================================================== */

    getGameState() {
        return {
            started:
                this.game.started,

            gameOver:
                this.game.gameOver,

            hostId:
                this.game.hostId,

            rounds:
                this.game.rounds,

            currentRound:
                this.game.currentRound,

            score:
                this.game.score,

            streak:
                this.game.streak,

            usedWords:
                this.game.usedWords,

            chunk:
                this.game.chunk,

            timeLeft:
                this.game.timeLeft,

            roundComplete:
                this.game.roundComplete,

            players:
                this.getPlayers()
        };
    }


    /* =====================================================
       ROOM STATUS
    ===================================================== */

    roomStatus() {
        return json({
            type: "roomState",

            hostId:
                this.game.hostId,

            players:
                this.getPlayers(),

            game:
                this.getGameState()
        });
    }


    /* =====================================================
       STORAGE
    ===================================================== */

    async saveGame() {
        await this.state.storage.put(
            "game",
            this.game
        );
    }


    /* =====================================================
       SEND
    ===================================================== */

    send(
        socket,
        data
    ) {
        if (!socket) {
            return;
        }

        try {
            socket.send(
                JSON.stringify(data)
            );
        } catch {}
    }


    /* =====================================================
       ERROR
    ===================================================== */

    sendError(
        playerId,
        error
    ) {
        this.send(
            this.sessions.get(
                playerId
            ),
            {
                type: "error",
                error
            }
        );
    }


    /* =====================================================
       BROADCAST
    ===================================================== */

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
                socket.send(message);
            } catch {}
        }
    }
}


/* =========================================================
   CHUNKS
========================================================= */

const TWO_LETTER_CHUNKS = [
    "st",
    "tr",
    "ch",
    "sh",
    "th",
    "ph",
    "wh",
    "bl",
    "br",
    "cl",
    "cr",
    "dr",
    "fl",
    "fr",
    "gl",
    "gr",
    "pl",
    "pr",
    "sc",
    "sk",
    "sl",
    "sm",
    "sn",
    "sp",
    "sw",
    "tw",
    "wr",
    "ck",
    "ng",
    "nd",
    "nt",
    "nk",
    "mp",
    "ll",
    "ss",
    "oo",
    "ee",
    "ea",
    "ou",
    "ow",
    "ai",
    "ay",
    "oa",
    "oi",
    "oy",
    "ar",
    "er",
    "ir",
    "or",
    "ur",
    "an",
    "en",
    "in",
    "on",
    "un",
    "at",
    "et",
    "it",
    "ot",
    "ut",
    "re",
    "le",
    "me",
    "ne"
];


const THREE_LETTER_CHUNKS = [
    "ing",
    "and",
    "the",
    "ion",
    "ere",
    "ate",
    "ent",
    "est",
    "for",
    "her",
    "his",
    "not",
    "are",
    "was",
    "all",
    "out",
    "one",
    "our",
    "you",
    "but",
    "can",
    "had",
    "has",
    "new",
    "too",
    "get",
    "day",
    "man",
    "top",
    "car",
    "dog",
    "cat"
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
   FILENAME
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
    } else if (
        contentType.includes("webm")
    ) {
        extension = ".webm";
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