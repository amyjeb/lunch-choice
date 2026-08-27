/* 점심초이스 - 온보딩 + 홈(오늘의 추천) 초기 화면 로직 */

const STORAGE_KEY = "lunchchoice_prefs";
const HISTORY_KEY = "lunchchoice_history";
const FEEDBACK_KEY = "lunchchoice_feedback";
const ROOMS_KEY = "lunchchoice_rooms";
const NOTIF_KEY = "lunchchoice_notif";
const RECENT_EXCLUDE_COUNT = 3; // FR-2.2: 최근 N일(간이 구현: 최근 N회) 추천/선택 제외

const state = {
  prefCategories: new Set(),
  avoidTags: new Set(),
  budget: null,
  locationGranted: false,
  locationLabel: ""
};

const teamState = {
  candidates: [],       // 투표방 설정 중인 후보 목록
  deadlineMinutes: null,
  currentRoomCode: null, // 내가 만든/참여 중인 투표방 코드
  selectedJoinCandidateId: null
};

let currentRecommendations = [];
let currentRandomPick = null;
let roomPollTimer = null;

// ---------- 유틸 ----------
function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}
function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    /* localStorage 미지원 환경은 세션 내 동작만 유지 */
  }
}

function restaurantLinksHTML(restaurant) {
  const mapBtn = `<a class="link-btn map" href="${restaurant.mapUrl}" target="_blank" rel="noopener">🗺️ 지도</a>`;
  const telBtn = restaurant.phone
    ? `<a class="link-btn tel" href="tel:${restaurant.phone}">📞 전화</a>`
    : "";
  return `<div class="restaurant-links">${mapBtn}${telBtn}</div>`;
}

function ratingHTML(restaurant) {
  if (restaurant.rating == null) return `<span class="rating-badge none">리뷰 없음</span>`;
  const reviewText = restaurant.reviewCount != null ? `리뷰 ${restaurant.reviewCount}개` : "리뷰 수 미확인";
  return `<span class="rating-badge">⭐ ${restaurant.rating.toFixed(1)} · ${reviewText}</span>`;
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove("show"), 1800);
}

const SCREEN_IDS = {
  home: "screen-home",
  team: "screen-team",
  history: "screen-history",
  mypage: "screen-mypage"
};

function navigateTo(screenName) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
  document.getElementById("bottom-nav").classList.remove("hidden");

  document.getElementById(SCREEN_IDS[screenName]).classList.add("active");
  const navBtn = document.querySelector(`.nav-item[data-nav="${screenName}"]`);
  if (navBtn) navBtn.classList.add("active");

  if (screenName !== "team") stopRoomPolling();

  if (screenName === "team") {
    showTeamView(teamState.currentRoomCode ? "room" : "landing");
  } else if (screenName === "history") {
    renderHistory();
  } else if (screenName === "mypage") {
    renderMypageSummary();
  }
}

// ---------- 온보딩 ----------
function toggleChip(btn, targetSet) {
  const value = btn.dataset.value;
  if (targetSet.has(value)) {
    targetSet.delete(value);
    btn.classList.remove("selected");
  } else {
    targetSet.add(value);
    btn.classList.add("selected");
  }
}

function selectBudget(btn) {
  document.querySelectorAll("#budget-group .pill").forEach(p => p.classList.remove("selected"));
  btn.classList.add("selected");
  state.budget = btn.dataset.value;
  updateStartButton();
}

function updateStartButton() {
  const startBtn = document.getElementById("start-btn");
  startBtn.disabled = !state.budget;
}

function requestLocation() {
  const btn = document.getElementById("location-btn");
  const statusText = document.getElementById("location-status");
  const btnText = document.getElementById("location-btn-text");

  if (!("geolocation" in navigator)) {
    state.locationGranted = true;
    state.locationLabel = "위치 API 미지원 환경 (샘플 위치로 대체)";
    btn.classList.add("granted");
    btnText.textContent = "샘플 위치로 설정됨";
    statusText.textContent = "이 브라우저는 위치 정보를 지원하지 않아 샘플 위치를 사용해요.";
    return;
  }

  btnText.textContent = "위치 확인 중...";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.locationGranted = true;
      state.locationLabel = `위도 ${pos.coords.latitude.toFixed(3)}, 경도 ${pos.coords.longitude.toFixed(3)}`;
      btn.classList.add("granted");
      btnText.textContent = "현재 위치 사용 중";
      statusText.textContent = "위치 기반으로 가까운 식당을 우선 추천해 드려요.";
    },
    () => {
      state.locationGranted = false;
      state.locationLabel = "";
      btnText.textContent = "다시 시도";
      statusText.textContent = "위치 권한이 거부되었어요. 권한 없이도 추천은 이용할 수 있어요.";
    },
    { timeout: 6000 }
  );
}

