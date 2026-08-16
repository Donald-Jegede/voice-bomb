const WORKER_URL = "https://workerjs.donaldjegede29.workers.dev";
const WS_URL = WORKER_URL.replace(/^http/, "ws");

const TURN_TIME = 20;

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

const createRoomButton = document.getElementById("createRoomButton");
const joinRoomButton = document.getElementById("joinRoomButton");
const roomInput = document.getElementById("roomInput");
const roomInfo = document.getElementById("roomInfo");
const roomCodeDisplay = document.getElementById("roomCode");
const copyRoomButton = document.getElementById("copyRoomButton");
const playersDisplay = document.getElementById("players");
const connectionStatus = document.getElementById("connectionStatus");
const turnText = document.getElementById("turnText");

let socket = null;

let roomCode = "";
let playerId = "";
let playerName = "";

let isHost = false;
let connected = false;

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
let gameOver = true;

let reconnectTimer = null;
let intentionalDisconnect = false;

let currentPlayers = [];

let gameStartedAt = 0;
let timerOwner = false;


/* =========================================================
   PLAYER ID / NAME
========================================================= */

function generatePlayerId() {
    return crypto.randomUUID
        ? crypto.randomUUID()
        : "p_" +
          Math.random().toString(36).slice(2) +
          Date.now().toString(36);
}

function getPlayerId() {
    let id = localStorage.getItem("voiceBombPlayerId");

    if (!id) {
        id = generatePlayerId();

        localStorage.setItem(
            "voiceBombPlayerId",
            id
        );
    }

    return id;
}

function getPlayerName() {
    let name =
        localStorage.getItem("voiceBombName");

    if (!name) {
        name =
            "Player " +
            Math.floor(
                Math.random() * 900 + 100
            );

        localStorage.setItem(
            "voiceBombName",
            name
        );
    }

    return name;
}


/* =========================================================
   ROOM CODES
========================================================= */

function generateRoomCode() {
    const chars =
        "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    let code = "";

    for (let i = 0; i < 4; i++) {
        code +=
            chars[
                Math.floor(
                    Math.random() * chars.length
                )
            ];
    }

    return code;
}


/* =========================================================
   CONNECTION STATUS
========================================================= */

function setConnectionStatus(
    text,
    type = ""
) {
    connectionStatus.textContent = text;

    connectionStatus.classList.remove(
        "good",
        "bad"
    );

    if (type === "good") {
        connectionStatus.classList.add("good");
    }

    if (type === "bad") {
        connectionStatus.classList.add("bad");
    }
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

    roomCode =
        generateRoomCode();

    isHost = true;

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

    const code =
        roomInput.value
            .trim()
            .toUpperCase();

    if (!/^[A-Z0-9]{4}$/.test(code)) {
        showMessage(
            "Enter a valid 4-character room code.",
            "bad"
        );

        return;
    }

    roomCode = code;

    /*
        IMPORTANT:
        We do NOT decide host status here.
        The Durable Object decides who the host is.
    */

    isHost = false;

    connectToRoom();
}


/* =========================================================
   CONNECT
========================================================= */

