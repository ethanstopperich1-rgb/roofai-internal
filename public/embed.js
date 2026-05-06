/**
 * Voxaris Pitch Embed — drop-in roof-estimate widget for any website.
 *
 * Install:
 *   <div data-voxaris-pitch
 *        data-brand="noland"
 *        data-accent="67dcff"></div>
 *   <script src="https://pitch.voxaris.io/embed.js" async></script>
 *
 * Optional data-* attributes (all optional, sane defaults):
 *   data-brand     — "noland", "westorange", "earljohnston" etc. Tags every
 *                    lead with `source: embed-{brand}` so per-brand attribution
 *                    works. Default: "default".
 *   data-accent    — hex color (no #) for the CTA button. Default "67dcff".
 *   data-headline  — H1 override.
 *   data-sub       — subheadline override.
 *   data-phone     — "false" to drop the phone field.
 *   data-redirect  — URL to redirect the user to on successful submit. When
 *                    set, the host page navigates to {redirect}?leadId={id}
 *                    instead of staying on the in-iframe success state.
 *
 * Events (window.addEventListener("message", ...)):
 *   { type: "voxaris-pitch:resize", height, brand }
 *     Fired whenever the embed's content height changes — handled by this
 *     script to auto-size the iframe.
 *   { type: "voxaris-pitch:lead-submitted", brand, leadId, address }
 *     Fired when the homeowner submits the form. Listen for it to fire your
 *     own analytics / conversion pixel:
 *       window.addEventListener("message", (e) => {
 *         if (e.data?.type === "voxaris-pitch:lead-submitted") {
 *           gtag("event", "conversion", { send_to: "AW-XXX/YYY" });
 *         }
 *       });
 */
(function () {
  // Origin where the embed page is hosted. When this script is served from
  // pitch.voxaris.io/embed.js, document.currentScript.src points there and
  // we strip the path to get the origin.
  var SCRIPT_ORIGIN = (function () {
    var s = document.currentScript;
    if (!s) return "https://pitch.voxaris.io";
    try {
      return new URL(s.src).origin;
    } catch (e) {
      return "https://pitch.voxaris.io";
    }
  })();

  function buildEmbedUrl(el) {
    var u = new URL(SCRIPT_ORIGIN + "/embed");
    var pass = ["brand", "accent", "headline", "sub", "phone"];
    pass.forEach(function (k) {
      var v = el.getAttribute("data-" + k);
      if (v) u.searchParams.set(k, v);
    });
    return u.toString();
  }

  function mountOne(el) {
    if (el.dataset.voxarisMounted === "true") return;
    el.dataset.voxarisMounted = "true";

    var iframe = document.createElement("iframe");
    iframe.src = buildEmbedUrl(el);
    iframe.title = "Free roof estimate · Voxaris";
    iframe.loading = "lazy";
    iframe.style.cssText = [
      "border: 0",
      "width: 100%",
      "min-height: 320px",
      "background: #07090d",
      "border-radius: 16px",
      "box-shadow: 0 8px 40px -8px rgba(0,0,0,0.4)",
      "color-scheme: dark",
    ].join(";");
    iframe.setAttribute(
      "allow",
      "geolocation; clipboard-write",
    );
    el.appendChild(iframe);

    var brandAttr = el.getAttribute("data-brand") || "default";
    var redirect = el.getAttribute("data-redirect");

    function handler(e) {
      // Strict origin check — only accept messages from the script's origin.
      if (!e.origin || e.origin !== SCRIPT_ORIGIN) return;
      var msg = e.data;
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "voxaris-pitch:resize" && msg.brand === brandAttr) {
        iframe.style.height = msg.height + "px";
      }
      if (msg.type === "voxaris-pitch:lead-submitted" && msg.brand === brandAttr) {
        if (redirect) {
          var sep = redirect.indexOf("?") >= 0 ? "&" : "?";
          window.location.href = redirect + sep + "leadId=" + encodeURIComponent(msg.leadId);
        }
      }
    }
    window.addEventListener("message", handler);
  }

  function mountAll() {
    var nodes = document.querySelectorAll("[data-voxaris-pitch]");
    for (var i = 0; i < nodes.length; i++) mountOne(nodes[i]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountAll);
  } else {
    mountAll();
  }

  // Re-scan on later DOM mutations so SPAs that mount the placeholder
  // after initial paint still pick it up.
  if (typeof MutationObserver === "function") {
    var mo = new MutationObserver(mountAll);
    mo.observe(document.body, { childList: true, subtree: true });
  }
})();
