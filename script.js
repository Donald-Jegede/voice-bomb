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
let totalRounds = MIN_ROUNDS;

let timeLeft = TURN_TIME;
let timerInterval = null;

let currentPlayers = [];
let lastSubmittedWord = "";


/* =========================================================
   CHUNKS
========================================================= */

const CHUNKS = [
    "st","tr","ch","sh","th","ph","wh",
    "bl","br","cl","cr","dr","fl","fr",
    "gl","gr","pl","pr","sc","sk","sl",
    "sm","sn","sp","sw","tw","wr","ck",
    "ng","nd","nt","nk","mp","ll","ss",
    "oo","ee","ea","ou","ow","ai","ay",
    "oa","oi","oy","ar","er","ir","or",
    "ur","an","en","in","on","un","at",
    "et","it","ot","ut","re","le","me","ne",
    "ing","and","the","ion","ere","ate",
    "ent","est","for","her","his","not",
    "are","was","all","out","one","our",
    "you","but","can","had","has","new",
    "too","get","day","man","top","car",
    "dog","cat"
];


/* =========================================================
   PLAYER
========================================================= */

function generatePlayerId() {
    return "p_" + crypto.randomUUID();
}

function getPlayerName() {
    let name = localStorage.getItem("voiceBombName");

    if (!name) {
        name = "Player";
        localStorage.setItem("voiceBombName", name);
    }

    return name;
}


/* =========================================================
   ROOM CODE
========================================================= */

function generateRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";

    for (let i = 0; i < 4; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }

    return code;
}


/* =========================================================
   WEBSOCKET
========================================================= */

function getWebSocketURL() {
    return (
        "wss://workerjs.donaldjegede29.workers.dev/room/" +
        encodeURIComponent(roomCode) +
        "?player=" +
        encodeURIComponent(playerId) +
        "&name=" +
        encodeURIComponent(playerName)
    );
}

function setConnectionStatus(text, type = "") {
    const element = document.getElementById("connectionStatus");

    if (!element) return;

    element.textContent = text;
    element.className = "connection-status";

    if (type) {
        element.classList.add(type);
    }
}


/* =========================================================
   CREATE / JOIN ROOM
========================================================= */

function createRoom() {
    if (connected) {
        showMessage("You're already in a room.", "bad");
        return;
    }

    roomCode = generateRoomCode();
    isHost = true;

    connectToRoom();
}

function joinRoom() {
    if (connected) {
        showMessage("You're already in a room.", "bad");
        return;
    }

    const code = roomInput.value.trim().toUpperCase();

    if (!/^[A-Z0-9]{4}$/.test(code)) {
        showMessage("Room codes are exactly 4 characters.", "bad");
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

    setConnectionStatus("🟡 Connecting...");

    try {
        socket = new WebSocket(getWebSocketURL());
    } catch (error) {
        console.error(error);
        setConnectionStatus("🔴 Connection failed", "bad");
        return;
    }

    socket.onopen = () => {
        connected = true;

        setConnectionStatus("🟢 Connected", "good");

        showRoom();

        sendSocketMessage({
            type: "setName",
            name: playerName
        });

        updateHostUI();
    };

    socket.onmessage = event => {
        handleSocketMessage(event.data);
    };

    socket.onerror = error => {
        console.error("[Voice Bomb] WebSocket error:", error);
        setConnectionStatus("🔴 Connection error", "bad");
    };

    socket.onclose = () => {
        connected = false;

        setConnectionStatus("🔴 Disconnected", "bad");

        if (!intentionalDisconnect) {
            scheduleReconnect();
        }
    };
}

function scheduleReconnect() {
    clearTimeout(reconnectTimer);

    reconnectTimer = setTimeout(() => {
        if (roomCode && !connected && !intentionalDisconnect) {
            connectToRoom();
        }
    }, 2500);
}

function sendSocketMessage(data) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        return false;
    }

    try {
        socket.send(JSON.stringify(data));
        return true;
    } catch {
        return false;
    }
}


/* =========================================================
   SOCKET MESSAGES
========================================================= */

