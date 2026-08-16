const WORKER_URL = "https://workerjs.donaldjegede29.workers.dev";

const TURN_TIME = 20;
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

const createRoomButton = document.getElementById("createRoomButton");
const joinRoomButton = document.getElementById("joinRoomButton");
const roomInput = document.getElementById("roomInput");
const roomInfo = document.getElementById("roomInfo");
const roomCodeDisplay = document.getElementById("roomCode");
const copyRoomButton = document.getElementById("copyRoomButton");
const playersDisplay = document.getElementById("players");
const connectionStatus = document.getElementById("connectionStatus");

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

let gameStarted = false;
let gameOver = false;

let currentRound = 0;
let totalRounds = MIN_ROUNDS;
let selectedChunk = "";

let score = 0;
let streak = 0;

let usedWords = new Set();

let timeLeft = TURN_TIME;
let timerInterval = null;

let currentPlayers = [];

let mediaRecorder = null;
let mediaStream = null;
let audioChunks = [];
let audioBlob = null;

let recording = false;
let processing = false;

let automaticRecording = false;
let recordingRound = 0;

let lastSubmittedWord = "";
let lastServerWord = "";

let reconnectAttempts = 0;

/* =========================================================
   CHUNKS
========================================================= */

const CHUNKS = [
    "ea","er","st","tr","ch","sh","th","ph","wh",
    "bl","br","cl","cr","dr","fl","fr","gl","gr",
    "pl","pr","sc","sk","sl","sm","sn","sp","sw",
    "tw","wr","ck","ng","nd","nt","nk","mp","ll",
    "ss","oo","ee","ou","ow","ai","ay","oa","oi",
    "oy","ar","ir","or","ur","an","en","in","on",
    "un","at","et","it","ot","ut","re","le","me",
    "ne","ing","and","the","ion","ere","ate","ent",
    "est","for","her","his","not","are","was","all",
    "out","one","our","you","but","can","had","has",
    "new","too","get","day","man","top","car","dog",
    "cat"
];

/* =========================================================
   HELPERS
========================================================= */

function clampRounds(value) {
    value = Number(value);

    if (!Number.isFinite(value)) {
        value = MIN_ROUNDS;
    }

    return Math.max(
        MIN_ROUNDS,
        Math.min(
            MAX_ROUNDS,
            Math.round(value)
        )
    );
}

function normalizeChunk(chunk) {
    if (typeof chunk !== "string") {
        return "";
    }

    return chunk
        .toLowerCase()
        .replace(/[^a-z]/g, "")
        .slice(0, 3);
}