function completeOnboarding() {
  const prefs = {
    prefCategories: Array.from(state.prefCategories),
    avoidTags: Array.from(state.avoidTags),
    budget: state.budget,
    locationGranted: state.locationGranted,
    locationLabel: state.locationLabel
  };
  saveJSON(STORAGE_KEY, prefs);
  navigateTo("home");
  renderRecommendations();
}

function initOnboarding() {
  document.querySelectorAll("#pref-category-group .chip").forEach(chip => {
    chip.addEventListener("click", () => toggleChip(chip, state.prefCategories));
  });
  document.querySelectorAll("#avoid-group .chip").forEach(chip => {
    chip.addEventListener("click", () => toggleChip(chip, state.avoidTags));
  });
  document.querySelectorAll("#budget-group .pill").forEach(pill => {
    pill.addEventListener("click", () => selectBudget(pill));
  });
  document.getElementById("location-btn").addEventListener("click", requestLocation);
  document.getElementById("start-btn").addEventListener("click", completeOnboarding);
}

// ---------- 추천 엔진 (규칙 기반, PRD 11.1 가정 대응) ----------
function getPrefs() {
  return loadJSON(STORAGE_KEY, null);
}

function getHistory() {
  return loadJSON(HISTORY_KEY, []);
}

function getFeedback() {
  return loadJSON(FEEDBACK_KEY, {});
}

function scoreMenu(item, prefs, feedback) {
  let score = 1;

  if (prefs.prefCategories.length > 0) {
    score += prefs.prefCategories.includes(item.category) ? 3 : 0;
  }
  if (item.weatherTags.includes(TODAY_WEATHER.tag)) {
    score += 2;
  }
  const fb = feedback[item.id];
  if (fb === "like") score += 3;
  if (fb === "dislike") score -= 5;

  return score;
}

function buildRecommendations(excludeIds = []) {
  const prefs = getPrefs() || { prefCategories: [], avoidTags: [], budget: null };
  const history = getHistory();
  const feedback = getFeedback();
  const recentIds = history.slice(0, RECENT_EXCLUDE_COUNT).map(h => h.id);

  let pool = MENU_DB.filter(item => {
    if (prefs.avoidTags.length && item.avoidTags.some(t => prefs.avoidTags.includes(t))) return false;
    if (excludeIds.includes(item.id)) return false;
    return true;
  });

  // 예산대 우선 필터, 후보가 부족하면 완화
  if (prefs.budget) {
    const byBudget = pool.filter(item => item.budget === prefs.budget);
    if (byBudget.length >= 3) pool = byBudget;
  }

  // 최근 추천/선택 제외, 후보가 너무 적어지면 완화
  const withoutRecent = pool.filter(item => !recentIds.includes(item.id));
  if (withoutRecent.length >= 3) pool = withoutRecent;

  pool = pool
    .map(item => ({ item, score: scoreMenu(item, prefs, feedback) }))
    // 취향 점수가 같으면 회사(포스코타워송도)에서 가까운 곳을 우선 노출
    .sort((a, b) => (b.score - a.score) || (a.item.restaurant.distanceMeters - b.item.restaurant.distanceMeters))
    .map(x => x.item);

  const topPool = pool.slice(0, 6);

  return topPool.slice(0, 3);
}

function renderRecommendations(excludeIds = []) {
  currentRecommendations = buildRecommendations(excludeIds);
  const listEl = document.getElementById("recommend-list");
  const feedback = getFeedback();
  listEl.innerHTML = "";

  if (currentRecommendations.length === 0) {
    listEl.innerHTML = `<p style="color:#6B6360;font-size:13.5px;">조건에 맞는 메뉴를 더 찾지 못했어요. 취향 설정을 조정해보세요.</p>`;
    return;
  }

  currentRecommendations.forEach(item => {
    const card = document.createElement("div");
    card.className = "menu-card";
    card.dataset.id = item.id;

    const isWeatherMatch = item.weatherTags.includes(TODAY_WEATHER.tag);
    const fb = feedback[item.id];

    card.innerHTML = `
      <div class="menu-card-top">
        <span class="menu-emoji">${item.emoji}</span>
        <div class="menu-main">
          <p class="menu-name">${item.name}</p>
          <div class="menu-tags">
            <span class="tag">${item.category}</span>
            ${isWeatherMatch ? `<span class="tag weather-match">오늘 날씨 추천</span>` : ""}
          </div>
        </div>
      </div>
      <div class="restaurant-box">
        <div class="restaurant-box-top">
          <div>
            <span class="restaurant-name">${item.restaurant.name}</span>
            <span>${item.restaurant.distance} · ${item.restaurant.hours}</span>
          </div>
          <span>${item.restaurant.price}</span>
        </div>
        ${ratingHTML(item.restaurant)}
        ${restaurantLinksHTML(item.restaurant)}
      </div>
      <div class="menu-card-actions">
        <button type="button" class="feedback-btn like ${fb === "like" ? "active" : ""}" data-action="like">👍</button>
        <button type="button" class="feedback-btn dislike ${fb === "dislike" ? "active" : ""}" data-action="dislike">👎</button>
        <button type="button" class="choose-btn" data-action="choose">이 메뉴로 결정</button>
      </div>
    `;

    card.querySelector('[data-action="like"]').addEventListener("click", () => setFeedback(item.id, "like", card));
    card.querySelector('[data-action="dislike"]').addEventListener("click", () => setFeedback(item.id, "dislike", card));
    card.querySelector('[data-action="choose"]').addEventListener("click", (e) => chooseMenu(item, e.currentTarget));

    listEl.appendChild(card);
  });
}