function connectToRoom() {
    if (!roomCode) {
        return;
    }

    clearTimeout(reconnectTimer);

    intentionalDisconnect = false;

    if (socket) {
        try {
            socket.close();
        } catch {}
    }

    playerId =
        playerId || getPlayerId();

    playerName =
        playerName || getPlayerName();

    setConnectionStatus(
        "🟡 Connecting...",
        ""
    );

    /*
        THIS IS THE IMPORTANT FIX.

        Worker expects:

        /room?room=ABCD

        NOT:

        /room/ABCD
    */

    const url =
        `${WS_URL}/room?room=${encodeURIComponent(
            roomCode
        )}`;

    console.log(
        "[Voice Bomb] Connecting to:",
        url
    );

    try {
        socket =
            new WebSocket(url);
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

    socket.addEventListener(
        "open",
        () => {
            console.log(
                "[Voice Bomb] WebSocket connected"
            );

            connected = true;

            setConnectionStatus(
                "🟢 Connected",
                "good"
            );

            /*
                Tell the Worker our name.
            */

            sendSocketMessage({
                type: "setName",
                name: playerName
            });

            showRoom();

            updateHostUI();

            showMessage(
                `Connected to room ${roomCode}!`,
                "good"
            );
        }
    );

    socket.addEventListener(
        "message",
        event => {
            handleSocketMessage(
                event.data
            );
        }
    );

    socket.addEventListener(
        "error",
        error => {
            console.error(
                "[Voice Bomb] WebSocket error:",
                error
            );

            setConnectionStatus(
                "🔴 Connection error",
                "bad"
            );
        }
    );

    socket.addEventListener(
        "close",
        event => {
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

            /*
                Don't reconnect while the user is
                intentionally leaving.
            */

            if (
                !intentionalDisconnect &&
                roomCode
            ) {
                scheduleReconnect();
            }
        }
    );
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
                    "[Voice Bomb] Reconnecting..."
                );

                connectToRoom();
            }
        }, 2500);
}


/* =========================================================
   SEND SOCKET MESSAGE
========================================================= */

function sendSocketMessage(data) {
    if (
        !socket ||
        socket.readyState !== WebSocket.OPEN
    ) {
        console.warn(
            "[Voice Bomb] Tried to send while disconnected:",
            data
        );

        return false;
    }

    try {
        socket.send(
            JSON.stringify(data)
        );

        return true;
    } catch (error) {
        console.error(
            "[Voice Bomb] Send failed:",
            error
        );

        return false;
    }
}


/* =========================================================
   SOCKET MESSAGES
========================================================= */

function handleSocketMessage(raw) {
    let data;

    try {
        data =
            typeof raw === "string"
                ? JSON.parse(raw)
                : raw;
    } catch (error) {
        console.error(
            "Invalid server message:",
            raw
        );

        return;
    }

    if (!data || !data.type) {
        return;
    }

    console.log(
        "[Voice Bomb] Server:",
        data
    );

    switch (data.type) {
        case "welcome":
            handleWelcome(data);
            break;

        case "playerJoined":
            handlePlayerJoined(data);
            break;

        case "playerLeft":
            handlePlayerLeft(data);
            break;

        case "players":
            updatePlayers(
                data.players
            );
            break;

        case "becameHost":
            handleBecameHost();
            break;

        case "gameStarted":
            handleGameStarted(data);
            break;

        case "chunkChanged":
            handleChunkChanged(data);
            break;

        case "wordAccepted":
            handleWordAccepted(data);
            break;

        case "wordResult":
            handleWordResult(data);
            break;

        case "gameOver":
            handleGameOver(data);
            break;

        case "error":
            showMessage(
                data.error ||
                "Server error.",
                "bad"
            );
            break;

        default:
            console.log(
                "[Voice Bomb] Unknown message:",
                data.type
            );
    }
}


/* =========================================================
   WELCOME
========================================================= */

function handleWelcome(data) {
    connected = true;

    if (data.player) {
        playerId =
            data.player.id ||
            playerId;

        playerName =
            data.player.name ||
            playerName;
    }

    /*
        The Worker tells us the real host.
    */

    isHost =
        data.isHost === true;

    if (
        data.game &&
        data.game.hostId
    ) {
        isHost =
            data.game.hostId ===
            playerId;
    }

    showRoom();

    updateHostUI();

    if (data.game) {
        applyServerGame(
            data.game
        );
    }

    /*
        The Worker doesn't currently send the
        player list inside welcome, so use it
        if available.
    */

    if (data.game?.players) {
        updatePlayers(
            data.game.players
        );
    }

    turnText.textContent =
        isHost
            ? "👑 You are the host."
            : "Waiting for the host to start.";

    console.log(
        "[Voice Bomb] Welcome:",
        {
            playerId,
            playerName,
            isHost
        }
    );
}