function normalizeWord(text) {
    if (typeof text !== "string") {
        return "";
    }

    const cleaned = text
        .toLowerCase()
        .replace(/[^a-z\s'-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    if (!cleaned) {
        return "";
    }

    const words = cleaned
        .split(" ")
        .map(word =>
            word
                .replace(/^'+|'+$/g, "")
                .trim()
        )
        .filter(Boolean);

    if (!words.length) {
        return "";
    }

    if (selectedChunk) {
        const matching = words.filter(word =>
            word.includes(selectedChunk)
        );

        if (matching.length) {
            matching.sort(
                (a, b) => b.length - a.length
            );

            return matching[0];
        }
    }

    return words[0];
}

function generatePlayerId() {
    if (crypto && crypto.randomUUID) {
        return "p_" + crypto.randomUUID();
    }

    return "p_" +
        Date.now() +
        "_" +
        Math.random()
            .toString(36)
            .slice(2);
}

function getPlayerName() {
    let name = localStorage.getItem(
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

function generateRoomCode() {
    const chars =
        "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    let code = "";

    for (let i = 0; i < 4; i++) {
        code += chars[
            Math.floor(
                Math.random() * chars.length
            )
        ];
    }

    return code;
}

/* =========================================================
   UI
========================================================= */

function showMessage(text, type = "") {
    if (!message) return;

    message.textContent = text;
    message.className = `message ${type}`;
}

function hideMessage() {
    if (!message) return;

    message.textContent = "";
    message.className = "message";
}

function setConnectionStatus(text, type = "") {
    if (!connectionStatus) return;

    connectionStatus.textContent = text;
    connectionStatus.className =
        "connection-status";

    if (type) {
        connectionStatus.classList.add(type);
    }
}

function updateStats() {
    if (scoreDisplay) {
        scoreDisplay.textContent = score;
    }

    if (streakDisplay) {
        streakDisplay.textContent = streak;
    }

    if (wordsUsedDisplay) {
        wordsUsedDisplay.textContent =
            usedWords.size;
    }
}

function displayChunk() {
    if (!chunkDisplay) return;

    chunkDisplay.textContent =
        selectedChunk
            ? selectedChunk.toUpperCase()
            : "--";
}

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
            "🏆 Game over!";
        return;
    }

    turnText.textContent =
        `Round ${currentRound} / ${totalRounds}`;
}

function renderPlayers(players) {
    if (!playersDisplay) return;

    if (!Array.isArray(players) || !players.length) {
        playersDisplay.innerHTML =
            `<div class="player waiting">
                Waiting for players...
            </div>`;
        return;
    }

    playersDisplay.innerHTML = "";

    players.forEach(player => {
        const element =
            document.createElement("div");

        element.className = "player";

        const id =
            player.id ||
            player.playerId;

        const host =
            player.host === true ||
            player.isHost === true ||
            id === player.hostId;

        element.textContent =
            `${host ? "👑" : "👤"} ${player.name || "Player"}`;

        playersDisplay.appendChild(element);
    });
}

function showRoom() {
    if (roomInfo) {
        roomInfo.classList.remove("hidden");
    }

    if (roomCodeDisplay) {
        roomCodeDisplay.textContent =
            roomCode;
    }
}

function updateHostUI() {
    if (!newGameButton) return;

    if (!roomCode) {
        newGameButton.disabled = false;
        return;
    }

    newGameButton.disabled = !isHost;

    newGameButton.title =
        isHost
            ? "Start the game"
            : "Only the host can start the game.";
}

/* =========================================================
   HOST ROUND CONTROL
========================================================= */

function createRoundControls() {
    if (!isHost) return;

    if (
        document.getElementById(
            "roundControls"
        )
    ) {
        return;
    }

    const panel =
        document.querySelector(
            ".multiplayer-panel"
        );

    if (!panel) return;

    const controls =
        document.createElement("div");

    controls.id = "roundControls";

    controls.style.cssText = `
        margin-top:14px;
        padding:12px;
        border-radius:12px;
        background:rgba(255,255,255,0.06);
    `;

    controls.innerHTML = `
        <div style="font-weight:800;margin-bottom:8px;">
            👑 Host Settings
        </div>

        <label
            for="roundCountInput"
            style="display:block;margin-bottom:6px;"
        >
            Number of rounds:
        </label>

        <div
            style="
                display:flex;
                gap:8px;
                align-items:center;
                flex-wrap:wrap;
            "
        >
            <input
                id="roundCountInput"
                type="number"
                min="${MIN_ROUNDS}"
                max="${MAX_ROUNDS}"
                value="${totalRounds}"
                style="
                    width:100px;
                    padding:9px;
                    border-radius:9px;
                    border:none;
                    outline:none;
                "
            >

            <span>rounds</span>
        </div>

        <small
            style="
                display:block;
                margin-top:6px;
                opacity:.7;
            "
        >
            Minimum ${MIN_ROUNDS} • Maximum ${MAX_ROUNDS}
        </small>
    `;

    panel.appendChild(controls);
}

function getRoundCount() {
    const input =
        document.getElementById(
            "roundCountInput"
        );

    if (!input) {
        return clampRounds(totalRounds);
    }

    const value =
        clampRounds(input.value);

    input.value = value;

    return value;
}

/* =========================================================
   WEBSOCKET
========================================================= */

function getWebSocketURL() {
    return (
        WORKER_URL
            .replace(/^https:/, "wss:")
            .replace(/^http:/, "ws:") +
        "/room/" +
        encodeURIComponent(roomCode) +
        "?player=" +
        encodeURIComponent(playerId) +
        "&name=" +
        encodeURIComponent(playerName)
    );
}

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
            "[Voice Bomb] Send failed:",
            error
        );

        return false;
    }
}

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

    const url = getWebSocketURL();

    console.log(
        "[Voice Bomb] Connecting:",
        url
    );

    try {
        socket =
            new WebSocket(url);
    } catch (error) {
        console.error(error);

        setConnectionStatus(
            "🔴 Connection failed",
            "bad"
        );

        scheduleReconnect();
        return;
    }

    socket.onopen = () => {
        connected = true;
        reconnectAttempts = 0;

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
        createRoundControls();

        updateRoundDisplay();

        if (
            gameStarted &&
            !gameOver
        ) {
            beginAutomaticRecording();
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
        connected = false;

        console.log(
            "[Voice Bomb] WebSocket closed:",
            event.code,
            event.reason
        );

        setConnectionStatus(
            "🔴 Disconnected",
            "bad"
        );

        if (!intentionalDisconnect) {
            scheduleReconnect();
        }
    };
}