function setFeedback(itemId, type, cardEl) {
  const feedback = getFeedback();
  feedback[itemId] = feedback[itemId] === type ? null : type; // 같은 버튼 재클릭 시 취소
  saveJSON(FEEDBACK_KEY, feedback);

  const likeBtn = cardEl.querySelector('[data-action="like"]');
  const dislikeBtn = cardEl.querySelector('[data-action="dislike"]');
  likeBtn.classList.toggle("active", feedback[itemId] === "like");
  dislikeBtn.classList.toggle("active", feedback[itemId] === "dislike");

  showToast(feedback[itemId] === "like" ? "취향에 반영할게요 👍" : feedback[itemId] === "dislike" ? "다음엔 덜 추천할게요" : "피드백을 취소했어요");
}

function addToHistory(item) {
  const history = getHistory();
  history.unshift({ id: item.id, name: item.name, emoji: item.emoji || "🍽️", at: Date.now() });
  saveJSON(HISTORY_KEY, history.slice(0, 30));
}

function chooseMenu(item, btnEl) {
  addToHistory(item);

  document.querySelectorAll(".choose-btn").forEach(b => {
    b.classList.remove("chosen");
    b.textContent = "이 메뉴로 결정";
  });
  btnEl.classList.add("chosen");
  btnEl.textContent = "오늘의 점심으로 결정!";

  showToast(`"${item.name}" 맛있게 드세요! 🍽️`);
}

function refreshRecommendations() {
  const excludeIds = currentRecommendations.map(r => r.id);
  renderRecommendations(excludeIds);
}

// ---------- 랜덤 메뉴 뽑기 팝업 ----------
function pickRandomMenu(excludeId) {
  const prefs = getPrefs() || { avoidTags: [] };
  let pool = MENU_DB.filter(item => {
    if (prefs.avoidTags && prefs.avoidTags.length && item.avoidTags.some(t => prefs.avoidTags.includes(t))) return false;
    if (excludeId && item.id === excludeId) return false;
    return true;
  });
  if (pool.length === 0) pool = MENU_DB.filter(item => item.id !== excludeId);
  return pool[Math.floor(Math.random() * pool.length)];
}

function renderRandomModal(item) {
  currentRandomPick = item;
  document.getElementById("modal-emoji").textContent = item.emoji;
  document.getElementById("modal-menu-name").textContent = item.name;
  document.getElementById("modal-tags").innerHTML = `<span class="tag">${item.category}</span>${item.weatherTags.includes(TODAY_WEATHER.tag) ? '<span class="tag weather-match">오늘 날씨 추천</span>' : ""}`;
  document.getElementById("modal-restaurant-name").textContent = item.restaurant.name;
  document.getElementById("modal-restaurant-meta").textContent = `${item.restaurant.distance} · ${item.restaurant.hours} · ${item.restaurant.price}`;
  document.getElementById("modal-restaurant-links").innerHTML = `${ratingHTML(item.restaurant)}${restaurantLinksHTML(item.restaurant)}`;

  const chooseBtn = document.getElementById("modal-choose-btn");
  chooseBtn.classList.remove("chosen");
  chooseBtn.textContent = "이 메뉴로 결정";
}

function rollRandomMenu(excludeId) {
  const rollingEl = document.getElementById("modal-rolling");
  const resultEl = document.getElementById("modal-result");
  rollingEl.classList.add("active");
  resultEl.classList.remove("active");

  setTimeout(() => {
    const picked = pickRandomMenu(excludeId);
    renderRandomModal(picked);
    rollingEl.classList.remove("active");
    resultEl.classList.add("active");
  }, 550);
}

function openRandomModal() {
  document.getElementById("random-modal").classList.add("show");
  rollRandomMenu(null);
}

function closeRandomModal() {
  document.getElementById("random-modal").classList.remove("show");
}

function chooseRandomMenu() {
  if (!currentRandomPick) return;
  addToHistory(currentRandomPick);
  const btn = document.getElementById("modal-choose-btn");
  btn.classList.add("chosen");
  btn.textContent = "오늘의 점심으로 결정!";
  showToast(`"${currentRandomPick.name}" 맛있게 드세요! 🍽️`);
}

