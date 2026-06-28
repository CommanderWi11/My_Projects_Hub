const PASSWORD = "airnest2020";
const STORAGE_KEY = "mph_unlocked";

const HQ_ORDER = ["personal", "airnest", "pilot"];
const HQ_LABEL = {
  personal: "Personal",
  airnest:  "Airnest",
  pilot:    "Pilot",
};

const gate     = document.getElementById("gate");
const content  = document.getElementById("content");
const form     = document.getElementById("gate-form");
const input    = document.getElementById("pw");
const errorEl  = document.getElementById("gate-error");
const groupsEl = document.getElementById("groups");
const mastCt   = document.getElementById("mast-count");

if (sessionStorage.getItem(STORAGE_KEY) === "1") {
  unlock();
} else {
  gate.hidden = false;
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (input.value === PASSWORD) {
    sessionStorage.setItem(STORAGE_KEY, "1");
    unlock();
  } else {
    errorEl.hidden = false;
    input.value = "";
    input.focus();
  }
});

async function unlock() {
  document.body.classList.remove("locked");
  gate.hidden = true;
  content.hidden = false;
  try {
    const res = await fetch("projects.json", { cache: "no-store" });
    const data = await res.json();
    render(data.projects || []);
  } catch (err) {
    groupsEl.innerHTML =
      '<p style="font-family:\'IBM Plex Mono\',monospace;font-size:12px;color:#9A9082;padding:40px 0;">Could not load projects.</p>';
  }
}

function hostOf(url) {
  try { return new URL(url).host.replace(/^www\./, ""); }
  catch { return ""; }
}

function render(projects) {
  const byHq = {};
  for (const p of projects) (byHq[p.hq] ||= []).push(p);

  groupsEl.innerHTML = "";
  let idx = 0;
  let total = 0;

  for (const hq of HQ_ORDER) {
    const list = byHq[hq];
    if (!list || !list.length) continue;

    const section = document.createElement("section");
    section.className = "band hq-" + hq;

    const head = document.createElement("div");
    head.className = "band-head";
    head.innerHTML =
      '<span class="band-mark"></span>' +
      '<span class="band-name">' + HQ_LABEL[hq] + '</span>' +
      '<span class="band-count">' + list.length +
        (list.length === 1 ? " project" : " projects") + '</span>';
    section.appendChild(head);

    for (const p of list) {
      idx += 1;
      total += 1;
      const a = document.createElement("a");
      a.href = p.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.className = "row";
      a.innerHTML =
        '<span class="row-idx">' + String(idx).padStart(2, "0") + '</span>' +
        '<div class="row-main">' +
          '<span class="row-cat">' + HQ_LABEL[hq] + '</span>' +
          '<h2 class="row-title">' + escapeHtml(p.name) + '</h2>' +
          '<p class="row-desc">' + escapeHtml(p.desc || p.url) + '</p>' +
        '</div>' +
        '<div class="row-meta">' +
          '<span class="row-tag">' + escapeHtml(hostOf(p.url)) + '</span>' +
        '</div>' +
        '<span class="row-arrow">→</span>';
      a.style.animationDelay = (0.84 + idx * 0.05) + "s";
      a.classList.add("shown");
      section.appendChild(a);
    }

    groupsEl.appendChild(section);
  }

  if (mastCt) mastCt.textContent = String(total).padStart(2, "0") + " Projects";
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