function scheduleReconnect() {
    clearTimeout(reconnectTimer);

    reconnectAttempts++;

    const delay =
        Math.min(
            10000,
            1500 *
            reconnectAttempts
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
        }, delay);
}

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
}

/* =========================================================
   SERVER MESSAGES
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
    } catch {
        console.error(
            "[Voice Bomb] Invalid JSON:",
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

    switch (type) {
        case "welcome":
            handleWelcome(data);
            break;

        case "playerjoined":
            handlePlayers(data);
            if (data.player) {
                showMessage(
                    `👋 ${data.player.name || "A player"} joined!`,
                    "good"
                );
            }
            break;

        case "players":
        case "playerleft":
            handlePlayers(data);
            break;

        case "becamehost":
            isHost = true;
            createRoundControls();
            updateHostUI();

            showMessage(
                "👑 You are now the host!",
                "good"
            );
            break;

        case "gamestarted":
            applyGameState(
                data.game || data
            );
            startGameFromServer(
                data.game || data
            );
            break;

        case "round":
        case "roundchanged":
        case "roundstarted":
            applyGameState(
                data.game || data
            );
            handleNewServerRound(
                data.game || data
            );
            break;

        case "chunkchanged":
            if (data.chunk) {
                selectedChunk =
                    normalizeChunk(
                        data.chunk
                    );
                displayChunk();
            }
            break;

        case "wordaccepted":
            handleWordAccepted(data);
            break;

        case "wordresult":
            if (data.success === false) {
                handleWordFailureFromServer(
                    data
                );
            }
            break;

        case "gameover":
            if (data.game) {
                applyGameState(data.game);
            }

            finishGame(
                data.reason === "timeout"
                    ? "💥 BOOM! Time ran out!"
                    : "🏆 GAME COMPLETE!"
            );
            break;

        case "error":
            showMessage(
                data.error ||
                "Server error.",
                "bad"
            );
            break;

        default:
            if (data.game) {
                applyGameState(data.game);
            }

            if (data.players) {
                handlePlayers(data);
            }
            break;
    }
}

function handleWelcome(data) {
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

    if (data.players) {
        currentPlayers =
            data.players;

        renderPlayers(
            currentPlayers
        );
    }

    if (data.game) {
        applyGameState(
            data.game
        );
    }

    showRoom();
    createRoundControls();
    updateHostUI();
}

function handlePlayers(data) {
    currentPlayers =
        Array.isArray(data.players)
            ? data.players
            : [];

    renderPlayers(
        currentPlayers
    );
}

function applyGameState(game) {
    if (!game) return;

    if (
        typeof game.hostId ===
        "string"
    ) {
        isHost =
            game.hostId ===
            playerId;
    }

    if (Array.isArray(game.players)) {
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
        typeof game.totalRounds ===
        "number"
    ) {
        totalRounds =
            clampRounds(
                game.totalRounds
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

    if (
        gameStarted &&
        !gameOver
    ) {
        startServerTimer();

        beginAutomaticRecording();
    } else {
        stopTimer();
        stopRecording(false);
    }
}

/* =========================================================
   SERVER GAME EVENTS
========================================================= */

function startGameFromServer(game) {
    gameStarted = true;
    gameOver = false;

    score = 0;
    streak = 0;

    usedWords.clear();

    currentRound =
        Number(
            game?.currentRound ||
            1
        );

    totalRounds =
        clampRounds(
            game?.rounds ||
            game?.totalRounds ||
            totalRounds
        );

    if (game?.chunk) {
        selectedChunk =
            normalizeChunk(
                game.chunk
            );
    }

    timeLeft =
        typeof game?.timeLeft === "number"
            ? game.timeLeft
            : TURN_TIME;

    updateStats();
    renderUsedWords();
    displayChunk();
    updateRoundDisplay();
    updateTimer();

    bomb?.classList.remove(
        "explode"
    );

    resultText.textContent =
        "Say a word!";

    resultText.className =
        "result";

    recordingStatus.textContent =
        "🎤 Listening...";

    startServerTimer();
    beginAutomaticRecording();
}