// ---------- 식당 둘러보기 (카테고리별, 회사에서 가까운 순) ----------
const browseState = { category: "한식" };

function openBrowseScreen() {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById("screen-browse").classList.add("active");
  renderBrowseCategoryChips();
  renderBrowseList();
}

function selectBrowseCategory(category) {
  browseState.category = category;
  renderBrowseCategoryChips();
  renderBrowseList();
}

function renderBrowseCategoryChips() {
  document.querySelectorAll("#browse-category-group .chip").forEach(chip => {
    chip.classList.toggle("selected", chip.dataset.value === browseState.category);
  });
}

function browseRestaurantCardHTML(rst) {
  const menuRows = rst.menus.map(m => `
    <div class="browse-menu-row">
      <span class="browse-menu-emoji">${m.emoji}</span>
      <span class="browse-menu-name">${m.name}</span>
      <span class="browse-menu-price">${m.price}</span>
      <button type="button" class="browse-choose-btn" data-choose-id="${m.id}">선택</button>
    </div>
  `).join("");

  return `
    <div class="browse-card">
      <p class="browse-restaurant-name">${rst.name}</p>
      <p class="browse-restaurant-meta">${rst.distanceLabel} · ${rst.hours}</p>
      ${ratingHTML(rst)}
      <p class="browse-address">${rst.address}</p>
      ${restaurantLinksHTML(rst)}
      <div class="browse-menus">${menuRows}</div>
    </div>
  `;
}

function renderBrowseList() {
  const restaurants = RESTAURANTS.filter(rst => rst.category === browseState.category);
  document.getElementById("browse-count").textContent = `${restaurants.length}곳 · 포스코타워송도에서 가까운 순으로 정렬`;

  const listEl = document.getElementById("browse-list");
  listEl.innerHTML = restaurants.map(browseRestaurantCardHTML).join("");

  listEl.querySelectorAll(".browse-choose-btn").forEach(btn => {
    btn.addEventListener("click", () => chooseFromBrowse(btn.dataset.chooseId, btn));
  });
}

function chooseFromBrowse(menuId, btnEl) {
  const item = MENU_DB.find(m => m.id === menuId);
  if (!item) return;
  addToHistory(item);
  btnEl.classList.add("chosen");
  btnEl.textContent = "결정!";
  showToast(`"${item.name}" 맛있게 드세요! 🍽️`);
}

// ---------- 팀 점심 투표 (PRD FR-3.x) ----------
// 백엔드 없는 프론트엔드 프로토타입이라, 같은 브라우저(localStorage) 안에서
// 투표방 코드를 공유해 여러 참여자가 돌아가며 투표하는 방식으로 시뮬레이션한다.

function getRooms() {
  return loadJSON(ROOMS_KEY, {});
}
function saveRoom(room) {
  const rooms = getRooms();
  rooms[room.code] = room;
  saveJSON(ROOMS_KEY, rooms);
}
function getRoom(code) {
  const rooms = getRooms();
  return rooms[code] || null;
}

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (getRoom(code));
  return code;
}

function tallyRoom(room) {
  return room.candidates.map(c => ({
    ...c,
    count: Object.values(room.votes).filter(v => v === c.id).length
  }));
}

function finalizeRoom(code) {
  const room = getRoom(code);
  if (!room || room.status === "closed") return;

  const tally = tallyRoom(room);
  const maxCount = Math.max(0, ...tally.map(t => t.count));
  const winners = tally.filter(t => t.count === maxCount && maxCount > 0);
  const isTie = winners.length > 1;

  room.status = "closed";
  room.winnerId = winners.length > 0
    ? winners[Math.floor(Math.random() * winners.length)].id // FR-3.5: 동점 시 무작위 선정
    : null;
  room.tie = isTie;
  saveRoom(room);
}

function checkAndAutoFinalize(code) {
  const room = getRoom(code);
  if (room && room.status === "open" && Date.now() >= room.deadline) {
    finalizeRoom(code);
  }
}

function showTeamView(viewName) {
  document.querySelectorAll(".team-view").forEach(v => v.classList.remove("active"));
  document.getElementById(`team-view-${viewName}`).classList.add("active");

  if (viewName === "setup") resetTeamSetup();
  if (viewName === "room" && teamState.currentRoomCode) {
    renderRoomView(teamState.currentRoomCode);
    startRoomPolling(teamState.currentRoomCode);
  } else {
    stopRoomPolling();
  }
}

function resetTeamSetup() {
  teamState.candidates = [];
  teamState.deadlineMinutes = null;
  document.querySelectorAll("#team-deadline-group .pill").forEach(p => p.classList.remove("selected"));
  document.getElementById("team-candidate-input").value = "";
  renderCandidateSetupList();
}