function handleSocketMessage(raw) {
    let data;

    try {
        data = JSON.parse(raw);
    } catch {
        console.error("Invalid server message:", raw);
        return;
    }

    if (!data) return;

    const type = String(data.type || "").toLowerCase();

    if (type === "welcome") {
        connected = true;

        if (data.player) {
            playerId = data.player.id || playerId;
            playerName = data.player.name || playerName;
        }

        if (typeof data.isHost === "boolean") {
            isHost = data.isHost;
        }

        if (data.players) {
            currentPlayers = data.players;
            renderPlayers(currentPlayers);
        }

        if (data.game) {
            applyServerGameState(data.game);
        }

        showRoom();
        updateHostUI();
        return;
    }

    if (type === "players") {
        currentPlayers = data.players || [];
        renderPlayers(currentPlayers);

        if (data.hostId) {
            isHost = data.hostId === playerId;
            updateHostUI();
        }

        return;
    }

    if (type === "playerjoined") {
        currentPlayers = data.players || [];
        renderPlayers(currentPlayers);
        return;
    }

    if (type === "playerleft") {
        currentPlayers = data.players || [];
        renderPlayers(currentPlayers);

        if (data.hostId) {
            isHost = data.hostId === playerId;
            updateHostUI();
        }

        return;
    }

    if (type === "becamehost") {
        isHost = true;
        showMessage("👑 You are now the host!", "good");
        updateHostUI();
        return;
    }

    if (type === "roundschanged") {
        totalRounds = clampRounds(data.rounds);
        updateRoundInput();
        updateRoundDisplay();

        if (!isHost) {
            showMessage(`🎯 Host selected ${totalRounds} rounds.`, "good");
        }

        return;
    }

    if (type === "gamestarted") {
        if (data.game) {
            applyServerGameState(data.game);
        }

        showMessage(
            `🎮 Game started — ${totalRounds} rounds!`,
            "good"
        );

        return;
    }

    if (type === "wordaccepted") {
        handleWordAccepted(data);
        return;
    }

    if (type === "wordresult") {
        if (data.success === false) {
            handleServerWordFailure(data);
        }

        return;
    }

    if (type === "gameover") {
        if (data.game) {
            applyServerGameState(data.game);
        }

        endGame("💥 BOOM!");
        return;
    }

    if (type === "error") {
        showMessage(data.error || "Server error.", "bad");
        return;
    }

    if (data.game) {
        applyServerGameState(data.game);
    }
}


/* =========================================================
   SERVER GAME STATE
========================================================= */

function applyServerGameState(game) {
    if (!game) return;

    if (typeof game.hostId === "string") {
        isHost = game.hostId === playerId;
    }

    if (typeof game.rounds === "number") {
        totalRounds = clampRounds(game.rounds);
    }

    if (typeof game.currentRound === "number") {
        currentRound = game.currentRound;
    }

    if (typeof game.started === "boolean") {
        gameStarted = game.started;
    }

    if (typeof game.gameOver === "boolean") {
        gameOver = game.gameOver;
    }

    if (game.chunk) {
        selectedChunk = normalizeChunk(game.chunk);
        displayChunk();
    }

    if (typeof game.timeLeft === "number") {
        timeLeft = Math.max(0, Math.min(TURN_TIME, game.timeLeft));
    }

    if (Array.isArray(game.players)) {
        currentPlayers = game.players;
        renderPlayers(currentPlayers);
    }

    updateRoundInput();
    updateRoundDisplay();
    updateTimer();
    updateHostUI();

    if (gameStarted && !gameOver) {
        recordButton.disabled = false;
        startTimer();
    } else {
        recordButton.disabled = true;
        stopTimer();
    }
}


/* =========================================================
   ROOM UI
========================================================= */

function showRoom() {
    roomInfo?.classList.remove("hidden");

    if (roomCodeDisplay) {
        roomCodeDisplay.textContent = roomCode;
    }
}

function renderPlayers(players) {
    if (!playersDisplay) return;

    if (!players.length) {
        playersDisplay.innerHTML =
            `<div class="player waiting">Waiting for players...</div>`;
        return;
    }

    playersDisplay.innerHTML = "";

    players.forEach(player => {
        const div = document.createElement("div");
        div.className = "player";

        const host =
            player.isHost === true ||
            player.host === true ||
            player.id === player.hostId;

        div.textContent =
            `${host ? "👑" : "👤"} ${player.name || "Player"}`;

        playersDisplay.appendChild(div);
    });
}


