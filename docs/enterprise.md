# Steplight for organisations

Steplight is local-first: it never sends data to a server, and it has no account, telemetry or remote code.
This page is for the people who decide whether Steplight may run on company machines: what data exists, where it
lives, what an administrator can enforce, and what an administrator can *not* rely on.

## Data flow

```
                     ┌──────────────────────────── your device ────────────────────────────┐
                     │                                                                      │
  web page ──────────▶ content script ─(redacted events)─▶ service worker ──▶ encrypted      │
 (untrusted text,    │  never-capture fields skipped        detectors run on     chrome.storage│
  scripts, requests) │  secrets redacted at the source      raw data in memory,   .local      │
                     │                                      storage follows the   (AES-256-GCM)│
  browser network ───▶ webRequest (observe only)            capture level            │       │
                     │                                                               ▼       │
                     │                                                         bundled viewer │
                     │                                                         (extension page)│
                     │                                                                      │
                     │   optional, opt-in: pair with the CLI on 127.0.0.1                   │
                     │   service worker ──(token, loopback only)──▶ `steplight view` ──▶ files│
                     │                                               (optionally AES-256-GCM)│
                     │   exports: only when a person presses Export; optional password      │
                     └──────────────────────────────────────────────────────────────────────┘
                                          nothing leaves the device
```

| Hop | What crosses it | Protection |
|---|---|---|
| page → content script | the DOM, read-only | content script only reads; password / card / OTP / CVV fields and anything editable in payment frames are skipped (always on) |
| content script → service worker | redacted events | secrets redacted before sending; messages validated; only this extension's own IDs accepted |
| service worker → storage | runs at the configured capture level | redacted again; AES-256-GCM with a non-extractable key; retention enforced |
| service worker → CLI (optional) | the same events, over `http://127.0.0.1:4777` | bearer token pairing, Host/Origin checks, schema validation, 5 MB limit, rate limit |
| CLI → disk (optional) | run folders | redacted again; optional AES-256-GCM; files 0600 on POSIX |
| viewer / export | what a person chooses | strict CSP, text-only rendering; pre-export dialog; optional password protection |

The full threat analysis is in [THREAT_MODEL.md](THREAT_MODEL.md).

## What an administrator can enforce

All settings only make Steplight **more** restrictive. A user can always choose something stricter than the policy
(for example a lower capture level), never something looser.

| Policy key | Type | Effect |
|---|---|---|
| `maxCaptureLevel` | `minimal` \| `standard` \| `full` | Highest level anyone may choose. `minimal` keeps URLs without query strings, step kinds and flags only. |
| `forceRedactionPatterns` | list of regular expressions | Always redacted (as `[REDACTED:custom]`) in addition to the built-in patterns. Unsafe patterns (catastrophic backtracking) are rejected. |
| `siteAllowlist` | list of domains | If not empty, **only** these sites are recorded. The user's own allow list is ignored. |
| `siteDenylist` | list of domains | Never recorded. Added to the user's own list; users cannot remove these entries. |
| `retentionDays` | 1 – 3650 | Runs are deleted after at most this many days. Users may choose less. |
| `disableExport` | boolean | Export and import are disabled in the viewer (and refused by the CLI). |
| `disableCliConnection` | boolean | The extension never talks to a CLI server and cannot be paired with one; the CLI server refuses ingest. |
| `disableDeepCapture` | boolean | The page-level hooks (fetch / XHR / sendBeacon / WebSocket) cannot be enabled. |
| `requireEncryption` | boolean | Exports must be password-protected; the CLI/SDK refuse to write unencrypted runs. (Runs stored by the extension are always encrypted.) |

Domains are written `example.com` (covers subdomains) or `*.example.com`.
When a policy is active the settings page shows **Managed by your organization**, locks what is locked, and
lists the entries that came from the policy.

### Chrome Enterprise policy (extension)

Steplight ships a managed storage schema (`managed_schema.json`), so the policy is delivered as
[extension policy](https://developer.chrome.com/docs/extensions/reference/manifest/storage) under
`3rdparty.extensions.<extension id>`. Use the extension's id from the Chrome Web Store (or from `chrome://extensions`
for an unpacked build).

**Linux / ChromeOS / any platform with JSON policy files** — `/etc/opt/chrome/policies/managed/steplight.json`
(Linux; `/etc/chromium/policies/managed/` for Chromium):

```json
{
  "ExtensionInstallForcelist": ["EXTENSION_ID;https://clients2.google.com/service/update2/crx"],
  "3rdparty": {
    "extensions": {
      "EXTENSION_ID": {
        "maxCaptureLevel": "standard",
        "siteDenylist": ["*.mybank.example", "hr.corp.example"],
        "forceRedactionPatterns": ["EMP-\\d{6}", "CASE-[A-Z]{2}\\d{8}"],
        "retentionDays": 7,
        "disableCliConnection": true,
        "disableDeepCapture": true,
        "requireEncryption": true
      }
    }
  }
}
```

**Windows (registry / Group Policy)** — values under
`HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome\3rdparty\extensions\EXTENSION_ID\policy`:

