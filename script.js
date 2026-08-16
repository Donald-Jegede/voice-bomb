const WORKER_URL = "https://workerjs.donaldjegede29.workers.dev";
const WS_URL = WORKER_URL.replace(/^http/, "ws") + "/room";

const TURN_TIME = 20;

const TWO_LETTER_CHUNKS = [
    "st","tr","ch","sh","th","ph","wh","bl","br","cl","cr","dr","fl","fr",
    "gl","gr","pl","pr","sc","sk","sl","sm","sn","sp","sw","tw","wr","ck",
    "ng","nd","nt","nk","mp","ll","ss","oo","ee","ea","ou","ow","ai","ay",
    "oa","oi","oy","ar","er","ir","or","ur","an","en","in","on","un","at",
    "et","it","ot","ut","re","le","me","ne"
];

const THREE_LETTER_CHUNKS = [
    "ing","and","the","ion","ere","ate","ent","est","for","her","his","not",
    "are","was","all","out","one","our","you","but","can","had","has","new",
    "too","get","day","man","top","car","dog","cat"
];

const recordButton = document.getElementById("speakButton");
const newGameButton = document.getElementById("newGameButton");
const copyButton = document.getElementById("copyButton");
const downloadButton = document.getElementById("downloadButton");

const transcript = document.getElementById("heard");
const resultText = document.getElementById("result");
const chunkDisplay = document.getElementById("chunk");

const scoreDisplay = document.getElementById("score");
const streakDisplay = document.getElementById("streak");
const wordsUsedDisplay = document.getElementById("wordsUsed");

const timerDisplay = document.getElementById("timer");
const timerBar = document.getElementById("timerBar");
const bomb = document.getElementById("bomb");

const recordingStatus = document.getElementById("recordingStatus");
const message = document.getElementById("message");
const usedWordsDisplay = document.getElementById("usedWords");

let mediaRecorder = null;
let mediaStream = null;
let audioChunks = [];
let audioBlob = null;

let selectedChunk = "";
let usedWords = new Set();

let score = 0;
let streak = 0;

let timeLeft = TURN_TIME;
let timerInterval = null;

let recording = false;
let processing = false;
let gameOver = false;

let socket = null;
let roomCode = "";
let playerId = "";
let playerName = "";
let isHost = false;
let connected = false;

let reconnectTimer = null;
let intentionalDisconnect = false;

let currentRoomState = null;


/* =========================================================
   MULTIPLAYER UI
========================================================= */

function createMultiplayerUI() {
    let panel = document.getElementById("multiplayerPanel");

    if (panel) return;

    panel = document.createElement("section");
    panel.id = "multiplayerPanel";

    panel.style.marginTop = "20px";
    panel.style.padding = "16px";
    panel.style.borderRadius = "16px";
    panel.style.background = "rgba(255,255,255,0.06)";
    panel.style.border = "1px solid rgba(255,255,255,0.12)";

    panel.innerHTML = `
        <div style="font-weight:800;font-size:18px;margin-bottom:10px;">
            👥 Multiplayer
        </div>

        <div id="connectionStatus"
             style="font-size:14px;margin-bottom:10px;">
            ⚪ Not connected
        </div>

        <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <input
                id="roomInput"
                placeholder="Room code"
                maxlength="8"
                style="
                    flex:1;
                    min-width:120px;
                    padding:10px;
                    border-radius:10px;
                    border:none;
                    outline:none;
                "
            >

            <button id="createRoomButton" class="secondary">
                🏠 Create
            </button>

            <button id="joinRoomButton" class="secondary">
                🚪 Join
            </button>
        </div>

        <div
            id="roomDisplay"
            style="
                margin-top:10px;
                font-weight:700;
            "
        ></div>

        <div
            id="playersDisplay"
            style="
                margin-top:8px;
                line-height:1.7;
            "
        ></div>
    `;

    const game = document.querySelector(".game");

    if (game) {
        const usedSection = game.querySelector(".used-section");

        if (usedSection) {
            game.insertBefore(panel, usedSection);
        } else {
            game.appendChild(panel);
        }
    }

    document
        .getElementById("createRoomButton")
        .addEventListener("click", createRoom);

    document
        .getElementById("joinRoomButton")
        .addEventListener("click", joinRoom);

    document
        .getElementById("roomInput")
        .addEventListener("keydown", event => {
            if (event.key === "Enter") {
                joinRoom();
            }
        });
}


