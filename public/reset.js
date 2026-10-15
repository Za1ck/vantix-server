const query = new URLSearchParams(location.search);
let token = query.get("token");
history.replaceState(null, "", location.pathname);
const form = document.getElementById("reset-form");
const status = document.getElementById("status");
const button = form.querySelector("button");
if (!token || query.has("error")) {
  form.hidden = true;
  status.textContent = "Linket er ugyldigt eller udløbet. Bed om en ny nulstillingsmail i Vantix.";
}
form.addEventListener("submit", async event => {
  event.preventDefault();
  const password = document.getElementById("password");
  const confirm = document.getElementById("confirm");
  if (!token || password.value.length < 12 || password.value.length > 128 || password.value !== confirm.value) {
    status.textContent = "Brug mindst 12 tegn, og skriv den samme adgangskode i begge felter.";
    return;
  }
  button.disabled = true;
  status.textContent = "Gemmer…";
  try {
    const response = await fetch("/api/auth/reset-password", {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, newPassword: password.value }), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error();
    token = null;
    form.reset();
    form.hidden = true;
    status.textContent = "Din adgangskode er ændret, og tidligere sessioner er afsluttet. Gå tilbage til Vantix, og log ind igen.";
  } catch {
    status.textContent = "Adgangskoden kunne ikke ændres. Linket kan være udløbet, eller tjenesten er ikke klar. Prøv et nyt link senere.";
    button.disabled = false;
  }
});
