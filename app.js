import { QUESTIONS } from "./questions.js";
import { firebaseConfig, firebaseIsConfigured } from "./firebase-config.js";

const FIREBASE_VERSION = "13.0.0";
const FIREBASE_BASE = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
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
  timerId: null,
  pausedTimerId: null,
  serverOffset: 0,
  phaseTransitioning: false,
  singleWarningArmed: false,
  signals: false,
  draftAnswer: "",
  draftRound: null,
  online: navigator.onLine
};

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const clone = (id) => document.querySelector(id).content.cloneNode(true);
const serverNow = () => Date.now() + state.serverOffset;
const roomRef = (path = "") => state.api.ref(state.db, `rooms/${state.roomCode}${path ? `/${path}` : ""}`);
const isHost = () => Boolean(state.room && state.uid === state.room.hostId);
const isDeputy = () => Boolean(state.room && state.uid === state.room.deputyId);
const currentPlayer = () => state.room?.players?.[state.uid] || null;
const cleanName = (value) => value.trim().replace(/\s+/g, " ").slice(0, 24);
const cleanAnswer = (value) => value.trim().replace(/\s+/g, " ").slice(0, 60);

function setScreen(fragment) {
  clearTimers();
  appRoot.replaceChildren(fragment);
  appRoot.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: "instant" });
}

function clearTimers() {
  clearInterval(state.timerId);
  clearInterval(state.pausedTimerId);
  state.timerId = null;
  state.pausedTimerId = null;
}

function setConnection(online) {
  state.online = online;
  connectionDot.classList.toggle("online", online);
  connectionDot.classList.toggle("offline", !online);
  connectionDot.setAttribute("aria-label", online ? "Verbunden" : "Nicht verbunden");
  offlineBanner.hidden = online;
}

function showHome() {
  const view = clone("#home-template");
  const note = $("#setup-note", view);
  if (!firebaseIsConfigured) {
    note.hidden = false;
    note.textContent = "Vor dem ersten Mehrspieler-Test muss Firebase einmal eingerichtet werden. Die Anleitung liegt dem Paket bei.";
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
  $("#form-eyebrow", view).textContent = joining ? "Mitspielen" : "Neues Spiel";
  $("#form-title", view).textContent = joining ? "Code und Name" : "Wie heißt du?";
  $("#code-field", view).hidden = !joining;
  const form = $("#entry-form", view);
  form.dataset.mode = mode;
  setScreen(view);
  setTimeout(() => $(joining ? "#room-code" : "#player-name")?.focus(), 80);
}

function showSetupModal() {
  showModal(
    "Firebase fehlt noch",
    `<p>Trage zuerst die Werte deines Firebase-Projekts in <strong>firebase-config.js</strong> ein. Danach funktionieren Spielcode und Live-Synchronisation.</p><p>Die Datei <strong>FIREBASE-SETUP.md</strong> führt dich Schritt für Schritt durch die Einrichtung.</p>`,
    [{ label: "Verstanden", className: "button-primary", action: closeModal }]
  );
}

async function initFirebase() {
  if (!firebaseIsConfigured) {
    connectionDot.classList.remove("online", "offline");
    connectionDot.setAttribute("aria-label", "Firebase noch nicht eingerichtet");
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
      await authApi.setPersistence(state.auth, authApi.browserLocalPersistence);
    } catch (error) {
      console.warn("Dauerhafte Anmeldung nicht verfügbar:", error);
    }

    dbApi.onValue(dbApi.ref(state.db, ".info/serverTimeOffset"), (snapshot) => {
      state.serverOffset = snapshot.val() || 0;
    });

    dbApi.onValue(dbApi.ref(state.db, ".info/connected"), (snapshot) => {
      setConnection(snapshot.val() === true);
    });

    authApi.onAuthStateChanged(state.auth, async (user) => {
      if (!user) {
        await authApi.signInAnonymously(state.auth);
        return;
      }
      state.uid = user.uid;
      await restoreSession();
    });
  } catch (error) {
    console.error(error);
    showHome();
    showModal("Verbindung nicht möglich", `<p>${friendlyError(error)}</p>`, [
      { label: "Erneut versuchen", className: "button-primary", action: () => location.reload() }
    ]);
  }
}