/* =========================================================
   CONNECTION STATUS
========================================================= */

function setConnectionStatus(text, type = "") {
    const element = document.getElementById("connectionStatus");

    if (!element) return;

    element.textContent = text;

    if (type === "good") {
        element.style.color = "#65ff9b";
    } else if (type === "bad") {
        element.style.color = "#ff6b6b";
    } else {
        element.style.color = "";
    }
}


/* =========================================================
   PLAYER / ROOM IDS
========================================================= */

function generatePlayerId() {
    if (crypto.randomUUID) {
        return crypto.randomUUID();
    }

    return (
        "p_" +
        Math.random().toString(36).substring(2, 10) +
        Date.now().toString(36)
    );
}


function getPlayerName() {
    let saved = localStorage.getItem("voiceBombName");

    if (!saved) {
        saved =
            "Player " +
            Math.floor(Math.random() * 999);

        localStorage.setItem(
            "voiceBombName",
            saved
        );
    }

    return saved;
}


function generateRoomCode() {
    const chars =
        "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    let code = "";

    for (let i = 0; i < 6; i++) {
        code += chars[
            Math.floor(Math.random() * chars.length)
        ];
    }

    return code;
}


/* =========================================================
   CREATE ROOM
========================================================= */

function createRoom() {
    if (connected) {
        showMessage(
            "You're already in a room.",
            "bad"
        );
        return;
    }

    roomCode = generateRoomCode();

    /*
        Host status is determined by the Worker.
        The first player connected to the Durable Object
        becomes host.
    */

    isHost = false;

    connectToRoom();
}


/* =========================================================
   JOIN ROOM
========================================================= */

function joinRoom() {
    if (connected) {
        showMessage(
            "You're already in a room.",
            "bad"
        );
        return;
    }

    const input =
        document.getElementById("roomInput");

    if (!input) return;

    const code =
        input.value
            .trim()
            .toUpperCase();

    if (!code) {
        showMessage(
            "Enter a room code.",
            "bad"
        );
        return;
    }

    roomCode = code;
    isHost = false;

    connectToRoom();
}


/* =========================================================
   CONNECT TO ROOM
========================================================= */

function connectToRoom() {
    if (!roomCode) return;

    clearTimeout(reconnectTimer);

    if (socket) {
        try {
            socket.close();
        } catch {}
    }

    intentionalDisconnect = false;

    playerId =
        playerId ||
        generatePlayerId();

    playerName =
        playerName ||
        getPlayerName();

    setConnectionStatus(
        "🟡 Connecting...",
        ""
    );

    /*
        IMPORTANT:
        Worker expects:

        /room?room=ROOMCODE

        NOT:

        /room/ROOMCODE
        /room/ws
        /room/ROOMCODE/ws
    */

    const url =
        `${WS_URL}?room=${encodeURIComponent(roomCode)}`;

    console.log(
        "[Voice Bomb] Connecting:",
        url
    );

    try {
        socket = new WebSocket(url);
    } catch (error) {
        console.error(
            "[Voice Bomb] WebSocket creation failed:",
            error
        );

        setConnectionStatus(
            "🔴 Connection failed",
            "bad"
        );

        return;
    }

    socket.onopen = () => {
        console.log(
            "[Voice Bomb] WebSocket connected"
        );

        connected = true;

        setConnectionStatus(
            "🟢 Connected",
            "good"
        );

        updateRoomDisplay();

        /*
            The current Worker doesn't need a join
            message. It creates the player as soon
            as the WebSocket connects.
        */

        showMessage(
            `Connected to room ${roomCode}.`,
            "good"
        );

        updateHostUI();
    };

    socket.onmessage = event => {
        handleSocketMessage(event.data);
    };

    socket.onerror = error => {
        console.error(
            "[Voice Bomb] WebSocket error:",
            error
        );

        setConnectionStatus(
            "🔴 Connection error",
            "bad"
        );
    };

    socket.onclose = event => {
        console.log(
            "[Voice Bomb] WebSocket closed:",
            event.code,
            event.reason
        );

        connected = false;

        setConnectionStatus(
            "🔴 Disconnected",
            "bad"
        );

        updateHostUI();

        if (!intentionalDisconnect) {
            scheduleReconnect();
        }
    };
}