/* =========================================================
   HOST ROUND GUI
========================================================= */

function createRoundControls() {
    if (!isHost) return;

    let panel = document.getElementById("roundControls");

    if (!panel) {
        panel = document.createElement("div");
        panel.id = "roundControls";

        panel.style.marginTop = "14px";
        panel.style.padding = "14px";
        panel.style.borderRadius = "14px";
        panel.style.background = "rgba(255,255,255,0.07)";
        panel.style.border = "1px solid rgba(255,255,255,0.1)";

        panel.innerHTML = `
            <div style="font-weight:800;font-size:18px;margin-bottom:10px;">
                👑 Host Settings
            </div>

            <label
                for="roundCountInput"
                style="display:block;margin-bottom:7px;"
            >
                Number of rounds
            </label>

            <div style="display:flex;gap:8px;align-items:center;">
                <input
                    id="roundCountInput"
                    type="number"
                    min="${MIN_ROUNDS}"
                    max="${MAX_ROUNDS}"
                    value="${totalRounds}"
                    style="
                        width:110px;
                        padding:10px;
                        border-radius:10px;
                        border:none;
                        font-size:16px;
                        font-weight:700;
                    "
                >

                <span>rounds</span>
            </div>

            <div
                style="
                    margin-top:7px;
                    font-size:12px;
                    opacity:.7;
                "
            >
                Minimum ${MIN_ROUNDS} • Maximum ${MAX_ROUNDS}
            </div>

            <button
                id="applyRoundsButton"
                style="
                    margin-top:10px;
                    width:100%;
                    padding:11px;
                    border:none;
                    border-radius:10px;
                    cursor:pointer;
                    font-weight:800;
                "
            >
                🎯 Set Rounds
            </button>
        `;

        document
            .querySelector(".multiplayer-panel")
            ?.appendChild(panel);

        document
            .getElementById("applyRoundsButton")
            ?.addEventListener("click", setRounds);

        document
            .getElementById("roundCountInput")
            ?.addEventListener("keydown", event => {
                if (event.key === "Enter") {
                    setRounds();
                }
            });
    }

    updateRoundInput();
}

function updateRoundInput() {
    const input = document.getElementById("roundCountInput");

    if (input) {
        input.value = totalRounds;
        input.disabled = gameStarted;
    }

    const button = document.getElementById("applyRoundsButton");

    if (button) {
        button.disabled = gameStarted;
        button.textContent =
            gameStarted
                ? "🔒 Game Running"
                : "🎯 Set Rounds";
    }
}

function setRounds() {
    if (!isHost || gameStarted) return;

    const input = document.getElementById("roundCountInput");

    if (!input) return;

    let rounds = Number(input.value);

    if (!Number.isFinite(rounds)) {
        rounds = MIN_ROUNDS;
    }

    rounds = clampRounds(rounds);

    input.value = rounds;
    totalRounds = rounds;

    sendSocketMessage({
        type: "setRounds",
        rounds
    });

    updateRoundDisplay();

    showMessage(
        `🎯 Rounds set to ${rounds}.`,
        "good"
    );
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
   HOST UI
========================================================= */

function updateHostUI() {
    if (isHost) {
        createRoundControls();
    }

    if (newGameButton) {
        newGameButton.disabled = roomCode ? !isHost : false;

        newGameButton.textContent =
            isHost
                ? "🎮 Start Game"
                : "🔒 Host Only";
    }

    updateRoundInput();
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
                ? `Ready — ${totalRounds} rounds selected.`
                : `Waiting for the host... (${totalRounds} rounds)`;
        return;
    }

    if (gameOver) {
        turnText.textContent = "Game over!";
        return;
    }

    turnText.textContent =
        `Round ${currentRound} / ${totalRounds}`;
}


/* =========================================================
   NEW GAME
========================================================= */

function newGame() {
    if (roomCode && !isHost) {
        showMessage("🔒 Only the host can start the game.", "bad");
        return;
    }

    if (roomCode) {
        const rounds = getRoundCount();

        sendSocketMessage({
            type: "newGame",
            rounds
        });

        return;
    }

    totalRounds = getRoundCount();
    currentRound = 1;

    startLocalGame();
}

