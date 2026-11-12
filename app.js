import { QUESTIONS } from "./questions.js";
import { firebaseConfig, firebaseIsConfigured } from "./firebase-config.js";

const FIREBASE_VERSION = "13.0.0";
const FIREBASE_BASE =
  `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;

const QUESTION_DURATION = 5000;
const ANSWER_SECONDS = [15, 20, 25, 30];
const COLLECTION_GRACE = 5000;
const ROOM_LIFETIME = 6 * 60 * 60 * 1000;
const TAKEOVER_WAIT = 120000;

const appRoot = document.querySelector("#app");
const modalRoot = document.querySelector("#modal-root");
const roomPill = document.querySelector("#room-pill");
const roomCodeSmall = document.querySelector("#room-code-small");
const connectionDot = document.querySelector("#connection-dot");
const offlineBanner = document.querySelector("#offline-banner");

const state = {
  uid: null,
  roomCode: null,
  room: null,
  db: null,
  auth: null,
  api: null,

  roomUnsub: null,
  connectionUnsub: null,

  presencePlayerRef: null,
  presenceHostRef: null,
  hostDisconnectKey: null,

  serverOffset: 0,
  online: false,
  phaseTransitioning: false,
  transitionRetryAt: 0,
  actionBusy: false,
  settingsSaving: false,

  viewKey: null,
  draftAnswer: "",
  draftRound: null,
  frozenAnswer: null,

  scoringSelected: null,
  singleWarningArmed: false,
  celebratedRound: null,
  signals: false
};

const $ = (selector, parent = document) =>
  parent.querySelector(selector);

const $$ = (selector, parent = document) =>
  [...parent.querySelectorAll(selector)];

const clone = (id) =>
  document.querySelector(id).content.cloneNode(true);

const serverNow = () => Date.now() + state.serverOffset;

const roomRef = (path = "") =>
  state.api.ref(
    state.db,
    `rooms/${state.roomCode}${path ? `/${path}` : ""}`
  );

const isHost = () =>
  Boolean(state.room && state.uid === state.room.hostId);

const isDeputy = () =>
  Boolean(state.room && state.uid === state.room.deputyId);

const cleanName = (value) =>
  value.trim().replace(/\s+/g, " ").slice(0, 24);

const cleanAnswer = (value) =>
  value.trim().replace(/\s+/g, " ").slice(0, 60);

function answerDuration() {
  const seconds = Number(state.room?.answerSeconds);
  return ANSWER_SECONDS.includes(seconds) ? seconds * 1000 : 15000;
}

function answerDeadline() {
  const room = state.room;
  if (!room) return 0;

  if (typeof room.answerEndsAt === "number") {
    return room.answerEndsAt;
  }

  return room.status === "answer"
    ? Number(room.phaseEndsAt || 0)
    : 0;
}

function collectionDeadline() {
  return Number(
    state.room?.collectionEndsAt ||
    (answerDeadline() ? answerDeadline() + COLLECTION_GRACE : 0)
  );
}

function roundKey() {
  if (!state.room || !state.roomCode) return "";

  const id =
    state.room.roundId ||
    `legacy-${state.room.round || 0}-${state.room.questionIndex ?? -1}`;

  return `${state.roomCode}:${id}`;
}

function getAnswer(uid) {
  const answer = state.room?.answers?.[uid];
  if (!answer) return null;

  if (
    state.room.roundId &&
    answer.roundId !== state.room.roundId
  ) {
    return null;
  }

  return answer;
}

function resetLocalRound() {
  state.draftAnswer = "";
  state.draftRound = null;
  state.frozenAnswer = null;
  state.scoringSelected = null;
  state.singleWarningArmed = false;
}

function syncLocalRound() {
  if (!state.room) return;

  if (state.room.status === "lobby") {
    if (state.draftRound !== null) resetLocalRound();
    return;
  }

  const key = roundKey();

  if (state.draftRound !== key) {
    state.draftRound = key;
    state.draftAnswer = getAnswer(state.uid)?.text || "";
    state.frozenAnswer = null;
    state.scoringSelected = null;
    state.singleWarningArmed = false;
  }
}

function setScreen(fragment) {
  state.viewKey = null;
  appRoot.replaceChildren(fragment);
  appRoot.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: "instant" });
}

function setConnection(online) {
  state.online = online;

  connectionDot.classList.toggle("online", online);
  connectionDot.classList.toggle("offline", !online);
  connectionDot.setAttribute(
    "aria-label",
    online ? "Verbunden" : "Nicht verbunden"
  );

  offlineBanner.hidden = online;

  if (online && state.room) {
    void syncHostDisconnect();
    clockTick();
  }
}

function showHome() {
  const view = clone("#home-template");
  const note = $("#setup-note", view);

  if (!firebaseIsConfigured) {
    note.hidden = false;
    note.textContent =
      "Vor dem ersten Mehrspieler-Test muss Firebase einmal eingerichtet werden. Die Anleitung liegt dem Paket bei.";
  }

  setScreen(view);
  roomPill.hidden = true;
}

function showEntry(mode) {
  if (!firebaseIsConfigured) {
    showSetupModal();
    return;
  }

  const view = clone("#name-template");
  const joining = mode === "join";

  $("#form-eyebrow", view).textContent =
    joining ? "Mitspielen" : "Neues Spiel";

  $("#form-title", view).textContent =
    joining ? "Code und Name" : "Wie heißt du?";

  $("#code-field", view).hidden = !joining;
  $("#entry-form", view).dataset.mode = mode;

  setScreen(view);

  setTimeout(() => {
    $(joining ? "#room-code" : "#player-name")?.focus();
  }, 80);
}

function showSetupModal() {
  showModal(
    "Firebase fehlt noch",
    `<p>Trage zuerst die Werte deines Firebase-Projekts in
    <strong>firebase-config.js</strong> ein.</p>
    <p>Die Datei <strong>FIREBASE-SETUP.md</strong> führt dich
    durch die Einrichtung.</p>`,
    [{
      label: "Verstanden",
      className: "button-primary",
      action: closeModal
    }]
  );
}

function showConnectionError(error) {
  console.error(error);
  showHome();

  showModal(
    "Verbindung nicht möglich",
    `<p>${escapeHtml(friendlyError(error))}</p>`,
    [{
      label: "Erneut versuchen",
      className: "button-primary",
      action: () => location.reload()
    }]
  );
}

async function initFirebase() {
  if (!firebaseIsConfigured) {
    connectionDot.classList.remove("online", "offline");
    connectionDot.setAttribute(
      "aria-label",
      "Firebase noch nicht eingerichtet"
    );
    offlineBanner.hidden = true;
    showHome();
    return;
  }

  try {
    const appApi = await import(`${FIREBASE_BASE}/firebase-app.js`);
    const authApi = await import(`${FIREBASE_BASE}/firebase-auth.js`);
    const dbApi = await import(`${FIREBASE_BASE}/firebase-database.js`);

    state.api = { ...appApi, ...authApi, ...dbApi };

    const firebaseApp = appApi.initializeApp(firebaseConfig);
    state.auth = authApi.getAuth(firebaseApp);
    state.db = dbApi.getDatabase(firebaseApp);

    try {
      await authApi.setPersistence(
        state.auth,
        authApi.browserLocalPersistence
      );
    } catch (error) {
      console.warn("Dauerhafte Anmeldung nicht verfügbar:", error);
    }

    dbApi.onValue(
      dbApi.ref(state.db, ".info/serverTimeOffset"),
      (snapshot) => {
        state.serverOffset = snapshot.val() || 0;
      }
    );

    dbApi.onValue(
      dbApi.ref(state.db, ".info/connected"),
      (snapshot) => {
        setConnection(snapshot.val() === true);
      }
    );

    authApi.onAuthStateChanged(state.auth, (user) => {
      if (!user) {
        authApi.signInAnonymously(state.auth)
          .catch(showConnectionError);
        return;
      }

      state.uid = user.uid;
      restoreSession().catch(showConnectionError);
    });
  } catch (error) {
    showConnectionError(error);
  }
}

async function restoreSession() {
  const { get, ref, remove } = state.api;

  const sessionSnapshot = await get(
    ref(state.db, `sessions/${state.uid}`)
  );

  const code = sessionSnapshot.val()?.roomCode;

  if (!code) {
    showHome();
    return;
  }

  const snapshot = await get(ref(state.db, `rooms/${code}`));
  const room = snapshot.val();

  const expired =
    room &&
    serverNow() - (room.lastActivity || room.createdAt || 0) >
      ROOM_LIFETIME;

  if (!room || !room.players?.[state.uid] || expired) {
    await remove(ref(state.db, `sessions/${state.uid}`));
    showHome();
    return;
  }

  connectToRoom(code);
}

async function createRoom(name) {
  const { ref, runTransaction, set } = state.api;
  const now = serverNow();

  let code = "";
  let committed = false;

  for (
    let attempt = 0;
    attempt < 30 && !committed;
    attempt += 1
  ) {
    code = String(Math.floor(1000 + Math.random() * 9000));

    const newRoom = {
      hostId: state.uid,
      deputyId: "",
      status: "lobby",
      paused: false,
      createdAt: now,
      lastActivity: now,
      round: 0,
      maxPlayers: 8,
      answerSeconds: 15,
      players: {
        [state.uid]: {
          name,
          score: 0,
          online: true,
          joinedAt: now,
          lastSeen: now
        }
      }
    };

    const result = await runTransaction(
      ref(state.db, `rooms/${code}`),
      (current) =>
        current === null ||
        now - (current.lastActivity || current.createdAt || 0) >
          ROOM_LIFETIME
          ? newRoom
          : undefined,
      { applyLocally: false }
    );

    committed = result.committed;
  }

  if (!committed) {
    throw new Error(
      "Es konnte kein freier Spielcode erzeugt werden."
    );
  }

  await set(
    ref(state.db, `sessions/${state.uid}`),
    { roomCode: code }
  );

  connectToRoom(code);
}

async function joinRoom(code, name) {
  const { get, ref, set } = state.api;

  const normalizedCode =
    code.replace(/\D/g, "").slice(0, 4);

  if (normalizedCode.length !== 4) {
    throw new Error(
      "Der Spielcode muss aus vier Ziffern bestehen."
    );
  }

  const snapshot = await get(
    ref(state.db, `rooms/${normalizedCode}`)
  );

  const room = snapshot.val();

  if (!room) {
    throw new Error(
      "Unter diesem Code wurde kein Spiel gefunden."
    );
  }

  if (
    serverNow() - (room.lastActivity || room.createdAt || 0) >
    ROOM_LIFETIME
  ) {
    throw new Error("Dieser Spielraum ist nicht mehr aktiv.");
  }

  if (room.status !== "lobby") {
    throw new Error("Dieses Spiel läuft bereits.");
  }

  const players = Object.values(room.players || {});

  if (players.length >= 8) {
    throw new Error("Dieser Spielraum ist bereits voll.");
  }

  if (
    players.some(
      (player) =>
        player.name.toLocaleLowerCase("de") ===
        name.toLocaleLowerCase("de")
    )
  ) {
    throw new Error(
      "Dieser Name wird im Spiel bereits verwendet."
    );
  }

  const now = serverNow();

  await set(
    ref(
      state.db,
      `rooms/${normalizedCode}/players/${state.uid}`
    ),
    {
      name,
      score: 0,
      online: true,
      joinedAt: now,
      lastSeen: now
    }
  );

  await set(
    ref(state.db, `sessions/${state.uid}`),
    { roomCode: normalizedCode }
  );

  connectToRoom(normalizedCode);
}

function connectToRoom(code) {
  disconnectRoomListener();
  resetLocalRound();

  state.roomCode = code;
  state.room = null;
  state.viewKey = null;

  roomPill.hidden = false;
  roomCodeSmall.textContent = code;

  state.roomUnsub = state.api.onValue(
    roomRef(),
    (snapshot) => {
      const room = snapshot.val();

      if (!room || !room.players?.[state.uid]) {
        void handleRemovedOrClosed();
        return;
      }

      state.room = room;
      syncLocalRound();
      registerPresence();
      void syncHostDisconnect();

      if (
        isHost() &&
        room.deputyId &&
        !room.players[room.deputyId]
      ) {
        state.api.update(roomRef(), {
          deputyId: "",
          lastActivity: serverNow()
        }).catch(showActionError);
      }

      if (
        isHost() &&
        room.paused &&
        room.players[state.uid]?.online
      ) {
        void resumeAfterHostReturn();
      }

      clockTick();
    },
    (error) => {
      console.error(error);

      showModal(
        "Spiel nicht erreichbar",
        `<p>${escapeHtml(friendlyError(error))}</p>`,
        [{
          label: "Zur Startseite",
          className: "button-primary",
          action: leaveToHome
        }]
      );
    }
  );
}

function disconnectRoomListener() {
  state.roomUnsub?.();
  state.connectionUnsub?.();

  state.roomUnsub = null;
  state.connectionUnsub = null;

  if (state.api && state.presencePlayerRef) {
    state.api.onDisconnect(state.presencePlayerRef)
      .cancel()
      .catch(console.warn);
  }

  if (state.api && state.presenceHostRef) {
    state.api.onDisconnect(state.presenceHostRef)
      .cancel()
      .catch(console.warn);
  }

  state.presencePlayerRef = null;
  state.presenceHostRef = null;
  state.hostDisconnectKey = null;
  state.phaseTransitioning = false;
  state.transitionRetryAt = 0;
  state.viewKey = null;
}

function registerPresence() {
  if (state.connectionUnsub) return;

  const {
    onValue,
    ref,
    update,
    onDisconnect,
    serverTimestamp
  } = state.api;

  const code = state.roomCode;

  state.connectionUnsub = onValue(
    ref(state.db, ".info/connected"),
    (snapshot) => {
      if (snapshot.val() !== true) {
        state.hostDisconnectKey = null;
        return;
      }

      if (!state.roomCode || state.roomCode !== code) return;

      const playerRef = roomRef(`players/${state.uid}`);
      state.presencePlayerRef = playerRef;

      (async () => {
        await onDisconnect(playerRef).update({
          online: false,
          lastSeen: serverTimestamp()
        });

        if (state.roomCode !== code) return;

        await update(playerRef, {
          online: true,
          lastSeen: serverNow()
        });

        await syncHostDisconnect();
      })().catch(console.warn);
    }
  );
}

async function syncHostDisconnect() {
  if (!state.api || !state.roomCode || !state.online) return;

  const desiredKey =
    isHost() ? `${state.roomCode}:${state.uid}` : null;

  if (state.hostDisconnectKey === desiredKey) return;

  const oldRef = state.presenceHostRef;

  state.hostDisconnectKey = desiredKey;
  state.presenceHostRef = desiredKey ? roomRef("paused") : null;

  try {
    if (oldRef) {
      await state.api.onDisconnect(oldRef).cancel();
    }

    if (state.presenceHostRef) {
      await state.api.onDisconnect(state.presenceHostRef)
        .set(true);
    }
  } catch (error) {
    state.hostDisconnectKey = null;
    console.warn("Anwesenheitsüberwachung:", error);
  }
}

async function resumeAfterHostReturn() {
  if (
    !isHost() ||
    !state.room.paused ||
    state.phaseTransitioning ||
    !state.online
  ) {
    return;
  }

  state.phaseTransitioning = true;

  try {
    // Bereits gesetzte Fristen werden nicht neu gestartet.
    await state.api.update(roomRef(), {
      paused: false,
      lastActivity: serverNow()
    });
  } catch (error) {
    console.warn(error);
  } finally {
    state.phaseTransitioning = false;
  }
}

function viewPhase() {
  if (state.room.paused && !isHost()) return "paused";

  if (
    state.room.status === "answer" &&
    (
      state.frozenAnswer?.key === roundKey() ||
      (
        answerDeadline() > 0 &&
        serverNow() >= answerDeadline()
      )
    )
  ) {
    return "collecting";
  }

  return state.room.status;
}

function renderKey(phase) {
  const base =
    `${roundKey()}:${phase}:${isHost() ? "host" : "player"}`;

  if (phase === "lobby") {
    return `${base}:${JSON.stringify({
      players: state.room.players,
      deputy: state.room.deputyId,
      seconds: state.room.answerSeconds || 15,
      saving: state.settingsSaving
    })}`;
  }

  if (phase === "results" || phase === "ended") {
    return `${base}:${JSON.stringify({
      scores: sortedPlayers(false).map(
        ([uid, player]) => [uid, player.name, player.score]
      ),
      winners: state.room.winners || {}
    })}`;
  }

  return base;
}

function renderRoom() {
  if (!state.room) return;

  const phase = viewPhase();
  const key = renderKey(phase);

  if (state.viewKey !== key) {
    switch (phase) {
      case "lobby":
        renderLobby();
        break;

      case "question":
      case "answer":
      case "collecting":
      case "reveal":
        renderRound(phase);
        break;

      case "scoring":
        if (isHost()) {
          renderScoring();
        } else {
          renderRound("scoring");
        }
        break;

      case "results":
        renderResults();
        break;

      case "ended":
        renderEnded();
        break;

      case "paused":
        renderPaused();
        break;

      default:
        renderLobby();
    }

    state.viewKey = key;
  }

  // Während der Eingabe wird das Formular NICHT ersetzt.
  // Nur kleine, dafür vorgesehene Anzeigen werden aktualisiert.
  if (
    ["collecting", "reveal", "scoring"].includes(phase)
  ) {
    updateAnswerOverview();
  }

  if (phase === "paused") {
    updatePausedCountdown();
  }

  updateTimer();
}

function renderLobby() {
  const view = clone("#lobby-template");

  $("#copy-code", view).textContent = state.roomCode;

  $("#copy-code", view).addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(state.roomCode);
    } catch (_) {
      // Der Code bleibt auch ohne Zwischenablage ablesbar.
    }
  });

  const players = sortedPlayers(false);

  $("#player-count", view).textContent =
    `${players.length} / 8`;

  const list = $("#lobby-list", view);

  players.forEach(([uid, player]) => {
    list.append(createPlayerRow(uid, player));
  });

  const actions = $("#lobby-actions", view);
  actions.before(createDurationSettings());

  if (isHost()) {
    const start = button(
      "Spiel starten",
      "button-primary",
      startGame
    );

    start.disabled =
      players.length < 2 ||
      !state.room.deputyId ||
      state.settingsSaving;

    actions.append(start);

    if (players.length < 2) {
      actions.prepend(
        helper("Mindestens zwei Personen müssen im Warteraum sein.")
      );
    } else if (!state.room.deputyId) {
      actions.prepend(
        helper("Bestimme eine Stellvertretung, bevor das Spiel startet.")
      );
    }
  } else {
    actions.append(
      helper("Die Spielleitung startet, sobald alle da sind.")
    );
  }

  setScreen(view);
}

function createDurationSettings() {
  const section = document.createElement("section");
  section.className = "field";
  section.setAttribute("aria-labelledby", "duration-title");

  const title = document.createElement("h2");
  title.id = "duration-title";
  title.textContent = "Antwortzeit";

  const description = document.createElement("p");
  description.className = "room-pill";

  const seconds = answerDuration() / 1000;

  description.textContent = isHost()
    ? "Wähle die Antwortzeit für dieses Spiel. Dazu kommen fünf Sekunden zum Lesen."
    : `${seconds} Sekunden pro Antwort, zusätzlich fünf Sekunden zum Lesen.`;

  section.append(title, description);

  if (isHost()) {
    const choices = document.createElement("div");
    choices.className = "action-stack";
    choices.setAttribute("role", "group");
    choices.setAttribute("aria-label", "Antwortzeit auswählen");

    ANSWER_SECONDS.forEach((value) => {
      const selected = value === seconds;

      const choice = button(
        `${value} Sekunden`,
        selected ? "button-primary" : "button-secondary",
        () => setAnswerDuration(value)
      );

      choice.setAttribute("aria-pressed", String(selected));
      choice.disabled = state.settingsSaving;
      choices.append(choice);
    });

    section.append(choices);
  }

  return section;
}

async function setAnswerDuration(seconds) {
  if (
    !isHost() ||
    state.room.status !== "lobby" ||
    !ANSWER_SECONDS.includes(seconds) ||
    state.settingsSaving
  ) {
    return;
  }

  state.settingsSaving = true;
  renderRoom();

  try {
    await state.api.update(roomRef(), {
      answerSeconds: seconds,
      lastActivity: serverNow()
    });
  } catch (error) {
    showActionError(error);
  } finally {
    state.settingsSaving = false;
    if (state.room) renderRoom();
  }
}

function createPlayerRow(uid, player) {
  const li = document.createElement("li");
  li.className = "player-row";

  const avatar = document.createElement("span");
  avatar.className = "player-avatar";
  avatar.textContent =
    player.name.charAt(0).toLocaleUpperCase("de");

  const name = document.createElement("span");
  name.className = "player-name";
  name.textContent = player.name;

  const tags = document.createElement("span");
  tags.className = "player-tags";

  const presence = document.createElement("span");
  presence.className =
    `presence ${player.online ? "online" : ""}`;
  presence.title =
    player.online ? "Verbunden" : "Nicht verbunden";

  tags.append(presence);

  if (uid === state.room.hostId) tags.append(tag("Spielleitung"));
  if (uid === state.room.deputyId) tags.append(tag("Vertretung"));

  li.append(avatar, name, tags);

  if (isHost() && uid !== state.uid) {
    const select = document.createElement("button");
    select.className = "deputy-select";
    select.type = "button";
    select.textContent =
      uid === state.room.deputyId
        ? "Vertretung ✓"
        : "Als Vertretung";

    select.addEventListener("click", () => setDeputy(uid));
    li.append(select);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-player";
    remove.setAttribute(
      "aria-label",
      `${player.name} entfernen`
    );
    remove.textContent = "×";
    remove.addEventListener(
      "click",
      () => confirmRemove(uid, player.name)
    );

    li.append(remove);
  }

  return li;
}

function helper(text) {
  const p = document.createElement("p");
  p.className = "phase-message";
  p.textContent = text;
  return p;
}

function tag(text) {
  const span = document.createElement("span");
  span.className = "tag";
  span.textContent = text;
  return span;
}

function button(label, className, handler) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = `button ${className}`;
  el.textContent = label;
  el.addEventListener("click", handler);
  return el;
}

function showActionError(error) {
  console.error(error);

  showModal(
    "Aktion nicht möglich",
    `<p>${escapeHtml(friendlyError(error))}</p>`,
    [{
      label: "OK",
      className: "button-primary",
      action: closeModal
    }]
  );
}

async function setDeputy(uid) {
  if (!isHost() || state.room.status !== "lobby") return;

  try {
    await state.api.update(roomRef(), {
      deputyId: uid,
      lastActivity: serverNow()
    });
  } catch (error) {
    showActionError(error);
  }
}

function confirmRemove(uid, name) {
  showModal(
    "Mitspieler entfernen?",
    `<p><strong>${escapeHtml(name)}</strong>
    wird aus dem Warteraum entfernt.</p>`,
    [
      {
        label: "Abbrechen",
        className: "button-ghost",
        action: closeModal
      },
      {
        label: "Entfernen",
        className: "button-danger",
        action: async () => {
          closeModal();

          try {
            await state.api.update(roomRef(), {
              [`players/${uid}`]: null,
              deputyId:
                state.room.deputyId === uid
                  ? ""
                  : state.room.deputyId,
              lastActivity: serverNow()
            });
          } catch (error) {
            showActionError(error);
          }
        }
      }
    ]
  );
}

async function startGame() {
  if (
    !isHost() ||
    state.room.status !== "lobby" ||
    state.settingsSaving
  ) {
    return;
  }

  const players = Object.keys(state.room.players || {});

  if (players.length < 2 || !state.room.deputyId) return;

  await beginNextRound();
}

function newRoundId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random()
    .toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

async function beginNextRound() {
  if (
    !isHost() ||
    state.actionBusy ||
    !["lobby", "results"].includes(state.room.status)
  ) {
    return;
  }

  const used = new Set(
    Object.keys(state.room.usedQuestions || {}).map(Number)
  );

  const available = QUESTIONS
    .map((_, index) => index)
    .filter((index) => !used.has(index));

  if (!available.length) {
    showQuestionExhausted();
    return;
  }

  state.actionBusy = true;

  const questionIndex =
    available[Math.floor(Math.random() * available.length)];

  const now = serverNow();

  try {
    await state.api.update(roomRef(), {
      status: "question",
      paused: false,
      round: (state.room.round || 0) + 1,
      roundId: newRoundId(),
      questionIndex,
      phaseEndsAt: now + QUESTION_DURATION,
      answerEndsAt: null,
      collectionEndsAt: null,
      answers: null,
      winners: null,
      scoringBaseScores: null,
      [`usedQuestions/${questionIndex}`]: true,
      lastActivity: now
    });
  } catch (error) {
    showActionError(error);
  } finally {
    state.actionBusy = false;
  }
}

function showQuestionExhausted() {
  showModal(
    "Alle Aussagen gespielt",
    "<p>Alle Aussagen wurden in diesem Spiel bereits verwendet.</p>",
    [
      {
        label: "Spiel beenden",
        className: "button-ghost",
        action: endGame
      },
      {
        label: "Neu mischen",
        className: "button-primary",
        action: async () => {
          closeModal();

          try {
            await state.api.update(roomRef(), {
              usedQuestions: null,
              lastActivity: serverNow()
            });

            if (state.room) {
              state.room.usedQuestions = {};
              await beginNextRound();
            }
          } catch (error) {
            showActionError(error);
          }
        }
      }
    ]
  );
}

function renderRound(phase) {
  const view = clone("#round-template");

  $("#round-label", view).textContent =
    `Runde ${state.room.round || 1}`;

  $("#question-text", view).textContent =
    QUESTIONS[state.room.questionIndex] || "–";

  const content = $("#round-content", view);
  const timer = $("#timer", view);

  if (phase === "question") {
    content.append(
      helper("Merkt euch die Aussage. Gleich könnt ihr antworten.")
    );
  } else if (phase === "answer") {
    content.append(createAnswerForm());
  } else {
    timer.hidden = true;
    content.append(createAnswerOverview());

    if (isHost()) {
      const scoring = button(
        "Punkte vergeben",
        "button-primary",
        openScoring
      );

      scoring.id = "open-scoring-button";
      scoring.disabled = state.room.status !== "reveal";
      content.append(scoring);
    } else {
      content.append(
        helper(
          phase === "scoring"
            ? "Die Spielleitung wertet gerade die Antworten aus."
            : "Vergleicht eure Antworten. Die Spielleitung vergibt die Punkte."
        )
      );
    }
  }

  setScreen(view);

  if (phase === "answer") {
    const key = roundKey();

    setTimeout(() => {
      const input = $("#answer-input");

      if (
        input &&
        roundKey() === key &&
        viewPhase() === "answer" &&
        !modalRoot.firstChild
      ) {
        input.focus({ preventScroll: true });
      }
    }, 100);
  }
}

function createAnswerForm() {
  const form = document.createElement("form");
  form.className = "answer-form";
  form.id = "answer-form";
  form.dataset.roundKey = roundKey();

  form.innerHTML = `
    <div class="field">
      <label for="answer-input">Deine Antwort</label>
      <input
        id="answer-input"
        class="answer-input"
        maxlength="60"
        autocomplete="off"
        enterkeyhint="done"
        placeholder="Antwort eingeben"
        aria-describedby="answer-hint"
      >
      <span class="char-count">
        <span id="char-count">0</span> / 60
      </span>
    </div>
    <p id="answer-hint" class="room-pill">
      Deine Antwort wird bei Zeitablauf automatisch gesendet.
      Du kannst sie bis dahin ändern.
    </p>
  `;

  const input = $("#answer-input", form);
  const count = $("#char-count", form);

  input.value = state.draftAnswer;
  count.textContent = String(input.value.length);

  input.addEventListener("input", () => {
    if (
      state.room?.status !== "answer" ||
      state.room.paused ||
      state.frozenAnswer ||
      serverNow() >= answerDeadline()
    ) {
      input.value = state.draftAnswer;
      freezeAnswerIfDue();
      clockTick();
      return;
    }

    state.draftAnswer = input.value;
    count.textContent = String(input.value.length);
  });

  // Die Enter-/Fertig-Taste sendet nicht vorzeitig an Firebase.
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    freezeAnswerIfDue();
    clockTick();
  });

  return form;
}

function freezeAnswerIfDue() {
  const room = state.room;

  if (
    !room ||
    !["answer", "collecting"].includes(room.status) ||
    !answerDeadline() ||
    serverNow() < answerDeadline()
  ) {
    return;
  }

  const key = roundKey();

  if (state.frozenAnswer?.key === key) return;

  const existing = getAnswer(state.uid);
  const form = $("#answer-form");
  const input = $("#answer-input");

  if (
    input &&
    form?.dataset.roundKey === key
  ) {
    // Der aktuelle Inhalt wird vor dem Entfernen des Formulars
    // einmalig eingefroren.
    state.draftAnswer = input.value;
    input.readOnly = true;
    input.blur();
  }

  const text = existing
    ? existing.text
    : cleanAnswer(state.draftAnswer);

  state.draftAnswer = text;

  state.frozenAnswer = {
    key,
    roomCode: state.roomCode,
    roundId: room.roundId || "",
    text,
    deadline: answerDeadline(),
    collectionEndsAt: collectionDeadline(),
    done: Boolean(existing),
    inFlight: false,
    nextRetryAt: 0,
    error: ""
  };
}

function publishFrozenAnswer() {
  const frozen = state.frozenAnswer;

  if (
    !frozen ||
    frozen.key !== roundKey() ||
    frozen.done ||
    frozen.inFlight ||
    !state.online ||
    !["answer", "collecting"].includes(state.room.status) ||
    serverNow() < frozen.deadline ||
    serverNow() > frozen.collectionEndsAt ||
    serverNow() < frozen.nextRetryAt
  ) {
    return;
  }

  // Alte, bereits laufende Räume sollen nicht mit einer
  // unpassenden Rundenzuordnung beschrieben werden.
  if (!frozen.roundId) {
    frozen.error =
      "Bitte ein neues Spiel starten, damit die neue automatische Übertragung verwendet werden kann.";
    return;
  }

  frozen.inFlight = true;
  frozen.error = "";

  const target = state.api.ref(
    state.db,
    `rooms/${frozen.roomCode}/answers/${state.uid}`
  );

  const payload = {
    text: frozen.text,
    roundId: frozen.roundId,
    submittedAt: state.api.serverTimestamp()
  };

  state.api.set(target, payload)
    .then(() => {
      frozen.done = true;
      frozen.inFlight = false;
      frozen.error = "";

      if (state.frozenAnswer === frozen) {
        clockTick();
      }
    })
    .catch((error) => {
      frozen.inFlight = false;
      frozen.error = friendlyError(error);
      frozen.nextRetryAt = serverNow() + 350;

      if (state.frozenAnswer === frozen) {
        clockTick();
      }
    });
}

function allAnswersReceived() {
  const players = Object.keys(state.room?.players || {});

  return (
    players.length > 0 &&
    players.every((uid) => Boolean(getAnswer(uid))) &&
    !(
      state.frozenAnswer &&
      state.frozenAnswer.key === roundKey() &&
      !state.frozenAnswer.done
    )
  );
}

function clockTick() {
  if (!state.room || !state.uid) return;

  syncLocalRound();
  freezeAnswerIfDue();
  publishFrozenAnswer();
  renderRoom();

  if (
    !isHost() ||
    !state.online ||
    state.room.paused ||
    state.phaseTransitioning ||
    serverNow() < state.transitionRetryAt
  ) {
    return;
  }

  const now = serverNow();

  if (
    state.room.status === "question" &&
    now >= Number(state.room.phaseEndsAt)
  ) {
    void advancePhase("answer");
  } else if (
    state.room.status === "answer" &&
    answerDeadline() > 0 &&
    now >= answerDeadline()
  ) {
    void advancePhase("collecting");
  } else if (
    state.room.status === "collecting" &&
    (
      allAnswersReceived() ||
      now >= collectionDeadline()
    )
  ) {
    void advancePhase("reveal");
  }
}

async function advancePhase(nextStatus) {
  if (!isHost() || state.phaseTransitioning) return;

  state.phaseTransitioning = true;

  const now = serverNow();
  let patch;

  if (nextStatus === "answer") {
    const deadline = now + answerDuration();

    patch = {
      status: "answer",
      phaseEndsAt: deadline,
      answerEndsAt: deadline,
      collectionEndsAt: deadline + COLLECTION_GRACE,
      lastActivity: now
    };
  } else if (nextStatus === "collecting") {
    patch = {
      status: "collecting",
      lastActivity: now
    };
  } else {
    patch = {
      status: "reveal",
      phaseEndsAt: null,
      lastActivity: now
    };
  }

  try {
    await state.api.update(roomRef(), patch);
    state.transitionRetryAt = 0;
  } catch (error) {
    console.warn("Phasenwechsel:", error);
    state.transitionRetryAt = serverNow() + 1000;
  } finally {
    state.phaseTransitioning = false;
  }
}

function updateTimer() {
  const timer = $("#timer");

  if (!timer || !state.room) return;

  const phase = viewPhase();

  if (!["question", "answer"].includes(phase)) {
    timer.hidden = true;
    return;
  }

  timer.hidden = false;

  const duration =
    phase === "question"
      ? QUESTION_DURATION
      : answerDuration();

  const deadline =
    phase === "question"
      ? Number(state.room.phaseEndsAt || 0)
      : answerDeadline();

  const remaining = Math.max(0, deadline - serverNow());
  const seconds = Math.ceil(remaining / 1000);
  const text = $("span", timer);

  if (text.textContent !== String(seconds)) {
    text.textContent = String(seconds);
  }

  timer.style.setProperty(
    "--progress",
    `${Math.max(
      0,
      Math.min(100, remaining / duration * 100)
    )}%`
  );

  timer.classList.toggle("warning", remaining <= 5000);
  timer.setAttribute(
    "aria-label",
    `Verbleibende Zeit: ${seconds} Sekunden`
  );
}

function createAnswerOverview() {
  const section = document.createElement("section");
  section.id = "answer-overview";
  section.className = "field";

  const title = document.createElement("h2");
  title.textContent = "Alle Antworten";

  const status = document.createElement("p");
  status.id = "answer-transfer-status";
  status.className = "room-pill";
  status.setAttribute("role", "status");

  const list = document.createElement("ul");
  list.id = "public-answer-list";
  list.className = "player-list";
  list.setAttribute("aria-label", "Antworten dieser Runde");

  section.append(title, status, list);
  return section;
}

function answerDisplayInfo(uid) {
  const answer = getAnswer(uid);
  const frozen =
    uid === state.uid &&
    state.frozenAnswer?.key === roundKey()
      ? state.frozenAnswer
      : null;

  if (frozen && !frozen.done) {
    const expired =
      serverNow() > frozen.collectionEndsAt ||
      ["reveal", "scoring", "results", "ended"].includes(
        state.room.status
      );

    return {
      text: frozen.text || "Keine Antwort eingegeben",
      note: frozen.inFlight
        ? "Wird übertragen …"
        : expired
          ? "Nicht übertragen – nur auf diesem Gerät vorhanden"
          : !state.online
            ? "Keine Verbindung – Übertragung wird versucht"
            : frozen.error
              ? "Übertragung wird erneut versucht …"
              : "Übertragung ausstehend …"
    };
  }

  if (answer) {
    return {
      text: answer.text || "Keine Antwort eingegeben",
      note: ""
    };
  }

  const collecting =
    ["answer", "collecting"].includes(state.room.status) &&
    serverNow() <= collectionDeadline();

  return {
    text: collecting
      ? "Übertragung ausstehend …"
      : "Keine Antwort empfangen",
    note: ""
  };
}

function updateAnswerOverview() {
  const section = $("#answer-overview");
  if (!section) return;

  const players = sortedPlayers(false);

  const items = players.map(([uid, player]) => ({
    uid,
    name: player.name,
    ...answerDisplayInfo(uid)
  }));

  const count = players.filter(([uid]) => getAnswer(uid)).length;
  const collecting =
    ["answer", "collecting"].includes(state.room.status);

  const message = collecting
    ? `${count} von ${players.length} Antworten empfangen. Die Eingabezeit ist beendet.`
    : "Die Eingabe ist geschlossen. Vergleicht eure Antworten.";

  const signature = JSON.stringify({ items, message });

  if (section.dataset.signature !== signature) {
    section.dataset.signature = signature;

    $("#answer-transfer-status", section).textContent = message;

    const list = $("#public-answer-list", section);
    const fragment = document.createDocumentFragment();

    items.forEach((item) => {
      const row = document.createElement("li");
      row.className = "player-row";

      const copy = document.createElement("div");
      copy.className = "answer-copy";

      const name = document.createElement("strong");
      name.textContent =
        item.uid === state.uid
          ? `${item.name} · Du`
          : item.name;

      const answer = document.createElement("span");
      answer.textContent = item.text;

      copy.append(name, answer);

      if (item.note) {
        const note = document.createElement("em");
        note.textContent = item.note;
        copy.append(note);
      }

      row.append(copy);
      fragment.append(row);
    });

    list.replaceChildren(fragment);
  }

  const scoring = $("#open-scoring-button");

  if (scoring) {
    scoring.disabled =
      state.room.status !== "reveal" ||
      Boolean(
        state.frozenAnswer &&
        !state.frozenAnswer.done &&
        state.frozenAnswer.inFlight
      );
  }
}

async function openScoring() {
  if (
    !isHost() ||
    state.room.status !== "reveal" ||
    state.actionBusy
  ) {
    return;
  }

  state.actionBusy = true;

  const scores = {};

  Object.entries(state.room.players || {}).forEach(
    ([uid, player]) => {
      scores[uid] = player.score || 0;
    }
  );

  state.scoringSelected = null;

  try {
    await state.api.update(roomRef(), {
      status: "scoring",
      scoringBaseScores: scores,
      lastActivity: serverNow()
    });
  } catch (error) {
    showActionError(error);
  } finally {
    state.actionBusy = false;
  }
}

function renderScoring() {
  const view = clone("#scoring-template");
  const list = $("#answer-list", view);

  if (!state.scoringSelected) {
    state.scoringSelected = new Set(
      Object.keys(state.room.winners || {})
    );
  }

  const question = document.createElement("p");
  question.className = "room-pill";
  question.textContent =
    QUESTIONS[state.room.questionIndex] || "";

  $("#scoring-form", view).before(question);

  sortedPlayers(false).forEach(([uid, player]) => {
    const li = document.createElement("li");
    li.className = "answer-option";

    const answer = getAnswer(uid);
    const hasText = Boolean(answer?.text?.trim());

    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = `score-${uid}`;
    input.value = uid;
    input.checked =
      hasText && state.scoringSelected.has(uid);
    input.disabled = !hasText;

    input.addEventListener("change", () => {
      if (input.checked) {
        state.scoringSelected.add(uid);
      } else {
        state.scoringSelected.delete(uid);
      }

      state.singleWarningArmed = false;
      const warning = $("#scoring-warning");
      if (warning) warning.hidden = true;
    });

    const label = document.createElement("label");
    label.htmlFor = input.id;

    const mark = document.createElement("span");
    mark.className = "checkmark";
    mark.textContent = "✓";

    const copy = document.createElement("span");
    copy.className = "answer-copy";

    const person = document.createElement("strong");
    person.textContent = player.name;

    const text = document.createElement("span");
    text.textContent =
      answer?.text ||
      (answer
        ? "Keine Antwort eingegeben"
        : "Keine Antwort empfangen");

    copy.append(person, text);

    if (!hasText) {
      const note = document.createElement("em");
      note.textContent = "Keine Punktevergabe möglich";
      copy.append(note);
    }

    label.append(mark, copy);
    li.append(input, label);
    list.append(li);
  });

  $("#scoring-form", view).addEventListener(
    "submit",
    confirmScoring
  );

  setScreen(view);
}

async function confirmScoring(event) {
  event.preventDefault();

  if (
    !isHost() ||
    state.room.status !== "scoring" ||
    state.actionBusy
  ) {
    return;
  }

  const selected = $$("#answer-list input:checked")
    .filter((input) => !input.disabled)
    .map((input) => input.value);

  const warning = $("#scoring-warning");

  if (selected.length === 1 && !state.singleWarningArmed) {
    warning.textContent =
      "Nur eine Person ist markiert. Für eine Übereinstimmung sind normalerweise mindestens zwei nötig. Noch einmal bestätigen, um trotzdem fortzufahren.";

    warning.hidden = false;
    state.singleWarningArmed = true;
    return;
  }

  state.singleWarningArmed = false;
  state.actionBusy = true;

  const winners = {};

  selected.forEach((uid) => {
    winners[uid] = true;
  });

  const patch = {
    status: "results",
    winners: selected.length ? winners : null,
    lastActivity: serverNow()
  };

  const base = state.room.scoringBaseScores || {};

  Object.keys(state.room.players || {}).forEach((uid) => {
    patch[`players/${uid}/score`] =
      (base[uid] || 0) + (winners[uid] ? 1 : 0);
  });

  try {
    await state.api.update(roomRef(), patch);
  } catch (error) {
    showActionError(error);
  } finally {
    state.actionBusy = false;
  }
}

function renderResults() {
  const view = clone("#results-template");
  const winners = state.room.winners || {};

  if (winners[state.uid]) {
    $("#result-title", view).textContent = "Ein Punkt für dich!";
  }

  const board = $("#leaderboard", view);
  appendLeaderboard(board, winners);

  // Die Antwortübersicht bleibt auch nach der Wertung sichtbar.
  board.after(createAnswerOverview());

  const actions = $("#result-actions", view);

  if (isHost()) {
    actions.append(
      button("Nächste Runde", "button-primary", beginNextRound),
      button(
        "Wertung korrigieren",
        "button-secondary",
        correctScoring
      ),
      button(
        "Spiel beenden",
        "button-ghost",
        confirmEndGame
      )
    );
  } else {
    actions.append(
      helper("Bereit für die nächste Runde? Die Spielleitung startet.")
    );
  }

  setScreen(view);
  updateAnswerOverview();

  if (
    winners[state.uid] &&
    state.celebratedRound !== roundKey()
  ) {
    state.celebratedRound = roundKey();
    launchConfetti();
    signal("win");
  }
}

async function correctScoring() {
  if (!isHost() || state.room.status !== "results") return;

  const patch = {
    status: "scoring",
    lastActivity: serverNow()
  };

  const base = state.room.scoringBaseScores || {};

  Object.keys(state.room.players || {}).forEach((uid) => {
    patch[`players/${uid}/score`] = base[uid] || 0;
  });

  state.scoringSelected = null;

  try {
    await state.api.update(roomRef(), patch);
  } catch (error) {
    showActionError(error);
  }
}

function appendLeaderboard(target, winners = {}) {
  sortedPlayers(true).forEach(([uid, player]) => {
    const li = document.createElement("li");

    if (uid === state.uid) li.classList.add("me");
    if (winners[uid]) li.classList.add("winner");

    const name = document.createElement("strong");
    name.textContent = player.name;

    const score = document.createElement("span");
    score.className = "score";
    score.textContent = player.score || 0;

    li.append(name, score);
    target.append(li);
  });
}

function sortedPlayers(byScore = false) {
  const entries = Object.entries(state.room?.players || {});

  if (byScore) {
    return entries.sort(
      (a, b) =>
        (b[1].score || 0) - (a[1].score || 0) ||
        (a[1].joinedAt || 0) - (b[1].joinedAt || 0)
    );
  }

  return entries.sort(
    (a, b) =>
      (a[1].joinedAt || 0) - (b[1].joinedAt || 0)
  );
}

function confirmEndGame() {
  showModal(
    "Spiel beenden?",
    "<p>Der aktuelle Punktestand bleibt in der Abschlussansicht sichtbar.</p>",
    [
      {
        label: "Weiterspielen",
        className: "button-ghost",
        action: closeModal
      },
      {
        label: "Spiel beenden",
        className: "button-danger",
        action: endGame
      }
    ]
  );
}

async function endGame() {
  if (!isHost()) return;
  closeModal();

  try {
    await state.api.update(roomRef(), {
      status: "ended",
      lastActivity: serverNow()
    });
  } catch (error) {
    showActionError(error);
  }
}

function renderEnded() {
  const view = clone("#ended-template");
  const ranking = sortedPlayers(true);
  const topScore = ranking[0]?.[1]?.score || 0;

  const winners = ranking
    .filter(([, player]) => (player.score || 0) === topScore)
    .map(([, player]) => player.name);

  $("#winner-copy", view).textContent =
    winners.length > 1
      ? `${winners.join(" und ")} teilen sich mit ${topScore} Punkten den Sieg.`
      : `${winners[0] || "Niemand"} gewinnt mit ${topScore} Punkten.`;

  appendLeaderboard($("#final-leaderboard", view));

  const actions = $("#ended-actions", view);

  if (isHost()) {
    actions.append(
      button("Revanche", "button-primary", rematch),
      button("Raum schließen", "button-ghost", closeRoom)
    );
  } else {
    actions.append(
      button("Zur Startseite", "button-secondary", leaveToHome)
    );
  }

  setScreen(view);
}

async function rematch() {
  if (!isHost()) return;

  const patch = {
    status: "lobby",
    round: 0,
    roundId: null,
    usedQuestions: null,
    answers: null,
    winners: null,
    scoringBaseScores: null,
    questionIndex: null,
    phaseEndsAt: null,
    answerEndsAt: null,
    collectionEndsAt: null,
    paused: false,
    lastActivity: serverNow()
  };

  Object.keys(state.room.players || {}).forEach((uid) => {
    patch[`players/${uid}/score`] = 0;
  });

  try {
    await state.api.update(roomRef(), patch);
  } catch (error) {
    showActionError(error);
  }
}

async function closeRoom() {
  if (!isHost()) return;

  try {
    await state.api.remove(roomRef());
  } catch (error) {
    showActionError(error);
  }
}

function renderPaused() {
  const section = document.createElement("section");
  section.className = "screen loading-screen";

  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "Spiel pausiert";

  const title = document.createElement("h1");
  title.textContent =
    "Verbindung zur Spielleitung unterbrochen";

  const copy = document.createElement("p");
  copy.textContent =
    "Das Spiel wartet auf die Rückkehr. Eine bereits gestartete Antwortfrist wird nicht verlängert.";

  const countdown = document.createElement("p");
  countdown.id = "takeover-countdown";
  countdown.className = "score";

  const takeover = button(
    "Spielleitung übernehmen",
    "button-primary",
    takeOverHost
  );

  takeover.id = "takeover-button";
  takeover.hidden = true;

  section.append(
    eyebrow,
    title,
    copy,
    countdown,
    takeover
  );

  setScreen(section);
}

function updatePausedCountdown() {
  const countdown = $("#takeover-countdown");
  const takeover = $("#takeover-button");

  if (!countdown || !takeover) return;

  const host = state.room.players?.[state.room.hostId];

  const elapsed = Math.max(
    0,
    serverNow() - (host?.lastSeen || serverNow())
  );

  const remaining = Math.max(0, TAKEOVER_WAIT - elapsed);
  const text = `${Math.ceil(remaining / 1000)} s`;

  if (countdown.textContent !== text) {
    countdown.textContent = text;
  }

  takeover.hidden = !(isDeputy() && remaining <= 0);
}

async function takeOverHost() {
  if (!isDeputy() || !state.room.paused) return;

  const host = state.room.players?.[state.room.hostId];

  if (
    serverNow() - (host?.lastSeen || serverNow()) <
    TAKEOVER_WAIT
  ) {
    return;
  }

  try {
    await state.api.update(roomRef(), {
      hostId: state.uid,
      paused: false,
      lastActivity: serverNow()
    });

    await syncHostDisconnect();
  } catch (error) {
    showActionError(error);
  }
}

async function handleRemovedOrClosed() {
  const uid = state.uid;

  disconnectRoomListener();

  state.roomCode = null;
  state.room = null;
  resetLocalRound();

  roomPill.hidden = true;
  showHome();

  if (uid && state.db) {
    try {
      await state.api.remove(
        state.api.ref(state.db, `sessions/${uid}`)
      );
    } catch (_) {}
  }

  showModal(
    "Spiel beendet",
    "<p>Der Raum wurde geschlossen oder du wurdest aus dem Warteraum entfernt.</p>",
    [{
      label: "OK",
      className: "button-primary",
      action: closeModal
    }]
  );
}

async function leaveToHome() {
  closeModal();

  const code = state.roomCode;
  const uid = state.uid;
  const wasHost = isHost();

  disconnectRoomListener();

  state.roomCode = null;
  state.room = null;
  resetLocalRound();
  showHome();

  if (!uid || !state.db) return;

  try {
    if (code) {
      const target = state.api.ref(state.db, `rooms/${code}`);

      if (wasHost) {
        await state.api.update(target, {
          paused: true,
          [`players/${uid}/online`]: false,
          [`players/${uid}/lastSeen`]:
            state.api.serverTimestamp(),
          lastActivity: serverNow()
        });
      } else {
        await state.api.remove(
          state.api.ref(
            state.db,
            `rooms/${code}/players/${uid}`
          )
        );
      }
    }

    await state.api.remove(
      state.api.ref(state.db, `sessions/${uid}`)
    );
  } catch (error) {
    console.warn(error);
  }
}

function requestLeave() {
  if (!state.roomCode) {
    showHome();
    return;
  }

  const message = isHost()
    ? "Als Spielleitung solltest du den Raum über „Spiel beenden“ schließen. Wirklich zur Startseite?"
    : "Möchtest du das laufende Spiel verlassen?";

  showModal(
    "Spiel verlassen?",
    `<p>${message}</p>`,
    [
      {
        label: "Im Spiel bleiben",
        className: "button-ghost",
        action: closeModal
      },
      {
        label: "Verlassen",
        className: "button-danger",
        action: leaveToHome
      }
    ]
  );
}

function showRules() {
  showModal(
    "So funktioniert’s",
    `
    <ol class="rules-list">
      <li>Die Spielleitung wählt im Warteraum
      15, 20, 25 oder 30 Sekunden Antwortzeit.</li>
      <li>Eine Aussage erscheint zunächst fünf Sekunden lang.</li>
      <li>Danach geben alle ihre Antwort ein.
      Bis zum Zeitablauf kann sie geändert werden.</li>
      <li>Bei Zeitablauf wird die Eingabe gesperrt und
      automatisch übertragen.</li>
      <li>Alle sehen anschließend die Übersicht der Antworten.</li>
      <li>Die Spielleitung markiert Personen mit gleichen
      Antworten. Jede markierte Person erhält einen Punkt.</li>
      <li>Nach dem Zwischenstand startet die Spielleitung
      die nächste Runde.</li>
    </ol>
    <label class="player-row">
      <input id="signals-toggle" type="checkbox"
      ${state.signals ? "checked" : ""}>
      Ton und Vibration verwenden
    </label>
    `,
    [{
      label: "Schließen",
      className: "button-primary",
      action: () => {
        state.signals = Boolean(
          $("#signals-toggle")?.checked
        );
        closeModal();
      }
    }]
  );
}

function showModal(title, html, actions = []) {
  closeModal();

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";

  backdrop.innerHTML = `
    <section class="modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title">
      <header class="modal-header">
        <h2 id="modal-title">${escapeHtml(title)}</h2>
        <button class="modal-close"
          type="button"
          aria-label="Schließen">×</button>
      </header>
      <div class="modal-copy">${html}</div>
      <div class="sticky-actions"></div>
    </section>
  `;

  $(".modal-close", backdrop).addEventListener(
    "click",
    closeModal
  );

  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) closeModal();
  });

  const area = $(".sticky-actions", backdrop);

  actions.forEach((item) => {
    area.append(
      button(item.label, item.className, item.action)
    );
  });

  modalRoot.append(backdrop);

  setTimeout(() => {
    $(".modal-close", backdrop)?.focus();
  }, 50);
}

function closeModal() {
  modalRoot.replaceChildren();
}

function signal(type) {
  if (!state.signals) return;

  if (navigator.vibrate) {
    navigator.vibrate(
      type === "win" ? [80, 40, 120] : 40
    );
  }

  try {
    const context =
      new (window.AudioContext || window.webkitAudioContext)();

    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.frequency.value =
      type === "win" ? 740 : 520;

    gain.gain.setValueAtTime(0.08, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(
      0.001,
      context.currentTime + 0.18
    );

    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.18);
    oscillator.onended = () => context.close();
  } catch (_) {}
}

function launchConfetti() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }

  const canvas = $("#confetti");
  const context = canvas.getContext("2d");
  const ratio = Math.min(devicePixelRatio || 1, 2);

  canvas.width = innerWidth * ratio;
  canvas.height = innerHeight * ratio;
  context.scale(ratio, ratio);

  const colors = [
    "#009D43",
    "#EB6608",
    "#FFCB03",
    "#009CC4",
    "#ffffff"
  ];

  const pieces = Array.from({ length: 90 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 80,
    y: innerHeight * 0.35,
    vx: (Math.random() - 0.5) * 12,
    vy: -5 - Math.random() * 9,
    gravity: 0.22 + Math.random() * 0.12,
    size: 5 + Math.random() * 7,
    color: colors[Math.floor(Math.random() * colors.length)],
    rotation: Math.random() * Math.PI
  }));

  const start = performance.now();

  function frame(now) {
    context.clearRect(0, 0, innerWidth, innerHeight);

    pieces.forEach((piece) => {
      piece.x += piece.vx;
      piece.y += piece.vy;
      piece.vy += piece.gravity;
      piece.rotation += 0.12;

      context.save();
      context.translate(piece.x, piece.y);
      context.rotate(piece.rotation);
      context.fillStyle = piece.color;

      context.fillRect(
        -piece.size / 2,
        -piece.size / 3,
        piece.size,
        piece.size * 0.65
      );

      context.restore();
    });

    if (now - start < 2200) {
      requestAnimationFrame(frame);
    } else {
      context.clearRect(0, 0, innerWidth, innerHeight);
    }
  }

  requestAnimationFrame(frame);
}

function friendlyError(error) {
  const code = String(error?.code || "").toLowerCase();

  if (
    code.includes("permission-denied") ||
    code.includes("permission_denied")
  ) {
    return "Der Zugriff wurde abgelehnt. Prüfe, ob die neuen Firebase-Regeln veröffentlicht sind.";
  }

  if (code.includes("network")) {
    return "Keine Verbindung zum Spielserver. Bitte prüfe das Internet.";
  }

  if (code.includes("operation-not-allowed")) {
    return "Die anonyme Anmeldung ist in Firebase noch nicht aktiviert.";
  }

  return (
    error?.message ||
    "Etwas ist schiefgegangen. Bitte versuche es erneut."
  );
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>'"]/g,
    (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;"
    }[char])
  );
}

appRoot.addEventListener("click", (event) => {
  const action =
    event.target.closest("[data-action]")?.dataset.action;

  if (!action) return;

  if (action === "show-create") showEntry("create");
  if (action === "show-join") showEntry("join");
  if (action === "show-rules") showRules();
  if (action === "home") showHome();
});

appRoot.addEventListener("submit", async (event) => {
  if (event.target.id !== "entry-form") return;

  event.preventDefault();

  const error = $("#form-error");
  const submit =
    event.submitter ||
    $('button[type="submit"]', event.target);

  const name = cleanName($("#player-name").value);

  if (name.length < 2) {
    error.textContent =
      "Bitte gib einen Namen mit mindestens zwei Zeichen ein.";
    error.hidden = false;
    return;
  }

  submit.disabled = true;
  error.hidden = true;

  try {
    if (event.target.dataset.mode === "create") {
      await createRoom(name);
    } else {
      await joinRoom($("#room-code").value, name);
    }
  } catch (err) {
    error.textContent = friendlyError(err);
    error.hidden = false;
    submit.disabled = false;
  }
});

$("#brand-home").addEventListener("click", requestLeave);

window.addEventListener("offline", () => {
  setConnection(false);
});

window.addEventListener("online", () => {
  // Der tatsächliche Firebase-Verbindungsstatus wird über
  // .info/connected gemeldet.
  clockTick();
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeModal();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) clockTick();
});

window.addEventListener("pageshow", clockTick);

// Ein einziger Taktgeber. Er ersetzt keine aktiven Eingabefelder.
setInterval(clockTick, 100);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./service-worker.js")
      .then((registration) => registration.update())
      .catch(console.warn);
  });
}

initFirebase();
