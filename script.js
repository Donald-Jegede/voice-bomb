const WORKER_URL = "https://workerjs.donaldjegede29.workers.dev";
const TURN_TIME = 60;
const MIN_ROUNDS = 5;
const MAX_ROUNDS = 250;

/* =========================================================
   DOM
========================================================= */

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

const turnText = document.getElementById("turnText");

const createRoomButton =
    document.getElementById("createRoomButton");

const joinRoomButton =
    document.getElementById("joinRoomButton");

const roomInput =
    document.getElementById("roomInput");

const roomInfo =
    document.getElementById("roomInfo");

const roomCodeDisplay =
    document.getElementById("roomCode");

const copyRoomButton =
    document.getElementById("copyRoomButton");

const playersDisplay =
    document.getElementById("players");


/* =========================================================
   STATE
========================================================= */

let socket = null;

let roomCode = "";
let playerId = "";
let playerName = "";

let connected = false;
let isHost = false;

let intentionalDisconnect = false;
let reconnectTimer = null;

let mediaRecorder = null;
let mediaStream = null;
let audioChunks = [];
let audioBlob = null;

let recording = false;
let processing = false;

let gameStarted = false;
let gameOver = false;

let score = 0;
let streak = 0;

let selectedChunk = "";

let usedWords = new Set();

let currentRound = 0;
let totalRounds = 5;

let timeLeft = TURN_TIME;
let timerInterval = null;

let currentPlayers = [];

let lastSubmittedWord = "";

let roundTransitionTimer = null;


/* =========================================================
   CHUNKS
========================================================= */