function renderCandidateSetupList() {
  const listEl = document.getElementById("team-candidate-list");
  listEl.innerHTML = teamState.candidates.map(c => `
    <div class="candidate-row">
      <span class="candidate-emoji">${c.emoji}</span>
      <span class="candidate-name">${c.name}</span>
      <button type="button" class="candidate-remove-btn" data-remove="${c.id}">✕</button>
    </div>
  `).join("");

  listEl.querySelectorAll("[data-remove]").forEach(btn => {
    btn.addEventListener("click", () => {
      teamState.candidates = teamState.candidates.filter(c => c.id !== btn.dataset.remove);
      renderCandidateSetupList();
      updateCreateRoomButton();
    });
  });

  const addBtn = document.getElementById("team-candidate-add-btn");
  const aiBtn = document.getElementById("team-add-from-ai-btn");
  const full = teamState.candidates.length >= 5;
  addBtn.disabled = full;
  aiBtn.disabled = full;
}

function addCandidateFromAI() {
  const pool = currentRecommendations.length > 0 ? currentRecommendations : buildRecommendations([]);
  for (const item of pool) {
    if (teamState.candidates.length >= 5) break;
    if (teamState.candidates.some(c => c.id === item.id)) continue;
    teamState.candidates.push({ id: item.id, name: item.name, emoji: item.emoji });
  }
  renderCandidateSetupList();
  updateCreateRoomButton();
}

function addCandidateManual() {
  const input = document.getElementById("team-candidate-input");
  const name = input.value.trim();
  if (!name || teamState.candidates.length >= 5) return;
  teamState.candidates.push({ id: `custom_${Math.random().toString(36).slice(2, 8)}`, name, emoji: "🍽️" });
  input.value = "";
  renderCandidateSetupList();
  updateCreateRoomButton();
}

function selectTeamDeadline(btn) {
  document.querySelectorAll("#team-deadline-group .pill").forEach(p => p.classList.remove("selected"));
  btn.classList.add("selected");
  teamState.deadlineMinutes = Number(btn.dataset.min);
  updateCreateRoomButton();
}

function updateCreateRoomButton() {
  const btn = document.getElementById("team-create-room-btn");
  btn.disabled = !(teamState.candidates.length >= 2 && teamState.deadlineMinutes);
}

function createRoomFromSetup() {
  const code = generateRoomCode();
  const room = {
    code,
    candidates: teamState.candidates,
    deadline: Date.now() + teamState.deadlineMinutes * 60 * 1000,
    votes: {},
    status: "open",
    winnerId: null,
    tie: false,
    createdAt: Date.now()
  };
  saveRoom(room);
  teamState.currentRoomCode = code;
  showTeamView("room");
  showToast("투표방을 만들었어요!");
}

function renderRoomView(code) {
  checkAndAutoFinalize(code);
  const room = getRoom(code);
  if (!room) {
    showTeamView("landing");
    return;
  }

  document.getElementById("room-code-display").textContent = room.code;

  const banner = document.getElementById("room-status-banner");
  const openActions = document.getElementById("room-actions-open");
  const closedActions = document.getElementById("room-actions-closed");
  const tally = tallyRoom(room).sort((a, b) => b.count - a.count);
  const maxCount = Math.max(1, ...tally.map(t => t.count));

  if (room.status === "open") {
    const remainMs = Math.max(0, room.deadline - Date.now());
    const mm = Math.floor(remainMs / 60000);
    const ss = Math.floor((remainMs % 60000) / 1000);
    banner.className = "room-status-banner";
    banner.textContent = `⏳ 마감까지 ${mm}:${String(ss).padStart(2, "0")} · 총 ${Object.keys(room.votes).length}명 투표`;
    openActions.style.display = "flex";
    closedActions.style.display = "none";
  } else {
    const winner = room.candidates.find(c => c.id === room.winnerId);
    banner.className = "room-status-banner closed";
    banner.textContent = winner
      ? `🏆 투표 마감! 오늘의 메뉴는 "${winner.name}"${room.tie ? " (동점 → 무작위 선정)" : ""}`
      : "투표에 참여한 사람이 없어 메뉴를 정하지 못했어요";
    openActions.style.display = "none";
    closedActions.style.display = "flex";
  }

  document.getElementById("room-tally-list").innerHTML = tally.map(t => `
    <div class="tally-row ${room.status === "closed" && t.id === room.winnerId ? "winner" : ""}">
      <div class="tally-row-top">
        <span>${t.emoji} ${t.name}</span>
        <span class="tally-count">${t.count}표</span>
      </div>
      <div class="tally-bar-track"><div class="tally-bar-fill" style="width:${(t.count / maxCount) * 100}%"></div></div>
    </div>
  `).join("");
}

function closeRoomManually() {
  if (!teamState.currentRoomCode) return;
  finalizeRoom(teamState.currentRoomCode);
  renderRoomView(teamState.currentRoomCode);
}

