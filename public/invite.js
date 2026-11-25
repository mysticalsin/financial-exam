// Process a new fragment as a fresh document, including links opened in the same tab.
// The browser never sends fragments to the server.
(() => {
  const TOKEN = /^[0-9a-f]{32}\.[0-9a-f]{64}$/;
  const fragment = () => new URLSearchParams(location.hash.slice(1));
  // Mail clients wrap the link, and some of them uppercase it. The claim key is the
  // invitation text, so the same link has to normalize to one token or a lost start
  // cannot be resumed.
  const normalizeInvite = (value) => {
    if (typeof value !== "string") return "";
    const compact = value.replace(/\s+/g, "").toLowerCase();
    const token = compact.endsWith(".") ? compact.slice(0, -1) : compact;
    return TOKEN.test(token) ? token : compact;
  };
  const readInvite = () => {
    const params = fragment();
    if (!params.has("invite")) return null;
    return normalizeInvite(params.get("invite"));
  };
  window.addEventListener("hashchange", () => {
    if (readInvite() === null) return;
    window.dispatchEvent(new Event("assessment:practice-clear"));
    window.assessmentChangingInvitation = true;
    if (document.body) document.body.hidden = true;
    location.reload();
  });
  const invite = readInvite();
  if (invite !== null) {
    window.assessmentInvitation = invite;
    history.replaceState(null, "", location.pathname + location.search);
  }
})();