async function restoreSession() {
  const { get, ref, remove } = state.api;
  const sessionSnapshot = await get(ref(state.db, `sessions/${state.uid}`));
  const code = sessionSnapshot.val()?.roomCode;
  if (!code) {
    showHome();
    return;
  }

  const snapshot = await get(ref(state.db, `rooms/${code}`));
  const room = snapshot.val();
  const expired = room && serverNow() - (room.lastActivity || room.createdAt || 0) > 6 * 60 * 60 * 1000;
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

  for (let attempt = 0; attempt < 30 && !committed; attempt += 1) {
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
      players: {
        [state.uid]: { name, score: 0, online: true, joinedAt: now, lastSeen: now }
      },
      usedQuestions: {}
    };

    const result = await runTransaction(
      ref(state.db, `rooms/${code}`),
      (current) =>
        current === null || now - (current.lastActivity || current.createdAt || 0) > 6 * 60 * 60 * 1000
          ? newRoom
          : undefined,
      { applyLocally: false }
    );
    committed = result.committed;
  }

  if (!committed) throw new Error("Es konnte kein freier Spielcode erzeugt werden.");
  await set(ref(state.db, `sessions/${state.uid}`), { roomCode: code });
  connectToRoom(code);
}

async function joinRoom(code, name) {
  const { get, ref, set } = state.api;
  const normalizedCode = code.replace(/\D/g, "").slice(0, 4);
  if (normalizedCode.length !== 4) throw new Error("Der Spielcode muss aus vier Ziffern bestehen.");

  const targetRef = ref(state.db, `rooms/${normalizedCode}`);
  const snapshot = await get(targetRef);
  const room = snapshot.val();

  if (!room) throw new Error("Unter diesem Code wurde kein Spiel gefunden.");
  if (serverNow() - (room.lastActivity || room.createdAt || 0) > 6 * 60 * 60 * 1000) {
    throw new Error("Dieser Spielraum ist nicht mehr aktiv.");
  }
  if (room.status !== "lobby") throw new Error("Dieses Spiel läuft bereits.");

  const players = Object.values(room.players || {});
  if (players.length >= 8) throw new Error("Dieser Spielraum ist bereits voll.");
  if (players.some((player) => player.name.toLocaleLowerCase("de") === name.toLocaleLowerCase("de"))) {
    throw new Error("Dieser Name wird im Spiel bereits verwendet.");
  }

  const now = serverNow();
  await set(ref(state.db, `rooms/${normalizedCode}/players/${state.uid}`), {
    name,
    score: 0,
    online: true,
    joinedAt: now,
    lastSeen: now
  });

  await set(ref(state.db, `sessions/${state.uid}`), { roomCode: normalizedCode });
  connectToRoom(normalizedCode);
}

function connectToRoom(code) {
  disconnectRoomListener();
  state.roomCode = code;
  roomPill.hidden = false;
  roomCodeSmall.textContent = code;

  const { onValue } = state.api;
  state.roomUnsub = onValue(
    roomRef(),
    (snapshot) => {
      const room = snapshot.val();
      if (!room || !room.players?.[state.uid]) {
        handleRemovedOrClosed();
        return;
      }

      state.room = room;
      registerPresence();

      if (isHost() && room.deputyId && !room.players[room.deputyId]) {
        state.api.update(roomRef(), { deputyId: "", lastActivity: serverNow() });
        return;
      }

      if (isHost() && room.paused && room.players[state.uid]?.online) {
        resumeAfterHostReturn();
        return;
      }

      renderRoom();
    },
    (error) => {
      console.error(error);
      showModal("Spiel nicht erreichbar", `<p>${friendlyError(error)}</p>`, [
        { label: "Zur Startseite", className: "button-primary", action: leaveToHome }
      ]);
    }
  );
}