function handleNewServerRound(game) {
    if (!gameStarted || gameOver) {
        return;
    }

    if (game?.chunk) {
        selectedChunk =
            normalizeChunk(
                game.chunk
            );
    }

    if (
        typeof game?.currentRound ===
        "number"
    ) {
        currentRound =
            game.currentRound;
    }

    totalRounds =
        clampRounds(
            game?.rounds ||
            game?.totalRounds ||
            totalRounds
        );

    timeLeft =
        typeof game?.timeLeft === "number"
            ? game.timeLeft
            : TURN_TIME;

    transcript.textContent = "—";

    resultText.textContent =
        "Say a word!";

    resultText.className =
        "result";

    displayChunk();
    updateRoundDisplay();
    updateTimer();

    recordingRound =
        currentRound;

    startServerTimer();
    beginAutomaticRecording();
}

/* =========================================================
   TIMER
========================================================= */

function startServerTimer() {
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

                handleLocalTimeout();
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
    if (timerDisplay) {
        timerDisplay.textContent =
            Math.max(
                0,
                timeLeft
            ).toFixed(1);
    }

    const percent =
        (timeLeft /
            TURN_TIME) *
        100;

    if (timerBar) {
        timerBar.style.width =
            `${Math.max(
                0,
                Math.min(
                    100,
                    percent
                )
            )}%`;
    }

    if (timeLeft <= 5) {
        bomb?.classList.add("warning");
        timerBar?.classList.add("warning");
    } else {
        bomb?.classList.remove("warning");
        timerBar?.classList.remove("warning");
    }
}

function handleLocalTimeout() {
    if (
        gameOver ||
        !gameStarted
    ) {
        return;
    }

    stopTimer();
    stopRecording(false);

    if (isHost) {
        sendSocketMessage({
            type: "gameOver",
            reason: "timeout"
        });
    }

    finishGame(
        "💥 BOOM! Time ran out!"
    );
}

/* =========================================================
   START GAME
========================================================= */

function newGame() {
    if (
        roomCode &&
        !isHost
    ) {
        showMessage(
            "🔒 Only the host can start the game.",
            "bad"
        );
        return;
    }

    if (!roomCode) {
        showMessage(
            "Create a room first.",
            "bad"
        );
        return;
    }

    if (!connected) {
        showMessage(
            "Not connected to the room.",
            "bad"
        );
        return;
    }

    const rounds =
        getRoundCount();

    totalRounds =
        rounds;

    sendSocketMessage({
        type: "newGame",
        rounds,
        totalRounds: rounds
    });

    showMessage(
        `🎮 Starting ${rounds} rounds...`,
        "good"
    );
}

/* =========================================================
   AUTOMATIC MICROPHONE
========================================================= */

async function requestMicrophone() {
    if (mediaStream) {
        return true;
    }

    if (
        !navigator.mediaDevices ||
        !navigator.mediaDevices.getUserMedia
    ) {
        showMessage(
            "🎤 Your browser does not support microphone access.",
            "bad"
        );

        return false;
    }

    try {
        mediaStream =
            await navigator.mediaDevices.getUserMedia({
                audio: true
            });

        return true;
    } catch (error) {
        console.error(
            "[Voice Bomb] Microphone permission:",
            error
        );

        showMessage(
            "🎤 Microphone permission is needed to play.",
            "bad"
        );

        recordingStatus.textContent =
            "Allow microphone access, then try again.";

        return false;
    }
}

async function beginAutomaticRecording() {
    if (
        !gameStarted ||
        gameOver ||
        processing ||
        recording
    ) {
        return;
    }

    if (
        recordingRound ===
        currentRound
    ) {
        return;
    }

    recordingRound =
        currentRound;

    const microphoneReady =
        await requestMicrophone();

    if (
        !microphoneReady ||
        !gameStarted ||
        gameOver
    ) {
        return;
    }

    startRecording();
}

