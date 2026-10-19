(() => {
  "use strict";

  const bar = document.createElement("div");
  bar.id = "cloudagentfleet-fleet-bar";
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
  label.textContent = "Cloud Agent Fleet";
  const select = document.createElement("select");
  select.setAttribute("aria-label", "Fleet host");
  select.style.cssText = [
    "min-width:190px",
    "padding:4px 8px",
    "border:1px solid #405069",
    "border-radius:6px",
    "background:#090c10",
    "color:#d7dee7",
  ].join(";");
  select.addEventListener("change", () => {
    if (select.value) window.location.assign(`/_fleet/select/${encodeURIComponent(select.value)}`);
  });
  const back = document.createElement("a");
  back.href = "/_fleet/clear";
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

  // Runs on the host-UI origin, which only exposes this read-only host list.
  fetch("/_fleet/api/switcher", { headers: { accept: "application/json" } })
    .then((response) => response.ok ? response.json() : Promise.reject(new Error("Unable to load hosts")))
    .then((payload) => {
      const hosts = Array.isArray(payload.hosts) ? payload.hosts : [];
      if (typeof payload.dashboardUrl === "string") back.href = payload.dashboardUrl;
      for (const host of hosts) {
        const option = document.createElement("option");
        option.value = String(host.id);
        option.textContent = `${host.label} · ${host.status}`;
        option.selected = host.id === payload.current;
        select.append(option);
      }
      if (hosts.length === 0) {
        select.disabled = true;
        select.title = "No hosts with a proxied UI are registered";
      }
    })
    .catch(() => {
      select.disabled = true;
      select.title = "Unable to load fleet hosts";
    });
})();