function disconnectRoomListener() {
  state.roomUnsub?.();
  state.connectionUnsub?.();
  state.roomUnsub = null;
  state.connectionUnsub = null;
  clearTimers();
}

function registerPresence() {
  if (state.connectionUnsub) return;

  const { onValue, ref, update, onDisconnect, serverTimestamp } = state.api;
  const connectedRef = ref(state.db, ".info/connected");

  state.connectionUnsub = onValue(connectedRef, async (snapshot) => {
    if (snapshot.val() !== true || !state.roomCode) return;

    const playerRef = roomRef(`players/${state.uid}`);
    await onDisconnect(playerRef).update({ online: false, lastSeen: serverTimestamp() });

    if (isHost()) {
      await onDisconnect(roomRef("paused")).set(true);
    }

    await update(playerRef, { online: true, lastSeen: serverNow() });
  });
}

async function resumeAfterHostReturn() {
  if (state.phaseTransitioning) return;
  state.phaseTransitioning = true;

  const patch = { paused: false, lastActivity: serverNow() };
  if (state.room.status === "question") patch.phaseEndsAt = serverNow() + 5000;
  if (state.room.status === "answer") patch.phaseEndsAt = serverNow() + 15000;

  await state.api.update(roomRef(), patch);
  state.phaseTransitioning = false;
}

function renderRoom() {
  if (!state.room) return;

  if (state.room.paused && !isHost()) {
    renderPaused();
    return;
  }

  switch (state.room.status) {
    case "lobby":
      renderLobby();
      break;
    case "question":
    case "answer":
    case "reveal":
      renderRound();
      break;
    case "scoring":
      isHost() ? renderScoring() : renderRound();
      break;
    case "results":
      renderResults();
      break;
    case "ended":
      renderEnded();
      break;
    default:
      renderLobby();
  }
}

function renderLobby() {
  const view = clone("#lobby-template");
  $("#copy-code", view).textContent = state.roomCode;

  const players = sortedPlayers(false);
  $("#player-count", view).textContent = `${players.length} / 8`;

  const list = $("#lobby-list", view);
  players.forEach(([uid, player]) => list.append(createPlayerRow(uid, player)));

  const actions = $("#lobby-actions", view);

  if (isHost()) {
    const start = button("Spiel starten", "button-primary", startGame);
    start.disabled = players.length < 2 || !state.room.deputyId;
    actions.append(start);

    if (players.length < 2) {
      actions.prepend(helper("Mindestens zwei Personen müssen im Warteraum sein."));
    } else if (!state.room.deputyId) {
      actions.prepend(helper("Bestimme eine Stellvertretung, bevor das Spiel startet."));
    }
  } else {
    actions.append(helper("Der Spielleiter startet, sobald alle da sind."));
  }

  setScreen(view);
}

