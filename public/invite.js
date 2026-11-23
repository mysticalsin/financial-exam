// Process a new fragment as a fresh document, including links opened in the same tab.
// The browser never sends fragments to the server.
(() => {
  const fragment = () => new URLSearchParams(location.hash.slice(1));
  window.addEventListener("hashchange", () => {
    if (!fragment().has("invite")) return;
    window.dispatchEvent(new Event("assessment:practice-clear"));
    window.assessmentChangingInvitation = true;
    if (document.body) document.body.hidden = true;
    location.reload();
  });
  if (fragment().has("invite")) {
    window.assessmentInvitation = fragment().get("invite");
    history.replaceState(null, "", location.pathname + location.search);
  }
})();