function startNewVoteFromRoom() {
  teamState.currentRoomCode = null;
  showTeamView("setup");
}

function startRoomPolling(code) {
  stopRoomPolling();
  roomPollTimer = setInterval(() => {
    if (!document.getElementById("screen-team").classList.contains("active")) return;
    renderRoomView(code);
  }, 1000);
}
function stopRoomPolling() {
  if (roomPollTimer) clearInterval(roomPollTimer);
  roomPollTimer = null;
}

function copyRoomLink() {
  const code = teamState.currentRoomCode;
  const link = `${location.origin}${location.pathname}?room=${code}`;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(link).then(
      () => showToast("초대 링크를 복사했어요"),
      () => showToast(`코드: ${code}`)
    );
  } else {
    showToast(`코드: ${code}`);
  }
}

function joinByCode(code) {
  const room = getRoom(code);
  if (!room) {
    showToast("존재하지 않는 코드예요");
    return;
  }
  if (room.status === "closed") {
    teamState.currentRoomCode = code;
    showTeamView("room");
    return;
  }
  teamState.selectedJoinCandidateId = null;
  document.getElementById("join-room-code-display").textContent = code;
  document.getElementById("join-name-input").value = "";
  document.getElementById("join-candidate-list").innerHTML = room.candidates.map(c => `
    <div class="join-candidate-row" data-candidate="${c.id}">
      <span class="candidate-emoji">${c.emoji}</span>
      <span class="candidate-name">${c.name}</span>
      <span class="join-check"></span>
    </div>
  `).join("");

  document.querySelectorAll(".join-candidate-row").forEach(row => {
    row.addEventListener("click", () => {
      document.querySelectorAll(".join-candidate-row").forEach(r => r.classList.remove("selected"));
      row.classList.add("selected");
      teamState.selectedJoinCandidateId = row.dataset.candidate;
      updateJoinVoteButton();
    });
  });

  teamState.joinRoomCode = code;
  updateJoinVoteButton();
  showTeamView("join");
}

function updateJoinVoteButton() {
  const name = document.getElementById("join-name-input").value.trim();
  document.getElementById("join-vote-btn").disabled = !(name && teamState.selectedJoinCandidateId);
}

function submitVote() {
  const code = teamState.joinRoomCode;
  const name = document.getElementById("join-name-input").value.trim();
  if (!code || !name || !teamState.selectedJoinCandidateId) return;

  checkAndAutoFinalize(code);
  const room = getRoom(code);
  if (!room || room.status === "closed") {
    teamState.currentRoomCode = code;
    showTeamView("room");
    return;
  }

  room.votes[name] = teamState.selectedJoinCandidateId;
  saveRoom(room);
  teamState.currentRoomCode = code;
  showToast(`${name}님의 투표가 반영됐어요`);
  showTeamView("room");
}

