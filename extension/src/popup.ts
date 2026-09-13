const off = document.getElementById("off")!;
const on = document.getElementById("on")!;

function render(activated: boolean): void {
  off.hidden = activated;
  on.hidden = !activated;
}

chrome.storage.local.get("activated").then(({ activated }) => render(activated === true));

document.getElementById("activate")!.addEventListener("click", () => {
  chrome.storage.local.set({ activated: true }).then(() => render(true));
});
document.getElementById("pause")!.addEventListener("click", () => {
  chrome.storage.local.set({ activated: false }).then(() => render(false));
});