function createPlayerRow(uid, player) {
  const li = document.createElement("li");
  li.className = "player-row";

  const avatar = document.createElement("span");
  avatar.className = "player-avatar";
  avatar.textContent = player.name.charAt(0).toLocaleUpperCase("de");

  const name = document.createElement("span");
  name.className = "player-name";
  name.textContent = player.name;

  const tags = document.createElement("span");
  tags.className = "player-tags";

  const presence = document.createElement("span");
  presence.className = `presence ${player.online ? "online" : ""}`;
  presence.title = player.online ? "Verbunden" : "Nicht verbunden";
  tags.append(presence);

  if (uid === state.room.hostId) tags.append(tag("Spielleitung"));
  if (uid === state.room.deputyId) tags.append(tag("Vertretung"));

  li.append(avatar, name, tags);

  if (isHost() && uid !== state.uid) {
    const select = document.createElement("button");
    select.className = "deputy-select";
    select.type = "button";
    select.textContent = uid === state.room.deputyId ? "Vertretung ✓" : "Als Vertretung";
    select.addEventListener("click", () => setDeputy(uid));
    li.append(select);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-player";
    remove.setAttribute("aria-label", `${player.name} entfernen`);
    remove.textContent = "×";
    remove.addEventListener("click", () => confirmRemove(uid, player.name));
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

async function setDeputy(uid) {
  await state.api.update(roomRef(), { deputyId: uid, lastActivity: serverNow() });
}

function confirmRemove(uid, name) {
  showModal("Mitspieler entfernen?", `<p><strong>${escapeHtml(name)}</strong> wird aus dem Warteraum entfernt.</p>`, [
    { label: "Abbrechen", className: "button-ghost", action: closeModal },
    {
      label: "Entfernen",
      className: "button-danger",
      action: async () => {
        closeModal();
        await state.api.update(roomRef(), {
          [`players/${uid}`]: null,
          deputyId: state.room.deputyId === uid ? "" : state.room.deputyId,
          lastActivity: serverNow()
        });
      }
    }
  ]);
}

async function startGame() {
  if (!isHost()) return;
  const players = Object.keys(state.room.players || {});
  if (players.length < 2 || !state.room.deputyId) return;
  await beginNextRound();
}

async function beginNextRound() {
  state.draftAnswer = "";
  state.draftRound = null;
  const used = new Set(Object.keys(state.room.usedQuestions || {}).map(Number));
  const available = QUESTIONS.map((_, index) => index).filter((index) => !used.has(index));

  if (!available.length) {
    showQuestionExhausted();
    return;
  }

  const questionIndex = available[Math.floor(Math.random() * available.length)];
  const now = serverNow();

  await state.api.update(roomRef(), {
    status: "question",
    paused: false,
    round: (state.room.round || 0) + 1,
    questionIndex,
    phaseEndsAt: now + 5000,
    answers: null,
    winners: null,
    scoringBaseScores: null,
    [`usedQuestions/${questionIndex}`]: true,
    lastActivity: now
  });
}

function showQuestionExhausted() {
  showModal("Alle Aussagen gespielt", "<p>Alle Aussagen wurden in diesem Spiel bereits verwendet.</p>", [
    { label: "Spiel beenden", className: "button-ghost", action: endGame },
    {
      label: "Neu mischen",
      className: "button-primary",
      action: async () => {
        closeModal();
        await state.api.update(roomRef(), { usedQuestions: null, lastActivity: serverNow() });
        state.room.usedQuestions = {};
        await beginNextRound();
      }
    }
  ]);
}

function renderRound() {
  const view = clone("#round-template");
  $("#round-label", view).textContent = `Runde ${state.room.round || 1}`;
  $("#question-text", view).textContent = QUESTIONS[state.room.questionIndex] || "–";
  const content = $("#round-content", view);
  const status = state.room.status;

  if (status === "question") {
    content.append(helper("Merkt euch die Aussage. Gleich könnt ihr antworten."));
  } else if (status === "answer") {
    content.append(createAnswerForm());
  } else if (status === "reveal") {
    content.append(createOwnAnswer());
    if (isHost()) {
      content.append(button("Punkte vergeben", "button-primary", openScoring));
    } else {
      content.append(helper("Zeigt euch eure Antworten. Die Spielleitung vergibt danach die Punkte."));
    }
  } else if (status === "scoring") {
    content.append(createOwnAnswer());
    content.append(helper("Die Spielleitung wertet gerade die Antworten aus."));
  }

  setScreen(view);

  if (status === "question") startPhaseTimer(5000, "answer");
  if (status === "answer") startPhaseTimer(15000, "reveal");
  if (status === "answer") setTimeout(() => $("#answer-input")?.focus(), 100);
}

function createAnswerForm() {
  const form = document.createElement("form");
  form.className = "answer-form";
  form.id = "answer-form";

  if (state.draftRound !== state.room.round) {
    state.draftRound = state.room.round;
    state.draftAnswer = "";
    state.draftRound = null;
  }

  const current = state.room.answers?.[state.uid]?.text || "";
  const draft = state.draftAnswer || current;

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
        value="${escapeAttr(draft)}"
      />
      <span class="char-count"><span id="char-count">${draft.length}</span> / 60</span>
    </div>
    <p id="answer-error" class="form-error" role="alert" hidden></p>
    <button class="button button-primary" type="submit">
      ${current ? "Antwort aktualisieren" : "Antwort bestätigen"}
    </button>
  `;

  const input = $("#answer-input", form);
  const count = $("#char-count", form);

  input.addEventListener("input", () => {
    state.draftAnswer = input.value;
    count.textContent = input.value.length;
  });

  form.addEventListener("submit", submitAnswer);
  return form;
}

async function submitAnswer(event) {
  event.preventDefault();
  const input = $("#answer-input");
  const error = $("#answer-error");
  const answer = cleanAnswer(input.value);

  if (!answer) {
    error.textContent = "Bitte gib eine Antwort ein.";
    error.hidden = false;
    return;
  }

  if (state.room.status !== "answer" || serverNow() > state.room.phaseEndsAt) {
    error.textContent = "Die Antwortzeit ist bereits abgelaufen.";
    error.hidden = false;
    return;
  }

  const submit = event.submitter;
  submit.disabled = true;

  try {
    await state.api.set(roomRef(`answers/${state.uid}`), {
      text: answer,
      submittedAt: serverNow()
    });

    state.draftAnswer = answer;
    
    submit.textContent = "Gespeichert ✓";
    signal("success");

    setTimeout(() => {
      if (submit.isConnected) {
        submit.disabled = false;
        submit.textContent = "Antwort aktualisieren";
      }
    }, 700);
  } catch (err) {
    error.textContent = friendlyError(err);
    error.hidden = false;
    submit.disabled = false;
  }
}

function createOwnAnswer() {
  const wrap = document.createElement("div");
  wrap.className = "own-answer";
  const answer = state.room.answers?.[state.uid]?.text || "Keine Antwort";

  const label = document.createElement("p");
  label.textContent = "Deine Antwort";

  const display = document.createElement("div");
  display.className = "answer-display";
  display.textContent = answer;

  wrap.append(label, display);
  return wrap;
}

function startPhaseTimer(duration, nextStatus) {
  const timer = $("#timer");
  if (!timer) return;

  const tick = async () => {
    const remaining = Math.max(0, state.room.phaseEndsAt - serverNow());
    const seconds = Math.ceil(remaining / 1000);
    $("span", timer).textContent = seconds;
    timer.style.setProperty("--progress", `${Math.max(0, Math.min(100, (remaining / duration) * 100))}%`);
    timer.classList.toggle("warning", remaining <= 5000);

    if (remaining <= 0 && isHost() && !state.phaseTransitioning) {
      state.phaseTransitioning = true;
      clearInterval(state.timerId);

      try {
        const patch =
          nextStatus === "answer"
            ? { status: "answer", phaseEndsAt: serverNow() + 15000, lastActivity: serverNow() }
            : { status: "reveal", phaseEndsAt: null, lastActivity: serverNow() };
        await state.api.update(roomRef(), patch);
      } finally {
        state.phaseTransitioning = false;
      }
    }
  };

  tick();
  state.timerId = setInterval(tick, 100);
}

async function openScoring() {
  const scores = {};
  Object.entries(state.room.players || {}).forEach(([uid, player]) => {
    scores[uid] = player.score || 0;
  });

  await state.api.update(roomRef(), {
    status: "scoring",
    scoringBaseScores: scores,
    lastActivity: serverNow()
  });
}

function renderScoring() {
  const view = clone("#scoring-template");
  const list = $("#answer-list", view);

  sortedPlayers(false).forEach(([uid, player]) => {
    const li = document.createElement("li");
    li.className = "answer-option";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = `score-${uid}`;
    input.value = uid;
    input.checked = Boolean(state.room.winners?.[uid]);

    const label = document.createElement("label");
    label.htmlFor = input.id;

    const mark = document.createElement("span");
    mark.className = "checkmark";
    mark.textContent = "✓";

    const copy = document.createElement("span");
    copy.className = "answer-copy";

    const person = document.createElement("strong");
    person.textContent = player.name;

    const answer = document.createElement("span");
    answer.textContent = state.room.answers?.[uid]?.text || "Keine Antwort";

    copy.append(person, answer);

    if (!state.room.answers?.[uid]) {
      const note = document.createElement("em");
      note.textContent = "Nicht abgegeben";
      copy.append(note);
    }

    label.append(mark, copy);
    li.append(input, label);
    list.append(li);
  });

  $("#scoring-form", view).addEventListener("submit", confirmScoring);
  setScreen(view);
}

async function confirmScoring(event) {
  event.preventDefault();
  const selected = $$("#answer-list input:checked").map((input) => input.value);
  const warning = $("#scoring-warning");

  if (selected.length === 1 && !state.singleWarningArmed) {
    warning.textContent =
      "Nur eine Person ist markiert. Für eine Übereinstimmung sind normalerweise mindestens zwei nötig. Noch einmal bestätigen, um trotzdem fortzufahren.";
    warning.hidden = false;
    state.singleWarningArmed = true;
    return;
  }

  state.singleWarningArmed = false;
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
    patch[`players/${uid}/score`] = (base[uid] || 0) + (winners[uid] ? 1 : 0);
  });

  await state.api.update(roomRef(), patch);
}

function renderResults() {
  const view = clone("#results-template");
  const winners = state.room.winners || {};

  if (winners[state.uid]) {
    $("#result-title", view).textContent = "Ein Punkt für dich!";
  }

  const board = $("#leaderboard", view);
  appendLeaderboard(board, winners);

  const answers = document.createElement("details");
  answers.className = "room-code-block";

  const summary = document.createElement("summary");
  summary.textContent = "Antworten dieser Runde anzeigen";

  const list = document.createElement("ul");
  list.className = "player-list";

  sortedPlayers(false).forEach(([uid, player]) => {
    const row = document.createElement("li");
    row.className = "player-row";

    const name = document.createElement("strong");
    name.textContent = player.name;

    const answer = document.createElement("span");
    answer.className = "player-tags";
    answer.textContent = state.room.answers?.[uid]?.text || "Keine Antwort";

    row.append(name, answer);
    list.append(row);
  });

  answers.append(summary, list);
  board.after(answers);

  const actions = $("#result-actions", view);
  if (isHost()) {
    actions.append(button("Nächste Runde", "button-primary", beginNextRound));
    actions.append(button("Wertung korrigieren", "button-secondary", correctScoring));
    actions.append(button("Spiel beenden", "button-ghost", confirmEndGame));
  } else {
    actions.append(helper("Bereit für die nächste Runde? Die Spielleitung startet."));
  }

  setScreen(view);

  if (winners[state.uid]) {
    launchConfetti();
    signal("win");
  }
}

async function correctScoring() {
  const patch = { status: "scoring", lastActivity: serverNow() };
  const base = state.room.scoringBaseScores || {};

  Object.keys(state.room.players || {}).forEach((uid) => {
    patch[`players/${uid}/score`] = base[uid] || 0;
  });

  await state.api.update(roomRef(), patch);
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
      (a, b) => (b[1].score || 0) - (a[1].score || 0) || (a[1].joinedAt || 0) - (b[1].joinedAt || 0)
    );
  }
  return entries.sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
}

function confirmEndGame() {
  showModal("Spiel beenden?", "<p>Der aktuelle Punktestand bleibt in der Abschlussansicht sichtbar.</p>", [
    { label: "Weiterspielen", className: "button-ghost", action: closeModal },
    { label: "Spiel beenden", className: "button-danger", action: endGame }
  ]);
}

async function endGame() {
  closeModal();
  await state.api.update(roomRef(), { status: "ended", lastActivity: serverNow() });
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
    actions.append(button("Revanche", "button-primary", rematch));
    actions.append(button("Raum schließen", "button-ghost", closeRoom));
  } else {
    actions.append(button("Zur Startseite", "button-secondary", leaveToHome));
  }

  setScreen(view);
}

async function rematch() {
  state.draftAnswer = "";
  state.draftRound = null;
  
  const patch = {
    status: "lobby",
    round: 0,
    usedQuestions: null,
    answers: null,
    winners: null,
    scoringBaseScores: null,
    questionIndex: null,
    phaseEndsAt: null,
    paused: false,
    lastActivity: serverNow()
  };

  Object.keys(state.room.players || {}).forEach((uid) => {
    patch[`players/${uid}/score`] = 0;
  });

  await state.api.update(roomRef(), patch);
}

async function closeRoom() {
  if (!isHost()) return;
  await state.api.remove(roomRef());
}

function renderPaused() {
  const section = document.createElement("section");
  section.className = "screen loading-screen";

  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "Spiel pausiert";

  const title = document.createElement("h1");
  title.textContent = "Verbindung zur Spielleitung unterbrochen";

  const copy = document.createElement("p");
  copy.textContent = "Das Spiel wartet bis zu zwei Minuten auf die Rückkehr.";

  const countdown = document.createElement("p");
  countdown.className = "score";

  section.append(eyebrow, title, copy, countdown);

  const takeover = button("Spielleitung übernehmen", "button-primary", takeOverHost);
  takeover.hidden = true;
  section.append(takeover);

  setScreen(section);

  const tick = () => {
    const host = state.room.players?.[state.room.hostId];
    const elapsed = Math.max(0, serverNow() - (host?.lastSeen || serverNow()));
    const remaining = Math.max(0, 120000 - elapsed);
    countdown.textContent = `${Math.ceil(remaining / 1000)} s`;
    takeover.hidden = !(isDeputy() && remaining <= 0);
  };

  tick();
  state.pausedTimerId = setInterval(tick, 500);
}

async function takeOverHost() {
  if (!isDeputy()) return;

  const host = state.room.players?.[state.room.hostId];
  if (serverNow() - (host?.lastSeen || serverNow()) < 120000) return;

  const patch = { hostId: state.uid, paused: false, lastActivity: serverNow() };
  if (state.room.status === "question") patch.phaseEndsAt = serverNow() + 5000;
  if (state.room.status === "answer") patch.phaseEndsAt = serverNow() + 15000;

  await state.api.update(roomRef(), patch);
}

async function handleRemovedOrClosed() {
  if (state.uid && state.db) {
    try {
      await state.api.remove(state.api.ref(state.db, `sessions/${state.uid}`));
    } catch (_) {}
  }

  disconnectRoomListener();
  state.roomCode = null;
  state.room = null;
  state.draftAnswer = "";
  state.draftRound = null;
  roomPill.hidden = true;
  showHome();

  showModal("Spiel beendet", "<p>Der Raum wurde geschlossen oder du wurdest aus dem Warteraum entfernt.</p>", [
    { label: "OK", className: "button-primary", action: closeModal }
  ]);
}

async function leaveToHome() {
  closeModal();

  if (state.uid && state.db) {
    try {
      if (state.roomCode && !isHost()) {
        await state.api.remove(roomRef(`players/${state.uid}`));
      }
      await state.api.remove(state.api.ref(state.db, `sessions/${state.uid}`));
    } catch (_) {}
  }

  disconnectRoomListener();
  state.roomCode = null;
  state.room = null;
  state.draftAnswer = "";
  state.draftRound = null;
  showHome();
}

function requestLeave() {
  if (!state.roomCode) {
    showHome();
    return;
  }

  const message = isHost()
    ? "Als Spielleitung solltest du den Raum über „Spiel beenden“ schließen. Wirklich zur Startseite?"
    : "Möchtest du das laufende Spiel verlassen?";

  showModal("Spiel verlassen?", `<p>${message}</p>`, [
    { label: "Im Spiel bleiben", className: "button-ghost", action: closeModal },
    { label: "Verlassen", className: "button-danger", action: leaveToHome }
  ]);
}

function showRules() {
  showModal(
    "So funktioniert’s",
    `
    <ol class="rules-list">
      <li>Eine Aussage erscheint fünf Sekunden lang.</li>
      <li>Danach haben alle 15 Sekunden Zeit für eine Antwort.</li>
      <li>Zeigt euch anschließend eure Antworten.</li>
      <li>Die Spielleitung markiert alle Personen mit gleichen Antworten. Jede markierte Person erhält einen Punkt.</li>
      <li>Nach dem Zwischenstand startet die Spielleitung die nächste Runde.</li>
    </ol>
    <label class="player-row"><input id="signals-toggle" type="checkbox" ${state.signals ? "checked" : ""}> Ton und Vibration verwenden</label>`,
    [
      {
        label: "Schließen",
        className: "button-primary",
        action: () => {
          state.signals = Boolean($("#signals-toggle")?.checked);
          closeModal();
        }
      }
    ]
  );
}

function showModal(title, html, actions = []) {
  closeModal();

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header class="modal-header"><h2 id="modal-title">${escapeHtml(title)}</h2><button class="modal-close" type="button" aria-label="Schließen">×</button></header><div class="modal-copy">${html}</div><div class="sticky-actions"></div></section>`;

  $(".modal-close", backdrop).addEventListener("click", closeModal);
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) closeModal();
  });

  const area = $(".sticky-actions", backdrop);
  actions.forEach((item) => area.append(button(item.label, item.className, item.action)));
  modalRoot.append(backdrop);

  setTimeout(() => $(".modal-close", backdrop)?.focus(), 50);
}

