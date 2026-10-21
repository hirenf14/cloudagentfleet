// Small syntax highlighter for the docs and landing page: shell / PowerShell and JSON.
// No dependencies. Used at build time (docs) and in the browser (the install panel).
// Everything it returns is escaped HTML made of <span class="tok-…"> wrappers.

const escapeHtml = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const span = (kind, text) => `<span class="tok-${kind}">${escapeHtml(text)}</span>`;

/** Commands whose first plain argument is a subcommand worth coloring (npm install, git commit, …). */
const WITH_SUBCOMMANDS = new Set([
  "npm", "pnpm", "git", "cloudagentfleet", "systemctl", "tailscale", "docker", "gh", "uv", "pipx", "wsl", "brew",
  "winget", "launchctl", "schtasks", "codeman",
]);
const OPERATORS = ["&&", "||", ">>", "|", ";", ">", "<", "(", ")", "&"];
/** After these, the next word is a command again. */
const STARTS_COMMAND = new Set(["&&", "||", "|", ";", "(", "&"]);
const VARIABLE_PREFIX = /^(\$\{[^}]+\}|\$env:[A-Za-z_]\w*|\$[A-Za-z_]\w*|~)/;

export function highlightShell(code) {
  let continued = false;
  return code.split("\n").map((line) => {
    const result = highlightShellLine(line, continued);
    continued = result.continued;
    return result.html;
  }).join("\n");
}

function highlightShellLine(line, continued) {
  let html = "";
  let expectCommand = !continued;
  let commandName = continued ? "continued" : "";
  let subcommandDone = continued;
  let endsContinued = false;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (/\s/.test(ch)) {
      html += ch;
      i += 1;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      html += span("comment", line.slice(i));
      break;
    }
    if ((ch === "\\" || ch === "`") && i === line.length - 1) {
      html += span("op", ch);
      endsContinued = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += ch === '"' && line[j] === "\\" ? 2 : 1;
      html += span("string", line.slice(i, j + 1));
      i = j + 1;
      expectCommand = false;
      continue;
    }
    const operator = OPERATORS.find((candidate) => line.startsWith(candidate, i));
    if (operator) {
      html += span("op", operator);
      i += operator.length;
      if (STARTS_COMMAND.has(operator)) {
        expectCommand = true;
        commandName = "";
        subcommandDone = false;
      }
      continue;
    }
    // A word: URLs run to whitespace; everything else stops at quotes and operators.
    let j = i;
    if (/^https?:\/\//.test(line.slice(i))) {
      while (j < line.length && !/[\s"']/.test(line[j])) j += 1;
    } else {
      while (j < line.length && !/[\s"'|&;<>()]/.test(line[j])) j += 1;
    }
    const word = line.slice(i, j);
    i = j;
    const variable = word.match(VARIABLE_PREFIX);
    if (/^https?:\/\//.test(word)) {
      html += span("url", word);
    } else if (word.startsWith("-") && word.length > 1 && !expectCommand) {
      const equals = word.indexOf("=");
      html += equals > 0 ? `${span("flag", word.slice(0, equals))}${escapeHtml(word.slice(equals))}` : span("flag", word);
    } else if (expectCommand && /^[A-Za-z_]\w*=/.test(word)) {
      const equals = word.indexOf("=");
      html += `${span("variable", word.slice(0, equals))}${escapeHtml(word.slice(equals))}`;
    } else if (variable) {
      const rest = word.slice(variable[0].length);
      html += span("variable", variable[0]) + (expectCommand && rest ? span("cmd", rest) : escapeHtml(rest));
      if (expectCommand) {
        expectCommand = false;
        commandName = rest.replace(/^.*[\\/]/, "").replace(/\.(exe|cmd)$/i, "").toLowerCase();
      }
    } else if (expectCommand) {
      html += span("cmd", word);
      expectCommand = false;
      commandName = word.replace(/^.*[\\/]/, "").replace(/\.(exe|cmd)$/i, "").toLowerCase();
    } else if (!subcommandDone && WITH_SUBCOMMANDS.has(commandName) && /^[a-z][\w-]*$/.test(word)) {
      html += span("sub", word);
      subcommandDone = true;
    } else {
      html += escapeHtml(word);
    }
  }
  return { html, continued: endsContinued };
}

export function highlightJson(code) {
  const token = /("(?:\\.|[^"\\])*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}[\],:]/g;
  let html = "";
  let last = 0;
  for (const match of code.matchAll(token)) {
    html += escapeHtml(code.slice(last, match.index));
    if (match[1] !== undefined) html += span(match[2] ? "key" : "string", match[1]) + (match[2] ? span("op", match[2]) : "");
    else if (/^[{}[\],:]$/.test(match[0])) html += span("op", match[0]);
    else html += span("number", match[0]);
    last = match.index + match[0].length;
  }
  return html + escapeHtml(code.slice(last));
}

/** Highlighted HTML for a fenced block's language, or undefined to leave the block plain. */
export function highlight(code, language) {
  if (["bash", "sh", "shell", "console", "powershell", "ps1"].includes(language)) return highlightShell(code);
  if (language === "json") return highlightJson(code);
  return undefined;
}