function startRecording() {
    if (
        recording ||
        processing ||
        !gameStarted ||
        gameOver
    ) {
        return;
    }

    if (!mediaStream) {
        return;
    }

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

    try {
        mediaRecorder =
            new MediaRecorder(
                mediaStream,
                { mimeType }
            );
    } catch (error) {
        console.error(error);

        showMessage(
            "Could not start recording.",
            "bad"
        );

        return;
    }

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
            if (!audioChunks.length) {
                processing = false;
                return;
            }

            audioBlob =
                new Blob(
                    audioChunks,
                    {
                        type: mimeType
                    }
                );

            if (downloadButton) {
                downloadButton.disabled =
                    false;
            }

            await transcribeWord();
        };

    mediaRecorder.start();

    recording = true;
    automaticRecording = true;

    recordButton.disabled = false;
    recordButton.classList.add(
        "speaking"
    );

    recordButton.textContent =
        "🔴 LISTENING...";

    recordingStatus.textContent =
        "🎤 Listening... say ONE word!";
}

function stopRecording(process = true) {
    if (!recording) {
        return;
    }

    recording = false;

    recordButton.classList.remove(
        "speaking"
    );

    recordButton.textContent =
        process
            ? "🧠 PROCESSING..."
            : "🎤 LISTENING...";

    if (mediaRecorder) {
        if (
            mediaRecorder.state ===
            "recording"
        ) {
            if (process) {
                processing = true;
            }

            mediaRecorder.stop();
        }
    }
}

/* =========================================================
   AUTOMATIC RECORDING CONTROL
========================================================= */

function stopRecordingForRoundChange() {
    if (
        mediaRecorder &&
        mediaRecorder.state ===
        "recording"
    ) {
        try {
            mediaRecorder.stop();
        } catch {}
    }

    recording = false;
    processing = false;

    audioChunks = [];
}

/* =========================================================
   TRANSCRIPTION
========================================================= */

async function transcribeWord() {
    if (!audioBlob) {
        processing = false;
        return;
    }

    processing = true;

    recordButton.disabled = true;

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

        let data;

        try {
            data =
                JSON.parse(raw);
        } catch {
            throw new Error(
                "Speech server returned invalid JSON."
            );
        }

        if (!response.ok) {
            throw new Error(
                data.error ||
                `Speech server error ${response.status}`
            );
        }

        if (!data.success) {
            throw new Error(
                data.error ||
                "No speech detected."
            );
        }

        const word =
            normalizeWord(
                data.text
            );

        transcript.textContent =
            word || "???";

        if (!word) {
            showWordFailure(
                "speech",
                ""
            );
            return;
        }

        lastSubmittedWord =
            word;

        submitWord(
            word
        );

    } catch (error) {
        console.error(
            "[Voice Bomb] Transcription:",
            error
        );

        showMessage(
            "🎤 " +
            error.message,
            "bad"
        );

        recordingStatus.textContent =
            "Try again.";

        recordingRound = 0;

    } finally {
        processing = false;

        if (
            gameStarted &&
            !gameOver
        ) {
            recordButton.disabled =
                false;
        }
    }
}

/* =========================================================
   WORD SUBMISSION
========================================================= */

function submitWord(word) {
    word =
        normalizeWord(word);

    if (!word) {
        return;
    }

    if (usedWords.has(word)) {
        showWordFailure(
            "duplicate",
            word
        );
        recordingRound = 0;
        return;
    }

    if (
        !selectedChunk ||
        !word.includes(
            selectedChunk
        )
    ) {
        showWordFailure(
            "missingChunk",
            word
        );
        recordingRound = 0;
        return;
    }

    if (!connected) {
        showMessage(
            "Disconnected from the room.",
            "bad"
        );

        recordingRound = 0;
        return;
    }

    sendSocketMessage({
        type: "word",
        word,
        playerId,
        name: playerName,
        round: currentRound
    });

    recordingStatus.textContent =
        "⏳ Checking word...";
}

/* =========================================================
   WORD ACCEPTED
========================================================= */

