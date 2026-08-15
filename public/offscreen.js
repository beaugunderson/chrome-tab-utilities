chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const textarea = document.getElementById("clipboard");

  if (message.type === "clipboard-write") {
    textarea.value = message.text;
    textarea.select();
    document.execCommand("copy");
    sendResponse();
  } else if (message.type === "clipboard-read") {
    textarea.value = "";
    textarea.focus();
    document.execCommand("paste");
    sendResponse(textarea.value);
  }
});
