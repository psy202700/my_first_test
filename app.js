const HISTORY_KEY = "menuHistory";
const RECENT_WINDOW = 5; // 최근 이 개수만큼의 기록 안에서 먹은 메뉴는 가중치를 낮춘다

let allMenus = [];
let currentPick = null;

const categorySelect = document.getElementById("categorySelect");
const recommendCard = document.getElementById("recommendCard");
const resultCategory = document.getElementById("resultCategory");
const resultName = document.getElementById("resultName");
const recommendButton = document.getElementById("recommendButton");
const eatButton = document.getElementById("eatButton");
const rerollButton = document.getElementById("rerollButton");
const historyList = document.getElementById("historyList");
const emptyHistory = document.getElementById("emptyHistory");
const clearHistoryButton = document.getElementById("clearHistoryButton");
const mealTimeLabel = document.getElementById("mealTimeLabel");

function getHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
  } catch {
    return [];
  }
}

function saveHistory(history) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

function currentMealLabel() {
  const hour = new Date().getHours();
  return hour < 16 ? "점심" : "저녁";
}

function populateCategories(menus) {
  const categories = [...new Set(menus.map((m) => m.category))];
  for (const category of categories) {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    categorySelect.appendChild(option);
  }
}

function weightedPick(menus, history) {
  const recentNames = history.slice(-RECENT_WINDOW).map((h) => h.name);
  const weighted = menus.map((menu) => {
    const occurrences = recentNames.filter((n) => n === menu.name).length;
    return { menu, weight: 1 / (occurrences + 1) };
  });
  const total = weighted.reduce((sum, w) => sum + w.weight, 0);
  let r = Math.random() * total;
  for (const w of weighted) {
    if (r < w.weight) return w.menu;
    r -= w.weight;
  }
  return weighted[weighted.length - 1].menu;
}

function pickMenu() {
  const category = categorySelect.value;
  const pool = category === "전체" ? allMenus : allMenus.filter((m) => m.category === category);
  if (pool.length === 0) return;
  currentPick = weightedPick(pool, getHistory());
  resultCategory.textContent = currentPick.category;
  resultName.textContent = currentPick.name;
  recommendCard.hidden = false;
}

function renderHistory() {
  const history = getHistory();
  historyList.innerHTML = "";
  emptyHistory.hidden = history.length > 0;

  const recent = [...history].reverse().slice(0, 10);
  for (const entry of recent) {
    const li = document.createElement("li");
    const nameSpan = document.createElement("span");
    nameSpan.textContent = `${entry.name} (${entry.meal})`;
    const dateSpan = document.createElement("span");
    dateSpan.className = "history-date";
    dateSpan.textContent = new Date(entry.date).toLocaleDateString("ko-KR", {
      month: "numeric",
      day: "numeric",
    });
    li.appendChild(nameSpan);
    li.appendChild(dateSpan);
    historyList.appendChild(li);
  }
}

function eatCurrentPick() {
  if (!currentPick) return;
  const history = getHistory();
  history.push({
    name: currentPick.name,
    category: currentPick.category,
    meal: currentMealLabel(),
    date: new Date().toISOString(),
  });
  saveHistory(history);
  renderHistory();
  recommendCard.hidden = true;
  currentPick = null;
}

function clearHistory() {
  if (!confirm("먹은 기록을 모두 지울까요?")) return;
  saveHistory([]);
  renderHistory();
}

async function init() {
  mealTimeLabel.textContent = `지금은 ${currentMealLabel()} 시간이에요`;
  const response = await fetch("data/menus.json");
  allMenus = await response.json();
  populateCategories(allMenus);
  renderHistory();

  recommendButton.addEventListener("click", pickMenu);
  rerollButton.addEventListener("click", pickMenu);
  eatButton.addEventListener("click", eatCurrentPick);
  clearHistoryButton.addEventListener("click", clearHistory);
}

init();