function handleWordAccepted(data) {
    const word =
        normalizeWord(
            data.word
        );

    if (!word) return;

    lastServerWord =
        word;

    usedWords.add(
        word
    );

    if (
        data.playerId ===
        playerId
    ) {
        const points =
            typeof data.points ===
            "number"
                ? data.points
                : 10;

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
            "🔥 Nice! Next round...";

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

        stopTimer();

        if (
            currentRound >=
            totalRounds
        ) {
            finishGame(
                "🏆 GAME COMPLETE!"
            );
            return;
        }

        recordingRound = 0;

        timeLeft =
            typeof data.timeLeft ===
            "number"
                ? data.timeLeft
                : TURN_TIME;

        updateTimer();
        updateRoundDisplay();

        setTimeout(() => {
            if (
                gameStarted &&
                !gameOver
            ) {
                beginAutomaticRecording();
                startServerTimer();
            }
        }, 500);

        return;
    }

    showMessage(
        `👥 ${data.name || "Player"} used "${word.toUpperCase()}"`,
        "good"
    );

    renderUsedWords();

    if (data.nextChunk) {
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

    if (
        typeof data.totalRounds ===
        "number"
    ) {
        totalRounds =
            clampRounds(
                data.totalRounds
            );
    }

    updateRoundDisplay();
}

/* =========================================================
   WORD FAILURE
========================================================= */

function handleWordFailureFromServer(data) {
    const word =
        normalizeWord(
            data.word ||
            lastSubmittedWord
        );

    showWordFailure(
        data.reason ||
        "invalid",
        word
    );

    recordingRound = 0;

    if (
        gameStarted &&
        !gameOver
    ) {
        setTimeout(() => {
            beginAutomaticRecording();
        }, 300);
    }
}

function showWordFailure(
    reason,
    word
) {
    streak = 0;

    updateStats();

    if (reason === "duplicate") {
        showMessage(
            `"${word.toUpperCase()}" was already used!`,
            "bad"
        );

        resultText.textContent =
            "🚫 Already used";
    } else if (reason === "missingChunk") {
        showMessage(
            `"${word.toUpperCase()}" does not contain "${selectedChunk.toUpperCase()}".`,
            "bad"
        );

        resultText.textContent =
            `❌ Missing "${selectedChunk.toUpperCase()}"`;
    } else if (reason === "speech") {
        showMessage(
            "🎤 I couldn't understand that.",
            "bad"
        );

        resultText.textContent =
            "❓ Didn't catch that";
    } else {
        showMessage(
            "❌ That word wasn't accepted.",
            "bad"
        );

        resultText.textContent =
            "❌ Not accepted";
    }

    resultText.className =
        "result bad";

    recordingStatus.textContent =
        "🎤 Listening again...";

    recordingRound = 0;
}

/* =========================================================
   GAME OVER
========================================================= */

function finishGame(text = "🏆 GAME COMPLETE!") {
    stopTimer();

    stopRecording(false);

    gameStarted = false;
    gameOver = true;

    recordButton.disabled = true;

    bomb?.classList.remove(
        "warning"
    );

    bomb?.classList.add(
        "explode"
    );

    resultText.textContent =
        text;

    resultText.className =
        "result good";

    recordingStatus.textContent =
        "Game over.";

    turnText.textContent =
        "🏆 Game complete!";

    streak = 0;

    updateStats();

    showMessage(
        `🏆 ${totalRounds} rounds complete!`,
        "good"
    );

    setTimeout(() => {
        bomb?.classList.remove(
            "explode"
        );
    }, 700);
}

/* =========================================================
   USED WORDS
========================================================= */

function renderUsedWords() {
    if (!usedWordsDisplay) return;

    if (!usedWords.size) {
        usedWordsDisplay.textContent =
            "No words yet.";
        return;
    }

    usedWordsDisplay.innerHTML = "";

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
}

/* =========================================================
   ROOM BUTTONS
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
            "Room codes are exactly 4 characters.",
            "bad"
        );
        return;
    }

    roomCode = code;
    isHost = false;

    connectToRoom();
}

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
   OLD SPEAK BUTTON
   Kept only as a manual microphone fallback.
========================================================= */

if (recordButton) {
    recordButton.disabled = true;

    recordButton.textContent =
        "🎤 AUTO LISTENING";

    recordButton.addEventListener(
        "click",
        async () => {
            if (
                !gameStarted ||
                gameOver
            ) {
                return;
            }

            recordingRound = 0;

            if (recording) {
                stopRecording(true);
            } else {
                await beginAutomaticRecording();
            }
        }
    );
}

/* =========================================================
   CLEANUP
========================================================= */

function cleanupStream() {
    if (mediaStream) {
        mediaStream
            .getTracks()
            .forEach(track => {
                try {
                    track.stop();
                } catch {}
            });
    }

    mediaStream = null;
}

window.addEventListener(
    "beforeunload",
    () => {
        intentionalDisconnect = true;

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
    "[Voice Bomb] Clean multiplayer script loaded."
);