/* =========================================================
   RECONNECT
========================================================= */

function scheduleReconnect() {
    clearTimeout(reconnectTimer);

    reconnectTimer =
        setTimeout(() => {
            if (
                roomCode &&
                !connected &&
                !intentionalDisconnect
            ) {
                console.log(
                    "[Voice Bomb] Attempting reconnect..."
                );

                connectToRoom();
            }
        }, 2000);
}


/* =========================================================
   DISCONNECT
========================================================= */

function disconnectRoom() {
    intentionalDisconnect = true;

    clearTimeout(reconnectTimer);

    if (socket) {
        try {
            socket.close();
        } catch {}
    }

    socket = null;
    connected = false;

    setConnectionStatus(
        "⚪ Disconnected",
        ""
    );
}


/* =========================================================
   SEND SOCKET MESSAGE
========================================================= */

function sendSocketMessage(data) {
    if (
        !socket ||
        socket.readyState !== WebSocket.OPEN
    ) {
        return false;
    }

    try {
        socket.send(
            JSON.stringify(data)
        );

        return true;
    } catch (error) {
        console.error(
            "[Voice Bomb] WebSocket send error:",
            error
        );

        return false;
    }
}


/* =========================================================
   SOCKET MESSAGE HANDLER
========================================================= */

function handleSocketMessage(raw) {
    console.log(
        "[Voice Bomb] Server message:",
        raw
    );

    let data;

    try {
        data =
            typeof raw === "string"
                ? JSON.parse(raw)
                : raw;
    } catch {
        console.warn(
            "Server sent invalid JSON:",
            raw
        );
        return;
    }

    if (!data) return;

    const type =
        String(
            data.type ||
            data.event ||
            ""
        ).toLowerCase();

    /*
        WORKER:
        welcome
    */

    if (type === "welcome") {
        connected = true;

        if (data.player?.id) {
            playerId =
                data.player.id;
        }

        if (data.player?.name) {
            playerName =
                data.player.name;
        }

        if (
            typeof data.isHost === "boolean"
        ) {
            isHost =
                data.isHost;
        }

        if (data.game) {
            applyWorkerGameState(
                data.game
            );
        }

        if (data.game?.players) {
            renderPlayers(
                data.game.players
            );
        }

        updateRoomDisplay();
        updateHostUI();

        return;
    }


    /*
        WORKER:
        playerJoined
    */

    if (type === "playerjoined") {
        showMessage(
            `👋 ${data.player?.name || "A new player"} joined!`,
            "good"
        );

        if (data.players) {
            renderPlayers(
                data.players
            );
        }

        updateRoomDisplay();

        return;
    }


    /*
        WORKER:
        playerLeft
    */

    if (type === "playerleft") {
        showMessage(
            "👋 A player left.",
            ""
        );

        if (data.players) {
            renderPlayers(
                data.players
            );
        }

        if (data.hostId) {
            isHost =
                data.hostId === playerId;
        }

        updateHostUI();
        updateRoomDisplay();

        return;
    }


    /*
        WORKER:
        becameHost
    */

    if (type === "becamehost") {
        isHost = true;

        showMessage(
            "👑 You are now the host!",
            "good"
        );

        updateHostUI();
        updateRoomDisplay();

        return;
    }


    /*
        WORKER:
        players
    */

    if (type === "players") {
        if (data.players) {
            renderPlayers(
                data.players
            );
        }

        return;
    }


    /*
        WORKER:
        gameStarted
    */

    if (type === "gamestarted") {
        if (data.game) {
            applyWorkerGameState(
                data.game
            );
        }

        return;
    }


    /*
        WORKER:
        chunkChanged
    */

    if (type === "chunkchanged") {
        if (data.chunk) {
            selectedChunk =
                String(data.chunk)
                    .toLowerCase();

            chunkDisplay.textContent =
                selectedChunk.toUpperCase();
        }

        return;
    }


    /*
        WORKER:
        wordAccepted
    */

    if (type === "wordaccepted") {
        if (
            data.word &&
            data.playerId !== playerId
        ) {
            addRemoteWord({
                word: data.word,
                playerId: data.playerId,
                points: data.points,
                game: data.game
            });
        }

        if (data.game) {
            applyWorkerGameState(
                data.game
            );
        }

        return;
    }


    /*
        WORKER:
        wordResult
    */

    if (type === "wordresult") {
        if (!data.success) {
            if (data.reason === "duplicate") {
                showMessage(
                    `"${String(data.word || "").toUpperCase()}" was already used!`,
                    "bad"
                );
            }

            if (data.reason === "missingchunk") {
                showMessage(
                    `"${String(data.word || "").toUpperCase()}" does not contain "${String(data.chunk || selectedChunk).toUpperCase()}".`,
                    "bad"
                );
            }
        }

        return;
    }


    /*
        WORKER:
        gameOver
    */

    if (type === "gameover") {
        applyRemoteExplosion(
            data.game || data
        );

        return;
    }


    /*
        WORKER:
        error
    */

    if (type === "error") {
        showMessage(
            `⚠️ ${data.error || "Server error."}`,
            "bad"
        );

        return;
    }


    /*
        Compatibility with older message names.
    */

    if (
        type === "player_joined" ||
        type === "join"
    ) {
        showMessage(
            `👋 ${data.name || data.player?.name || "A new player"} joined!`,
            "good"
        );

        if (data.players) {
            renderPlayers(data.players);
        }

        return;
    }

    if (
        type === "player_left" ||
        type === "leave"
    ) {
        if (data.players) {
            renderPlayers(data.players);
        }

        return;
    }

    if (
        type === "host_changed" ||
        type === "hostchange"
    ) {
        const host =
            data.playerId ||
            data.hostId;

        if (host) {
            isHost =
                host === playerId;
        }

        updateHostUI();

        return;
    }
}