/* =========================================================
   PLAYER JOINED
========================================================= */

function handlePlayerJoined(data) {
    updatePlayers(
        data.players || []
    );

    if (data.player) {
        showMessage(
            `👋 ${data.player.name} joined the room!`,
            "good"
        );
    }

    if (
        data.player &&
        data.player.id === playerId
    ) {
        return;
    }
}


/* =========================================================
   PLAYER LEFT
========================================================= */

function handlePlayerLeft(data) {
    updatePlayers(
        data.players || []
    );

    if (data.playerId) {
        showMessage(
            "👋 A player left the room.",
            ""
        );
    }

    if (
        data.hostId &&
        data.hostId === playerId
    ) {
        isHost = true;

        updateHostUI();

        showMessage(
            "👑 You are now the host!",
            "good"
        );
    }
}


/* =========================================================
   BECAME HOST
========================================================= */

function handleBecameHost() {
    isHost = true;

    updateHostUI();

    turnText.textContent =
        "👑 You are the host.";

    showMessage(
        "👑 You are now the host!",
        "good"
    );
}


/* =========================================================
   PLAYERS
========================================================= */

function updatePlayers(players) {
    if (!Array.isArray(players)) {
        return;
    }

    currentPlayers = players;

    playersDisplay.innerHTML = "";

    if (players.length === 0) {
        playersDisplay.innerHTML =
            `<div class="player waiting">
                Waiting for players...
            </div>`;

        return;
    }

    players.forEach(player => {
        const div =
            document.createElement("div");

        div.className =
            "player";

        const isCurrent =
            player.id === playerId;

        const isPlayerHost =
            player.id ===
            currentHostId();

        div.textContent =
            `${isPlayerHost ? "👑" : "👤"} ${
                player.name || "Player"
            }${
                isCurrent
                    ? " (You)"
                    : ""
            }`;

        playersDisplay.appendChild(
            div
        );
    });
}


function currentHostId() {
    /*
        We know our own host status, but the Worker
        doesn't always include hostId in player data.

        If we are host, our ID is the host ID.
    */

    if (isHost) {
        return playerId;
    }

    return null;
}


/* =========================================================
   ROOM UI
========================================================= */

function showRoom() {
    roomInfo.classList.remove(
        "hidden"
    );

    roomCodeDisplay.textContent =
        roomCode;

    createRoomButton.disabled =
        connected;

    joinRoomButton.disabled =
        connected;

    roomInput.disabled =
        connected;
}


function updateHostUI() {
    /*
        New Game is ONLY usable by host.
    */

    if (!roomCode) {
        newGameButton.disabled =
            true;

        return;
    }

    newGameButton.disabled =
        !isHost;

    newGameButton.title =
        isHost
            ? "Start a new game"
            : "Only the host can start a new game";
}


/* =========================================================
   COPY ROOM
========================================================= */

copyRoomButton.addEventListener(
    "click",
    async () => {
        if (!roomCode) {
            return;
        }

        try {
            await navigator.clipboard.writeText(
                roomCode
            );

            copyRoomButton.textContent =
                "✅ Copied!";

            setTimeout(() => {
                copyRoomButton.textContent =
                    "📋 Copy";
            }, 1200);
        } catch {
            showMessage(
                "Couldn't copy the room code.",
                "bad"
            );
        }
    }
);


/* =========================================================
   NEW GAME
========================================================= */

function newGame() {
    if (!connected) {
        showMessage(
            "Connect to a room first.",
            "bad"
        );

        return;
    }

    if (!isHost) {
        showMessage(
            "🔒 Only the host can start a new game.",
            "bad"
        );

        return;
    }

    /*
        IMPORTANT:
        The Worker creates the chunk.
        We do NOT generate it locally.
    */

    sendSocketMessage({
        type: "newGame"
    });
}


/* =========================================================
   GAME STARTED
========================================================= */

