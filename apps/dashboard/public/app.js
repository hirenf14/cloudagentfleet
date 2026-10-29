(() => {
  "use strict";

  const {
    createElement: h,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
  } = React;

  const TERMINAL_STATUSES = new Set(["completed", "failed", "stopped"]);
  const STATUS_LABELS = {
    starting: "Starting",
    working: "Working",
    waiting: "Needs input",
    idle: "Idle",
    completed: "Completed",
    failed: "Failed",
    stopped: "Stopped",
  };

  const TERMINAL_THEME = {
    background: "#0a0a0a",
    foreground: "#d4d4d4",
    cursor: "#d4d4d4",
    cursorAccent: "#0a0a0a",
    selectionBackground: "#404040",
    black: "#20262e",
    red: "#ff6b6b",
    green: "#4ade80",
    yellow: "#f5c451",
    blue: "#63a4ff",
    magenta: "#d084ff",
    cyan: "#2dd4bf",
    white: "#d7dee7",
    brightBlack: "#64748b",
    brightRed: "#ff8585",
    brightGreen: "#75f0a8",
    brightYellow: "#f8d477",
    brightBlue: "#85b8ff",
    brightMagenta: "#e0a3ff",
    brightCyan: "#65e8db",
    brightWhite: "#ffffff",
  };

  /** Instances advertise what the Hub can do with them; the UI never checks backend names. */
  function hasFeature(instance, feature) {
    return Array.isArray(instance?.features) && instance.features.includes(feature);
  }

  function backendLabel(backends, instance) {
    return backends.find((backend) => backend.backend === instance?.backend)?.label || instance?.backend || "Host";
  }

  function connectionLabel(instance) {
    return instance.connectionMode === "connector"
      ? "Connected through the Worker connector"
      : "Reached directly over Tailscale";
  }

  function csrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)cloudagentfleet_csrf=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  /** Hub-owned routes; everything else on this origin may belong to a selected host. */
  const FLEET = "/_fleet";

  function api(path, options) {
    const request = { ...(options || {}) };
    const method = String(request.method || "GET").toUpperCase();
    if (request.body && typeof request.body !== "string") {
      request.body = JSON.stringify(request.body);
    }
    const csrf = csrfToken();
    return fetch(`${FLEET}${path}`, {
      ...request,
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        ...(request.body ? { "content-type": "application/json" } : {}),
        ...(csrf && method !== "GET" && method !== "HEAD" ? { "x-csrf-token": csrf } : {}),
        ...(options && options.headers ? options.headers : {}),
      },
    }).then(async (response) => {
      if (response.status === 401) {
        location.reload();
        throw new Error("Authentication required — sign in again");
      }
      const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
      return body;
    });
  }

  function formatTime(value) {
    if (!value) return "Never";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Unknown";
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }

  /** "5m ago" style age for sidebar rows. */
  function timeAgo(value) {
    const time = new Date(value).getTime();
    if (Number.isNaN(time)) return "";
    const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  /** Sessions that have ended stay listed only on request. */
  const ENDED_STATUSES = new Set(["completed", "failed", "stopped"]);
  const LIVE_SESSIONS_SHOWN = 3;
  const RECENT_SESSIONS_SHOWN = 5;
  const MACHINES_SHOWN = 6;

  const GUIDE_URL = "https://techoblix.github.io/cloudagentfleet/docs/getting-started.html";
  const CREDITS_URL = "https://techoblix.github.io/cloudagentfleet/docs/credits.html";

  /** Per-browser conveniences (guide hidden, host UI opened); never required state. */
  function readLocal(key) {
    try {
      return window.localStorage.getItem(`cloudagentfleet.${key}`);
    } catch {
      return null;
    }
  }

  function writeLocal(key, value) {
    try {
      window.localStorage.setItem(`cloudagentfleet.${key}`, value);
    } catch {
      // Storage blocked: the guide simply shows again next time.
    }
  }

  function byLastActivity(left, right) {
    return new Date(right.lastEventAt || right.createdAt).getTime()
      - new Date(left.lastEventAt || left.createdAt).getTime();
  }

  function instanceSummary(label, instanceSessions) {
    const live = instanceSessions.filter((session) => !ENDED_STATUSES.has(session.status)).length;
    return instanceSessions.length === 0
      ? `${label} · no sessions`
      : `${label} · ${live} active · ${instanceSessions.length} total`;
  }

  function normalizeTerminalText(value) {
    if (!value) return "";
    return cleanLegacyTerminalBuffer(String(value))
      .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/\u001b[()][0-2A-Za-z]/g, "")
      .replace(/\u001b[ -~]/g, "")
      .replace(/\u001b[@-_]/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\u0008/g, "")
      .replace(/\n{3,}/g, "\n\n");
  }

  // terminalUpdate:start
  /**
   * Works out what to write when a polled terminal buffer arrives. The Hub sends only the last 20,000
   * characters, so once output passes that the window slides and the buffer no longer starts with what
   * is on screen; the live stream also adds text the poll may not match exactly. Writing just the new
   * tail (found after the last part already on screen) keeps the terminal steady; a full redraw is
   * only for a buffer that doesn't match at all. Before this, every 2-second poll redrew it.
   * @param {string} rendered - What the terminal shows (polled buffer plus streamed output).
   * @param {string} next - The newly polled buffer.
   * @returns {{reset: boolean, write: string}} Whether to clear first, and the text to write.
   */
  function terminalUpdate(rendered, next) {
    if (next === rendered || rendered.endsWith(next)) return { reset: false, write: "" };
    if (!rendered) return { reset: true, write: next };
    if (next.startsWith(rendered)) return { reset: false, write: next.slice(rendered.length) };
    const anchor = rendered.slice(-256);
    const at = next.lastIndexOf(anchor);
    if (at >= 0) return { reset: false, write: next.slice(at + anchor.length) };
    return { reset: true, write: next };
  }
  // terminalUpdate:end

  function cleanLegacyTerminalBuffer(value) {
    const deviceReplyCount = (value.match(/0;276;0c1;2c/g) || []).length;
    if (deviceReplyCount < 3) return value;
    // Older Hub sessions persisted xterm's device replies as visible shell
    // input. Their saved screen is not recoverable; new sessions are protected
    // at the parser and PTY boundaries.
    return "";
  }

  function suppressTerminalColorQueries(terminal) {
    const parser = terminal.parser;
    if (!parser || typeof parser.registerOscHandler !== "function") return;
    for (const selector of [10, 11]) {
      parser.registerOscHandler(selector, () => true);
    }
  }

  function stripTerminalResponses(value) {
    return value
      // xterm.js emits these replies through its input event. They are
      // terminal protocol, not operator input, and must not be written into
      // Codeman's PTY where the shell would echo them as visible text.
      .replace(/\u001b\](?:10|11);[^\u0007]*(?:\u0007|\u001b\\)/g, "")
      .replace(/\u001b\[[?>=!]?[0-9;]*[cnt]/g, "");
  }

  function shortId(value) {
    return String(value || "").slice(0, 8);
  }

  function StatusDot({ status }) {
    return h("span", {
      className: `status-dot status-dot--${status}`,
      title: status,
      "aria-label": status,
    });
  }

  function StatusBadge({ status }) {
    return h(
      "span",
      { className: `status-badge status-badge--${status}` },
      h(StatusDot, { status }),
      STATUS_LABELS[status] || status,
    );
  }

  function EmptyState({ title, children, action }) {
    return h(
      "div",
      { className: "empty-state" },
      h("h2", null, title),
      children && h("p", null, children),
      action,
    );
  }

  function App() {
    const [instances, setInstances] = useState([]);
    const [sessions, setSessions] = useState([]);
    const [terminalEvent, setTerminalEvent] = useState(null);
    const [selectedInstanceId, setSelectedInstanceId] = useState(null);
    const [selectedSessionKey, setSelectedSessionKey] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [streamStatus, setStreamStatus] = useState("connecting");
    const [showCreate, setShowCreate] = useState(false);
    const [backends, setBackends] = useState([]);
    // A host UI shown inside the dashboard (an iframe on the host-UI origin).
    const [embeddedInstanceId, setEmbeddedInstanceId] = useState(null);
    // Instances whose every live session, or whose ended sessions, are listed.
    const [expandedLive, setExpandedLive] = useState(() => new Set());
    const [expandedEnded, setExpandedEnded] = useState(() => new Set());
    const [query, setQuery] = useState("");
    const searchRef = useRef(null);
    const [onboarding, setOnboarding] = useState(null);
    const [showGuide, setShowGuide] = useState(false);
    const [guideHidden, setGuideHidden] = useState(() => readLocal("guideHidden") === "1");
    const [openedHostUi, setOpenedHostUi] = useState(() => readLocal("openedHostUi") === "1");
    const [showAddMachine, setShowAddMachine] = useState(false);
    const [showHelp, setShowHelp] = useState(false);
    const [showAllMachines, setShowAllMachines] = useState(false);
    // Machine id -> open (true) or closed (false), when the user toggled it.
    const [machineOpen, setMachineOpen] = useState(() => new Map());
    const [hostUiOrigin, setHostUiOrigin] = useState(null);

    useEffect(() => {
      api("/api/fleet/onboarding")
        .then((data) => setOnboarding(data))
        .catch(() => setOnboarding(null));
    }, []);

    // "/" or Ctrl/⌘+K: search. "?": help. Not while typing or in a terminal.
    useEffect(() => {
      const onKey = (event) => {
        const target = event.target;
        const typing = target instanceof HTMLElement
          && (target.closest("input, textarea, select, [contenteditable=true], .xterm") !== null);
        if ((event.key === "k" && (event.ctrlKey || event.metaKey)) || (event.key === "/" && !typing)) {
          event.preventDefault();
          searchRef.current?.focus();
        } else if (event.key === "?" && !typing) {
          event.preventDefault();
          setShowHelp(true);
        } else if (event.key === "Escape") {
          setShowHelp(false);
          setShowAddMachine(false);
        }
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, []);

    useEffect(() => {
      api("/api/fleet/origins")
        .then((data) => setHostUiOrigin(data.hostUiOrigin || null))
        .catch(() => setHostUiOrigin(null));
    }, []);

    useEffect(() => {
      api("/api/backends")
        .then((data) => setBackends(data.backends || []))
        .catch(() => setBackends([]));
    }, []);

    const refresh = useCallback(async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const instanceData = await api("/api/instances");
        const nextInstances = instanceData.instances || [];
        // One unreachable host (for example a Worker that went offline) must not
        // blank the whole fleet: load each instance on its own and keep the
        // last-known sessions for any that fail.
        const sessionInstances = nextInstances.filter((instance) => hasFeature(instance, "sessions"));
        const sessionResults = await Promise.allSettled(
          sessionInstances.map((instance) => api(`/api/instances/${encodeURIComponent(instance.id)}/sessions`)),
        );
        setInstances(nextInstances);
        setSessions((previous) => sessionResults.flatMap((result, index) => (
          result.status === "fulfilled"
            ? result.value.sessions || []
            : previous.filter((session) => session.instanceId === sessionInstances[index].id)
        )));
        setSelectedInstanceId((current) =>
          current && nextInstances.some((instance) => instance.id === current)
            ? current
            : nextInstances[0]?.id || null,
        );
        setError("");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Unable to load fleet");
      } finally {
        setLoading(false);
      }
    }, []);

    useEffect(() => {
      void refresh();
    }, [refresh]);

    useEffect(() => {
      const timer = setInterval(() => void refresh(true), 2000);
      return () => clearInterval(timer);
    }, [refresh]);

    useEffect(() => {
      const events = new EventSource(`${FLEET}/api/events`);
      let refreshTimer = null;
      const reload = () => {
        if (refreshTimer !== null) return;
        refreshTimer = setTimeout(() => {
          refreshTimer = null;
          void refresh(true);
        }, 120);
      };
      events.addEventListener("open", () => setStreamStatus("live"));
      events.addEventListener("snapshot", reload);
      events.addEventListener("session", (message) => {
        try {
          const event = JSON.parse(message.data);
          if (event.event === "output" && typeof event.data === "string") {
            setTerminalEvent((current) => ({
              ...event,
              version: (current?.version || 0) + 1,
            }));
            // Output goes straight to the terminal; reloading the fleet on every chunk would poll the
            // Hub (and each Codeman) many times a second while an agent types.
            return;
          }
        } catch {
          // The periodic refresh remains the recovery path for malformed events.
        }
        reload();
      });
      events.onerror = () => setStreamStatus("reconnecting");
      return () => {
        events.close();
        if (refreshTimer !== null) clearTimeout(refreshTimer);
      };
    }, [refresh]);

    const selectedInstance = instances.find((instance) => instance.id === selectedInstanceId) || null;
    const selectedSession = sessions.find(
      (session) => `${session.instanceId}/${session.id}` === selectedSessionKey,
    ) || null;
    const embeddedInstance = !selectedSession && hostUiOrigin && selectedInstance
      && selectedInstance.id === embeddedInstanceId && hasFeature(selectedInstance, "native-ui-proxy")
      ? selectedInstance
      : null;

    // Open the most recent session once, on first load; after that the operator's
    // choice (including an instance overview with no session open) sticks.
    const autoSelectedSession = useRef(false);
    useEffect(() => {
      if (!loading && !autoSelectedSession.current) {
        autoSelectedSession.current = true;
        if (!selectedSessionKey && sessions[0]) {
          setSelectedSessionKey(`${sessions[0].instanceId}/${sessions[0].id}`);
        }
      }
      if (selectedSessionKey && !sessions.some(
        (session) => `${session.instanceId}/${session.id}` === selectedSessionKey,
      )) {
        setSelectedSessionKey(null);
      }
    }, [loading, sessions, selectedSessionKey]);

    const sessionsByInstance = useMemo(() => {
      const groups = new Map();
      for (const instance of instances) groups.set(instance.id, []);
      for (const session of sessions) {
        if (!groups.has(session.instanceId)) groups.set(session.instanceId, []);
        groups.get(session.instanceId).push(session);
      }
      for (const group of groups.values()) group.sort(byLastActivity);
      return groups;
    }, [instances, sessions]);
    const recentSessions = useMemo(
      () => [...sessions].sort(byLastActivity).slice(0, RECENT_SESSIONS_SHOWN),
      [sessions],
    );
    const instanceLabels = useMemo(
      () => new Map(instances.map((instance) => [instance.id, instance.label])),
      [instances],
    );
    const toggle = (setter, id) => setter((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    const sessionKey = (session) => `${session.instanceId}/${session.id}`;
    const sessionRow = (session, context) => h(
      "button",
      {
        className: `session-row ${selectedSessionKey === sessionKey(session) ? "session-row--selected" : ""}`,
        key: sessionKey(session),
        title: `${session.title} · ${session.agent.name} · ${STATUS_LABELS[session.status] || session.status}`,
        onClick: () => {
          setSelectedInstanceId(session.instanceId);
          setSelectedSessionKey(sessionKey(session));
          setEmbeddedInstanceId(null);
        },
      },
      h("span", { className: `session-row__indicator session-row__indicator--${session.status}` }),
      h(
        "span",
        { className: "session-row__copy" },
        h("span", { className: "session-row__title" }, session.title),
        context && h("span", { className: "session-row__context" }, context),
      ),
      session.needsInput
        ? h("span", { className: "needs-input-dot", title: "Needs input" })
        : h("span", { className: "session-row__age" }, timeAgo(session.lastEventAt || session.createdAt)),
    );
    // Under each machine: live sessions first (capped), ended ones folded,
    // and the selected session always visible.
    const instanceSessionRows = (instanceId) => {
      const all = sessionsByInstance.get(instanceId) || [];
      const live = all.filter((session) => !ENDED_STATUSES.has(session.status));
      const ended = all.filter((session) => ENDED_STATUSES.has(session.status));
      const showAllLive = expandedLive.has(instanceId);
      const showEnded = expandedEnded.has(instanceId);
      const shownLive = showAllLive ? live : live.slice(0, LIVE_SESSIONS_SHOWN);
      const hiddenSelected = [...live.slice(shownLive.length), ...(showEnded ? [] : ended)]
        .filter((session) => selectedSessionKey === sessionKey(session));
      return [
        ...shownLive.map((session) => sessionRow(session)),
        ...hiddenSelected.map((session) => sessionRow(session)),
        live.length > LIVE_SESSIONS_SHOWN && h(
          "button",
          { className: "session-toggle", key: "more", onClick: () => toggle(setExpandedLive, instanceId) },
          showAllLive ? "Show fewer" : `Show ${live.length - LIVE_SESSIONS_SHOWN} more`,
        ),
        ended.length > 0 && h(
          "button",
          {
            className: "session-toggle",
            key: "ended",
            "aria-expanded": showEnded,
            onClick: () => toggle(setExpandedEnded, instanceId),
          },
          `${showEnded ? "▾" : "▸"} ${ended.length} ended`,
        ),
        ...(showEnded ? ended.map((session) => sessionRow(session)) : []),
      ];
    };

    // Search shows every match, uncapped; otherwise machines and sessions are capped.
    const needle = query.trim().toLowerCase();
    const sessionMatches = (session) => !needle
      || session.title.toLowerCase().includes(needle)
      || session.agent.name.toLowerCase().includes(needle);
    const machineMatches = (instance) => !needle
      || instance.label.toLowerCase().includes(needle)
      || (sessionsByInstance.get(instance.id) || []).some(sessionMatches);
    const orderedMachines = [...instances]
      .filter(machineMatches)
      .sort((left, right) => Number(right.status === "online") - Number(left.status === "online"));
    const cappedMachines = needle || showAllMachines ? orderedMachines : orderedMachines.slice(0, MACHINES_SHOWN);
    const shownMachines = cappedMachines.some((instance) => instance.id === selectedInstanceId)
      ? cappedMachines
      : [...cappedMachines, ...orderedMachines.filter((instance) => instance.id === selectedInstanceId)];
    const isMachineOpen = (instance) => {
      if (needle) return true;
      if (machineOpen.has(instance.id)) return machineOpen.get(instance.id);
      const live = (sessionsByInstance.get(instance.id) || []).some((session) => !ENDED_STATUSES.has(session.status));
      return instance.id === selectedInstanceId || live;
    };
    const toggleMachine = (instance) => setMachineOpen((current) => new Map(current).set(instance.id, !isMachineOpen(instance)));
    const machineSessionRows = (instanceId) => needle
      ? (sessionsByInstance.get(instanceId) || []).filter(sessionMatches).map((session) => sessionRow(session))
      : instanceSessionRows(instanceId);

    const guideSteps = [
      { id: "hub", done: true, title: "Run the Hub", detail: "Done: you are signed in to it." },
      {
        id: "reach",
        done: Boolean(onboarding?.reachableBeyondThisMachine),
        title: "Reach it from your other devices",
        detail: "Publish the Hub privately on your tailnet. On the Hub machine run:",
        command: "cloudagentfleet hub serve",
      },
      {
        id: "machine",
        done: instances.length > 0,
        title: "Add a machine",
        detail: "Install the Worker on any machine whose agents you want here; it can be this one.",
        action: { label: "Add machine", onClick: () => setShowAddMachine(true) },
      },
      {
        id: "use",
        done: sessions.length > 0 || openedHostUi,
        title: "Start a session or open a machine's own UI",
        detail: "Pick a machine on the left, then use Start a session or Open … UI.",
      },
    ];
    const guideDone = guideSteps.filter((step) => step.done).length;
    const guideComplete = guideDone === guideSteps.length;
    const showGuideView = showGuide || (!loading && instances.length === 0);

    async function signOut() {
      try {
        await api("/api/auth/logout", { method: "POST" });
      } finally {
        window.location.reload();
      }
    }

    async function stopSession() {
      if (!selectedSession || !selectedInstance) return;
      try {
        await api(
          `/api/instances/${encodeURIComponent(selectedInstance.id)}/sessions/${encodeURIComponent(selectedSession.id)}/stop`,
          { method: "POST" },
        );
        await refresh(true);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Unable to stop session");
      }
    }

    async function removeSession() {
      if (!selectedSession || !selectedInstance) return;
      if (!TERMINAL_STATUSES.has(selectedSession.status)) return;
      try {
        await api(
          `/api/instances/${encodeURIComponent(selectedInstance.id)}/sessions/${encodeURIComponent(selectedSession.id)}`,
          { method: "DELETE" },
        );
        setSelectedSessionKey(null);
        await refresh(true);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Unable to remove session");
      }
    }

    const onlineCount = instances.filter((instance) => instance.status === "online").length;
    const selectedSessions = selectedInstance ? sessionsByInstance.get(selectedInstance.id) || [] : [];
    const selectedLive = selectedSessions.filter((session) => !ENDED_STATUSES.has(session.status));
    const selectedEnded = selectedSessions.filter((session) => ENDED_STATUSES.has(session.status)).slice(0, 5);
    const openHostUi = () => {
      setOpenedHostUi(true);
      writeLocal("openedHostUi", "1");
      if (hasFeature(selectedInstance, "native-ui-proxy") && hostUiOrigin) {
        setEmbeddedInstanceId(selectedInstance.id);
      } else if (hasFeature(selectedInstance, "native-ui-proxy")) {
        window.open(`${FLEET}/api/fleet/select/${encodeURIComponent(selectedInstance.id)}`, "_blank", "noopener");
      } else if (hasFeature(selectedInstance, "native-ui-link") && selectedInstance.launchUrl) {
        window.open(selectedInstance.launchUrl, "_blank", "noopener,noreferrer");
      }
    };
    const checkHealth = async () => {
      try {
        await api(`/api/instances/${encodeURIComponent(selectedInstance.id)}/health`, { method: "POST" });
        await refresh(true);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Unable to check instance health");
      }
    };
    const homeSessionLink = (session) => h(
      "button",
      {
        className: "home-item",
        key: sessionKey(session),
        onClick: () => setSelectedSessionKey(sessionKey(session)),
      },
      h("span", { className: "home-item__title" }, session.title),
      h("span", { className: "home-item__meta" }, `${session.agent.name} · ${STATUS_LABELS[session.status] || session.status} · ${timeAgo(session.lastEventAt || session.createdAt)}`),
    );

    const instanceHome = selectedInstance && h(
      "section",
      { className: "instance-overview" },
      h(
        "div",
        { className: "instance-overview__title" },
        h("h2", null, selectedInstance.label),
        h(StatusBadge, { status: selectedInstance.status }),
      ),
      h("p", { className: "instance-overview__meta" }, `${backendLabel(backends, selectedInstance)} · ${connectionLabel(selectedInstance)}`),
      // The Hub mediates (and policy-checks) sessions only through the sessions feature.
      !hasFeature(selectedInstance, "sessions") && h(
        "p",
        { className: "policy-note", role: "note" },
        "This host's own UI is not mediated by the Hub: folder policy is not enforced there, and anyone signed in to it has full shell access.",
      ),
      h("span", { className: "home-label" }, "Start"),
      h(
        "div",
        { className: "overview-actions" },
        h(
          "button",
          {
            className: "home-action",
            onClick: () => setShowCreate(true),
            disabled: selectedInstance.status !== "online" || !hasFeature(selectedInstance, "sessions"),
          },
          selectedInstance.status === "online" ? "Start a session" : "Instance unavailable",
        ),
        hasFeature(selectedInstance, "sessions") && h(
          "span",
          { className: "home-hint" },
          "Runs an agent (or a plain shell) in one of this machine's workspaces; you watch and type here.",
        ),
        h(
          "button",
          {
            className: "home-action",
            onClick: openHostUi,
            disabled: !hasFeature(selectedInstance, "native-ui-proxy")
              && !(hasFeature(selectedInstance, "native-ui-link") && selectedInstance.launchUrl),
            title: hasFeature(selectedInstance, "native-ui-proxy")
              ? `Open ${backendLabel(backends, selectedInstance)}'s own UI for this host here, through the Hub.`
              : hasFeature(selectedInstance, "native-ui-link")
                ? `Open ${backendLabel(backends, selectedInstance)} in a new tab (signs in separately)`
                : "This host's UI is not available through the Hub",
          },
          `Open ${backendLabel(backends, selectedInstance)} UI`,
        ),
        (hasFeature(selectedInstance, "native-ui-proxy") || hasFeature(selectedInstance, "native-ui-link")) && h(
          "span",
          { className: "home-hint" },
          `${backendLabel(backends, selectedInstance)}'s own interface for this machine, inside the dashboard.`,
        ),
        h("button", { className: "home-action", onClick: checkHealth }, "Check health"),
        h("span", { className: "home-hint" }, "Asks the machine whether it is reachable right now."),
      ),
      selectedLive.length > 0 && h("span", { className: "home-label" }, "Continue"),
      selectedLive.map(homeSessionLink),
      selectedEnded.length > 0 && h("span", { className: "home-label" }, "Recent"),
      selectedEnded.map(homeSessionLink),
      h("span", { className: "home-label" }, "Details"),
      h(
        "dl",
        { className: "overview-grid" },
        h("div", null, h("dt", null, "Workspaces"), h("dd", null, selectedInstance.workspaces.length)),
        h("div", null, h("dt", null, "Agents ready"), h("dd", null, selectedInstance.agents.filter((agent) => agent.ready).length)),
        h("div", null, h("dt", null, "Last seen"), h("dd", null, formatTime(selectedInstance.lastSeenAt))),
      ),
    );

    return h(
      "div",
      { className: `app-shell ${embeddedInstance ? "app-shell--embedded" : ""}` },
      h(
        "aside",
        { className: "sidebar", "aria-label": "Fleet machines and sessions" },
        h(
          "div",
          { className: "sidebar__brand" },
          h("span", { className: "brand__mark", "aria-hidden": "true" }, "✦"),
          h("strong", null, "Cloud Agent Fleet"),
          h("span", {
            className: `connection-state__dot connection-state__dot--${streamStatus}`,
            title: streamStatus === "live" ? "Live updates" : "Reconnecting…",
            "aria-label": streamStatus === "live" ? "Live updates" : "Reconnecting",
            role: "status",
          }),
        ),
        h(
          "label",
          { className: "sidebar__search" },
          h("span", { className: "sidebar__search-icon", "aria-hidden": "true" }, "⌕"),
          h("input", {
            type: "search",
            placeholder: "Search",
            ref: searchRef,
            value: query,
            onChange: (event) => setQuery(event.target.value),
            "aria-label": "Search machines and sessions",
          }),
        ),
        loading
          ? h("div", { className: "skeleton-list", "aria-label": "Loading instances" }, h("span"), h("span"), h("span"))
          : instances.length === 0
            ? h(EmptyState, { title: "No machines yet" }, "Follow Getting started to connect your first one.")
            : h(
              "nav",
              { className: "instance-list" },
              !needle && recentSessions.length > 0 && h(
                "section",
                { className: "sidebar-section", "aria-label": "Recent sessions" },
                h("span", { className: "sidebar-section__title" }, "Recent"),
                recentSessions.map((session) => sessionRow(session, instanceLabels.get(session.instanceId) || session.instanceId)),
              ),
              h(
                "section",
                { className: "sidebar-section", "aria-label": "Machines" },
                h(
                  "span",
                  { className: "sidebar-section__title" },
                  "Machines",
                  h(
                    "span",
                    { className: "sidebar-section__tools" },
                    h("span", { className: "sidebar-section__count" }, `${onlineCount}/${instances.length} online`),
                    h("button", {
                      className: "sidebar-section__add",
                      onClick: () => setShowAddMachine(true),
                      "aria-label": "Add machine",
                      title: "Add machine",
                    }, "+"),
                  ),
                ),
                orderedMachines.length === 0 && h("p", { className: "sidebar-empty" }, "No matches"),
                shownMachines.map((instance) => {
                  const instanceSessions = sessionsByInstance.get(instance.id) || [];
                  const live = instanceSessions.filter((session) => !ENDED_STATUSES.has(session.status)).length;
                  const open = isMachineOpen(instance);
                  return h(
                    "div",
                    { className: "instance-group", key: instance.id },
                    h(
                      "div",
                      { className: `instance-row ${selectedInstanceId === instance.id && !selectedSession ? "instance-row--selected" : ""}` },
                      instanceSessions.length > 0
                        ? h(
                          "button",
                          {
                            className: "instance-row__toggle",
                            "aria-expanded": open,
                            "aria-label": `${open ? "Hide" : "Show"} sessions of ${instance.label}`,
                            onClick: () => toggleMachine(instance),
                          },
                          open ? "▾" : "▸",
                        )
                        : h("span", { className: "instance-row__toggle instance-row__toggle--empty", "aria-hidden": "true" }),
                      h(
                        "button",
                        {
                          className: "instance-card",
                          title: instanceSummary(backendLabel(backends, instance), instanceSessions),
                          onClick: () => {
                            // Show this instance's overview, not a session from another instance.
                            setSelectedInstanceId(instance.id);
                            setSelectedSessionKey(null);
                            setEmbeddedInstanceId(null);
                            setShowGuide(false);
                          },
                          "aria-pressed": selectedInstanceId === instance.id,
                        },
                        h(StatusDot, { status: instance.status }),
                        h("span", { className: "instance-card__copy" }, instance.label),
                        live > 0 && h("span", { className: "instance-card__count", title: `${live} active` }, live),
                      ),
                    ),
                    open && machineSessionRows(instance.id),
                  );
                }),
                !needle && orderedMachines.length > MACHINES_SHOWN && h(
                  "button",
                  { className: "session-toggle session-toggle--machines", onClick: () => setShowAllMachines((value) => !value) },
                  showAllMachines ? "Show fewer machines" : `Show all ${orderedMachines.length} machines`,
                ),
              ),
            ),
        !guideComplete && !guideHidden && h(
          "button",
          {
            className: `sidebar__guide ${showGuideView ? "sidebar__guide--active" : ""}`,
            onClick: () => {
              setShowGuide(true);
              setSelectedSessionKey(null);
              setEmbeddedInstanceId(null);
            },
          },
          h("span", null, "Getting started"),
          h("span", { className: "sidebar__guide-progress" }, `${guideDone}/${guideSteps.length}`),
        ),
        h(
          "div",
          { className: "sidebar__footer" },
          h("span", null, `${onlineCount} online · ${sessions.length} sessions`),
          h("button", { className: "sidebar__signout", onClick: () => setShowHelp(true), "aria-label": "Help", title: "Help (?)" }, "?"),
          h("button", { className: "sidebar__signout", onClick: () => void signOut() }, "Sign out"),
        ),
      ),
      h(
        "main",
        { className: `main-content ${embeddedInstance ? "main-content--embedded" : ""}` },
        error && h(
          "div",
          { className: "alert", role: "alert" },
          h("strong", null, "Couldn’t update the fleet"),
          h("span", null, error),
          h("button", { className: "button button--quiet", onClick: () => void refresh() }, "Try again"),
        ),
        embeddedInstance
          ? h(HostUiFrame, {
            key: embeddedInstance.id,
            instance: embeddedInstance,
            label: backendLabel(backends, embeddedInstance),
            src: `${hostUiOrigin}/_fleet/select/${encodeURIComponent(embeddedInstance.id)}`,
            onClose: () => setEmbeddedInstanceId(null),
          })
          : selectedSession
            ? h(
              SessionDetail,
              {
                key: selectedSessionKey,
                instance: instances.find((instance) => instance.id === selectedSession.instanceId),
                session: selectedSession,
                terminalEvent,
                onStop: stopSession,
                onRemove: removeSession,
                onNewSession: () => setShowCreate(true),
                setError,
              },
            )
            : showGuideView
              ? h(GettingStarted, {
                steps: guideSteps,
                done: guideDone,
                hidden: guideHidden,
                onHide: () => {
                  setGuideHidden(true);
                  writeLocal("guideHidden", "1");
                  setShowGuide(false);
                },
                onClose: instances.length > 0 ? () => setShowGuide(false) : undefined,
              })
              : instanceHome,
      ),
      showAddMachine && h(AddMachineDialog, { onboarding, onClose: () => setShowAddMachine(false) }),
      showHelp && h(HelpDialog, {
        onClose: () => setShowHelp(false),
        onShowGuide: () => {
          setShowHelp(false);
          setGuideHidden(false);
          writeLocal("guideHidden", "0");
          setShowGuide(true);
          setSelectedSessionKey(null);
          setEmbeddedInstanceId(null);
        },
      }),
      showCreate && h(
        CreateSessionDialog,
        {
          instances: instances.filter((instance) => hasFeature(instance, "sessions")),
          preferredInstanceId: selectedInstanceId,
          onClose: () => setShowCreate(false),
          onCreated: async (session) => {
            setShowCreate(false);
            setSelectedInstanceId(session.instanceId);
            await refresh(true);
            setSelectedSessionKey(`${session.instanceId}/${session.id}`);
          },
          setError,
        },
      ),
    );
  }

  /** A command with a copy button. */
  function CopyLine({ text }) {
    const [copied, setCopied] = useState(false);
    return h(
      "div",
      { className: "copy-line" },
      h("code", null, text),
      h("button", {
        className: "copy-line__button",
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            setCopied(false);
          }
        },
        "aria-label": `Copy ${text}`,
      }, copied ? "Copied" : "Copy"),
    );
  }

  /** First-run guide; each step checks itself off from the fleet's state. */
  function GettingStarted({ steps, done, onHide, onClose }) {
    return h(
      "section",
      { className: "guide", "aria-label": "Getting started" },
      h("h2", null, "Getting started"),
      h(
        "p",
        { className: "instance-overview__meta" },
        `${done} of ${steps.length} done · a Hub (this dashboard) and a Worker on each machine you want to reach`,
      ),
      h(
        "ol",
        { className: "guide__steps" },
        steps.map((step) => h(
          "li",
          { key: step.id, className: `guide-step ${step.done ? "guide-step--done" : ""}` },
          h("span", { className: "guide-step__check", "aria-hidden": "true" }, step.done ? "✓" : ""),
          h(
            "div",
            { className: "guide-step__body" },
            h("strong", null, step.title, step.done && h("span", { className: "visually-hidden" }, " (done)")),
            !step.done && h("p", null, step.detail),
            !step.done && step.command && h(CopyLine, { text: step.command }),
            !step.done && step.action && h("button", { className: "button", onClick: step.action.onClick }, step.action.label),
          ),
        )),
      ),
      h(
        "div",
        { className: "guide__footer" },
        h("a", { href: GUIDE_URL, target: "_blank", rel: "noopener noreferrer" }, "Read the full guide"),
        onClose && h("button", { className: "home-action", onClick: onClose }, "Back to machines"),
        h("button", { className: "home-action", onClick: onHide }, "Hide this guide"),
      ),
    );
  }

  const RELEASE_DOWNLOAD = "https://github.com/techoblix/cloudagentfleet/releases/latest/download";
  // Release archives are built on each platform's standard runner.
  const ARCHIVE_PLATFORM = { windows: "win32-x64", macos: "darwin-arm64", linux: "linux-x64" };

  function detectOs() {
    const platform = `${navigator.userAgentData?.platform || navigator.platform || ""} ${navigator.userAgent}`.toLowerCase();
    if (platform.includes("win")) return "windows";
    if (platform.includes("mac")) return "macos";
    return "linux";
  }

  /**
   * The commands for one install. Every install is standalone: the archive
   * carries its own Node, and `init` installs whatever the machine offers.
   */
  function installSteps({ target, os, method }) {
    // The Hub install already contains the Worker: nothing to add, just
    // rerun init there and say yes to running a Worker.
    if (target === "hub-machine") {
      const hubFolder = `cloudagentfleet-hub-${ARCHIVE_PLATFORM[os]}`;
      const command = method === "npm"
        ? "cloudagentfleet init"
        : os === "windows"
          ? `$HOME\\cloudagentfleet\\${hubFolder}\\cloudagentfleet.cmd init`
          : `~/cloudagentfleet/${hubFolder}/cloudagentfleet init`;
      return {
        commands: [command],
        note: [
          "The Hub install includes the Worker, so there is nothing new to install.",
          method === "npm" ? "" : "Use the folder you extracted the Hub into.",
          "Answer yes to \"Also run a Worker on this machine\"; the Hub keeps its settings and data.",
        ].filter(Boolean).join(" "),
      };
    }
    if (method === "npm") {
      return { commands: ["npm install --global @cloudagentfleet/worker", "cloudagentfleet init"] };
    }
    const asset = `cloudagentfleet-worker-${ARCHIVE_PLATFORM[os]}`;
    const url = `${RELEASE_DOWNLOAD}/${asset}.tar.gz`;
    const commands = os === "windows"
      ? [
        "mkdir -Force $HOME\\cloudagentfleet; cd $HOME\\cloudagentfleet",
        `curl.exe -fsSLO ${url}`,
        `tar -xzf ${asset}.tar.gz`,
        `.\\${asset}\\cloudagentfleet.cmd init`,
      ]
      : [
        "mkdir -p ~/cloudagentfleet && cd ~/cloudagentfleet",
        `curl -fsSLO ${url}`,
        `tar -xzf ${asset}.tar.gz`,
        `./${asset}/cloudagentfleet init`,
      ];
    return {
      commands,
      note: [
        "Keep this folder: the services run from it. Node.js is included.",
        os === "windows" ? "Run these in PowerShell (not inside WSL)." : "",
        os === "macos" ? "This archive is for Apple silicon; on an Intel Mac use npm." : "",
      ].filter(Boolean).join(" "),
    };
  }

  function Segmented({ label, value, options, onChange }) {
    return h(
      "div",
      { className: "segmented", role: "radiogroup", "aria-label": label },
      options.map(([id, text]) => h(
        "button",
        {
          key: id,
          role: "radio",
          "aria-checked": value === id,
          className: `segmented__option ${value === id ? "segmented__option--active" : ""}`,
          onClick: () => onChange(id),
        },
        text,
      )),
    );
  }

  /** Every way to add a machine, with this Hub's address; the token stays on the Hub machine. */
  function AddMachineDialog({ onboarding, onClose }) {
    const hubUrl = onboarding?.hubUrl || window.location.origin;
    const [target, setTarget] = useState("other");
    const [os, setOs] = useState(detectOs);
    const [method, setMethod] = useState("archive");
    const { commands, note } = installSteps({ target, os, method });
    return h(
      "div",
      { className: "dialog-backdrop", role: "presentation", onMouseDown: (event) => event.target === event.currentTarget && onClose() },
      h(
        "section",
        { className: "dialog dialog--wide", role: "dialog", "aria-modal": "true", "aria-labelledby": "add-machine-title" },
        h(
          "div",
          { className: "dialog__header" },
          h("h2", { id: "add-machine-title" }, "Add a machine"),
          h("button", { className: "icon-button", onClick: onClose, "aria-label": "Close dialog" }, "×"),
        ),
        h(
          "div",
          { className: "dialog__body" },
          h("span", { className: "home-label" }, "Which machine"),
          h(Segmented, {
            label: "Which machine",
            value: target,
            onChange: setTarget,
            options: [["other", "Another machine"], ["hub-machine", "This Hub's machine"]],
          }),
          h("span", { className: "home-label" }, "Its system"),
          h(Segmented, {
            label: "Its system",
            value: os,
            onChange: setOs,
            options: [["windows", "Windows"], ["macos", "macOS"], ["linux", "Linux"]],
          }),
          h("span", { className: "home-label" }, "Install with"),
          h(Segmented, {
            label: "Install with",
            value: method,
            onChange: setMethod,
            options: [["archive", "Download (nothing else needed)"], ["npm", "npm (Node.js 22.6+)"]],
          }),
          h("span", { className: "home-label" }, "Run on that machine"),
          h("div", { className: "copy-lines" }, commands.map((line) => h(CopyLine, { key: line, text: line }))),
          note && h("p", { className: "dialog__note" }, note),
          h("span", { className: "home-label" }, "init then asks what the machine offers: one or both"),
          h(
            "dl",
            { className: "help-terms" },
            h("dt", null, "Codeman"),
            h("dd", null, "Agent sessions in terminals: start, watch, and type into them from here. Light; good for many agents at once. Runs in WSL on Windows."),
            h("dt", null, "Open WebUI Computer"),
            h("dd", null, "A full workspace: files, editor, terminal, app previews, and agent chat, inside the dashboard."),
          ),
          h("p", { className: "dialog__note" }, "It also offers Claude Code and Cursor's agent CLI, installs what you pick in one go, and runs everything as services."),
          target === "other" && h("span", { className: "home-label" }, "And asks for"),
          target === "other" && h(
            "dl",
            { className: "dialog__facts" },
            h("dt", null, "Hub URL"),
            h("dd", null, h(CopyLine, { text: hubUrl })),
            h("dt", null, "Worker token"),
            h(
              "dd",
              null,
              h("p", { className: "dialog__note" }, "On this Hub's machine, run:"),
              h(CopyLine, { text: "cloudagentfleet hub token" }),
              onboarding?.workerTokenPath && h("p", { className: "dialog__note" }, `It is stored there in ${onboarding.workerTokenPath}.`),
            ),
          ),
          target === "other" && !onboarding?.reachableBeyondThisMachine && h(
            "p",
            { className: "policy-note" },
            "This Hub is only reachable on its own machine. To add other machines, run cloudagentfleet hub serve on it first (Tailscale), then use the address it prints.",
          ),
          h("p", { className: "dialog__note" }, "The machine appears on the left within a few seconds of init finishing. "),
          h("a", { className: "dialog__link", href: GUIDE_URL, target: "_blank", rel: "noopener noreferrer" }, "Full guide, including starting a new Hub"),
        ),
      ),
    );
  }

  /** Short, plain explanations and shortcuts. */
  function HelpDialog({ onClose, onShowGuide }) {
    const term = (name, text) => [h("dt", { key: `${name}-t` }, name), h("dd", { key: `${name}-d` }, text)];
    return h(
      "div",
      { className: "dialog-backdrop", role: "presentation", onMouseDown: (event) => event.target === event.currentTarget && onClose() },
      h(
        "section",
        { className: "dialog dialog--wide", role: "dialog", "aria-modal": "true", "aria-labelledby": "help-title" },
        h(
          "div",
          { className: "dialog__header" },
          h("h2", { id: "help-title" }, "Help"),
          h("button", { className: "icon-button", onClick: onClose, "aria-label": "Close dialog" }, "×"),
        ),
        h(
          "div",
          { className: "dialog__body" },
          h("span", { className: "home-label" }, "The parts"),
          h("dl", { className: "help-terms" },
            ...term("Hub", "This dashboard. It keeps the list of machines and connects you to them; run one per fleet."),
            ...term("Worker", "A small service on each machine. It connects out to the Hub, so the machine needs no open ports."),
            ...term("Codeman", "Runs agent sessions in terminals. Start them here, watch them, and type into them. An open-source project by Ark0N (MIT)."),
            ...term("Open WebUI Computer", "A full workspace on the machine: files, editor, terminal, previews, and agent chat. Opens inside the dashboard. By Open WebUI, Inc., under its own license."),
            ...term("Session", "One agent (or shell) working in one workspace on one machine."),
          ),
          h("span", { className: "home-label" }, "Shortcuts"),
          h("dl", { className: "help-terms" },
            ...term(h("span", null, h("kbd", null, "/"), " or ", h("kbd", null, "Ctrl"), "+", h("kbd", null, "K")), "Search machines and sessions"),
            ...term(h("kbd", null, "?"), "This help"),
            ...term(h("kbd", null, "Esc"), "Close a dialog"),
          ),
          h(
            "div",
            { className: "guide__footer" },
            h("button", { className: "home-action", onClick: onShowGuide }, "Show the getting-started guide"),
            h("a", { href: GUIDE_URL, target: "_blank", rel: "noopener noreferrer" }, "Read the full guide"),
            h("a", { href: CREDITS_URL, target: "_blank", rel: "noopener noreferrer" }, "Credits"),
          ),
        ),
      ),
    );
  }

  /**
   * A host's own UI inside the dashboard. The frame runs on the host-UI origin,
   * so the host UI still cannot read or drive the Hub API; the bar sits outside
   * the frame and never covers the host's own UI or branding.
   */
  function HostUiFrame({ instance, label, src, onClose }) {
    return h(
      "section",
      { className: "host-frame", "aria-label": `${label} for ${instance.label}` },
      h(
        "div",
        { className: "host-frame__bar" },
        h("button", { className: "button button--quiet", onClick: onClose }, "‹ Overview"),
        h(
          "span",
          { className: "host-frame__title" },
          h(StatusDot, { status: instance.status }),
          h("strong", null, instance.label),
          h("small", null, label),
        ),
        h(
          "button",
          { className: "button button--quiet", onClick: () => window.open(src, "_blank", "noopener") },
          "Open in new tab",
        ),
      ),
      h("iframe", {
        className: "host-frame__view",
        src,
        title: `${label} for ${instance.label}`,
        allow: "clipboard-read; clipboard-write; microphone; fullscreen",
      }),
    );
  }

  function SessionDetail({ instance, session, terminalEvent, onStop, onRemove, onNewSession, setError }) {
    const terminalHostRef = useRef(null);
    const terminalRef = useRef(null);
    const inputQueueRef = useRef(Promise.resolve());
    const pendingInputRef = useRef("");
    const inputFlushTimerRef = useRef(null);
    const resizeQueueRef = useRef(Promise.resolve());
    const terminalSizeRef = useRef("");
    const lastWrittenEventVersionRef = useRef(0);
    const renderedTerminalBufferRef = useRef("");
    // When live output last arrived for this session; while it flows, polled snapshots are skipped.
    const lastLiveOutputRef = useRef(0);
    const canInteract = instance && !TERMINAL_STATUSES.has(session.status);
    const workspace = instance?.workspaces.find((item) => item.id === session.workspaceId);

    const localEchoRef = useRef("");

    const flushTerminalInput = useCallback(() => {
      if (inputFlushTimerRef.current !== null) {
        clearTimeout(inputFlushTimerRef.current);
        inputFlushTimerRef.current = null;
      }
      const value = pendingInputRef.current;
      pendingInputRef.current = "";
      if (!value || !instance || !canInteract) return;
      inputQueueRef.current = inputQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          const raw = /[^\u0020-\u007e\r]/.test(value) || !value.endsWith("\r");
          await api(
            `/api/instances/${encodeURIComponent(instance.id)}/sessions/${encodeURIComponent(session.id)}/input`,
            { method: "POST", body: { input: value, raw } },
          );
        })
        .catch((cause) => setError(cause instanceof Error ? cause.message : "Unable to send terminal input"));
    }, [canInteract, instance?.id, session.id, setError]);

    const writeLocalEcho = useCallback((value) => {
      const terminal = terminalRef.current;
      if (!terminal || !value) return;
      // Echo printable text immediately so the UI tracks keystrokes without
      // waiting on the network. Control keys are left to the remote PTY/TUI.
      if (!/^[\u0020-\u007e]+$/.test(value)) return;
      terminal.write(value);
      localEchoRef.current += value;
      if (localEchoRef.current.length > 4000) {
        localEchoRef.current = localEchoRef.current.slice(-2000);
      }
    }, []);

    const consumeRemoteEcho = useCallback((chunk) => {
      if (!chunk || !localEchoRef.current) return chunk;
      let remaining = chunk;
      let pending = localEchoRef.current;
      while (pending && remaining) {
        if (remaining.startsWith(pending)) {
          remaining = remaining.slice(pending.length);
          pending = "";
          break;
        }
        if (pending.startsWith(remaining)) {
          pending = pending.slice(remaining.length);
          remaining = "";
          break;
        }
        // Divergence: drop one local-echo character and keep reconciling.
        pending = pending.slice(1);
      }
      localEchoRef.current = pending;
      return remaining;
    }, []);

    const sendTerminalInput = useCallback((value) => {
      if (!value || !instance || !canInteract) return;
      writeLocalEcho(value);
      pendingInputRef.current += value;
      // Printable typing is coalesced into one request. Control sequences
      // must remain immediate so Ctrl-C, Enter, arrows, and escape-driven
      // TUIs retain Codeman-like responsiveness.
      if (/[\u0000-\u001f\u007f\u001b]/.test(value)) {
        flushTerminalInput();
        return;
      }
      if (inputFlushTimerRef.current === null) {
        inputFlushTimerRef.current = setTimeout(flushTerminalInput, 32);
      }
    }, [canInteract, flushTerminalInput, instance?.id, writeLocalEcho]);

    const sendTerminalResize = useCallback((cols, rows) => {
      if (!instance || !canInteract || !Number.isInteger(cols) || !Number.isInteger(rows)) return;
      const size = `${cols}x${rows}`;
      if (terminalSizeRef.current === size) return;
      terminalSizeRef.current = size;
      resizeQueueRef.current = resizeQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          await api(
            `/api/instances/${encodeURIComponent(instance.id)}/sessions/${encodeURIComponent(session.id)}/resize`,
            { method: "POST", body: { cols, rows } },
          );
        })
        .catch((cause) => setError(cause instanceof Error ? cause.message : "Unable to resize terminal"));
    }, [canInteract, instance?.id, session.id, setError]);

    useEffect(() => {
      const TerminalConstructor = globalThis.Terminal;
      if (!terminalHostRef.current || typeof TerminalConstructor !== "function") return undefined;
      const terminal = new TerminalConstructor({
        allowProposedApi: true,
        convertEol: true,
        disableStdin: !canInteract,
        cursorBlink: false,
        fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
        fontSize: 13,
        lineHeight: 1.35,
        scrollback: 5000,
        theme: TERMINAL_THEME,
      });
      suppressTerminalColorQueries(terminal);
      const FitAddonConstructor = globalThis.FitAddon?.FitAddon;
      const fitAddon = typeof FitAddonConstructor === "function"
        ? new FitAddonConstructor()
        : null;
      if (fitAddon) terminal.loadAddon(fitAddon);
      terminal.open(terminalHostRef.current);
      const fitTerminal = () => {
        fitAddon?.fit();
        sendTerminalResize(terminal.cols, terminal.rows);
        terminal.scrollToBottom();
      };
      fitTerminal();
      const resizeObserver = typeof ResizeObserver === "function"
        ? new ResizeObserver(fitTerminal)
        : null;
      resizeObserver?.observe(terminalHostRef.current);
      if (canInteract) {
        terminal.onData((data) => sendTerminalInput(stripTerminalResponses(data)));
      }
      terminalRef.current = terminal;
      return () => {
        resizeObserver?.disconnect();
        if (inputFlushTimerRef.current !== null) {
          clearTimeout(inputFlushTimerRef.current);
          inputFlushTimerRef.current = null;
        }
        pendingInputRef.current = "";
        localEchoRef.current = "";
        terminal.dispose();
        terminalRef.current = null;
      };
    }, [canInteract, sendTerminalInput, sendTerminalResize]);

    useEffect(() => {
      const terminal = terminalRef.current;
      if (!terminal) return;
      // The live stream appends exact bytes; a polled snapshot (tmux's redraw stream, the last 20K) would
      // repaint the whole terminal and make it jump. Use snapshots only for the first paint and as a
      // fallback when the live stream has been quiet for 10s.
      if (Date.now() - lastLiveOutputRef.current < 10_000) return;
      const terminalBuffer = cleanLegacyTerminalBuffer(session.terminalBuffer);
      const renderedBuffer = renderedTerminalBufferRef.current;
      const update = terminalUpdate(renderedBuffer, terminalBuffer);
      if (!update.reset && !update.write) return;
      if (!update.reset) {
        const delta = consumeRemoteEcho(update.write);
        if (delta) terminal.write(delta);
        // Keep only a recent window: matching needs the end of what is on screen, not all of it.
        renderedTerminalBufferRef.current = (renderedBuffer + update.write).slice(-40_000);
      } else {
        localEchoRef.current = "";
        // Clear and repaint in ONE write: reset() + write() let a blank frame render in between, which made the
        // view jerk on every poll (the polled buffer is tmux's redraw stream, so most polls repaint).
        const content = terminalBuffer
          || (session.terminalBuffer
            ? "This legacy session has corrupted terminal output. Start a new session.\r\n"
            : "Waiting for terminal output…\r\n");
        terminal.write(`\x1bc${content}`);
        renderedTerminalBufferRef.current = terminalBuffer;
      }
      lastWrittenEventVersionRef.current = terminalEvent?.version || 0;
      terminal.scrollToBottom();
    }, [canInteract, consumeRemoteEcho, session.id, session.terminalBuffer]);

    useEffect(() => {
      const terminal = terminalRef.current;
      if (
        !terminal
        || !terminalEvent
        || terminalEvent.instanceId !== session.instanceId
        || terminalEvent.sessionId !== session.id
        || terminalEvent.version <= lastWrittenEventVersionRef.current
      ) {
        return;
      }
      const delta = consumeRemoteEcho(terminalEvent.data);
      if (delta) terminal.write(delta);
      lastLiveOutputRef.current = Date.now();
      renderedTerminalBufferRef.current = (renderedTerminalBufferRef.current + terminalEvent.data).slice(-40_000);
      terminal.scrollToBottom();
      lastWrittenEventVersionRef.current = terminalEvent.version;
    }, [consumeRemoteEcho, session.id, session.instanceId, terminalEvent]);

    return h(
      "section",
      { className: "session-detail" },
      h(
        "div",
        { className: "session-detail__header" },
        h(
          "div",
          null,
          h("span", { className: "breadcrumb" }, instance?.label || "Unknown instance", " / ", workspace?.name || session.workspaceId),
          h("h2", null, session.title),
        h("div", { className: "session-meta" },
          h(StatusBadge, { status: session.status }),
          h("span", null, session.agent.name),
          h("span", { className: "session-id", title: session.id }, shortId(session.id)),
          h("span", null, `updated ${timeAgo(session.lastEventAt)}`),
        ),
        ),
        h("div", { className: "session-detail__actions" },
          h(
            "button",
            { className: "button button--quiet", onClick: onNewSession, disabled: !instance || instance.status !== "online" },
            "New session",
          ),
          h(
            "button",
            {
              className: `button ${canInteract ? "button--danger" : "button--quiet"}`,
              onClick: canInteract ? onStop : onRemove,
              disabled: !canInteract && !TERMINAL_STATUSES.has(session.status),
            },
            canInteract ? "Stop session" : "Remove session",
          ),
        ),
      ),
      h(
        "div",
        { className: "terminal", "aria-label": "Session terminal output" },
        h("div", { className: "terminal__bar" }, h("span", null, "Terminal"), h("span", null, session.id)),
      h("div", {
        ref: terminalHostRef,
        className: "terminal__output",
        onMouseDown: () => terminalRef.current?.focus(),
      },
          !globalThis.Terminal && (
            normalizeTerminalText(session.terminalBuffer)
              || h("span", { className: "terminal__placeholder" }, "Waiting for terminal output…")
          ),
        ),
      ),
    );
  }

  function CreateSessionDialog({ instances, preferredInstanceId, onClose, onCreated, setError }) {
    const [instanceId, setInstanceId] = useState(
      instances.some((item) => item.id === preferredInstanceId) ? preferredInstanceId : instances[0]?.id || "",
    );
    const instance = instances.find((item) => item.id === instanceId);
    const readyWorkspaces = (instance?.workspaces || []).filter((workspace) => workspace.health === "ready");
    const allAgents = instance?.agents || [];
    const readyAgents = allAgents.filter((agent) => agent.ready);
    const [workspaceSource, setWorkspaceSource] = useState(
      readyWorkspaces.length ? "workspace" : (instance?.workspacePolicy ? "path" : "workspace"),
    );
    const [workspaceId, setWorkspaceId] = useState(readyWorkspaces[0]?.id || "");
    const [workspacePath, setWorkspacePath] = useState("");
    const [pathSuggestions, setPathSuggestions] = useState([]);
    const [activeSuggestion, setActiveSuggestion] = useState(-1);
    const [suggesting, setSuggesting] = useState(false);
    const [suggestionError, setSuggestionError] = useState("");
    const [agentId, setAgentId] = useState(preferredAgentId(readyAgents, allAgents));
    const [title, setTitle] = useState("");
    const [creating, setCreating] = useState(false);

    useEffect(() => {
      const nextWorkspaces = (instance?.workspaces || []).filter((workspace) => workspace.health === "ready");
      const nextAgents = instance?.agents || [];
      const nextReady = nextAgents.filter((agent) => agent.ready);
      setWorkspaceSource(nextWorkspaces.length ? "workspace" : (instance?.workspacePolicy ? "path" : "workspace"));
      setWorkspaceId(nextWorkspaces[0]?.id || "");
      setWorkspacePath("");
      setPathSuggestions([]);
      setActiveSuggestion(-1);
      setSuggestionError("");
      setAgentId(preferredAgentId(nextReady, nextAgents));
    }, [instanceId]);

    useEffect(() => {
      const nextAgents = instance?.agents || [];
      const nextReady = nextAgents.filter((agent) => agent.ready);
      if (!nextAgents.some((agent) => agent.id === agentId)) {
        setAgentId(preferredAgentId(nextReady, nextAgents));
      }
    }, [instance?.agents, agentId]);

    useEffect(() => {
      if (workspaceSource !== "path" || !instance?.workspacePolicy) {
        setPathSuggestions([]);
        setSuggesting(false);
        setSuggestionError("");
        return undefined;
      }
      const controller = new AbortController();
      const timer = setTimeout(async () => {
        setSuggesting(true);
        setSuggestionError("");
        try {
          const result = await api(
            `/api/instances/${encodeURIComponent(instance.id)}/workspaces/suggestions?path=${encodeURIComponent(workspacePath)}`,
            { signal: controller.signal },
          );
          setPathSuggestions(Array.isArray(result.suggestions) ? result.suggestions : []);
          setActiveSuggestion(-1);
        } catch (cause) {
          if (cause?.name !== "AbortError") {
            setPathSuggestions([]);
            setSuggestionError(cause instanceof Error ? cause.message : "Unable to suggest paths");
          }
        } finally {
          if (!controller.signal.aborted) setSuggesting(false);
        }
      }, 180);
      return () => {
        controller.abort();
        clearTimeout(timer);
      };
    }, [instance?.id, workspacePath, workspaceSource]);

    function choosePath(path) {
      setWorkspacePath(path);
      setActiveSuggestion(-1);
      setSuggestionError("");
    }

    function handlePathKeyDown(event) {
      if (!pathSuggestions.length) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveSuggestion((current) => (current + 1) % pathSuggestions.length);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveSuggestion((current) => (current <= 0 ? pathSuggestions.length - 1 : current - 1));
      } else if (event.key === "Enter" && activeSuggestion >= 0) {
        event.preventDefault();
        choosePath(pathSuggestions[activeSuggestion].path);
      } else if (event.key === "Escape") {
        setActiveSuggestion(-1);
      }
    }

    async function createSession(event) {
      event.preventDefault();
      const path = workspacePath.trim();
      const selectedAgent = allAgents.find((agent) => agent.id === agentId);
      if (
        !instance
        || (!workspaceId && workspaceSource === "workspace")
        || (!path && workspaceSource === "path")
        || !selectedAgent
        || !selectedAgent.ready
      ) return;
      setCreating(true);
      try {
        const result = await api(`/api/instances/${encodeURIComponent(instance.id)}/sessions`, {
          method: "POST",
          body: {
            agentId,
            ...(workspaceSource === "path" ? { workspacePath: path } : { workspaceId }),
            ...(title.trim() ? { title: title.trim() } : {}),
          },
        });
        onCreated(result.session);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Unable to create session");
      } finally {
        setCreating(false);
      }
    }

    return h(
      "div",
      { className: "dialog-backdrop", role: "presentation", onMouseDown: (event) => event.target === event.currentTarget && onClose() },
      h(
        "section",
        { className: "dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "create-session-title" },
        h(
          "div",
          { className: "dialog__header" },
          h("div", null, h("span", { className: "eyebrow" }, "New work"), h("h2", { id: "create-session-title" }, "Start a session")),
          h("button", { className: "icon-button", onClick: onClose, "aria-label": "Close dialog" }, "×"),
        ),
        h(
          "form",
          { onSubmit: createSession },
          h(
            "label",
            { className: "field" },
            h("span", null, "Instance"),
            h(
              "select",
              { value: instanceId, onChange: (event) => setInstanceId(event.target.value), required: true },
              instances.map((item) => h("option", { value: item.id, key: item.id }, item.label)),
            ),
            instance && h("small", null, h(StatusBadge, { status: instance.status })),
          ),
          h(
            "label",
            { className: "field" },
            h("span", null, "Workspace source"),
            h(
              "select",
              { value: workspaceSource, onChange: (event) => setWorkspaceSource(event.target.value), required: true },
              h("option", { value: "workspace", disabled: readyWorkspaces.length === 0 }, "Known workspace"),
              h("option", { value: "path", disabled: !instance?.workspacePolicy }, "Enter a path (policy required)"),
            ),
          ),
          workspaceSource === "workspace"
            ? h(
              "label",
              { className: "field" },
              h("span", null, "Workspace"),
              h(
                "select",
                { value: workspaceId, onChange: (event) => setWorkspaceId(event.target.value), required: true, disabled: readyWorkspaces.length === 0 },
                readyWorkspaces.length
                  ? readyWorkspaces.map((workspace) => h("option", { value: workspace.id, key: `${workspace.id}:${workspace.canonicalPath}` }, workspace.name))
                  : h("option", { value: "" }, "No ready workspaces"),
              ),
              workspaceId && h("small", null, readyWorkspaces.find((workspace) => workspace.id === workspaceId)?.canonicalPath),
            )
            : h(
              "label",
              { className: "field" },
              h("span", null, "Workspace path"),
              h(
                "div",
                { className: "path-picker" },
                h("input", {
                  value: workspacePath,
                  onChange: (event) => {
                    setWorkspacePath(event.target.value);
                    setActiveSuggestion(-1);
                  },
                  onKeyDown: handlePathKeyDown,
                  placeholder: instance?.workspacePolicy?.mode === "system" ? "/home/user/project" : "/approved/root/project",
                  required: true,
                  role: "combobox",
                  "aria-autocomplete": "list",
                  "aria-expanded": pathSuggestions.length > 0,
                  "aria-controls": "workspace-path-suggestions",
                }),
                suggesting && h("small", { className: "path-picker__status" }, "Finding folders…"),
                suggestionError && h("small", { className: "path-picker__error" }, suggestionError),
                pathSuggestions.length > 0 && h(
                  "div",
                  { id: "workspace-path-suggestions", className: "path-picker__suggestions", role: "listbox" },
                  pathSuggestions.map((suggestion, index) => h(
                    "button",
                    {
                      type: "button",
                      className: `path-picker__suggestion${index === activeSuggestion ? " path-picker__suggestion--active" : ""}`,
                      role: "option",
                      "aria-selected": index === activeSuggestion,
                      key: suggestion.path,
                      onMouseDown: (event) => event.preventDefault(),
                      onClick: () => choosePath(suggestion.path),
                    },
                    h("strong", null, suggestion.name),
                    h("small", null, suggestion.path),
                  )),
                ),
              ),
              h("small", null, instance?.workspacePolicy?.mode === "system"
                ? "System access is enabled for this instance."
                : `Must exist on that host and stay inside: ${(instance?.workspacePolicy?.roots || []).join(", ") || "approved folders"}.`),
            ),
          h(
            "label",
            { className: "field" },
            h("span", null, "Agent"),
            h(
              "select",
              {
                value: agentId,
                onChange: (event) => setAgentId(event.target.value),
                required: true,
                disabled: allAgents.length === 0,
              },
              allAgents.length
                ? allAgents.map((agent) => h(
                  "option",
                  { value: agent.id, key: agent.id, disabled: !agent.ready },
                  formatAgentOption(agent),
                ))
                : h("option", { value: "" }, "No agents advertised yet"),
            ),
            allAgents.length > 0 && h(
              "small",
              null,
              "Shell (raw CLI) is a bare terminal on the host. CLI options launch a provider inside that shell.",
            ),
          ),
          !readyAgents.length && allAgents.length > 0
            && h("small", null, "No ready agents yet — check the host's agent configuration, or install/authenticate a provider CLI."),
          !allAgents.length
            && h("small", null, "Run Check health on the instance after the Worker is online."),
          h(
            "label",
            { className: "field" },
            h("span", null, "Session name ", h("em", null, "optional")),
            h("input", { value: title, onChange: (event) => setTitle(event.target.value), placeholder: "e.g. Fix the auth flow", maxLength: 120 }),
          ),
          h(
            "div",
            { className: "dialog__actions" },
            h("button", { className: "button button--quiet", type: "button", onClick: onClose }, "Cancel"),
            h("button", {
              className: "button button--primary",
              type: "submit",
              disabled: creating
                || !instance
                || instance.status !== "online"
                || (workspaceSource === "workspace" ? !workspaceId : !workspacePath.trim())
                || !readyAgents.some((agent) => agent.id === agentId),
            }, creating ? "Starting…" : "Start session"),
          ),
        ),
      ),
    );
  }

  function preferredAgentId(readyAgents, allAgents = readyAgents) {
    const preferred = readyAgents.find((agent) => agent.id === "shell")
      || readyAgents.find((agent) => agent.mode === "shell")
      || readyAgents[0]
      || allAgents[0];
    return preferred?.id || "";
  }

  function formatAgentOption(agent) {
    const base = agent.name || agent.id;
    const modeNote = agent.mode && agent.mode !== agent.id && !String(base).toLowerCase().includes(agent.mode)
      ? ` · ${agent.mode}`
      : "";
    return agent.ready ? `${base}${modeNote}` : `${base}${modeNote} (not ready)`;
  }

  ReactDOM.createRoot(document.getElementById("root")).render(h(App));
})();