/* =========================================================
   WORKER GAME STATE
========================================================= */

function applyWorkerGameState(game) {
    if (!game) return;

    currentRoomState = game;

    if (game.hostId) {
        isHost =
            game.hostId === playerId;
    }

    if (
        Array.isArray(game.players)
    ) {
        renderPlayers(
            game.players
        );
    }

    if (
        typeof game.chunk === "string" &&
        game.chunk
    ) {
        selectedChunk =
            game.chunk.toLowerCase();

        chunkDisplay.textContent =
            selectedChunk.toUpperCase();
    }

    if (
        typeof game.timeLeft === "number"
    ) {
        timeLeft =
            Math.max(
                0,
                Math.min(
                    TURN_TIME,
                    game.timeLeft
                )
            );

        updateTimer();
    }

    if (
        typeof game.started === "boolean"
    ) {
        gameOver =
            !game.started ||
            !!game.gameOver;
    }

    if (game.gameOver) {
        applyRemoteExplosion(game);
        return;
    }

    if (game.started) {
        gameOver = false;

        recordButton.disabled = false;

        startExistingTimer();
    }

    updateHostUI();
    updateRoomDisplay();
}


/* =========================================================
   RENDER PLAYERS
========================================================= */

function renderPlayers(players) {
    const display =
        document.getElementById(
            "playersDisplay"
        );

    if (!display) return;

    let list = [];

    if (Array.isArray(players)) {
        list = players;
    } else if (
        players &&
        typeof players === "object"
    ) {
        list =
            Object.values(players);
    }

    if (list.length === 0) {
        display.textContent =
            "👤 Just you";

        return;
    }

    display.innerHTML = "";

    list.forEach(player => {
        const div =
            document.createElement("div");

        const name =
            player.name ||
            player.username ||
            "Player";

        const id =
            player.id ||
            player.playerId;

        const host =
            id === currentRoomState?.hostId;

        div.textContent =
            `${host ? "👑 " : "👤 "}${name}`;

        display.appendChild(div);
    });
}


/* =========================================================
   ROOM DISPLAY
========================================================= */

function updateRoomDisplay() {
    const display =
        document.getElementById(
            "roomDisplay"
        );

    if (!display) return;

    if (!roomCode) {
        display.textContent = "";
        return;
    }

    display.textContent =
        `🏠 Room: ${roomCode}` +
        (isHost ? "  👑 HOST" : "");
}


/* =========================================================
   HOST UI
========================================================= */