function handleGameStarted(data) {
    const game =
        data.game || {};

    stopTimer();

    gameOver = false;
    processing = false;

    usedWords.clear();

    score = 0;
    streak = 0;

    timeLeft =
        typeof game.timeLeft === "number"
            ? game.timeLeft
            : TURN_TIME;

    selectedChunk =
        game.chunk || "";

    if (selectedChunk) {
        chunkDisplay.textContent =
            selectedChunk.toUpperCase();
    }

    transcript.textContent =
        "—";

    resultText.textContent =
        "Say a word!";

    resultText.className =
        "result";

    recordingStatus.textContent =
        "Hold the button and say ONE word.";

    recordButton.disabled =
        false;

    bomb.classList.remove(
        "explode",
        "warning"
    );

    updateStats();
    renderUsedWords();
    updateTimer();

    turnText.textContent =
        isHost
            ? "👑 Game started! You're the host."
            : "🔥 Game started!";

    showMessage(
        "🔥 New game started!",
        "good"
    );

    startTimer();
}


/* =========================================================
   APPLY SERVER GAME
========================================================= */

function applyServerGame(game) {
    if (!game) {
        return;
    }

    if (game.hostId) {
        isHost =
            game.hostId ===
            playerId;

        updateHostUI();
    }

    if (game.chunk) {
        selectedChunk =
            game.chunk;

        chunkDisplay.textContent =
            selectedChunk.toUpperCase();
    }

    if (
        typeof game.timeLeft ===
        "number"
    ) {
        timeLeft =
            Math.max(
                0,
                Math.min(
                    TURN_TIME,
                    game.timeLeft
                )
            );
    }

    if (game.started) {
        gameOver = false;

        recordButton.disabled =
            false;

        updateTimer();
        startExistingTimer();
    } else {
        gameOver = true;

        stopTimer();

        recordButton.disabled =
            true;

        updateTimer();
    }
}


/* =========================================================
   CHUNK CHANGED
========================================================= */

function handleChunkChanged(data) {
    if (!data.chunk) {
        return;
    }

    selectedChunk =
        data.chunk
            .toLowerCase();

    chunkDisplay.textContent =
        selectedChunk.toUpperCase();

    timeLeft =
        TURN_TIME;

    gameOver = false;

    transcript.textContent =
        "—";

    resultText.textContent =
        "Say a word!";

    resultText.className =
        "result";

    updateTimer();

    startTimer();
}


/* =========================================================
   TIMER
========================================================= */

function startTimer() {
    stopTimer();

    if (gameOver) {
        return;
    }

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

    if (gameOver) {
        return;
    }

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
    if (timerInterval) {
        clearInterval(
            timerInterval
        );

        timerInterval = null;
    }
}


function updateTimer() {
    timerDisplay.textContent =
        timeLeft.toFixed(1);

    const percentage =
        (timeLeft / TURN_TIME) * 100;

    timerBar.style.width =
        `${Math.max(
            0,
            percentage
        )}%`;

    if (timeLeft <= 5) {
        timerBar.classList.add(
            "warning"
        );

        bomb.classList.add(
            "warning"
        );
    } else {
        timerBar.classList.remove(
            "warning"
        );

        bomb.classList.remove(
            "warning"
        );
    }
}


/* =========================================================
   EXPLODE
========================================================= */

function explode() {
    if (gameOver) {
        return;
    }

    stopTimer();

    gameOver = true;

    bomb.classList.remove(
        "warning"
    );

    bomb.classList.add(
        "explode"
    );

    resultText.textContent =
        "💥 BOOM!";

    resultText.className =
        "result bad";

    message.textContent =
        "Time ran out!";

    message.className =
        "message bad";

    recordButton.disabled =
        true;

    recordingStatus.textContent =
        "Game over.";

    streak = 0;

    updateStats();

    /*
        Tell the Worker.
        The Worker will broadcast gameOver.
    */

    sendSocketMessage({
        type: "gameOver"
    });

    setTimeout(() => {
        bomb.classList.remove(
            "explode"
        );
    }, 600);
}