function getRoundCount() {
    const input = document.getElementById("roundCountInput");

    if (!input) {
        return clampRounds(totalRounds);
    }

    let value = Number(input.value);

    if (!Number.isFinite(value)) {
        value = MIN_ROUNDS;
    }

    value = clampRounds(value);
    input.value = value;

    totalRounds = value;

    return value;
}

function startLocalGame() {
    stopTimer();

    score = 0;
    streak = 0;
    usedWords.clear();

    gameStarted = true;
    gameOver = false;

    currentRound = 1;
    timeLeft = TURN_TIME;

    chooseChunk();

    transcript.textContent = "—";
    resultText.textContent = "Say a word!";
    resultText.className = "result";

    recordButton.disabled = false;

    bomb.classList.remove("explode", "warning");

    updateStats();
    renderUsedWords();
    updateRoundDisplay();
    updateTimer();

    startTimer();
}


/* =========================================================
   TIMER
========================================================= */

function startTimer() {
    stopTimer();

    if (!gameStarted || gameOver) return;

    timerInterval = setInterval(() => {
        if (processing || recording) return;

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
        clearInterval(timerInterval);
    }

    timerInterval = null;
}

function updateTimer() {
    if (!timerDisplay) return;

    timerDisplay.textContent = timeLeft.toFixed(1);

    const percent =
        Math.max(0, (timeLeft / TURN_TIME) * 100);

    if (timerBar) {
        timerBar.style.width = `${percent}%`;
    }

    if (timeLeft <= 5) {
        bomb?.classList.add("warning");
        timerBar?.classList.add("warning");
    } else {
        bomb?.classList.remove("warning");
        timerBar?.classList.remove("warning");
    }
}

function timeExpired() {
    if (!gameStarted || gameOver) return;

    stopTimer();

    if (roomCode) {
        if (isHost) {
            sendSocketMessage({
                type: "gameOver",
                reason: "timeout"
            });
        }
    } else {
        endGame("💥 BOOM! Time ran out!");
    }
}


/* =========================================================
   CHUNK
========================================================= */

function chooseChunk() {
    let chunk;

    do {
        chunk =
            CHUNKS[
                Math.floor(Math.random() * CHUNKS.length)
            ];
    } while (
        CHUNKS.length > 1 &&
        chunk === selectedChunk
    );

    selectedChunk = chunk;
    displayChunk();
}

function normalizeChunk(chunk) {
    if (typeof chunk !== "string") return "";

    return chunk
        .toLowerCase()
        .replace(/[^a-z]/g, "")
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
   RECORDING
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

    try {
        mediaStream =
            await navigator.mediaDevices.getUserMedia({
                audio: true
            });

        audioChunks = [];

        const mimeType =
            MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
                ? "audio/webm;codecs=opus"
                : "audio/webm";

        mediaRecorder =
            new MediaRecorder(mediaStream, {
                mimeType
            });

        mediaRecorder.ondataavailable = event => {
            if (event.data?.size > 0) {
                audioChunks.push(event.data);
            }
        };

        mediaRecorder.onstop = async () => {
            audioBlob =
                new Blob(audioChunks, {
                    type: mimeType
                });

            downloadButton.disabled = false;

            await transcribeWord();

            cleanupStream();
        };

        mediaRecorder.start();

        recording = true;

        recordButton.classList.add("speaking");
        recordButton.textContent = "🔴 RECORDING...";
        recordingStatus.textContent =
            "🎤 Listening... say ONE word!";

    } catch (error) {
        console.error(error);

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

    recordButton.classList.remove("speaking");
    recordButton.textContent = "🧠 PROCESSING...";
    recordingStatus.textContent = "🧠 Transcribing...";

    if (
        mediaRecorder &&
        mediaRecorder.state === "recording"
    ) {
        mediaRecorder.stop();
    }
}


/* =========================================================
   SPEAK BUTTON
========================================================= */

if (recordButton) {
    recordButton.disabled = true;

    recordButton.addEventListener("click", () => {
        if (recording) {
            stopRecording();
        } else {
            startRecording();
        }
    });
}


/* =========================================================
   TRANSCRIPTION
========================================================= */

async function transcribeWord() {
    if (!audioBlob) {
        showMessage("No recording was created.", "bad");
        return;
    }

    processing = true;
    recordButton.disabled = true;
    stopTimer();

    const formData = new FormData();

    formData.append(
        "file",
        audioBlob,
        "word.webm"
    );

    try {
        const response =
            await fetch(WORKER_URL, {
                method: "POST",
                body: formData
            });

        const raw = await response.text();

        let result;

        try {
            result = JSON.parse(raw);
        } catch {
            throw new Error("Worker returned invalid JSON.");
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
            normalizeWord(result.text);

        transcript.textContent =
            word || "???";

        if (!word) {
            showMessage(
                "I couldn't understand that.",
                "bad"
            );

            return;
        }

        lastSubmittedWord = word;

        submitWord(word);

    } catch (error) {
        console.error(error);

        showMessage(
            "Transcription error: " + error.message,
            "bad"
        );

        recordingStatus.textContent = "Try again.";

    } finally {
        processing = false;

        if (gameStarted && !gameOver) {
            recordButton.disabled = false;
            startTimer();
        }
    }
}


/* =========================================================
   WORD
========================================================= */

function normalizeWord(text) {
    if (typeof text !== "string") return "";

    return text
        .toLowerCase()
        .replace(/[^a-z'-]/g, "")
        .replace(/^'+|'+$/g, "")
        .trim()
        .slice(0, 50);
}

function submitWord(word) {
    if (!word) return;

    if (usedWords.has(word)) {
        showWordFailure("duplicate", word);
        return;
    }

    if (!word.includes(selectedChunk)) {
        showWordFailure("missingChunk", word);
        return;
    }

    if (roomCode) {
        stopTimer();

        sendSocketMessage({
            type: "word",
            word
        });

        return;
    }

    acceptLocalWord(word);
}


/* =========================================================
   LOCAL WORD
========================================================= */

function acceptLocalWord(word) {
    usedWords.add(word);

    const points =
        10 +
        Math.min(streak * 2, 20);

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

    resultText.className = "result good";

    if (currentRound >= totalRounds) {
        finishGame();
        return;
    }

    currentRound++;

    chooseChunk();

    timeLeft = TURN_TIME;

    updateRoundDisplay();
    updateTimer();

    startTimer();
}


/* =========================================================
   WORD ACCEPTED FROM SERVER
========================================================= */

function handleWordAccepted(data) {
    const word = normalizeWord(data.word);

    if (!word) return;

    usedWords.add(word);

    if (data.playerId === playerId) {
        if (typeof data.points === "number") {
            score += data.points;
        }

        streak++;

        transcript.textContent = word;

        resultText.textContent =
            `✅ Contains "${selectedChunk.toUpperCase()}"`;

        resultText.className = "result good";

        recordingStatus.textContent =
            "Nice! Next round...";

        updateStats();
        renderUsedWords();
    } else {
        showMessage(
            `👥 ${data.name || "Player"} used "${word.toUpperCase()}"`,
            "good"
        );
    }

    if (typeof data.currentRound === "number") {
        currentRound = data.currentRound;
    }

    if (typeof data.totalRounds === "number") {
        totalRounds = clampRounds(data.totalRounds);
    }

    if (data.nextChunk) {
        selectedChunk = normalizeChunk(data.nextChunk);
        displayChunk();
    }

    updateRoundDisplay();

    if (currentRound >= totalRounds) {
        finishGame();
        return;
    }

    timeLeft =
        typeof data.timeLeft === "number"
            ? data.timeLeft
            : TURN_TIME;

    updateTimer();

    if (gameStarted && !gameOver) {
        startTimer();
    }
}


/* =========================================================
   WORD FAILURE
========================================================= */

function handleServerWordFailure(data) {
    showWordFailure(
        data.reason,
        data.word || lastSubmittedWord
    );

    startTimer();
}

function showWordFailure(reason, word) {
    if (reason === "duplicate") {
        showMessage(
            `"${word.toUpperCase()}" was already used!`,
            "bad"
        );

        resultText.textContent = "🚫 Already used";
    } else {
        showMessage(
            `"${word.toUpperCase()}" does not contain "${selectedChunk.toUpperCase()}".`,
            "bad"
        );

        resultText.textContent =
            `❌ Missing "${selectedChunk.toUpperCase()}"`;
    }

    resultText.className = "result bad";

    streak = 0;
    updateStats();

    recordingStatus.textContent =
        "Try another word.";
}


/* =========================================================
   GAME OVER
========================================================= */

function finishGame() {
    stopTimer();

    gameStarted = false;
    gameOver = true;

    recordButton.disabled = true;

    updateRoundDisplay();
    updateRoundInput();

    resultText.textContent =
        "🏆 GAME COMPLETE";

    resultText.className = "result good";

    recordingStatus.textContent =
        "All rounds completed.";

    showMessage(
        `🏆 ${totalRounds} rounds complete!`,
        "good";
    );
}

function endGame(text = "💥 BOOM!") {
    stopTimer();

    gameStarted = false;
    gameOver = true;

    recordButton.disabled = true;

    bomb?.classList.add("explode");

    resultText.textContent = text;
    resultText.className = "result bad";

    recordingStatus.textContent =
        "Game over.";

    updateRoundDisplay();
    updateRoundInput();

    setTimeout(() => {
        bomb?.classList.remove("explode");
    }, 600);
}


/* =========================================================
   STATS
========================================================= */

function updateStats() {
    scoreDisplay.textContent = score;
    streakDisplay.textContent = streak;
    wordsUsedDisplay.textContent = usedWords.size;
}


/* =========================================================
   USED WORDS
========================================================= */

function renderUsedWords() {
    if (!usedWordsDisplay) return;

    if (usedWords.size === 0) {
        usedWordsDisplay.textContent = "No words yet.";
        return;
    }

    usedWordsDisplay.innerHTML = "";

    [...usedWords]
        .reverse()
        .forEach(word => {
            const element =
                document.createElement("span");

            element.className = "used-word";
            element.textContent = word;

            usedWordsDisplay.appendChild(element);
        });
}


/* =========================================================
   COPY
========================================================= */

copyRoomButton?.addEventListener("click", async () => {
    if (!roomCode) return;

    try {
        await navigator.clipboard.writeText(roomCode);

        copyRoomButton.textContent = "✅ Copied!";

        setTimeout(() => {
            copyRoomButton.textContent = "📋 Copy";
        }, 1200);
    } catch {
        showMessage(
            "Couldn't copy room code.",
            "bad"
        );
    }
});

copyButton?.addEventListener("click", async () => {
    const word = transcript.textContent.trim();

    if (!word || word === "—" || word === "???") return;

    try {
        await navigator.clipboard.writeText(word);

        copyButton.textContent = "✅ Copied!";

        setTimeout(() => {
            copyButton.textContent = "📋 Copy Word";
        }, 1200);
    } catch {
        showMessage(
            "Couldn't copy the word.",
            "bad"
        );
    }
});

downloadButton?.addEventListener("click", () => {
    if (!audioBlob) return;

    const url = URL.createObjectURL(audioBlob);
    const link = document.createElement("a");

    link.href = url;
    link.download = "word-bomb-word.webm";

    document.body.appendChild(link);
    link.click();
    link.remove();

    URL.revokeObjectURL(url);
});


/* =========================================================
   BUTTONS
========================================================= */

createRoomButton?.addEventListener("click", createRoom);
joinRoomButton?.addEventListener("click", joinRoom);
newGameButton?.addEventListener("click", newGame);

roomInput?.addEventListener("keydown", event => {
    if (event.key === "Enter") {
        joinRoom();
    }
});


/* =========================================================
   MESSAGES
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


/* =========================================================
   CLEANUP
========================================================= */

function cleanupStream() {
    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
    }

    mediaStream = null;
}

window.addEventListener("beforeunload", () => {
    intentionalDisconnect = true;

    cleanupStream();

    if (socket) {
        try {
            socket.close();
        } catch {}
    }
});


/* =========================================================
   INITIALIZE
========================================================= */

playerId =
    localStorage.getItem("voiceBombPlayerId");

if (!playerId) {
    playerId = generatePlayerId();

    localStorage.setItem(
        "voiceBombPlayerId",
        playerId
    );
}

playerName = getPlayerName();

totalRounds = MIN_ROUNDS;

updateStats();
updateTimer();
displayChunk();
updateRoundDisplay();
updateHostUI();

console.log("[Voice Bomb] script.js loaded.");