function updateHostUI() {
    if (!newGameButton) return;

    /*
        Outside multiplayer:
        New Game works normally.
    */

    if (!roomCode) {
        newGameButton.disabled = false;
        newGameButton.title = "";
        return;
    }

    /*
        Inside multiplayer:
        ONLY host can use New Game.
    */

    newGameButton.disabled =
        !isHost;

    newGameButton.title =
        isHost
            ? "Host controls"
            : "Only the host can start a new game";
}


/* =========================================================
   RANDOM CHUNK
========================================================= */

function chooseChunk() {
    const useThreeLetters =
        Math.random() < 0.25;

    const list =
        useThreeLetters
            ? THREE_LETTER_CHUNKS
            : TWO_LETTER_CHUNKS;

    selectedChunk =
        list[
            Math.floor(
                Math.random() *
                list.length
            )
        ];

    chunkDisplay.textContent =
        selectedChunk.toUpperCase();
}


/* =========================================================
   TIMER
========================================================= */

function startTimer() {
    stopTimer();

    if (gameOver) return;

    timeLeft = TURN_TIME;

    updateTimer();

    timerInterval =
        setInterval(() => {
            if (
                gameOver ||
                processing
            ) {
                return;
            }

            timeLeft -= 0.1;

            if (timeLeft <= 0) {
                timeLeft = 0;

                updateTimer();

                explode();

                return;
            }

            updateTimer();
        }, 100);
}


function startExistingTimer() {
    stopTimer();

    if (gameOver) return;

    updateTimer();

    timerInterval =
        setInterval(() => {
            if (
                gameOver ||
                processing
            ) {
                return;
            }

            timeLeft -= 0.1;

            if (timeLeft <= 0) {
                timeLeft = 0;

                updateTimer();

                explode();

                return;
            }

            updateTimer();
        }, 100);
}


function stopTimer() {
    clearInterval(timerInterval);
    timerInterval = null;
}


function updateTimer() {
    if (!timerDisplay || !timerBar) {
        return;
    }

    timerDisplay.textContent =
        timeLeft.toFixed(1);

    const percentage =
        (timeLeft / TURN_TIME) * 100;

    timerBar.style.width =
        `${Math.max(0, percentage)}%`;

    if (timeLeft <= 5) {
        timerBar.classList.add("warning");

        if (bomb) {
            bomb.classList.add("warning");
        }
    } else {
        timerBar.classList.remove("warning");

        if (bomb) {
            bomb.classList.remove("warning");
        }
    }
}


/* =========================================================
   EXPLOSION
========================================================= */

function explode() {
    if (gameOver) return;

    stopTimer();

    gameOver = true;

    if (bomb) {
        bomb.classList.remove("warning");
        bomb.classList.add("explode");
    }

    resultText.textContent =
        "💥 BOOM!";

    resultText.className =
        "result bad";

    message.textContent =
        "Time ran out!";

    message.className =
        "message bad";

    recordButton.disabled = true;

    recordingStatus.textContent =
        "Game over.";

    streak = 0;

    updateStats();

    /*
        Only send game over through multiplayer
        if we're actually connected.
    */

    sendSocketMessage({
        type: "gameOver"
    });

    setTimeout(() => {
        if (bomb) {
            bomb.classList.remove("explode");
        }
    }, 600);
}


/* =========================================================
   RECORDING
========================================================= */

async function startRecording() {
    if (
        processing ||
        gameOver ||
        recording
    ) {
        return;
    }

    hideMessage();

    try {
        mediaStream =
            await navigator.mediaDevices.getUserMedia({
                audio: true
            });

        audioChunks = [];

        let mimeType = "audio/webm";

        if (
            MediaRecorder.isTypeSupported(
                "audio/webm;codecs=opus"
            )
        ) {
            mimeType =
                "audio/webm;codecs=opus";
        }

        mediaRecorder =
            new MediaRecorder(
                mediaStream,
                { mimeType }
            );

        mediaRecorder.ondataavailable =
            event => {
                if (event.data.size > 0) {
                    audioChunks.push(
                        event.data
                    );
                }
            };

        mediaRecorder.onstop =
            async () => {
                audioBlob =
                    new Blob(
                        audioChunks,
                        {
                            type: mimeType
                        }
                    );

                downloadButton.disabled =
                    false;

                await transcribeWord();

                cleanupStream();
            };

        mediaRecorder.start();

        recording = true;

        recordButton.classList.add(
            "speaking"
        );

        recordButton.textContent =
            "🟢 RELEASE TO SUBMIT";

        recordingStatus.textContent =
            "Listening... say ONE word!";

    } catch (error) {
        console.error(
            "Microphone error:",
            error
        );

        showMessage(
            "Microphone access failed.",
            "bad"
        );

        cleanupStream();
    }
}