// ---------- 이력 (PRD FR-5.1) ----------
function formatRelativeTime(ts) {
  const diffMin = Math.floor((Date.now() - ts) / 60000);
  if (diffMin < 1) return "방금 전";
  if (diffMin < 60) return `${diffMin}분 전`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}시간 전`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

function renderHistory() {
  const history = getHistory();
  const listEl = document.getElementById("history-list");
  const summaryEl = document.getElementById("history-summary");
  const emptyEl = document.getElementById("history-empty");

  if (history.length === 0) {
    listEl.innerHTML = "";
    summaryEl.innerHTML = "";
    emptyEl.style.display = "flex";
    return;
  }
  emptyEl.style.display = "none";

  const countById = {};
  history.forEach(h => { countById[h.id] = (countById[h.id] || 0) + 1; });
  const topId = Object.keys(countById).sort((a, b) => countById[b] - countById[a])[0];
  const topItem = history.find(h => h.id === topId);

  summaryEl.innerHTML = `총 <b>${history.length}</b>번의 점심을 기록했어요<br><strong>${topItem.emoji} ${topItem.name}</strong>을(를) 가장 많이 골랐어요 (${countById[topId]}회)`;

  listEl.innerHTML = history.map(h => `
    <div class="history-row">
      <span class="history-emoji">${h.emoji}</span>
      <div class="history-main">
        <p class="history-name">${h.name}</p>
        <span class="history-time">${formatRelativeTime(h.at)}</span>
      </div>
    </div>
  `).join("");
}

// ---------- 마이페이지 (PRD FR-6.x) ----------
function renderMypageSummary() {
  const prefs = getPrefs();
  const summaryEl = document.getElementById("mypage-pref-summary");

  if (!prefs) {
    summaryEl.innerHTML = "아직 설정된 취향이 없어요.";
  } else {
    const budgetLabel = { low: "~8,000원", mid: "8,000~12,000원", high: "12,000원~" }[prefs.budget] || "미설정";
    summaryEl.innerHTML = `
      선호 카테고리: <b>${prefs.prefCategories.length ? prefs.prefCategories.join(", ") : "미설정"}</b><br>
      기피 음식: <b>${prefs.avoidTags.length ? prefs.avoidTags.join(", ") : "없음"}</b><br>
      예산대: <b>${budgetLabel}</b>
    `;
  }

  const notifOn = loadJSON(NOTIF_KEY, false);
  const toggle = document.getElementById("notif-toggle");
  toggle.classList.toggle("on", notifOn);
  toggle.setAttribute("aria-checked", String(notifOn));

  document.getElementById("mypage-pref-edit").classList.remove("active");
  document.getElementById("mypage-edit-toggle-btn").textContent = "수정";
}

function toggleMypageEdit() {
  const editBlock = document.getElementById("mypage-pref-edit");
  const willOpen = !editBlock.classList.contains("active");
  editBlock.classList.toggle("active", willOpen);
  document.getElementById("mypage-edit-toggle-btn").textContent = willOpen ? "취소" : "수정";
  if (willOpen) populateMypageEditForm();
}

function populateMypageEditForm() {
  const prefs = getPrefs() || { prefCategories: [], avoidTags: [], budget: null };
  document.querySelectorAll("#mypage-pref-category-group .chip").forEach(chip => {
    chip.classList.toggle("selected", prefs.prefCategories.includes(chip.dataset.value));
  });
  document.querySelectorAll("#mypage-avoid-group .chip").forEach(chip => {
    chip.classList.toggle("selected", prefs.avoidTags.includes(chip.dataset.value));
  });
  document.querySelectorAll("#mypage-budget-group .pill").forEach(pill => {
    pill.classList.toggle("selected", prefs.budget === pill.dataset.value);
  });
}

function saveMypagePrefs() {
  const prevPrefs = getPrefs() || { locationGranted: false, locationLabel: "" };
  const prefCategories = Array.from(document.querySelectorAll("#mypage-pref-category-group .chip.selected")).map(c => c.dataset.value);
  const avoidTags = Array.from(document.querySelectorAll("#mypage-avoid-group .chip.selected")).map(c => c.dataset.value);
  const budgetBtn = document.querySelector("#mypage-budget-group .pill.selected");

  const newPrefs = {
    prefCategories,
    avoidTags,
    budget: budgetBtn ? budgetBtn.dataset.value : prevPrefs.budget,
    locationGranted: prevPrefs.locationGranted,
    locationLabel: prevPrefs.locationLabel
  };
  saveJSON(STORAGE_KEY, newPrefs);
  renderMypageSummary();
  showToast("취향을 저장했어요");
}

function toggleNotif() {
  const current = loadJSON(NOTIF_KEY, false);
  saveJSON(NOTIF_KEY, !current);
  const toggle = document.getElementById("notif-toggle");
  toggle.classList.toggle("on", !current);
  toggle.setAttribute("aria-checked", String(!current));
}

function resetAllData() {
  if (!confirm("취향 설정과 점심 이력을 모두 초기화할까요?")) return;
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(HISTORY_KEY);
  localStorage.removeItem(FEEDBACK_KEY);
  state.prefCategories = new Set();
  state.avoidTags = new Set();
  state.budget = null;
  document.querySelectorAll("#pref-category-group .chip, #avoid-group .chip, #budget-group .pill").forEach(el => el.classList.remove("selected"));
  updateStartButton();
  document.getElementById("bottom-nav").classList.add("hidden");
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById("screen-onboarding").classList.add("active");
  showToast("초기화됐어요");
}

// ---------- 초기화 ----------
// ---------- 상단 메타 정보바 (업데이트 날짜 · 방문자 수) ----------
function initMetaBar() {
  document.getElementById("last-updated").textContent = `데이터 업데이트: ${LAST_UPDATED}`;
  updateVisitorCount();
}

function updateVisitorCount() {
  const el = document.getElementById("visitor-count");
  const namespace = "lunchchoice-posco-songdo";
  const alreadyCounted = sessionStorage.getItem("lunchchoice_visit_counted");
  // 세션당 1회만 카운트를 올리고(hit), 새로고침 시에는 조회만(get) 해서 중복 집계를 막는다.
  const url = alreadyCounted
    ? `https://abacus.jasoncameron.dev/get/${namespace}/visits`
    : `https://abacus.jasoncameron.dev/hit/${namespace}/visits`;

  fetch(url)
    .then(res => { if (!res.ok) throw new Error("count api error"); return res.json(); })
    .then(data => {
      if (typeof data.value !== "number") throw new Error("no value");
      el.textContent = `방문 ${data.value.toLocaleString()}회`;
      sessionStorage.setItem("lunchchoice_visit_counted", "1");
    })
    .catch(() => {
      el.textContent = "방문자 수 집계 불가";
    });
}