/* =========================================================
   GAME OVER FROM SERVER
========================================================= */

function handleGameOver(data) {
    stopTimer();

    gameOver = true;

    recordButton.disabled =
        true;

    bomb.classList.remove(
        "warning"
    );

    bomb.classList.add(
        "explode"
    );

    resultText.textContent =
        "💥 BOOM!";

    resultText.className =
        "result bad";

    message.textContent =
        "💥 The bomb exploded!";

    message.className =
        "message bad";

    recordingStatus.textContent =
        "Game over.";

    turnText.textContent =
        isHost
            ? "👑 Start another game when ready."
            : "Waiting for the host to start again.";

    setTimeout(() => {
        bomb.classList.remove(
            "explode"
        );
    }, 600);
}


/* =========================================================
   RECORDING
========================================================= */

async function startRecording() {
    if (
        processing ||
        gameOver ||
        recording ||
        !connected
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

        let mimeType =
            "audio/webm";

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
                {
                    mimeType
                }
            );

        mediaRecorder.ondataavailable =
            event => {
                if (
                    event.data &&
                    event.data.size > 0
                ) {
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
    if (!recording) {
        return;
    }

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
        mediaRecorder.state ===
            "recording"
    ) {
        mediaRecorder.stop();
    }
}


/* =========================================================
   POINTER RECORDING
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
        if (
            event.code === "Space"
        ) {
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

    recordButton.disabled =
        true;

    /*
        Pause timer while Groq processes
        the recording.
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

            recordingStatus.textContent =
                "Try again.";

            startExistingTimer();

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
        cleaned
            .split(" ")
            .map(word =>
                word.replace(
                    /^'+|'+$/g,
                    ""
                )
            )
            .filter(Boolean);

    if (!words.length) {
        return "";
    }

    /*
        Whisper sometimes gives a short sentence
        instead of exactly one word.

        Prefer a word containing the chunk.
    */

    const matching =
        words.filter(word =>
            selectedChunk &&
            word.includes(
                selectedChunk
            )
        );

    if (matching.length) {
        matching.sort(
            (a, b) =>
                b.length - a.length
        );

        return matching[0];
    }

    return words[0];
}


/* =========================================================
   CHECK WORD
========================================================= */

