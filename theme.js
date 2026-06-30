// Set theme before first paint to avoid flash. Loaded in <head> (render-blocking).
(function () {
  try {
    var saved = localStorage.getItem("mph_theme");
    var sys = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", saved || sys);
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "light");
  }
})();
