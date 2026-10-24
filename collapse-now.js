const ms = window.motionStudio;
ms.setWorkspace("animate");
await new Promise((r) => setTimeout(r, 400));
const a = [...document.querySelectorAll(".area")].find((x) => {
  const s = x.querySelector("select.area-type");
  return s && s.value === "timeline" && x.getBoundingClientRect().height > 0;
});
a.querySelector(".area-head").dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
await new Promise((r) => setTimeout(r, 500));
return { collapsed: a.classList.contains("is-collapsed"), w: Math.round(a.getBoundingClientRect().width) };
