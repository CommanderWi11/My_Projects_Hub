// Set-password page logic (externalized so the CSP can use script-src 'self').
var $ = function (id) { return document.getElementById(id); };
var token = new URLSearchParams(location.search).get("token") || "";
if (!token) { $("err").textContent = "Missing or invalid link."; $("err").hidden = false; $("login-form").hidden = true; }

function showErr(m) { $("err").textContent = m; $("err").hidden = false; }

document.querySelector("form").addEventListener("submit", async function (e) {
  e.preventDefault();
  $("err").hidden = true;
  var p1 = $("pw1").value, p2 = $("pw2").value;
  if (p1.length < 8) { return showErr("Password must be at least 8 characters."); }
  if (p1 !== p2) { return showErr("Passwords don't match."); }
  var btn = document.querySelector("form button");
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    var res = await fetch("api/set-password", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token, password: p1 }),
    });
    var j = await res.json();
    if (!res.ok || !j.ok) throw new Error(j.error || "Could not set password");
    document.querySelector("form").hidden = true;
    $("note").textContent = "Password updated. You can sign in now.";
    $("done").hidden = false;
  } catch (err) {
    showErr(err.message || "Could not set password");
  } finally { btn.disabled = false; btn.textContent = "Save password"; }
});
