// Tracks whether the user has typed into a form/contenteditable on this page
// since the last navigation. Background pings us before auto-discarding the
// tab; if dirty, we tell it to skip.

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_start",
  allFrames: false,
  main() {
    let dirty = false;

    const onInput = (event: Event) => {
      if (dirty) return;
      const target = event.target as HTMLElement | null;
      if (!target) return;
      // Skip clicks on buttons/checkboxes/radios — only mark dirty for actual
      // text-ish entry. `input` event on text fields, textareas, selects, and
      // contenteditable means the user typed/pasted/picked something.
      const tag = target.tagName;
      if (tag === "INPUT") {
        const type = (target as HTMLInputElement).type;
        if (type === "button" || type === "submit" || type === "reset") return;
      }
      dirty = true;
    };

    document.addEventListener("input", onInput, true);
    document.addEventListener("change", onInput, true);

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg && msg.type === "is-form-dirty") {
        sendResponse({ dirty });
        return false;
      }
    });
  },
});
