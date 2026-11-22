"use strict";

chrome.action.onClicked.addListener(async tab => {
  if (tab.id !== undefined) {
    try {
      const opened = await chrome.tabs.sendMessage(tab.id, { type: "projectx-open-settings" });
      if (opened) return;
    } catch {
      // The tab may be outside FunPay or have been opened before the extension loaded.
    }
  }
  await chrome.tabs.create({ url: "https://funpay.com/chat/#projectx-settings" });
});
