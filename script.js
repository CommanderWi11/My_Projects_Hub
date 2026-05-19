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
  gate.hidden = true;
  content.hidden = false;
  try {
    const res = await fetch("projects.json", { cache: "no-store" });
    const data = await res.json();
    render(data.projects || []);
  } catch (err) {
    groupsEl.textContent = "Could not load projects.";
  }
}

function render(projects) {
  const byHq = {};
  for (const p of projects) {
    (byHq[p.hq] ||= []).push(p);
  }

  groupsEl.innerHTML = "";
  for (const hq of HQ_ORDER) {
    const list = byHq[hq];
    if (!list || !list.length) continue;

    const section = document.createElement("section");
    section.className = "group";

    const h2 = document.createElement("h2");
    h2.textContent = HQ_LABEL[hq];
    section.appendChild(h2);

    for (const p of list) {
      const entry = document.createElement("div");
      entry.className = "entry";

      const a = document.createElement("a");
      a.href = p.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = p.name;

      const url = document.createElement("span");
      url.className = "url";
      url.textContent = p.url;

      entry.append(a, url);
      section.appendChild(entry);
    }

    groupsEl.appendChild(section);
  }
}
