async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

const btnPick = document.getElementById("btn-pick");
const btnPage = document.getElementById("btn-page");
const statusBox = document.getElementById("status-box");
const statusSpinner = document.getElementById("status-spinner");
const statusText = document.getElementById("status-text");

function showStatus(text, type = "loading") {
  if (!statusBox || !statusText) return;
  statusBox.style.display = "flex";
  statusBox.className = `status-box status-${type}`;
  statusText.textContent = text;
  if (statusSpinner) {
    statusSpinner.style.display = type === "loading" ? "block" : "none";
  }
}

function hideStatus() {
  if (statusBox) statusBox.style.display = "none";
}

function setButtonsDisabled(disabled) {
  if (btnPick) btnPick.disabled = disabled;
  if (btnPage) btnPage.disabled = disabled;
}

async function ensureContentScript(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { action: "ping" });
    if (res && res.status === "pong") return true;
  } catch {
    // Ping failed, inject script
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
    // Wait for listener registration
    await new Promise((r) => setTimeout(r, 80));
    return true;
  } catch (err) {
    console.error("Failed to inject content script:", err);
    return false;
  }
}

btnPick?.addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    showStatus("No active tab found", "error");
    return;
  }

  if (tab.url?.startsWith("chrome://") || tab.url?.startsWith("chrome-extension://")) {
    showStatus("Cannot capture Chrome system pages. Please open a webpage.", "error");
    return;
  }

  setButtonsDisabled(true);
  showStatus("Activating inspector...", "loading");

  const ready = await ensureContentScript(tab.id);
  if (!ready) {
    setButtonsDisabled(false);
    showStatus("Please refresh this tab (⌘R) once, then try again.", "error");
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { action: "start-inspect" });
    if (response && response.status === "started") {
      window.close();
    } else {
      setButtonsDisabled(false);
      showStatus("Please refresh this tab (⌘R) once, then try again.", "error");
    }
  } catch (err) {
    setButtonsDisabled(false);
    showStatus("Please refresh this tab (⌘R) once, then try again.", "error");
  }
});

btnPage?.addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    showStatus("No active tab found", "error");
    return;
  }

  if (tab.url?.startsWith("chrome://") || tab.url?.startsWith("chrome-extension://")) {
    showStatus("Cannot capture Chrome system pages. Please open a webpage.", "error");
    return;
  }

  setButtonsDisabled(true);
  showStatus("Auto-scrolling & loading images...", "loading");

  const ready = await ensureContentScript(tab.id);
  if (!ready) {
    setButtonsDisabled(false);
    showStatus("Please refresh this tab (⌘R) once, then try again.", "error");
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { action: "capture-page" });

    if (!response || !response.success) {
      throw new Error(response?.error || "Failed to extract page content");
    }

    showStatus("Writing to clipboard...", "loading");

    const payload = {
      format: "fish-html-clip",
      version: "0.1",
      mode: "page",
      title: response.title || tab.title || "Captured Page",
      url: response.url || tab.url,
      html: response.html
    };

    // Modern async clipboard API in extension popup context
    const jsonStr = JSON.stringify(payload);
    await navigator.clipboard.writeText(jsonStr);

    showStatus("✓ Copied! Switch to FISH & press ⌘V", "success");
    setTimeout(() => {
      window.close();
    }, 1800);
  } catch (err) {
    console.error("Capture page error:", err);
    setButtonsDisabled(false);
    showStatus(`Capture failed: ${err.message || String(err)}`, "error");
  }
});