function stopRecording() {
    if (!recording) return;

    recording = false;

    recordButton.classList.remove(
        "speaking"
    );

    recordButton.textContent =
        "🎤 HOLD TO SPEAK";

    recordingStatus.textContent =
        "🧠 Transcribing...";

    if (
        mediaRecorder &&
        mediaRecorder.state === "recording"
    ) {
        mediaRecorder.stop();
    }
}


/* =========================================================
   POINTER CONTROLS
========================================================= */

recordButton.addEventListener(
    "pointerdown",
    event => {
        event.preventDefault();

        try {
            recordButton.setPointerCapture(
                event.pointerId
            );
        } catch {}

        startRecording();
    }
);


recordButton.addEventListener(
    "pointerup",
    event => {
        event.preventDefault();

        stopRecording();
    }
);


recordButton.addEventListener(
    "pointercancel",
    () => {
        stopRecording();
    }
);


recordButton.addEventListener(
    "pointerleave",
    () => {
        if (recording) {
            stopRecording();
        }
    }
);


/* =========================================================
   SPACEBAR
========================================================= */

document.addEventListener(
    "keydown",
    event => {
        if (
            event.code === "Space" &&
            !event.repeat &&
            !event.target.matches(
                "input, textarea, button"
            )
        ) {
            event.preventDefault();

            startRecording();
        }
    }
);


document.addEventListener(
    "keyup",
    event => {
        if (event.code === "Space") {
            event.preventDefault();

            stopRecording();
        }
    }
);


/* =========================================================
   TRANSCRIPTION
========================================================= */

async function transcribeWord() {
    if (!audioBlob) {
        showMessage(
            "No recording was created.",
            "bad"
        );

        return;
    }

    processing = true;

    recordButton.disabled = true;

    /*
        Pause timer while transcription happens.
    */

    stopTimer();

    const formData =
        new FormData();

    formData.append(
        "file",
        audioBlob,
        "word.webm"
    );

    try {
        const response =
            await fetch(
                WORKER_URL,
                {
                    method: "POST",
                    body: formData
                }
            );

        const raw =
            await response.text();

        let result;

        try {
            result =
                JSON.parse(raw);
        } catch {
            throw new Error(
                "Worker returned invalid JSON."
            );
        }

        if (!response.ok) {
            throw new Error(
                result.error ||
                `Worker error ${response.status}`
            );
        }

        if (!result.success) {
            throw new Error(
                result.error ||
                "Transcription failed."
            );
        }

        const word =
            normalizeWord(
                result.text
            );

        transcript.textContent =
            word || "???";

        if (!word) {
            showMessage(
                "I couldn't understand a word.",
                "bad"
            );

            processing = false;

            recordButton.disabled =
                gameOver;

            if (!gameOver) {
                startExistingTimer();
            }

            return;
        }

        checkWord(word);

    } catch (error) {
        console.error(
            "Transcription error:",
            error
        );

        showMessage(
            "Transcription error: " +
            error.message,
            "bad"
        );

        recordingStatus.textContent =
            "Try again.";

        if (!gameOver) {
            startExistingTimer();
        }

    } finally {
        processing = false;

        recordButton.disabled =
            gameOver;
    }
}


/* =========================================================
   NORMALIZE WORD
========================================================= */