| Value | Type | Example |
|---|---|---|
| `maxCaptureLevel` | `REG_SZ` | `standard` |
| `retentionDays` | `REG_DWORD` | `7` |
| `disableCliConnection` | `REG_DWORD` | `1` |
| `disableDeepCapture` | `REG_DWORD` | `1` |
| `disableExport` | `REG_DWORD` | `0` |
| `requireEncryption` | `REG_DWORD` | `1` |
| `siteDenylist` | sub-key with `REG_SZ` values named `1`, `2`, … | `1` = `*.mybank.example` |
| `forceRedactionPatterns` | sub-key with `REG_SZ` values named `1`, `2`, … | `1` = `EMP-\d{6}` |

```reg
Windows Registry Editor Version 5.00

[HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome\3rdparty\extensions\EXTENSION_ID\policy]
"maxCaptureLevel"="standard"
"retentionDays"=dword:00000007
"disableCliConnection"=dword:00000001
"requireEncryption"=dword:00000001

[HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome\3rdparty\extensions\EXTENSION_ID\policy\siteDenylist]
"1"="*.mybank.example"
"2"="hr.corp.example"
```

**macOS** — a configuration profile (or `/Library/Managed Preferences/com.google.Chrome.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>3rdparty</key>
  <dict>
    <key>extensions</key>
    <dict>
      <key>EXTENSION_ID</key>
      <dict>
        <key>maxCaptureLevel</key><string>standard</string>
        <key>retentionDays</key><integer>7</integer>
        <key>disableCliConnection</key><true/>
        <key>requireEncryption</key><true/>
        <key>siteDenylist</key>
        <array>
          <string>*.mybank.example</string>
          <string>hr.corp.example</string>
        </array>
      </dict>
    </dict>
  </dict>
</dict>
</plist>
```

Check what the browser received at `chrome://policy` (show "extension policies"). The extension re-reads the policy when
it changes and records `policy_applied` in its audit log.

Host access: the shipped extension asks for access to all sites **at runtime** (optional permission), not at install.
To pre-grant or to restrict it, use Chrome's `ExtensionSettings` policy (`runtime_allowed_hosts`, `runtime_blocked_hosts`).

### CLI and SDK

The CLI and SDK read the same keys from, in this order of authority (the result is never looser than any single source):

1. an **organisation policy file**: `--policy /etc/steplight/policy.json` or `$STEPLIGHT_POLICY_FILE`;
2. **`steplight.config.json`** in the working directory (or `$STEPLIGHT_CONFIG`);
3. **environment variables**: `STEPLIGHT_MAX_CAPTURE_LEVEL`, `STEPLIGHT_FORCE_REDACTION_PATTERNS` (newline separated),
   `STEPLIGHT_SITE_ALLOWLIST`, `STEPLIGHT_SITE_DENYLIST` (comma separated), `STEPLIGHT_RETENTION_DAYS`,
   `STEPLIGHT_DISABLE_EXPORT`, `STEPLIGHT_DISABLE_CLI_CONNECTION`, `STEPLIGHT_DISABLE_DEEP_CAPTURE`,
   `STEPLIGHT_REQUIRE_ENCRYPTION`.

```json
{
  "maxCaptureLevel": "standard",
  "siteDenylist": ["*.mybank.example"],
  "retentionDays": 7,
  "requireEncryption": true,
  "disableExport": false
}
```

What the CLI/SDK enforce:

- the capture level is capped (the SDK lowers `captureLevel`; `steplight view` caps what the extension sends);
- denied sites leave no step at all; forced redaction patterns apply to everything stored;
- `retentionDays` deletes older runs when `steplight view` starts or `record()` is called;
- `requireEncryption` makes `steplight view` refuse to start without `STEPLIGHT_ENCRYPTION_KEY` / `STEPLIGHT_PASSPHRASE`, makes
  `record()` skip recording (the agent keeps running — it fails open for the agent and closed for privacy), and requires
  `--password-env` for exports;
- `disableExport` makes `report`, `export --bundle` and `decrypt` refuse, and the server rejects import;
- `disableCliConnection` makes the server reject `/api/ingest`.

An organisation policy file that is missing or unreadable is an **error**, never "no restrictions".

## Audit log

Steplight keeps a local log of its own actions: recording started / stopped, exports and imports, deletions, settings changes,
policy applied, pairing. It never contains page content, URLs or task titles. Each entry holds the hash of the previous
one (SHA-256), so editing, removing or reordering history is detected.

- Extension: **Privacy settings → Audit log** (shows whether the chain is intact; export as JSON).
- CLI: `steplight audit [--verify] [--json]` (log file `audit.jsonl` next to the runs folder, or `$STEPLIGHT_AUDIT_FILE`).

Limits, stated plainly: the log is *tamper-evident*, not tamper-proof. Someone who can edit the whole file can truncate
the end of the log or replace the whole chain with a fresh one. For stronger guarantees, ship the file to your own log
store; Steplight will not do that for you because it sends nothing off the device.

## What a policy can not do

- It cannot stop someone with full control of the machine (local administrator, malware running as the user) from reading
  memory, the browser profile or files, or from running a modified build.
- CLI/SDK policy files are ordinary files: protect them with file permissions or ACLs so users cannot replace them.
  Environment variables and `steplight.config.json` belong to the user and can only make Steplight stricter.
- Redaction is pattern-based. Names, addresses and free text are not detected unless you add `forceRedactionPatterns`.
  Use `maxCaptureLevel: "minimal"` for data that must never be stored.
- Deleting files does not overwrite them on disk. Use the encryption options (and full-disk encryption) when residue matters.
- On Windows the CLI's file-mode bits have no effect: run folders inherit the folder's ACL. Keep them inside the user profile
  or tighten them with `icacls`.
