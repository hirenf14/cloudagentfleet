(() => {
  "use strict";

  const bar = document.createElement("div");
  bar.id = "hosted-agents-fleet-bar";
  bar.style.cssText = [
    "position:fixed",
    "top:0",
    "left:0",
    "right:0",
    "z-index:2147483647",
    "display:flex",
    "align-items:center",
    "gap:10px",
    "height:36px",
    "padding:0 12px",
    "box-sizing:border-box",
    "background:#101722",
    "border-bottom:1px solid #2b384b",
    "color:#d7dee7",
    "font:13px system-ui,sans-serif",
  ].join(";");
  const label = document.createElement("strong");
  label.textContent = "Hosted Agents";
  const select = document.createElement("select");
  select.setAttribute("aria-label", "Codeman host");
  select.style.cssText = [
    "min-width:190px",
    "padding:4px 8px",
    "border:1px solid #405069",
    "border-radius:6px",
    "background:#090c10",
    "color:#d7dee7",
  ].join(";");
  select.addEventListener("change", () => {
    if (select.value) window.location.assign(`/api/fleet/select/${encodeURIComponent(select.value)}`);
  });
  const back = document.createElement("a");
  back.href = "/api/fleet/clear";
  back.textContent = "Fleet dashboard";
  back.style.cssText = [
    "margin-left:auto",
    "color:#9ec1ff",
    "text-decoration:none",
    "white-space:nowrap",
  ].join(";");
  bar.append(label, select, back);
  document.body.prepend(bar);
  document.documentElement.style.paddingTop = "36px";

  fetch("/api/instances", { headers: { accept: "application/json" } })
    .then((response) => response.ok ? response.json() : Promise.reject(new Error("Unable to load hosts")))
    .then((payload) => {
      const instances = Array.isArray(payload.instances) ? payload.instances : [];
      return fetch("/api/fleet/current")
        .then((response) => response.json())
        .then((current) => ({ instances, current }));
    })
    .then(({ instances, current }) => {
      for (const instance of instances) {
        const option = document.createElement("option");
        option.value = String(instance.id);
        option.textContent = `${instance.label} · ${instance.status}`;
        option.selected = instance.id === current.instanceId;
        select.append(option);
      }
      if (instances.length === 0) {
        select.disabled = true;
        select.title = "No Codeman hosts are registered";
      }
    })
    .catch(() => {
      select.disabled = true;
      select.title = "Unable to load Codeman hosts";
    });
})();
