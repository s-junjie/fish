(function () {
  // Clean up any stale UI from previously injected scripts
  document.getElementById("__fish_inspect_overlay__")?.remove();
  document.getElementById("__fish_inspect_badge__")?.remove();
  document.getElementById("__fish_inspect_banner__")?.remove();
  document.getElementById("__fish_toast_notification__")?.remove();

  const OVERLAY_ID = "__fish_inspect_overlay__";
  const BADGE_ID = "__fish_inspect_badge__";
  const BANNER_ID = "__fish_inspect_banner__";
  const TOAST_ID = "__fish_toast_notification__";

  let isInspectMode = false;
  let hoveredElement = null;

  function showToast(message, isError = false, duration = 3500) {
    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement("div");
      toast.id = TOAST_ID;
      toast.style.cssText = `
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%) translateY(0);
        background: #181818;
        color: #F3F4F6;
        padding: 10px 18px;
        border-radius: 8px;
        border: 1px solid #3F3F46;
        box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(245, 158, 11, 0.4);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 13px;
        font-weight: 500;
        z-index: 2147483647;
        pointer-events: none;
        display: flex;
        align-items: center;
        gap: 8px;
        transition: opacity 0.2s, transform 0.2s;
      `;
      (document.body || document.documentElement).appendChild(toast);
    }
    const icon = isError ? `<span style="color: #EF4444; font-weight: 700;">✕</span>` : `<span style="color: #F59E0B; font-weight: 700;">✓</span>`;
    toast.innerHTML = `${icon} ${message}`;
    toast.style.opacity = "1";
    setTimeout(() => {
      if (toast) {
        toast.style.opacity = "0";
        setTimeout(() => toast.remove(), 250);
      }
    }, duration);
  }

  function createInspectUI() {
    const root = document.body || document.documentElement;

    // Top instruction banner
    let banner = document.getElementById(BANNER_ID);
    if (!banner) {
      banner = document.createElement("div");
      banner.id = BANNER_ID;
      banner.style.cssText = `
        position: fixed;
        top: 14px;
        left: 50%;
        transform: translateX(-50%);
        background: #121212;
        color: #E5E7EB;
        padding: 8px 18px;
        border-radius: 20px;
        border: 1px solid #F59E0B;
        box-shadow: 0 4px 20px rgba(0,0,0,0.6);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 12.5px;
        font-weight: 500;
        z-index: 2147483647;
        pointer-events: none;
        display: flex;
        align-items: center;
        gap: 8px;
      `;
      banner.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#F59E0B;"></span> <b>FISH Inspect</b>: Hover & click any element to copy · Esc to cancel`;
      root.appendChild(banner);
    }

    // Highlight box
    let overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = OVERLAY_ID;
      overlay.style.cssText = `
        position: fixed;
        pointer-events: none;
        border: 2px solid #F59E0B;
        background: rgba(245, 158, 11, 0.08);
        border-radius: 2px;
        z-index: 2147483646;
        display: none;
        box-sizing: border-box;
      `;
      root.appendChild(overlay);
    }

    // Floating badge
    let badge = document.getElementById(BADGE_ID);
    if (!badge) {
      badge = document.createElement("div");
      badge.id = BADGE_ID;
      badge.style.cssText = `
        position: fixed;
        pointer-events: none;
        background: #181818;
        color: #FBBF24;
        padding: 3px 8px;
        border-radius: 4px;
        border: 1px solid #F59E0B;
        font-family: ui-monospace, SFMono-Regular, monospace;
        font-size: 11px;
        font-weight: 600;
        z-index: 2147483647;
        display: none;
        white-space: nowrap;
        box-shadow: 0 2px 8px rgba(0,0,0,0.4);
      `;
      root.appendChild(badge);
    }
  }

  function removeInspectUI() {
    document.getElementById(OVERLAY_ID)?.remove();
    document.getElementById(BADGE_ID)?.remove();
    document.getElementById(BANNER_ID)?.remove();
  }

  function onPointerMove(e) {
    if (!isInspectMode) return;
    const target = document.elementFromPoint(e.clientX, e.clientY);
    if (!target || target.id === OVERLAY_ID || target.id === BADGE_ID || target.id === BANNER_ID) return;

    hoveredElement = target;
    const rect = target.getBoundingClientRect();
    const overlay = document.getElementById(OVERLAY_ID);
    const badge = document.getElementById(BADGE_ID);

    if (overlay && badge) {
      overlay.style.display = "block";
      overlay.style.left = `${rect.left}px`;
      overlay.style.top = `${rect.top}px`;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;

      const tag = target.tagName.toLowerCase();
      let cls = "";
      if (target.className && typeof target.className === "string") {
        const parts = target.className.trim().split(/\s+/).filter(Boolean);
        if (parts.length > 0) cls = "." + parts.slice(0, 2).join(".");
      }
      badge.textContent = `${tag}${cls} (${Math.round(rect.width)} × ${Math.round(rect.height)})`;
      badge.style.display = "block";

      const badgeTop = rect.top - 28 < 10 ? rect.bottom + 6 : rect.top - 28;
      badge.style.left = `${Math.max(8, rect.left)}px`;
      badge.style.top = `${badgeTop}px`;
    }
  }

  async function onPointerClick(e) {
    if (!isInspectMode || !hoveredElement) return;
    e.preventDefault();
    e.stopPropagation();

    const target = hoveredElement;
    stopInspect();
    showToast("Extracting element and styles...", false, 2000);
    await serializeAndCopy(target, "element");
  }

  function onKeyDown(e) {
    if (e.key === "Escape" && isInspectMode) {
      e.preventDefault();
      stopInspect();
    }
  }

  function startInspect() {
    isInspectMode = true;
    createInspectUI();
    document.addEventListener("mousemove", onPointerMove, true);
    document.addEventListener("click", onPointerClick, true);
    document.addEventListener("keydown", onKeyDown, true);
  }

  function stopInspect() {
    isInspectMode = false;
    hoveredElement = null;
    document.removeEventListener("mousemove", onPointerMove, true);
    document.removeEventListener("click", onPointerClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    removeInspectUI();
  }

  function collectStylesheets() {
    const rules = [];
    try {
      for (const sheet of document.styleSheets) {
        try {
          if (sheet.cssRules) {
            for (let i = 0; i < sheet.cssRules.length; i++) {
              rules.push(sheet.cssRules[i].cssText);
            }
          }
        } catch {
          if (sheet.href) {
            rules.push(`@import url("${sheet.href}");`);
          }
        }
      }
    } catch (err) {
      console.warn("FISH: Could not read all document stylesheets:", err);
    }
    return rules.join("\n");
  }

  async function triggerLazyLoad() {
    // 1. Force native lazy images to eager
    try {
      const lazyImgs = document.querySelectorAll('img[loading="lazy"]');
      for (const img of lazyImgs) {
        img.loading = "eager";
      }
    } catch {}

    // 2. Measure total window scroll height
    const origWindowX = window.scrollX;
    const origWindowY = window.scrollY;
    const docHeight = Math.max(
      document.body?.scrollHeight || 0,
      document.documentElement?.scrollHeight || 0
    );
    const vh = window.innerHeight || 800;

    // Step scroll to trigger IntersectionObservers on long pages
    if (docHeight > vh * 1.2) {
      const step = Math.max(Math.round(vh * 0.75), 400);
      for (let y = 0; y < docHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 40));
      }
      window.scrollTo(0, docHeight);
      await new Promise((r) => setTimeout(r, 100));
      window.scrollTo(origWindowX, origWindowY);
      await new Promise((r) => setTimeout(r, 50));
    }

    // 3. Trigger scroll on SPA containers (e.g. dashboards with overflow: auto)
    try {
      const containers = Array.from(document.querySelectorAll("main, [role='main'], #root, #__next, .main-content")).filter(
        (el) => el.scrollHeight > el.clientHeight + 200
      );
      for (const container of containers) {
        const origTop = container.scrollTop;
        const sh = container.scrollHeight;
        const ch = container.clientHeight;
        const step = Math.max(Math.round(ch * 0.75), 300);
        for (let y = 0; y < sh; y += step) {
          container.scrollTop = y;
          await new Promise((r) => setTimeout(r, 30));
        }
        container.scrollTop = origTop;
      }
    } catch {}

    // 4. Brief wait for any in-flight image decodes
    try {
      const images = Array.from(document.querySelectorAll("img"));
      const pendingImages = images.filter((img) => !img.complete && img.src);
      if (pendingImages.length > 0) {
        await Promise.race([
          Promise.all(
            pendingImages.slice(0, 30).map((img) =>
              img.decode ? img.decode().catch(() => {}) : new Promise((r) => { img.onload = img.onerror = r; })
            )
          ),
          new Promise((r) => setTimeout(r, 600))
        ]);
      }
    } catch {}
  }

  function inlineComputedStyles(origEl, cloneEl, isRoot) {
    if (!(origEl instanceof Element)) return;
    const cs = window.getComputedStyle(origEl);
    if (!cs) return;

    if (isRoot) {
      const rect = origEl.getBoundingClientRect();
      cloneEl.style.position = "relative";
      cloneEl.style.left = "0px";
      cloneEl.style.top = "0px";
      cloneEl.style.margin = "0px";
      cloneEl.style.width = `${Math.round(rect.width)}px`;
    }

    const styleMap = {};

    // Typography & Colors
    styleMap["color"] = cs.color;
    styleMap["font-family"] = cs.fontFamily;
    styleMap["font-size"] = cs.fontSize;
    styleMap["font-weight"] = cs.fontWeight;
    if (cs.fontStyle && cs.fontStyle !== "normal") styleMap["font-style"] = cs.fontStyle;
    if (cs.fontVariantNumeric && cs.fontVariantNumeric !== "normal") styleMap["font-variant-numeric"] = cs.fontVariantNumeric;
    if (cs.lineHeight && cs.lineHeight !== "normal") styleMap["line-height"] = cs.lineHeight;
    if (cs.letterSpacing && cs.letterSpacing !== "normal") styleMap["letter-spacing"] = cs.letterSpacing;
    if (cs.textAlign) styleMap["text-align"] = cs.textAlign;
    if (cs.textTransform && cs.textTransform !== "none") styleMap["text-transform"] = cs.textTransform;
    if (cs.textDecorationLine && cs.textDecorationLine !== "none") {
      styleMap["text-decoration-line"] = cs.textDecorationLine;
      styleMap["text-decoration-color"] = cs.textDecorationColor;
      if (cs.textDecorationStyle && cs.textDecorationStyle !== "solid") {
        styleMap["text-decoration-style"] = cs.textDecorationStyle;
      }
    }
    if (cs.whiteSpace && cs.whiteSpace !== "normal") styleMap["white-space"] = cs.whiteSpace;
    if (cs.textShadow && cs.textShadow !== "none") styleMap["text-shadow"] = cs.textShadow;

    // Background
    if (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent") {
      styleMap["background-color"] = cs.backgroundColor;
    }
    if (cs.backgroundImage && cs.backgroundImage !== "none") {
      styleMap["background-image"] = cs.backgroundImage;
      styleMap["background-size"] = cs.backgroundSize;
      styleMap["background-position"] = cs.backgroundPosition;
      styleMap["background-repeat"] = cs.backgroundRepeat;
    }

    // Borders & Radius
    for (const side of ["top", "right", "bottom", "left"]) {
      const w = cs.getPropertyValue(`border-${side}-width`);
      const s = cs.getPropertyValue(`border-${side}-style`);
      const c = cs.getPropertyValue(`border-${side}-color`);
      if (parseFloat(w) > 0 && s !== "none" && s !== "hidden") {
        styleMap[`border-${side}-width`] = w;
        styleMap[`border-${side}-style`] = s;
        styleMap[`border-${side}-color`] = c;
      }
    }
    const hasRadius = (r) => r && r !== "0px";
    if (hasRadius(cs.borderTopLeftRadius)) styleMap["border-top-left-radius"] = cs.borderTopLeftRadius;
    if (hasRadius(cs.borderTopRightRadius)) styleMap["border-top-right-radius"] = cs.borderTopRightRadius;
    if (hasRadius(cs.borderBottomRightRadius)) styleMap["border-bottom-right-radius"] = cs.borderBottomRightRadius;
    if (hasRadius(cs.borderBottomLeftRadius)) styleMap["border-bottom-left-radius"] = cs.borderBottomLeftRadius;

    // Box Model & Layout
    styleMap["box-sizing"] = cs.boxSizing || "border-box";
    styleMap["display"] = cs.display;

    for (const side of ["top", "right", "bottom", "left"]) {
      const p = cs.getPropertyValue(`padding-${side}`);
      if (p && p !== "0px") styleMap[`padding-${side}`] = p;
    }

    if (!isRoot) {
      for (const side of ["top", "right", "bottom", "left"]) {
        const m = cs.getPropertyValue(`margin-${side}`);
        if (m && m !== "0px") styleMap[`margin-${side}`] = m;
      }
    }

    // Flex & Grid container properties
    const isFlex = cs.display.includes("flex");
    const isGrid = cs.display.includes("grid");
    if (isFlex || isGrid) {
      if (cs.gap && cs.gap !== "normal" && cs.gap !== "0px") styleMap["gap"] = cs.gap;
      if (cs.rowGap && cs.rowGap !== "normal" && cs.rowGap !== "0px") styleMap["row-gap"] = cs.rowGap;
      if (cs.columnGap && cs.columnGap !== "normal" && cs.columnGap !== "0px") styleMap["column-gap"] = cs.columnGap;
      if (cs.justifyContent && cs.justifyContent !== "normal") styleMap["justify-content"] = cs.justifyContent;
      if (cs.alignItems && cs.alignItems !== "normal") styleMap["align-items"] = cs.alignItems;
      if (cs.alignContent && cs.alignContent !== "normal") styleMap["align-content"] = cs.alignContent;
    }
    if (isFlex) {
      if (cs.flexDirection && cs.flexDirection !== "row") styleMap["flex-direction"] = cs.flexDirection;
      if (cs.flexWrap && cs.flexWrap !== "nowrap") styleMap["flex-wrap"] = cs.flexWrap;
    }
    if (isGrid) {
      if (cs.gridTemplateColumns && cs.gridTemplateColumns !== "none") styleMap["grid-template-columns"] = cs.gridTemplateColumns;
      if (cs.gridTemplateRows && cs.gridTemplateRows !== "none") styleMap["grid-template-rows"] = cs.gridTemplateRows;
    }

    // Flex item properties
    if (cs.flexGrow && cs.flexGrow !== "0") styleMap["flex-grow"] = cs.flexGrow;
    if (cs.flexShrink && cs.flexShrink !== "1") styleMap["flex-shrink"] = cs.flexShrink;
    if (cs.flexBasis && cs.flexBasis !== "auto") styleMap["flex-basis"] = cs.flexBasis;
    if (cs.alignSelf && cs.alignSelf !== "auto") styleMap["align-self"] = cs.alignSelf;

    // Visual Effects
    if (cs.boxShadow && cs.boxShadow !== "none") styleMap["box-shadow"] = cs.boxShadow;
    if (cs.opacity && cs.opacity !== "1") styleMap["opacity"] = cs.opacity;
    if (cs.filter && cs.filter !== "none") styleMap["filter"] = cs.filter;
    if (cs.backdropFilter && cs.backdropFilter !== "none") styleMap["backdrop-filter"] = cs.backdropFilter;
    if (cs.mixBlendMode && cs.mixBlendMode !== "normal") styleMap["mix-blend-mode"] = cs.mixBlendMode;
    if (cs.overflow && cs.overflow !== "visible") styleMap["overflow"] = cs.overflow;
    if (cs.overflowX && cs.overflowX !== "visible") styleMap["overflow-x"] = cs.overflowX;
    if (cs.overflowY && cs.overflowY !== "visible") styleMap["overflow-y"] = cs.overflowY;

    // Transforms
    if (cs.transform && cs.transform !== "none") {
      styleMap["transform"] = cs.transform;
      styleMap["transform-origin"] = cs.transformOrigin;
    }

    // SVG specifics
    if (origEl instanceof SVGElement) {
      if (cs.fill && cs.fill !== "none") styleMap["fill"] = cs.fill;
      if (cs.stroke && cs.stroke !== "none") styleMap["stroke"] = cs.stroke;
      if (cs.strokeWidth) styleMap["stroke-width"] = cs.strokeWidth;
    }

    for (const [prop, val] of Object.entries(styleMap)) {
      try {
        cloneEl.style.setProperty(prop, val);
      } catch {}
    }
  }

  function resolveAbsoluteUrl(raw) {
    if (!raw || typeof raw !== "string") return "";
    const trimmed = raw.trim();
    if (
      trimmed.startsWith("data:") ||
      trimmed.startsWith("blob:") ||
      trimmed.startsWith("#") ||
      trimmed.startsWith("javascript:")
    ) {
      return trimmed;
    }
    try {
      return new URL(trimmed, window.location.href).href;
    } catch {
      return trimmed;
    }
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Concurrently convert referenced image URLs to Base64 Data URIs.
   * Delegates to the background service worker (which has host_permissions: ["<all_urls>"]
   * to bypass CORS), with fallback to page-context fetch.
   */
  async function inlineImages(urls) {
    const result = {};
    if (!Array.isArray(urls) || urls.length === 0) return result;

    const needFetch = [];

    for (const raw of urls) {
      if (!raw || typeof raw !== "string") continue;
      const url = raw.trim();
      if (!url) continue;

      if (url.startsWith("data:")) {
        result[url] = url;
        continue;
      }

      if (url.startsWith("blob:")) {
        try {
          const resp = await fetch(url);
          if (resp.ok) {
            const dataUrl = await blobToDataUrl(await resp.blob());
            if (dataUrl) result[url] = dataUrl;
          }
        } catch {}
        continue;
      }

      if (/^https?:\/\//i.test(url)) {
        needFetch.push(url);
      }
    }

    if (needFetch.length === 0) return result;

    const uniqueHttp = Array.from(new Set(needFetch));

    // 1. Try background service worker first (bypasses CORS via host_permissions)
    let bgHandled = false;
    try {
      if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        const response = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), 10000);
          chrome.runtime.sendMessage({ action: "inline-images", urls: uniqueHttp }, (res) => {
            clearTimeout(timer);
            resolve(res);
          });
        });
        if (response && response.success && response.results) {
          Object.assign(result, response.results);
          bgHandled = true;
        }
      }
    } catch (e) {
      console.warn("FISH: Background image inlining threw:", e);
    }

    // 2. Fallback: for any URLs not resolved by background, try in page context
    const remaining = uniqueHttp.filter((u) => !result[u]);
    if (remaining.length > 0) {
      await Promise.all(
        remaining.map(async (url) => {
          try {
            const resp = await fetch(url, { cache: "force-cache" });
            if (resp.ok) {
              const dataUrl = await blobToDataUrl(await resp.blob());
              if (dataUrl) result[url] = dataUrl;
            }
          } catch {}
        })
      );
    }

    return result;
  }

  async function serializeSubtree(node, isPickedElement = false) {
    try {
      const clone = node.cloneNode(true);

      // 1. Turn canvas elements into png images if possible
      try {
        const origCanvases = node.querySelectorAll ? [node, ...node.querySelectorAll("canvas")] : [];
        const cloneCanvases = clone.querySelectorAll ? [clone, ...clone.querySelectorAll("canvas")] : [];
        for (let i = 0; i < origCanvases.length; i++) {
          if (origCanvases[i].tagName === "CANVAS" && cloneCanvases[i]) {
            try {
              const dataUrl = origCanvases[i].toDataURL();
              if (dataUrl && dataUrl.length > 20) {
                const img = document.createElement("img");
                img.src = dataUrl;
                img.className = origCanvases[i].className;
                cloneCanvases[i].replaceWith(img);
              }
            } catch {
              // Ignore tainted or WebGL canvas errors
            }
          }
        }
      } catch {}

      // 2. In Pick Element mode: inline computed styles for high-fidelity component extraction
      if (isPickedElement && node.nodeType === Node.ELEMENT_NODE) {
        try {
          const origElements = [node, ...(node.querySelectorAll ? node.querySelectorAll("*") : [])];
          const cloneElements = [clone, ...(clone.querySelectorAll ? clone.querySelectorAll("*") : [])];
          const len = Math.min(origElements.length, cloneElements.length);
          for (let i = 0; i < len; i++) {
            inlineComputedStyles(origElements[i], cloneElements[i], i === 0);
          }
        } catch (e) {
          console.warn("FISH: Failed to inline computed styles on picked element:", e);
        }
      }

      // 3. Collect all referenced image URLs from elements, SVG images, and backgrounds
      const origElements = [node, ...(node.querySelectorAll ? node.querySelectorAll("*") : [])];
      const cloneElements = [clone, ...(clone.querySelectorAll ? clone.querySelectorAll("*") : [])];
      const count = Math.min(origElements.length, cloneElements.length);

      const urlsToInline = new Set();
      const imageEntries = [];

      for (let i = 0; i < count; i++) {
        const origEl = origElements[i];
        const cloneEl = cloneElements[i];
        if (!origEl || !cloneEl || origEl.nodeType !== Node.ELEMENT_NODE) continue;

        // A. <img> tags
        if (origEl.tagName === "IMG") {
          const raw =
            origEl.currentSrc ||
            origEl.src ||
            origEl.getAttribute("src") ||
            origEl.getAttribute("data-src") ||
            origEl.getAttribute("data-original") ||
            "";
          const resolved = resolveAbsoluteUrl(raw);
          if (resolved) {
            urlsToInline.add(resolved);
            imageEntries.push({ cloneEl, origEl, type: "img", rawUrl: resolved });
          }
        }

        // B. SVG <image> tags
        if (origEl.tagName === "IMAGE" || origEl.tagName === "image") {
          const raw =
            origEl.getAttribute("href") ||
            origEl.getAttribute("xlink:href") ||
            cloneEl.getAttribute("href") ||
            cloneEl.getAttribute("xlink:href") ||
            "";
          const resolved = resolveAbsoluteUrl(raw);
          if (resolved) {
            urlsToInline.add(resolved);
            imageEntries.push({ cloneEl, origEl, type: "svg-image", rawUrl: resolved });
          }
        }

        // C. Background images
        try {
          const csBg =
            (isPickedElement ? cloneEl.style.backgroundImage : null) ||
            window.getComputedStyle(origEl).backgroundImage;
          if (csBg && csBg !== "none" && csBg.includes("url(")) {
            for (const match of csBg.matchAll(/url\((["']?)([^"')]+)\1\)/g)) {
              const bgUrl = resolveAbsoluteUrl(match[2]);
              if (bgUrl) {
                urlsToInline.add(bgUrl);
              }
            }
            imageEntries.push({ cloneEl, origEl, type: "bg", csBg });
          }
        } catch {}

        // D. Resolve relative <a> hyperlinks safely
        if (origEl.tagName === "A") {
          try {
            const href = cloneEl.getAttribute("href");
            if (href && !href.startsWith("#") && !href.startsWith("javascript:")) {
              cloneEl.href = resolveAbsoluteUrl(href);
            }
          } catch {}
        }
      }

      // 4. Concurrently fetch and convert images to Base64 Data URIs
      if (urlsToInline.size > 0) {
        const urlMap = await inlineImages(Array.from(urlsToInline));

        // 5. Replace URLs in cloned DOM with Base64 Data URIs
        for (const entry of imageEntries) {
          const { cloneEl, type, rawUrl, csBg } = entry;
          if (type === "img") {
            const inlined = urlMap[rawUrl];
            if (inlined) {
              cloneEl.src = inlined;
              cloneEl.setAttribute("src", inlined);
              cloneEl.removeAttribute("srcset");
              cloneEl.removeAttribute("loading");
            } else if (rawUrl) {
              cloneEl.src = rawUrl;
              cloneEl.setAttribute("src", rawUrl);
            }
            // Strip child <source> tags from parent <picture> to ensure the inlined img is rendered
            const picture = cloneEl.closest ? cloneEl.closest("picture") : null;
            if (picture) {
              for (const s of Array.from(picture.querySelectorAll("source"))) {
                s.remove();
              }
            }
          } else if (type === "svg-image") {
            const inlined = urlMap[rawUrl];
            if (inlined) {
              cloneEl.setAttribute("href", inlined);
              if (cloneEl.hasAttribute("xlink:href")) {
                cloneEl.setAttribute("xlink:href", inlined);
              }
            } else if (rawUrl) {
              cloneEl.setAttribute("href", rawUrl);
            }
          } else if (type === "bg" && csBg) {
            let nextBg = csBg;
            for (const match of csBg.matchAll(/url\((["']?)([^"')]+)\1\)/g)) {
              const bgUrl = resolveAbsoluteUrl(match[2]);
              const inlined = urlMap[bgUrl];
              if (inlined) {
                nextBg = nextBg.replaceAll(match[0], `url("${inlined}")`);
              }
            }
            if (nextBg !== csBg) {
              cloneEl.style.backgroundImage = nextBg;
            }
          }
        }
      }

      return clone.outerHTML || clone.innerHTML;
    } catch (err) {
      console.warn("FISH: serializeSubtree encountered an error, falling back:", err);
      return node.outerHTML || node.innerHTML;
    }
  }

  function buildHtmlEnvelope(bodyHtml, title) {
    const styles = collectStylesheets();
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    ${styles}
  </style>
</head>
<body style="margin:0;padding:0;background:transparent;">
  ${bodyHtml}
</body>
</html>`;
  }

  async function writeClipboardText(text) {
    // 1. Modern Async Clipboard API
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (e) {
        console.warn("FISH: navigator.clipboard.writeText threw, falling back to execCommand:", e);
      }
    }

    // 2. Fallback via temporary textarea
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.cssText = "position:fixed;left:10px;top:10px;width:10px;height:10px;opacity:0.01;z-index:2147483647;";
    (document.body || document.documentElement).appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      const ok = document.execCommand("copy");
      textarea.remove();
      if (ok) return true;
    } catch (e) {
      textarea.remove();
      throw e;
    }

    throw new Error("Clipboard copy was blocked by the browser. Please check tab focus or permissions.");
  }

  async function serializeAndCopy(targetNode, mode = "element") {
    try {
      const title = document.title || "Captured Webpage";
      const bodyHtml = await serializeSubtree(targetNode, mode === "element");
      const completeHtml = buildHtmlEnvelope(bodyHtml, title);

      const payload = {
        format: "fish-html-clip",
        version: "0.1",
        mode,
        title: mode === "element" ? `${targetNode.tagName.toLowerCase()} · ${title}` : title,
        url: window.location.href,
        html: completeHtml
      };

      await writeClipboardText(JSON.stringify(payload));
      showToast(`Copied! Switch to FISH and press ⌘V to paste.`, false);
    } catch (err) {
      console.error("FISH Capture error:", err);
      showToast(`Capture failed: ${err.message || String(err)}`, true);
    }
  }

  // Handle messages from extension popup
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "ping") {
      sendResponse({ status: "pong" });
      return true;
    }

    if (msg.action === "start-inspect") {
      startInspect();
      sendResponse({ status: "started" });
      return true;
    }

    if (msg.action === "capture-page") {
      (async () => {
        try {
          await triggerLazyLoad();
          const title = document.title || "Captured Page";
          const root = document.body || document.documentElement;
          const bodyHtml = await serializeSubtree(root, false);
          const completeHtml = buildHtmlEnvelope(bodyHtml, title);

          sendResponse({
            success: true,
            html: completeHtml,
            title,
            url: window.location.href
          });
        } catch (err) {
          console.error("FISH: Failed to capture page:", err);
          sendResponse({
            success: false,
            error: err.message || String(err)
          });
        }
      })();
      return true;
    }

    return true;
  });
})();