function normalizeWord(text) {
    if (
        !text ||
        typeof text !== "string"
    ) {
        return "";
    }

    const cleaned =
        text
            .toLowerCase()
            .replace(
                /[^a-z\s'-]/g,
                " "
            )
            .replace(
                /\s+/g,
                " "
            )
            .trim();

    if (!cleaned) {
        return "";
    }

    const words =
        cleaned.split(" ");

    const cleanedWords =
        words
            .map(word =>
                word.replace(
                    /^'+|'+$/g,
                    ""
                )
            )
            .filter(Boolean);

    if (
        cleanedWords.length === 0
    ) {
        return "";
    }

    /*
        Whisper sometimes returns extra words.
        Prefer the longest word containing
        the current chunk.
    */

    const matchingWords =
        cleanedWords.filter(
            word =>
                selectedChunk &&
                word.includes(
                    selectedChunk
                )
        );

    if (
        matchingWords.length > 0
    ) {
        matchingWords.sort(
            (a, b) =>
                b.length - a.length
        );

        return matchingWords[0];
    }

    return cleanedWords[0];
}


/* =========================================================
   CHECK WORD
========================================================= */

function checkWord(word) {
    const lower =
        word.toLowerCase();

    const hasChunk =
        lower.includes(
            selectedChunk
        );

    const alreadyUsed =
        usedWords.has(
            lower
        );

    if (alreadyUsed) {
        showMessage(
            `"${word.toUpperCase()}" was already used!`,
            "bad"
        );

        resultText.textContent =
            "🚫 Already used";

        resultText.className =
            "result bad";

        streak = 0;

        updateStats();

        recordingStatus.textContent =
            "Try another word.";

        startExistingTimer();

        return;
    }

    if (!hasChunk) {
        showMessage(
            `"${word.toUpperCase()}" does not contain "${selectedChunk.toUpperCase()}".`,
            "bad"
        );

        resultText.textContent =
            `❌ Missing "${selectedChunk.toUpperCase()}"`;

        resultText.className =
            "result bad";

        streak = 0;

        updateStats();

        recordingStatus.textContent =
            "Try again!";

        startExistingTimer();

        return;
    }

    /*
        VALID WORD
    */

    usedWords.add(lower);

    const points =
        10 +
        Math.min(
            streak * 2,
            20
        );

    score += points;
    streak++;

    updateStats();

    showMessage(
        `✅ ${word.toUpperCase()} works! +${points}`,
        "good"
    );

    resultText.textContent =
        `✅ Contains "${selectedChunk.toUpperCase()}"`;

    resultText.className =
        "result good";

    recordingStatus.textContent =
        "Nice! Next word...";

    renderUsedWords();

    /*
        Tell Worker.
    */

    sendSocketMessage({
        type: "word",
        word: lower
    });

    stopTimer();

    setTimeout(() => {
        if (!gameOver) {
            /*
                The host controls the next chunk.
            */

            if (isHost || !roomCode) {
                chooseChunk();

                sendSocketMessage({
                    type: "setChunk",
                    chunk: selectedChunk
                });
            }

            transcript.textContent =
                "—";

            resultText.textContent =
                "Say a word!";

            resultText.className =
                "result";

            startTimer();
        }
    }, 700);
}


/* =========================================================
   REMOTE WORD
========================================================= */

function addRemoteWord(data) {
    const word =
        String(
            data.word || ""
        )
        .toLowerCase()
        .trim();

    if (!word) return;

    usedWords.add(word);

    renderUsedWords();
    updateStats();

    showMessage(
        `👥 ${data.name || "Player"} used "${word.toUpperCase()}"`,
        "good"
    );
}


/* =========================================================
   REMOTE EXPLOSION
========================================================= */

function applyRemoteExplosion(data) {
    stopTimer();

    gameOver = true;

    if (bomb) {
        bomb.classList.add("explode");
    }

    resultText.textContent =
        "💥 BOOM!";

    resultText.className =
        "result bad";

    message.textContent =
        data?.name
            ? `💥 ${data.name} got the bomb!`
            : "💥 BOOM!";

    message.className =
        "message bad";

    recordButton.disabled = true;

    recordingStatus.textContent =
        "Game over.";

    setTimeout(() => {
        if (bomb) {
            bomb.classList.remove("explode");
        }
    }, 600);
}


/* =========================================================
   STATS
========================================================= */

function updateStats() {
    scoreDisplay.textContent =
        score;

    streakDisplay.textContent =
        streak;

    wordsUsedDisplay.textContent =
        usedWords.size;
}


/* =========================================================
   USED WORDS
========================================================= */

function renderUsedWords() {
    if (usedWords.size === 0) {
        usedWordsDisplay.textContent =
            "No words yet.";

        return;
    }

    usedWordsDisplay.innerHTML = "";

    [...usedWords]
        .reverse()
        .forEach(word => {
            const element =
                document.createElement(
                    "span"
                );

            element.className =
                "used-word";

            element.textContent =
                word;

            usedWordsDisplay.appendChild(
                element
            );
        });
}


/* =========================================================
   NEW GAME
========================================================= */

function newGame() {
    /*
        Multiplayer:
        ONLY HOST can start.
    */

    if (
        roomCode &&
        !isHost
    ) {
        showMessage(
            "🔒 Only the host can start a new game.",
            "bad"
        );

        return;
    }

    stopTimer();

    cleanupStream();

    gameOver = false;
    processing = false;
    recording = false;

    score = 0;
    streak = 0;

    timeLeft = TURN_TIME;

    usedWords.clear();

    audioBlob = null;
    audioChunks = [];

    downloadButton.disabled =
        true;

    recordButton.disabled =
        false;

    recordButton.classList.remove(
        "speaking"
    );

    recordButton.textContent =
        "🎤 HOLD TO SPEAK";

    recordingStatus.textContent =
        "Hold the button and say ONE word.";

    transcript.textContent =
        "—";

    resultText.textContent =
        "Say a word!";

    resultText.className =
        "result";

    message.textContent =
        "";

    message.className =
        "message";

    if (bomb) {
        bomb.classList.remove(
            "explode",
            "warning"
        );
    }

    chooseChunk();

    updateStats();

    renderUsedWords();

    updateTimer();

    /*
        In multiplayer, host tells the Worker
        to reset everyone.
    */

    if (
        roomCode &&
        isHost
    ) {
        sendSocketMessage({
            type: "newGame"
        });

        /*
            The Worker generates the official chunk.
            We temporarily show our local chunk,
            then the Worker state will update it.
        */
    }

    startTimer();
}


/* =========================================================
   NEW GAME BUTTON
========================================================= */

newGameButton.addEventListener(
    "click",
    () => {
        if (
            roomCode &&
            !isHost
        ) {
            showMessage(
                "🔒 Only the host can start a new game.",
                "bad"
            );

            return;
        }

        newGame();
    }
);


/* =========================================================
   COPY WORD
========================================================= */

copyButton.addEventListener(
    "click",
    async () => {
        const word =
            transcript.textContent.trim();

        if (
            !word ||
            word === "—" ||
            word === "???"
        ) {
            return;
        }

        try {
            await navigator.clipboard.writeText(
                word
            );

            copyButton.textContent =
                "✅ Copied!";

            setTimeout(() => {
                copyButton.textContent =
                    "📋 Copy Word";
            }, 1200);

        } catch {
            showMessage(
                "Couldn't copy the word.",
                "bad"
            );
        }
    }
);


/* =========================================================
   DOWNLOAD AUDIO
========================================================= */

downloadButton.addEventListener(
    "click",
    () => {
        if (!audioBlob) return;

        const url =
            URL.createObjectURL(
                audioBlob
            );

        const link =
            document.createElement("a");

        link.href = url;

        link.download =
            "word-bomb-word.webm";

        document.body.appendChild(
            link
        );

        link.click();

        link.remove();

        URL.revokeObjectURL(url);
    }
);


/* =========================================================
   MESSAGES
========================================================= */

function showMessage(
    text,
    type = ""
) {
    message.textContent =
        text;

    message.className =
        `message ${type}`;
}


function hideMessage() {
    message.textContent =
        "";

    message.className =
        "message";
}


/* =========================================================
   CLEANUP MICROPHONE
========================================================= */

function cleanupStream() {
    if (mediaStream) {
        mediaStream
            .getTracks()
            .forEach(track => {
                track.stop();
            });
    }

    mediaStream = null;
}


/* =========================================================
   PAGE CLEANUP
========================================================= */

window.addEventListener(
    "beforeunload",
    () => {
        intentionalDisconnect = true;

        cleanupStream();

        if (socket) {
            try {
                socket.close();
            } catch {}
        }
    }
);


/* =========================================================
   START
========================================================= */

createMultiplayerUI();

playerId =
    localStorage.getItem(
        "voiceBombPlayerId"
    ) || generatePlayerId();

localStorage.setItem(
    "voiceBombPlayerId",
    playerId
);

playerName =
    getPlayerName();

updateHostUI();

newGame();