function closeModal() {
  modalRoot.replaceChildren();
}

function signal(type) {
  if (!state.signals) return;

  if (navigator.vibrate) {
    navigator.vibrate(type === "win" ? [80, 40, 120] : 40);
  }

  try {
    const context = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.frequency.value = type === "win" ? 740 : 520;
    gain.gain.setValueAtTime(0.08, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.18);

    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.18);
  } catch (_) {}
}

function launchConfetti() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const canvas = $("#confetti");
  const context = canvas.getContext("2d");
  const ratio = Math.min(devicePixelRatio || 1, 2);

  canvas.width = innerWidth * ratio;
  canvas.height = innerHeight * ratio;
  context.scale(ratio, ratio);

  const colors = ["#009D43", "#EB6608", "#FFCB03", "#009CC4", "#ffffff"];
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
      context.fillRect(-piece.size / 2, -piece.size / 3, piece.size, piece.size * 0.65);
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
  const code = error?.code || "";
  if (code.includes("permission-denied")) return "Der Zugriff wurde abgelehnt. Prüfe die Firebase-Regeln und deine Verbindung.";
  if (code.includes("network")) return "Keine Verbindung zum Spielserver. Bitte prüfe das Internet.";
  if (code.includes("operation-not-allowed")) return "Die anonyme Anmeldung ist in Firebase noch nicht aktiviert.";
  return error?.message || "Etwas ist schiefgegangen. Bitte versuche es erneut.";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;"
  }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value);
}

appRoot.addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
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
  const submit = event.submitter;
  const name = cleanName($("#player-name").value);

  if (name.length < 2) {
    error.textContent = "Bitte gib einen Namen mit mindestens zwei Zeichen ein.";
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

document.querySelector("#brand-home").addEventListener("click", requestLeave);
window.addEventListener("online", () => setConnection(true));
window.addEventListener("offline", () => setConnection(false));
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeModal();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(console.warn);
  });
}

initFirebase();