function checkWord(word) {
    const lower =
        word.toLowerCase();

    if (
        usedWords.has(lower)
    ) {
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

    if (
        !selectedChunk ||
        !lower.includes(
            selectedChunk
        )
    ) {
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
        Valid word.
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

    renderUsedWords();

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

    /*
        Send the word to the Worker.

        The Worker is the authority on whether
        the word is valid.
    */

    sendSocketMessage({
        type: "word",
        word: lower
    });

    stopTimer();
}


/* =========================================================
   WORD ACCEPTED
========================================================= */

function handleWordAccepted(data) {
    if (!data.word) {
        return;
    }

    const word =
        String(data.word)
            .toLowerCase()
            .trim();

    usedWords.add(word);

    /*
        If this was another player,
        show their word.
    */

    if (
        data.playerId !== playerId
    ) {
        showMessage(
            `👥 Player used "${word.toUpperCase()}" +${data.points || 0}`,
            "good"
        );

        resultText.textContent =
            `👥 ${word.toUpperCase()}`;

        resultText.className =
            "result good";
    }

    /*
        Server score is authoritative for
        the player who submitted the word.
    */

    if (
        data.playerId === playerId
    ) {
        if (
            data.game?.score?.[playerId] !==
            undefined
        ) {
            score =
                data.game.score[playerId];
        } else if (
            typeof data.points === "number"
        ) {
            /*
                Don't double-add if the local
                score already includes it.
            */
        }

        if (
            data.game?.streak?.[playerId] !==
            undefined
        ) {
            streak =
                data.game.streak[playerId];
        }
    }

    renderUsedWords();
    updateStats();

    /*
        The host controls the next chunk.
    */

    if (isHost) {
        setTimeout(() => {
            if (!gameOver) {
                chooseAndSendNextChunk();
            }
        }, 500);
    }
}


/* =========================================================
   WORD RESULT
========================================================= */

function handleWordResult(data) {
    if (data.success) {
        return;
    }

    if (
        data.reason ===
        "duplicate"
    ) {
        showMessage(
            `"${String(data.word || "").toUpperCase()}" was already used!`,
            "bad"
        );

        resultText.textContent =
            "🚫 Already used";

        resultText.className =
            "result bad";

        streak = 0;

        updateStats();

        startExistingTimer();

        return;
    }

    if (
        data.reason ===
        "missingChunk"
    ) {
        showMessage(
            `"${String(data.word || "").toUpperCase()}" doesn't contain "${String(data.chunk || selectedChunk).toUpperCase()}".`,
            "bad"
        );

        resultText.textContent =
            "❌ Wrong word";

        resultText.className =
            "result bad";

        streak = 0;

        updateStats();

        startExistingTimer();
    }
}


/* =========================================================
   NEXT CHUNK
========================================================= */

function chooseAndSendNextChunk() {
    const useThree =
        Math.random() < 0.25;

    const two =
        [
            "st","tr","ch","sh","th","ph",
            "wh","bl","br","cl","cr","dr",
            "fl","fr","gl","gr","pl","pr",
            "sc","sk","sl","sm","sn","sp",
            "sw","tw","wr","ck","ng","nd",
            "nt","nk","mp","ll","ss","oo",
            "ee","ea","ou","ow","ai","ay",
            "oa","oi","oy","ar","er","ir",
            "or","ur","an","en","in","on",
            "un","at","et","it","ot","ut",
            "re","le","me","ne"
        ];

    const three =
        [
            "ing","and","the","ion","ere",
            "ate","ent","est","for","her",
            "his","not","are","was","all",
            "out","one","our","you","but",
            "can","had","has","new","too",
            "get","day","man","top","car",
            "dog","cat"
        ];

    const list =
        useThree
            ? three
            : two;

    const chunk =
        list[
            Math.floor(
                Math.random() *
                list.length
            )
        ];

    /*
        Worker accepts setChunk only from host.
    */

    sendSocketMessage({
        type: "setChunk",
        chunk
    });
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
    if (
        usedWords.size === 0
    ) {
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
        if (!audioBlob) {
            return;
        }

        const url =
            URL.createObjectURL(
                audioBlob
            );

        const link =
            document.createElement(
                "a"
            );

        link.href = url;

        link.download =
            "word-bomb-word.webm";

        document.body.appendChild(
            link
        );

        link.click();

        link.remove();

        URL.revokeObjectURL(
            url
        );
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
   MICROPHONE CLEANUP
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

        clearTimeout(
            reconnectTimer
        );

        stopTimer();

        cleanupStream();

        if (socket) {
            try {
                socket.close();
            } catch {}
        }
    }
);


/* =========================================================
   BUTTONS
========================================================= */

createRoomButton.addEventListener(
    "click",
    createRoom
);

joinRoomButton.addEventListener(
    "click",
    joinRoom
);

roomInput.addEventListener(
    "keydown",
    event => {
        if (event.key === "Enter") {
            joinRoom();
        }
    }
);

newGameButton.addEventListener(
    "click",
    newGame
);


/* =========================================================
   STARTUP
========================================================= */

playerId =
    getPlayerId();

playerName =
    getPlayerName();

newGameButton.disabled =
    true;

recordButton.disabled =
    true;

downloadButton.disabled =
    true;

timerDisplay.textContent =
    TURN_TIME.toFixed(1);

timerBar.style.width =
    "100%";

setConnectionStatus(
    "🟡 Not connected"
);

console.log(
    "[Voice Bomb] Ready.",
    {
        playerId,
        playerName,
        worker: WORKER_URL
    }
);