const CHUNKS = [
    "ea",
    "er",
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
    "ou",
    "ow",
    "ai",
    "ay",
    "oa",
    "oi",
    "oy",
    "ar",
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
    "ne",
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


/* =========================================================
   PLAYER
========================================================= */

function generatePlayerId() {
    return (
        "p_" +
        crypto.randomUUID()
    );
}


function getPlayerName() {
    let name =
        localStorage.getItem(
            "voiceBombName"
        );

    if (!name) {
        name = "Player";

        localStorage.setItem(
            "voiceBombName",
            name
        );
    }

    return name;
}


/* =========================================================
   ROOM CODE
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
   CONNECTION URL
========================================================= */

function getWebSocketURL() {
    return (
        "wss://workerjs.donaldjegede29.workers.dev" +
        "/room/" +
        encodeURIComponent(roomCode) +
        "?player=" +
        encodeURIComponent(playerId) +
        "&name=" +
        encodeURIComponent(playerName)
    );
}


/* =========================================================
   CONNECTION STATUS
========================================================= */

function setConnectionStatus(
    text,
    type = ""
) {
    const element =
        document.getElementById(
            "connectionStatus"
        );

    if (!element) return;

    element.textContent = text;

    element.className =
        "connection-status";

    if (type) {
        element.classList.add(type);
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

    if (!code) {
        showMessage(
            "Enter a room code.",
            "bad"
        );

        return;
    }

    if (!/^[A-Z0-9]{4}$/.test(code)) {
        showMessage(
            "Room codes are 4 characters.",
            "bad"
        );

        return;
    }

    roomCode = code;

    isHost = false;

    connectToRoom();
}


/* =========================================================
   CONNECT
========================================================= */

function connectToRoom() {
    if (!roomCode) return;

    clearTimeout(reconnectTimer);

    intentionalDisconnect = false;

    if (socket) {
        try {
            socket.close();
        } catch {}
    }

    setConnectionStatus(
        "🟡 Connecting..."
    );

    const url =
        getWebSocketURL();

    console.log(
        "[Voice Bomb] Connecting to:",
        url
    );

    try {
        socket =
            new WebSocket(url);
    } catch (error) {
        console.error(
            "WebSocket creation error:",
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
            "[Voice Bomb] Connected!"
        );

        connected = true;

        setConnectionStatus(
            "🟢 Connected",
            "good"
        );

        showRoom();

        showMessage(
            `Connected to room ${roomCode}!`,
            "good"
        );

        sendSocketMessage({
            type: "join",
            room: roomCode,
            playerId,
            name: playerName,
            host: isHost
        });

        updateHostUI();

        if (recordButton) {
            recordButton.disabled =
                !gameStarted || gameOver;
        }
    };

    socket.onmessage = event => {
        handleSocketMessage(
            event.data
        );
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

        if (!intentionalDisconnect) {
            scheduleReconnect();
        }
    };
}


/* =========================================================
   RECONNECT
========================================================= */

function scheduleReconnect() {
    clearTimeout(
        reconnectTimer
    );

    reconnectTimer =
        setTimeout(() => {
            if (
                roomCode &&
                !connected &&
                !intentionalDisconnect
            ) {
                connectToRoom();
            }
        }, 2500);
}


/* =========================================================
   DISCONNECT
========================================================= */

function disconnectRoom() {
    intentionalDisconnect = true;

    clearTimeout(
        reconnectTimer
    );

    if (socket) {
        try {
            socket.close();
        } catch {}
    }

    socket = null;

    connected = false;
}


/* =========================================================
   SEND
========================================================= */

function sendSocketMessage(data) {
    if (
        !socket ||
        socket.readyState !==
            WebSocket.OPEN
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
            "WebSocket send failed:",
            error
        );

        return false;
    }
}


/* =========================================================
   SOCKET MESSAGES
========================================================= */

function handleSocketMessage(raw) {
    console.log(
        "[Voice Bomb] Server:",
        raw
    );

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

    if (!data) return;

    const type =
        String(
            data.type ||
            data.event ||
            ""
        ).toLowerCase();


    /* WELCOME */

    if (type === "welcome") {
        connected = true;

        if (data.player) {
            if (data.player.id) {
                playerId =
                    data.player.id;
            }

            if (data.player.name) {
                playerName =
                    data.player.name;
            }
        }

        if (
            typeof data.isHost ===
            "boolean"
        ) {
            isHost =
                data.isHost;
        }

        if (data.game) {
            applyServerGameState(
                data.game
            );
        }

        if (data.players) {
            currentPlayers =
                data.players;

            renderPlayers(
                currentPlayers
            );
        }

        updateHostUI();

        return;
    }


    /* NEW PLAYER */

    if (
        type === "playerjoined"
    ) {
        if (data.players) {
            currentPlayers =
                data.players;

            renderPlayers(
                currentPlayers
            );
        }

        const player =
            data.player;

        if (
            player &&
            player.id !== playerId
        ) {
            showMessage(
                `👋 ${player.name || "A new player"} joined!`,
                "good"
            );
        }

        return;
    }


    /* PLAYER LIST */

    if (type === "players") {
        currentPlayers =
            data.players || [];

        renderPlayers(
            currentPlayers
        );

        return;
    }


    /* PLAYER LEFT */

    if (type === "playerleft") {
        currentPlayers =
            data.players || [];

        renderPlayers(
            currentPlayers
        );

        return;
    }


    /* HOST CHANGED */

    if (type === "becamehost") {
        isHost = true;

        showMessage(
            "👑 You are now the host!",
            "good"
        );

        updateHostUI();

        return;
    }


    /* CHUNK */

    if (type === "chunkchanged") {
        if (data.chunk) {
            selectedChunk =
                normalizeChunk(
                    data.chunk
                );

            displayChunk();
        }

        return;
    }


    /* GAME STARTED */

    if (type === "gamestarted") {
        if (data.game) {
            applyServerGameState(
                data.game
            );
        }

        return;
    }


    /* WORD ACCEPTED */

    if (type === "wordaccepted") {
        handleRemoteWordAccepted(
            data
        );

        return;
    }


    /* WORD RESULT */

    if (type === "wordresult") {
        if (
            data.success === false
        ) {
            handleServerWordFailure(
                data
            );
        }

        return;
    }


    /* GAME OVER */

    if (type === "gameover") {
        if (data.game) {
            applyServerGameState(
                data.game
            );
        }

        endGame(
            "💥 BOOM!"
        );

        return;
    }


    /* ERROR */

    if (type === "error") {
        showMessage(
            data.error ||
            "Server error.",
            "bad"
        );

        return;
    }


    /* FALLBACK */

    if (data.game) {
        applyServerGameState(
            data.game
        );
    }

    if (data.players) {
        currentPlayers =
            data.players;

        renderPlayers(
            currentPlayers
        );
    }
}


/* =========================================================
   SERVER GAME STATE
========================================================= */

function applyServerGameState(game) {
    if (!game) return;

    if (
        typeof game.hostId ===
        "string"
    ) {
        isHost =
            game.hostId ===
            playerId;
    }

    if (
        Array.isArray(
            game.players
        )
    ) {
        currentPlayers =
            game.players;

        renderPlayers(
            currentPlayers
        );
    }

    if (
        typeof game.rounds ===
        "number"
    ) {
        totalRounds =
            clampRounds(
                game.rounds
            );
    }

    if (
        typeof game.currentRound ===
        "number"
    ) {
        currentRound =
            game.currentRound;
    }

    if (game.chunk) {
        selectedChunk =
            normalizeChunk(
                game.chunk
            );

        displayChunk();
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

        updateTimer();
    }

    if (
        typeof game.started ===
        "boolean"
    ) {
        gameStarted =
            game.started;
    }

    if (
        typeof game.gameOver ===
        "boolean"
    ) {
        gameOver =
            game.gameOver;
    }

    updateRoundDisplay();
    updateHostUI();

    if (gameStarted && !gameOver) {
        recordButton.disabled =
            false;

        startExistingTimer();
    } else {
        recordButton.disabled =
            true;

        stopTimer();
    }
}


/* =========================================================
   ROOM UI
========================================================= */

function showRoom() {
    if (roomInfo) {
        roomInfo.classList.remove(
            "hidden"
        );
    }

    if (roomCodeDisplay) {
        roomCodeDisplay.textContent =
            roomCode;
    }
}


function renderPlayers(players) {
    if (!playersDisplay) return;

    if (
        !Array.isArray(players) ||
        players.length === 0
    ) {
        playersDisplay.innerHTML =
            `<div class="player waiting">
                Waiting for players...
            </div>`;

        return;
    }

    playersDisplay.innerHTML = "";

    players.forEach(player => {
        const div =
            document.createElement(
                "div"
            );

        div.className =
            "player";

        const id =
            player.id ||
            player.playerId;

        const host =
            id === player.hostId ||
            player.host === true ||
            player.isHost === true;

        div.textContent =
            `${host ? "👑 " : "👤 "}${player.name || "Player"}`;

        playersDisplay.appendChild(
            div
        );
    });
}


/* =========================================================
   HOST UI
========================================================= */

function updateHostUI() {
    if (!newGameButton) return;

    if (!roomCode) {
        newGameButton.disabled =
            false;

        return;
    }

    newGameButton.disabled =
        !isHost;

    newGameButton.title =
        isHost
            ? "Host controls"
            : "Only the host can start a new game.";
}


/* =========================================================
   ROUND SETTINGS UI
========================================================= */

function createRoundControls() {
    if (!isHost) return;

    let existing =
        document.getElementById(
            "roundControls"
        );

    if (existing) return;

    const panel =
        document.querySelector(
            ".multiplayer-panel"
        );

    if (!panel) return;

    const controls =
        document.createElement(
            "div"
        );

    controls.id =
        "roundControls";

    controls.style.marginTop =
        "14px";

    controls.style.padding =
        "12px";

    controls.style.borderRadius =
        "12px";

    controls.style.background =
        "rgba(255,255,255,0.06)";

    controls.innerHTML = `
        <div style="font-weight:800;margin-bottom:8px;">
            👑 Host Settings
        </div>

        <label style="display:block;margin-bottom:6px;">
            Number of rounds:
        </label>

        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <input
                id="roundCountInput"
                type="number"
                min="5"
                max="250"
                value="${totalRounds}"
                style="
                    width:100px;
                    padding:9px;
                    border-radius:9px;
                    border:none;
                    outline:none;
                "
            >

            <span>
                rounds
            </span>
        </div>

        <small style="display:block;margin-top:6px;opacity:.7;">
            Minimum 5 • Maximum 250
        </small>
    `;

    panel.appendChild(
        controls
    );
}


function getRoundCount() {
    const input =
        document.getElementById(
            "roundCountInput"
        );

    if (!input) {
        return totalRounds;
    }

    let value =
        Number(input.value);

    if (!Number.isFinite(value)) {
        value = 5;
    }

    value =
        Math.round(value);

    value =
        clampRounds(value);

    input.value =
        value;

    return value;
}


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
   CHUNKS
========================================================= */

function chooseChunk() {
    let chunk;

    do {
        chunk =
            CHUNKS[
                Math.floor(
                    Math.random() *
                    CHUNKS.length
                )
            ];
    } while (
        CHUNKS.length > 1 &&
        chunk === selectedChunk
    );

    selectedChunk =
        chunk;

    displayChunk();
}


function normalizeChunk(chunk) {
    if (
        typeof chunk !==
        "string"
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


function displayChunk() {
    if (!chunkDisplay) return;

    chunkDisplay.textContent =
        selectedChunk
            ? selectedChunk.toUpperCase()
            : "--";
}


/* =========================================================
   ROUND DISPLAY
========================================================= */

function updateRoundDisplay() {
    if (!turnText) return;

    if (!roomCode) {
        turnText.textContent =
            "Create or join a room to play.";

        return;
    }

    if (!gameStarted) {
        turnText.textContent =
            isHost
                ? "Set the rounds and start the game."
                : "Waiting for the host to start...";
        return;
    }

    if (gameOver) {
        turnText.textContent =
            "Game over!";
        return;
    }

    turnText.textContent =
        `Round ${currentRound} / ${totalRounds}`;
}


/* =========================================================
   TIMER
========================================================= */

function startTimer() {
    stopTimer();

    if (
        !gameStarted ||
        gameOver
    ) {
        return;
    }

    timeLeft =
        TURN_TIME;

    updateTimer();

    startExistingTimer();
}


function startExistingTimer() {
    stopTimer();

    if (
        !gameStarted ||
        gameOver
    ) {
        return;
    }

    timerInterval =
        setInterval(() => {
            if (
                processing ||
                recording
            ) {
                return;
            }

            timeLeft -= 0.1;

            if (timeLeft <= 0) {
                timeLeft = 0;

                updateTimer();

                timeExpired();

                return;
            }

            updateTimer();
        }, 100);

    updateTimer();
}


function stopTimer() {
    if (timerInterval) {
        clearInterval(
            timerInterval
        );
    }

    timerInterval = null;
}


function updateTimer() {
    if (!timerDisplay) return;

    timerDisplay.textContent =
        timeLeft.toFixed(1);

    const percent =
        (timeLeft /
            TURN_TIME) *
        100;

    if (timerBar) {
        timerBar.style.width =
            `${Math.max(
                0,
                percent
            )}%`;
    }

    if (
        timeLeft <= 5
    ) {
        bomb?.classList.add(
            "warning"
        );

        timerBar?.classList.add(
            "warning"
        );
    } else {
        bomb?.classList.remove(
            "warning"
        );

        timerBar?.classList.remove(
            "warning"
        );
    }
}


/* =========================================================
   TIME EXPIRED
========================================================= */

function timeExpired() {
    if (
        gameOver ||
        !gameStarted
    ) {
        return;
    }

    stopTimer();

    endGame(
        "💥 BOOM! Time ran out!"
    );

    sendSocketMessage({
        type: "gameOver",
        playerId,
        name: playerName,
        reason: "timeout"
    });
}


/* =========================================================
   NEW GAME
========================================================= */

function newGame() {
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

    const rounds =
        getRoundCount();

    totalRounds =
        rounds;

    stopTimer();

    cleanupStream();

    clearTimeout(
        roundTransitionTimer
    );

    score = 0;
    streak = 0;

    currentRound = 1;

    timeLeft =
        TURN_TIME;

    gameStarted = true;
    gameOver = false;

    processing = false;
    recording = false;

    usedWords.clear();

    lastSubmittedWord = "";

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
        "🎤 SPEAK";

    recordingStatus.textContent =
        "Click SPEAK and say ONE word.";

    transcript.textContent =
        "—";

    resultText.textContent =
        "Say a word!";

    resultText.className =
        "result";

    hideMessage();

    bomb.classList.remove(
        "explode",
        "warning"
    );

    chooseChunk();

    updateStats();
    renderUsedWords();
    updateRoundDisplay();
    updateTimer();

    if (roomCode && isHost) {
        sendSocketMessage({
            type: "newGame",
            rounds: totalRounds,
            chunk: selectedChunk,
            currentRound: 1,
            timeLeft: TURN_TIME
        });
    }

    startTimer();
}


/* =========================================================
   ADVANCE ROUND
========================================================= */

function advanceRound() {
    if (gameOver) return;

    if (
        currentRound >=
        totalRounds
    ) {
        finishGame();

        return;
    }

    currentRound++;

    chooseChunk();

    transcript.textContent =
        "—";

    resultText.textContent =
        "Say a word!";

    resultText.className =
        "result";

    timeLeft =
        TURN_TIME;

    updateRoundDisplay();
    updateTimer();

    if (isHost) {
        sendSocketMessage({
            type: "round",
            currentRound,
            totalRounds,
            chunk: selectedChunk,
            timeLeft: TURN_TIME
        });
    }

    startTimer();
}


/* =========================================================
   FINISH GAME
========================================================= */

function finishGame() {
    stopTimer();

    gameStarted = false;
    gameOver = true;

    recordButton.disabled =
        true;

    turnText.textContent =
        "🏆 Game complete!";

    recordingStatus.textContent =
        "All rounds completed.";

    showMessage(
        `🏆 ${totalRounds} rounds complete!`,
        "good"
    );

    resultText.textContent =
        "🏆 GAME COMPLETE";

    resultText.className =
        "result good";

    if (isHost) {
        sendSocketMessage({
            type: "gameOver",
            reason: "roundsComplete"
        });
    }
}


/* =========================================================
   AUTOMATIC RECORDING
========================================================= */

async function startRecording() {
    if (
        processing ||
        recording ||
        !gameStarted ||
        gameOver
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
            "🔴 RECORDING...";

        recordingStatus.textContent =
            "🎤 Listening... say ONE word!";

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


/* =========================================================
   STOP RECORDING
========================================================= */

function stopRecording() {
    if (!recording) return;

    recording = false;

    recordButton.classList.remove(
        "speaking"
    );

    recordButton.textContent =
        "🧠 PROCESSING...";

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
   SPEAK BUTTON
========================================================= */

if (recordButton) {
    recordButton.disabled =
        true;

    recordButton.addEventListener(
        "click",
        () => {
            if (
                recording
            ) {
                stopRecording();
            } else {
                startRecording();
            }
        }
    );
}


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
                "No speech detected."
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
                "I couldn't understand that.",
                "bad"
            );

            return;
        }

        lastSubmittedWord =
            word;

        submitWord(word);

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

    } finally {
        processing = false;

        if (
            gameStarted &&
            !gameOver
        ) {
            recordButton.disabled =
                false;

            startExistingTimer();
        }
    }
}


/* =========================================================
   NORMALIZE WORD
========================================================= */

function normalizeWord(text) {
    if (
        typeof text !==
        "string"
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
                word
                    .replace(
                        /^'+|'+$/g,
                        ""
                    )
                    .trim()
            )
            .filter(Boolean);

    if (
        words.length === 0
    ) {
        return "";
    }

    const matching =
        words.filter(
            word =>
                word.includes(
                    selectedChunk
                )
        );

    if (
        matching.length > 0
    ) {
        matching.sort(
            (a, b) =>
                b.length -
                a.length
        );

        return matching[0];
    }

    return words[0];
}


/* =========================================================
   SUBMIT WORD
========================================================= */

function submitWord(word) {
    const lower =
        normalizeWord(word);

    if (!lower) return;

    if (
        usedWords.has(lower)
    ) {
        showWordFailure(
            "duplicate",
            lower
        );

        return;
    }

    if (
        !lower.includes(
            selectedChunk
        )
    ) {
        showWordFailure(
            "missingChunk",
            lower
        );

        return;
    }

    /*
       Multiplayer server gets the final
       authority over the word.
    */

    if (roomCode) {
        sendSocketMessage({
            type: "word",
            word: lower,
            playerId,
            name: playerName
        });

        /*
           Don't advance the round locally yet.
           The server confirms the word first.
        */

        stopTimer();

        return;
    }

    acceptLocalWord(
        lower
    );
}


/* =========================================================
   LOCAL WORD
========================================================= */

function acceptLocalWord(word) {
    if (
        usedWords.has(word)
    ) {
        showWordFailure(
            "duplicate",
            word
        );

        return;
    }

    if (
        !word.includes(
            selectedChunk
        )
    ) {
        showWordFailure(
            "missingChunk",
            word
        );

        return;
    }

    usedWords.add(
        word
    );

    const points =
        10 +
        Math.min(
            streak * 2,
            20
        );

    score +=
        points;

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
        "Nice! Next round...";

    stopTimer();

    roundTransitionTimer =
        setTimeout(
            advanceRound,
            700
        );
}


/* =========================================================
   REMOTE WORD ACCEPTED
========================================================= */

function handleRemoteWordAccepted(
    data
) {
    const word =
        normalizeWord(
            data.word
        );

    if (!word) return;

    usedWords.add(
        word
    );

    if (
        data.playerId ===
        playerId
    ) {
        if (
            typeof data.points ===
            "number"
        ) {
            score +=
                data.points;
        }

        streak++;

        updateStats();

        renderUsedWords();

        showMessage(
            `✅ ${word.toUpperCase()} works! +${data.points || 0}`,
            "good"
        );

        resultText.textContent =
            `✅ Contains "${selectedChunk.toUpperCase()}"`;

        resultText.className =
            "result good";

        recordingStatus.textContent =
            "Nice! Next round...";

        stopTimer();

        if (
            typeof data.currentRound ===
            "number"
        ) {
            currentRound =
                data.currentRound;
        }

        if (
            typeof data.totalRounds ===
            "number"
        ) {
            totalRounds =
                clampRounds(
                    data.totalRounds
                );
        }

        if (data.nextChunk) {
            selectedChunk =
                normalizeChunk(
                    data.nextChunk
                );

            displayChunk();
        }

        if (
            currentRound >=
            totalRounds
        ) {
            finishGame();
        } else {
            roundTransitionTimer =
                setTimeout(
                    () => {
                        if (
                            data.nextChunk
                        ) {
                            timeLeft =
                                TURN_TIME;

                            updateTimer();

                            updateRoundDisplay();

                            startTimer();
                        }
                    },
                    700
                );
        }

        return;
    }

    /*
       Another player successfully used
       a word.
    */

    showMessage(
        `👥 ${data.name || "Player"} used "${word.toUpperCase()}"`,
        "good"
    );

    renderUsedWords();

    if (
        data.nextChunk
    ) {
        selectedChunk =
            normalizeChunk(
                data.nextChunk
            );

        displayChunk();
    }

    if (
        typeof data.currentRound ===
        "number"
    ) {
        currentRound =
            data.currentRound;
    }

    updateRoundDisplay();
}


/* =========================================================
   SERVER WORD FAILURE
========================================================= */

function handleServerWordFailure(
    data
) {
    const word =
        normalizeWord(
            data.word ||
            lastSubmittedWord
        );

    showWordFailure(
        data.reason,
        word
    );

    startExistingTimer();
}


/* =========================================================
   WORD FAILURE
========================================================= */

function showWordFailure(
    reason,
    word
) {
    if (reason === "duplicate") {
        showMessage(
            `"${word.toUpperCase()}" was already used!`,
            "bad"
        );

        resultText.textContent =
            "🚫 Already used";
    } else {
        showMessage(
            `"${word.toUpperCase()}" does not contain "${selectedChunk.toUpperCase()}".`,
            "bad"
        );

        resultText.textContent =
            `❌ Missing "${selectedChunk.toUpperCase()}"`;
    }

    resultText.className =
        "result bad";

    streak = 0;

    updateStats();

    recordingStatus.textContent =
        "Try another word.";
}


/* =========================================================
   REMOTE GAME OVER
========================================================= */

function endGame(
    text = "💥 BOOM!"
) {
    stopTimer();

    gameStarted = false;
    gameOver = true;

    recordButton.disabled =
        true;

    bomb?.classList.remove(
        "warning"
    );

    bomb?.classList.add(
        "explode"
    );

    resultText.textContent =
        text;

    resultText.className =
        "result bad";

    recordingStatus.textContent =
        "Game over.";

    turnText.textContent =
        "Game over!";

    streak = 0;

    updateStats();

    setTimeout(() => {
        bomb?.classList.remove(
            "explode"
        );
    }, 600);
}


/* =========================================================
   STATS
========================================================= */

function updateStats() {
    if (scoreDisplay) {
        scoreDisplay.textContent =
            score;
    }

    if (streakDisplay) {
        streakDisplay.textContent =
            streak;
    }

    if (wordsUsedDisplay) {
        wordsUsedDisplay.textContent =
            usedWords.size;
    }
}


/* =========================================================
   USED WORDS
========================================================= */

function renderUsedWords() {
    if (!usedWordsDisplay) return;

    if (
        usedWords.size === 0
    ) {
        usedWordsDisplay.textContent =
            "No words yet.";

        return;
    }

    usedWordsDisplay.innerHTML =
        "";

    [
        ...usedWords
    ]
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
   COPY ROOM
========================================================= */

if (copyRoomButton) {
    copyRoomButton.addEventListener(
        "click",
        async () => {
            if (!roomCode) return;

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
                    "Couldn't copy room code.",
                    "bad"
                );
            }
        }
    );
}


/* =========================================================
   COPY WORD
========================================================= */

if (copyButton) {
    copyButton.addEventListener(
        "click",
        async () => {
            const word =
                transcript.textContent
                    .trim();

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
}


/* =========================================================
   DOWNLOAD AUDIO
========================================================= */

if (downloadButton) {
    downloadButton.addEventListener(
        "click",
        () => {
            if (!audioBlob) return;

            const url =
                URL.createObjectURL(
                    audioBlob
                );

            const link =
                document.createElement(
                    "a"
                );

            link.href =
                url;

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
}


/* =========================================================
   BUTTONS
========================================================= */

if (createRoomButton) {
    createRoomButton.addEventListener(
        "click",
        createRoom
    );
}


if (joinRoomButton) {
    joinRoomButton.addEventListener(
        "click",
        joinRoom
    );
}


if (roomInput) {
    roomInput.addEventListener(
        "keydown",
        event => {
            if (
                event.key ===
                "Enter"
            ) {
                joinRoom();
            }
        }
    );
}


if (newGameButton) {
    newGameButton.addEventListener(
        "click",
        newGame
    );
}


/* =========================================================
   MESSAGES
========================================================= */

function showMessage(
    text,
    type = ""
) {
    if (!message) return;

    message.textContent =
        text;

    message.className =
        `message ${type}`;
}


function hideMessage() {
    if (!message) return;

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
        intentionalDisconnect =
            true;

        cleanupStream();

        if (socket) {
            try {
                socket.close();
            } catch {}
        }
    }
);


/* =========================================================
   INITIALIZE
========================================================= */

playerId =
    localStorage.getItem(
        "voiceBombPlayerId"
    );

if (!playerId) {
    playerId =
        generatePlayerId();

    localStorage.setItem(
        "voiceBombPlayerId",
        playerId
    );
}

playerName =
    getPlayerName();

totalRounds =
    MIN_ROUNDS;

updateStats();
updateTimer();
displayChunk();
updateRoundDisplay();
updateHostUI();

console.log(
    "[Voice Bomb] script.js loaded."
);
