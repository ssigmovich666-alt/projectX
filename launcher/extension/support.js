(() => {
  "use strict";

  const root = document.documentElement;
  const surfaceAttribute = "data-projectx-support-surface";
  const inkAttribute = "data-projectx-support-ink";
  const surfaces = "main, section, aside, article, div, form, fieldset, header, nav, footer, ul, li, table, tr, th, td, a, button, span, label, input, select, textarea";
  const candidates = surfaces + ", p, time, small, strong, em, h1, h2, h3, h4, h5, h6";
  const excluded = ".projectx-settings, .projectx-nav-button, .badge, .avatar, .avatar-photo, .btn-primary, .btn-success, .btn-warning, .btn-danger";

  function rgb(value) {
    const channels = /^rgba?\(([^)]+)\)$/.exec(value)?.[1].split(",").map(Number);
    return channels?.length >= 3 ? channels : null;
  }

  function refreshSurfaces() {
    if (!root.hasAttribute("data-projectx-themed")) return;

    // Read styles in one pass so marking a panel does not force layout between elements.
    const updates = [];
    for (const element of document.body.querySelectorAll(candidates)) {
      if (element.closest(excluded)) continue;

      const checkSurface = element.matches(surfaces) && !element.hasAttribute(surfaceAttribute);
      const checkInk = !element.hasAttribute(inkAttribute) && [...element.childNodes]
        .some(node => node.nodeType === Node.TEXT_NODE && /\S/.test(node.nodeValue));
      if (!checkSurface && !checkInk) continue;

      const style = getComputedStyle(element);
      if (checkSurface && style.backgroundImage === "none") {
        const background = rgb(style.backgroundColor);
        if (background) {
          const [red, green, blue, opacity = 1] = background;
          const low = Math.min(red, green, blue);
          const high = Math.max(red, green, blue);
          if (opacity >= 0.65 && low >= 175 && (red + green + blue) / 3 >= 197) {
            const shade = high - low >= 14 ? "tint" : low >= 248 ? "base" : "neutral";
            updates.push([element, surfaceAttribute, shade]);
          }
        }
      }
      if (checkInk) {
        const ink = rgb(style.color);
        if (ink && Math.max(ink[0], ink[1], ink[2]) <= 153) {
          updates.push([element, inkAttribute, ""]);
        }
      }
    }
    for (const [element, attribute, value] of updates) {
      element.setAttribute(attribute, value);
    }
  }

  let frame;
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type !== "attributes" || record.target === root) continue;
      record.target.removeAttribute(surfaceAttribute);
      record.target.removeAttribute(inkAttribute);
    }
    if (frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      refreshSurfaces();
    });
  });
  observer.observe(root, { attributes: true, attributeFilter: ["data-projectx-themed"] });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden"],
  });
  refreshSurfaces();
})();