function applyGreetingByTime() {
  const hour = new Date().getHours();
  const greetingEl = document.getElementById("greeting-text");
  if (hour < 11) {
    greetingEl.textContent = "곧 점심시간이에요!";
  } else if (hour < 14) {
    greetingEl.textContent = "오늘 점심, 뭐 드실까요?";
  } else {
    greetingEl.textContent = "내일 점심은 어디서 드실까요?";
  }
}

function initTeamHandlers() {
  document.getElementById("team-goto-setup-btn").addEventListener("click", () => showTeamView("setup"));
  document.getElementById("team-setup-back-btn").addEventListener("click", () => showTeamView("landing"));
  document.getElementById("team-add-from-ai-btn").addEventListener("click", addCandidateFromAI);
  document.getElementById("team-candidate-add-btn").addEventListener("click", addCandidateManual);
  document.getElementById("team-candidate-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addCandidateManual();
  });
  document.querySelectorAll("#team-deadline-group .pill").forEach(pill => {
    pill.addEventListener("click", () => selectTeamDeadline(pill));
  });
  document.getElementById("team-create-room-btn").addEventListener("click", createRoomFromSetup);

  document.getElementById("team-join-btn").addEventListener("click", () => {
    const code = document.getElementById("team-join-code-input").value.trim().toUpperCase();
    if (code) joinByCode(code);
  });
  document.getElementById("join-back-btn").addEventListener("click", () => showTeamView("landing"));
  document.getElementById("join-name-input").addEventListener("input", updateJoinVoteButton);
  document.getElementById("join-vote-btn").addEventListener("click", submitVote);

  document.getElementById("room-copy-btn").addEventListener("click", copyRoomLink);
  document.getElementById("room-close-btn").addEventListener("click", closeRoomManually);
  document.getElementById("room-refresh-btn").addEventListener("click", () => renderRoomView(teamState.currentRoomCode));
  document.getElementById("room-new-btn").addEventListener("click", startNewVoteFromRoom);
  document.getElementById("room-home-btn").addEventListener("click", () => navigateTo("home"));
}

function initMypageHandlers() {
  document.getElementById("mypage-edit-toggle-btn").addEventListener("click", toggleMypageEdit);
  document.querySelectorAll("#mypage-pref-category-group .chip, #mypage-avoid-group .chip").forEach(chip => {
    chip.addEventListener("click", () => chip.classList.toggle("selected"));
  });
  document.querySelectorAll("#mypage-budget-group .pill").forEach(pill => {
    pill.addEventListener("click", () => {
      document.querySelectorAll("#mypage-budget-group .pill").forEach(p => p.classList.remove("selected"));
      pill.classList.add("selected");
    });
  });
  document.getElementById("mypage-save-btn").addEventListener("click", saveMypagePrefs);
  document.getElementById("notif-toggle").addEventListener("click", toggleNotif);
  document.getElementById("mypage-reset-btn").addEventListener("click", resetAllData);
}

function initApp() {
  initOnboarding();
  updateStartButton();
  initTeamHandlers();
  initMypageHandlers();
  initMetaBar();

  document.getElementById("weather-chip").textContent = TODAY_WEATHER.label;
  document.getElementById("refresh-btn").addEventListener("click", refreshRecommendations);
  document.querySelectorAll("[data-nav]").forEach(el => {
    el.addEventListener("click", () => navigateTo(el.dataset.nav));
  });

  document.getElementById("browse-open-btn").addEventListener("click", openBrowseScreen);
  document.getElementById("browse-back-btn").addEventListener("click", () => navigateTo("home"));
  document.querySelectorAll("#browse-category-group .chip").forEach(chip => {
    chip.addEventListener("click", () => selectBrowseCategory(chip.dataset.value));
  });

  document.getElementById("random-pick-btn").addEventListener("click", openRandomModal);
  document.getElementById("modal-close-btn").addEventListener("click", closeRandomModal);
  document.getElementById("modal-reroll-btn").addEventListener("click", () => rollRandomMenu(currentRandomPick ? currentRandomPick.id : null));
  document.getElementById("modal-choose-btn").addEventListener("click", chooseRandomMenu);
  document.getElementById("random-modal").addEventListener("click", (e) => {
    if (e.target.id === "random-modal") closeRandomModal();
  });

  applyGreetingByTime();

  const existingPrefs = getPrefs();
  const roomCodeFromUrl = new URLSearchParams(location.search).get("room");

  if (existingPrefs || roomCodeFromUrl) {
    document.getElementById("screen-onboarding").classList.remove("active");
    navigateTo("home");
    renderRecommendations();
  }

  if (roomCodeFromUrl) {
    navigateTo("team");
    joinByCode(roomCodeFromUrl.toUpperCase());
  }
}

document.addEventListener("DOMContentLoaded", initApp);
