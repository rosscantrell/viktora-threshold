//! WP-INTAKE (ONBOARD) — Power Automate flow-package generator.
//!
//! Onboarding's OneDrive mail transport needs two Power Automate flows in the
//! user's own tenant that write each arriving / sent email as a schema-v1 JSON
//! file into `OneDrive/Apps/Threshold/mail` — the exact files
//! `onedrive_mail_sweep.rs` (SCHEMA v1) parses. This module GENERATES those
//! flows data-driven so onboarding can hand the user a ready artifact.
//!
//! ── Zip vs fallback (the deliberate call) ────────────────────────────────────
//! The ideal is a one-click Power Automate "Import Package (Legacy)" `.zip`. We
//! ship the FALLBACK instead, on purpose:
//!   * No `zip` crate is in the tree, and adding one to a size-conscious signed
//!     desktop app to emit an artifact we CANNOT live-test (there is no Power
//!     Automate import to drive from CI/this Mac) is the wrong trade.
//!   * Microsoft's legacy export schema has undocumented required fields and a
//!     picky import resolver; a package generated blind that fails at import is
//!     strictly worse than a clear, correct recipe (brief §E: "a working
//!     fallback beats a speculative zip that fails at import").
//! So `generate_flow_package` writes, into a chosen directory:
//!   * `threshold-mail-inbox.flow.json`  — the Inbox flow definition
//!   * `threshold-mail-sent.flow.json`   — the Sent flow definition
//!   * `IMPORT-RECIPE.md`                — the paste-ready build steps
//! The UI can one-click-copy any of these. The definitions carry the FROZEN
//! File-Content expression byte-exact, so if the legacy-zip layout is later
//! confirmed the definitions drop straight in.
//!
//! ── The FROZEN contract ──────────────────────────────────────────────────────
//! The `File Content` expression is what `onedrive_mail_sweep` parses. It is
//! FROZEN and asserted byte-exact by the unit tests against a literal copy of the
//! brief's spec. Changing it here without changing the parser (and the flow
//! schemaVersion) is a break.
//!
//! ── v2 flows (WP-INTAKE TEAMS + COLDSTART) ───────────────────────────────────
//! Three additional flows write SCHEMA-v2 JSON (`schemaVersion:2` + `kind` +
//! `capture`) the same sweep now routes by kind:
//!   * Teams LIVE — "when a new channel message is added" → kind teams-channel,
//!     capture live (one flow per channel).
//!   * Mail BACKFILL — a manual/instant flow, "Get emails (V3)" over Sent
//!     Items, last BACKFILL_WINDOW_DAYS days → kind email, capture backfill (the DEFAULT coldstart;
//!     runs once, then delete).
//!   * Teams BACKFILL — a manual/instant flow, "Get messages" for a channel,
//!     last BACKFILL_WINDOW_DAYS days → kind teams-channel, capture backfill.
//!
//! ── Capture-boundary law (WP-FORMATTING-SEMANTICS) ───────────────────────────
//! EVERY flow maps the source's HTML body token → the schema `bodyHtml` field and
//! NEVER introduces a flow-side html-to-text step or uses a text preview as the
//! primary body. Formatting (strikethrough/color/indent) is SEMANTICS in this
//! product — a struck-through commitment reads as cancelled — so stripping HTML at
//! capture would kill it before any engine code runs, and the messageId dedupe
//! would make the flat copy permanent. The drift-guard tests assert this invariant
//! (HTML token → `bodyHtml`, no preview/`bodyText` substitution) for every flow.

use serde::Serialize;
use serde_json::json;
use std::path::Path;

/// Which mailbox a flow watches. Drives the trigger folder + the `mailbox`
/// literal baked into the frozen expression.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Mailbox {
    Inbox,
    Sent,
}

impl Mailbox {
    /// The `mailbox` value written into each JSON file (`onedrive_mail_sweep`
    /// treats it as informational; both import identically).
    pub fn label(self) -> &'static str {
        match self {
            Mailbox::Inbox => "inbox",
            Mailbox::Sent => "sent",
        }
    }
    /// The Office 365 Outlook trigger's `folderPath`. `Inbox` / `SentItems` are
    /// the well-known folder ids the "When a new email arrives (V3)" trigger
    /// accepts.
    pub fn trigger_folder(self) -> &'static str {
        match self {
            Mailbox::Inbox => "Inbox",
            Mailbox::Sent => "SentItems",
        }
    }
    /// Human flow name (matches the brief's two flows).
    pub fn flow_name(self) -> &'static str {
        match self {
            Mailbox::Inbox => "Threshold mail — Inbox",
            Mailbox::Sent => "Threshold mail — Sent",
        }
    }
    /// Output filename for this flow's definition.
    pub fn definition_filename(self) -> &'static str {
        match self {
            Mailbox::Inbox => "threshold-mail-inbox.flow.json",
            Mailbox::Sent => "threshold-mail-sent.flow.json",
        }
    }
}

/// The OneDrive-for-Business folder the Create-file action targets. Matches
/// `integration_doctor::SWEEP_FOLDER_SEGMENTS` (`Apps/Threshold/mail`).
pub const CREATE_FILE_FOLDER_PATH: &str = "/Apps/Threshold/mail";

/// The Create-file `File Name` expression — a fresh GUID per message so files
/// never collide (the sweep dedups engine-side by internetMessageId anyway).
pub const CREATE_FILE_NAME_EXPRESSION: &str = "@{concat(guid(),'.json')}";

/// Compose a `File Content` expression that serializes ordered `(key, value)`
/// pairs to a JSON string, in Power Automate's workflow-definition language.
///
/// ── Why `setProperty` and not `createObject` ─────────────────────────────────
/// Every expression here USED to call `createObject(...)`. **That function does
/// not exist.** Power Automate has `createArray`, and someone reasoned by
/// symmetry — so all five flows failed identically and instantly, in the field:
///
///   InvalidTemplate ... 'The template function 'createObject' is not defined
///   or not valid.'
///
/// The tests asserted the broken string byte-exact against a copy of the brief,
/// so they were green the whole time: the spec and the code agreed with each
/// other and neither had ever met Power Automate. Only running a real flow
/// (2026-07-16, Olympus tenant) surfaced it. Don't "fix" this from a spec —
/// verify against a run.
///
/// `setProperty(object, key, value)` layered onto a `json('{}')` base is the
/// documented way to build an object. (`addProperty` THROWS if the key already
/// exists; `setProperty` doesn't — safer for a generated chain.)
///
/// ── Why serialize an object instead of concatenating JSON ────────────────────
/// `string()` of a real object escapes for us. `bodyHtml` carries raw email HTML
/// — quotes, newlines, the lot — and any hand-built JSON literal or `concat`
/// shreds on the first message containing a `"`. Verified: a 463-char HTML body
/// round-tripped intact through a live run.
fn json_object_expression(fields: &[(&str, &str)]) -> String {
    let mut expr = String::from("json('{}')");
    for (key, value) in fields {
        expr = format!("setProperty({expr},'{key}',{value})");
    }
    format!("string({expr})")
}

/// The FROZEN `File Content` expression for a mailbox — the exact JSON shape
/// `onedrive_mail_sweep` schema v1 parses. The unit tests assert it byte-for-byte
/// against a separate literal copy (drift guard).
///
/// VERIFIED END-TO-END against a live Power Automate run (2026-07-16): the
/// produced file parsed as `MailFileV1` with every required field populated
/// (`from`, `internetMessageId`, a body). The shape is UNCHANGED from the old
/// broken expression's intent, so the parser and `schemaVersion` don't move —
/// only the function that builds it.
pub fn file_content_expression(mailbox: Mailbox) -> String {
    json_object_expression(&[
        ("schemaVersion", "1"),
        ("mailbox", &format!("'{}'", mailbox.label())),
        ("from", "triggerBody()?['from']"),
        ("to", "coalesce(triggerBody()?['toRecipients'],'')"),
        ("cc", "coalesce(triggerBody()?['ccRecipients'],'')"),
        ("subject", "coalesce(triggerBody()?['subject'],'')"),
        ("dateTimeCreated", "triggerBody()?['receivedDateTime']"),
        ("bodyHtml", "coalesce(triggerBody()?['body'],'')"),
        ("internetMessageId", "triggerBody()?['internetMessageId']"),
    ])
}

/// Build one flow's Logic-App workflow definition (the shape Power Automate's
/// import consumes / the designer round-trips). Data-driven: the two flows differ
/// only in the trigger folder + the frozen expression's `mailbox` literal.
pub fn build_flow_definition(mailbox: Mailbox) -> serde_json::Value {
    let file_content = format!("@{{{}}}", file_content_expression(mailbox));
    json!({
        "name": mailbox.flow_name(),
        "properties": {
            "displayName": mailbox.flow_name(),
            "definition": {
                "$schema": "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#",
                "contentVersion": "1.0.0.0",
                "parameters": {
                    "$connections": { "defaultValue": {}, "type": "Object" },
                    "$authentication": { "defaultValue": {}, "type": "SecureObject" }
                },
                "triggers": {
                    "When_a_new_email_arrives_V3": {
                        "type": "OpenApiConnectionNotification",
                        "splitOn": "@triggerOutputs()?['body/value']",
                        "inputs": {
                            "host": {
                                "connectionName": "shared_office365",
                                "operationId": "OnNewEmailV3",
                                "apiId": "/providers/Microsoft.PowerApps/apis/shared_office365"
                            },
                            "parameters": {
                                "folderPath": mailbox.trigger_folder(),
                                "importance": "Any",
                                "fetchOnlyWithAttachment": false,
                                "includeAttachments": false
                            },
                            "authentication": "@parameters('$authentication')"
                        }
                    }
                },
                "actions": {
                    "Create_file": {
                        "type": "OpenApiConnection",
                        "runAfter": {},
                        "inputs": {
                            "host": {
                                "connectionName": "shared_onedriveforbusiness",
                                "operationId": "CreateFile",
                                "apiId": "/providers/Microsoft.PowerApps/apis/shared_onedriveforbusiness"
                            },
                            "parameters": {
                                "folderPath": CREATE_FILE_FOLDER_PATH,
                                "name": CREATE_FILE_NAME_EXPRESSION,
                                "body": file_content
                            },
                            "authentication": "@parameters('$authentication')"
                        }
                    }
                }
            }
        },
        "connectionReferences": {
            "shared_office365": {
                "runtimeSource": "embedded",
                "connection": {},
                "api": { "name": "shared_office365" }
            },
            "shared_onedriveforbusiness": {
                "runtimeSource": "embedded",
                "connection": {},
                "api": { "name": "shared_onedriveforbusiness" }
            }
        }
    })
}

/// The paste-ready recipe. Documents the 5-step manual build (the fallback for
/// the one-click package) with the frozen expressions inline so a user can
/// one-click-copy each into the Power Automate designer. Deterministic — the
/// unit test asserts the frozen expressions appear verbatim.
pub fn build_recipe() -> String {
    let inbox_expr = file_content_expression(Mailbox::Inbox);
    let sent_expr = file_content_expression(Mailbox::Sent);
    format!(
        r#"# Threshold mail flows — 1-minute setup

These two Power Automate flows quietly copy each email into
`OneDrive → Apps → Threshold → mail` as a small JSON file. Threshold's app sweeps
that folder and pulls each message into your workspace — no forwarding, no BCC.

You build them once, in your own Microsoft account. Nothing here needs admin
rights (standard Office 365 Outlook + OneDrive for Business connectors).

> Prefer to import? These same two flows are provided as
> `threshold-mail-inbox.flow.json` and `threshold-mail-sent.flow.json` next to
> this file — the definitions are exact, but manual build below is the reliable
> path and takes about a minute.

## Do this twice — once for **Inbox**, once for **Sent**

**Step 1 — New flow.** Go to Power Automate → **Create** → **Automated cloud
flow**. Name it `{inbox_name}` (or `{sent_name}` for the second).

**Step 2 — Trigger.** Choose **Office 365 Outlook → When a new email arrives
(V3)**. Set **Folder** to **Inbox** (for the Sent flow, set it to **Sent Items**).
Leave the other options at their defaults.

**Step 3 — Action.** Add **OneDrive for Business → Create file**.
- **Folder Path:** `{folder}`
- **File Name:** switch the field to expression and paste:

    concat(guid(),'.json')

**Step 4 — File Content (the important one).** In the **File Content** field,
switch to the expression editor and paste EXACTLY this for the **Inbox** flow:

    {inbox_expr}

…and this for the **Sent** flow:

    {sent_expr}

**Step 5 — Save + test.** Save the flow. Send yourself a test email; within a
minute a `.json` file appears in `OneDrive/Apps/Threshold/mail`. Threshold's
channel flips green on its next sweep. That's the whole 5-step import test.

---

If a step is blocked ("your admin hasn't allowed this connector"), that's an
org policy — Threshold's doctor records it and falls back to the classic-Outlook
or add-in path. Nothing here ever exposes more than the emails you already
receive.
"#,
        inbox_name = Mailbox::Inbox.flow_name(),
        sent_name = Mailbox::Sent.flow_name(),
        folder = CREATE_FILE_FOLDER_PATH,
        inbox_expr = inbox_expr,
        sent_expr = sent_expr,
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// v2 flows — WP-INTAKE TEAMS (live channel messages) + COLDSTART (30d backfill).
// Each writes schema-v2 JSON (schemaVersion:2 + kind + capture) via the same
// json_object_expression() serializer the sweep's v2 dispatcher parses.
// ─────────────────────────────────────────────────────────────────────────────

/// The Create-file folder for Teams captures — the SAME swept folder as mail
/// (one sweep, kind-discriminated). Kept as its own const for recipe clarity.
pub const CREATE_FILE_FOLDER_PATH_TEAMS: &str = CREATE_FILE_FOLDER_PATH;

/// FROZEN `File Content` for the Teams LIVE flow (kind teams-channel, capture
/// live). Tokens come from the "When a new channel message is added" trigger's
/// message body. `bodyHtml` carries the HTML `body/content` (capture-boundary
/// law — never a text preview). `channelName`/`teamName` are cosmetic and left
/// empty (the trigger payload has ids, not display names; the flow NAME carries
/// the channel — a user may hard-code a literal name if they want a prettier
/// title). The engine derives the thread key from `channelId` + `replyToId`.
pub fn teams_live_file_content_expression() -> String {
    json_object_expression(&[
        ("schemaVersion", "2"),
        ("kind", "'teams-channel'"),
        ("capture", "'live'"),
        ("channelId", "triggerBody()?['channelIdentity']?['channelId']"),
        ("channelName", "''"),
        ("teamName", "''"),
        ("author", "triggerBody()?['from']?['user']?['displayName']"),
        ("messageId", "triggerBody()?['id']"),
        ("replyToId", "coalesce(triggerBody()?['replyToId'],'')"),
        ("dateTimeCreated", "triggerBody()?['createdDateTime']"),
        ("bodyHtml", "coalesce(triggerBody()?['body']?['content'],'')"),
    ])
}

/// FROZEN `File Content` for the mail BACKFILL flow (kind email, capture
/// backfill), evaluated inside an Apply-to-each over "Get emails (V3)" `value`.
/// `bodyHtml` carries the HTML `body` token (capture-boundary law). Mirrors the
/// live-mail field set so the sweep parses it identically, plus the v2
/// discriminators.
///
/// The mailbox is a PARAMETER, not a constant. Sent remains the recommended
/// coldstart (you wrote it, so it's safe unconditionally, and it's what teaches
/// the reciprocity gate its correspondent set). Inbox exists because the gate
/// makes it safe: with INBOX_RECIPROCITY_GATE_ENABLED on, an inbox backfill
/// self-filters to people you already correspond with. Running one WITHOUT the
/// gate imports 14 days of solicitations, permanently — hence the recipe puts
/// Sent first and says so.
pub fn email_backfill_file_content_expression(mailbox: Mailbox) -> String {
    json_object_expression(&[
        ("schemaVersion", "2"),
        ("kind", "'email'"),
        ("capture", "'backfill'"),
        ("mailbox", &format!("'{}'", mailbox.label())),
        ("from", "item()?['from']"),
        ("to", "coalesce(item()?['toRecipients'],'')"),
        ("cc", "coalesce(item()?['ccRecipients'],'')"),
        ("subject", "coalesce(item()?['subject'],'')"),
        ("dateTimeCreated", "item()?['receivedDateTime']"),
        ("bodyHtml", "coalesce(item()?['body'],'')"),
        ("internetMessageId", "item()?['internetMessageId']"),
    ])
}

/// FROZEN `File Content` for the Teams BACKFILL flow (kind teams-channel, capture
/// backfill), evaluated inside an Apply-to-each over "Get messages" `value`. Same
/// field set as the Teams live flow but sourced from `item()`.
pub fn teams_backfill_file_content_expression() -> String {
    json_object_expression(&[
        ("schemaVersion", "2"),
        ("kind", "'teams-channel'"),
        ("capture", "'backfill'"),
        ("channelId", "item()?['channelIdentity']?['channelId']"),
        ("channelName", "''"),
        ("teamName", "''"),
        ("author", "item()?['from']?['user']?['displayName']"),
        ("messageId", "item()?['id']"),
        ("replyToId", "coalesce(item()?['replyToId'],'')"),
        ("dateTimeCreated", "item()?['createdDateTime']"),
        ("bodyHtml", "coalesce(item()?['body']?['content'],'')"),
    ])
}

/// How far back a coldstart backfill reaches.
///
/// ONE place: this number appeared in the Get-emails search query, the Teams
/// client-side filter, both flow NAMES, both generated FILENAMES, the recipe
/// prose, and the app's card copy. Seven copies of a number is how they drift —
/// a flow named "30d" quietly importing 14 is the kind of lie that survives
/// review. Everything below derives from here.
///
/// 14 days (Ross, 2026-07-16 — was 30). The window is a judgement call, not a
/// constraint: bigger warms the field faster, smaller keeps the first import
/// cheap and the blast radius small if a capture is wrong.
pub const BACKFILL_WINDOW_DAYS: u32 = 14;

/// Flow names for the v2 flows (match the brief).
pub const TEAMS_LIVE_FLOW_NAME: &str = "Threshold Teams — <channel>";

/// `Threshold backfill — Sent mail <N>d` / `— Inbox mail <N>d`. Derived so the
/// NAME can never claim a window (or a mailbox) the flow doesn't implement.
pub fn mail_backfill_flow_name(mailbox: Mailbox) -> String {
    let which = match mailbox {
        Mailbox::Sent => "Sent",
        Mailbox::Inbox => "Inbox",
    };
    format!("Threshold backfill — {which} mail {BACKFILL_WINDOW_DAYS}d")
}
/// `Threshold backfill — Teams channel <N>d`.
pub fn teams_backfill_flow_name() -> String {
    format!("Threshold backfill — Teams channel {BACKFILL_WINDOW_DAYS}d")
}
/// `threshold-mail-backfill-<sent|inbox>-<N>d.flow.json`.
pub fn mail_backfill_filename(mailbox: Mailbox) -> String {
    format!("threshold-mail-backfill-{}-{BACKFILL_WINDOW_DAYS}d.flow.json", mailbox.label())
}
/// `threshold-teams-backfill-<N>d.flow.json`.
pub fn teams_backfill_filename() -> String {
    format!("threshold-teams-backfill-{BACKFILL_WINDOW_DAYS}d.flow.json")
}

/// The Teams LIVE flow definition — standard Teams trigger → Create file.
pub fn build_teams_live_flow_definition() -> serde_json::Value {
    let file_content = format!("@{{{}}}", teams_live_file_content_expression());
    json!({
        "name": TEAMS_LIVE_FLOW_NAME,
        "properties": {
            "displayName": TEAMS_LIVE_FLOW_NAME,
            "definition": {
                "$schema": "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#",
                "contentVersion": "1.0.0.0",
                "parameters": {
                    "$connections": { "defaultValue": {}, "type": "Object" },
                    "$authentication": { "defaultValue": {}, "type": "SecureObject" }
                },
                "triggers": {
                    "When_a_new_channel_message_is_added": {
                        "type": "OpenApiConnectionNotification",
                        "inputs": {
                            "host": {
                                "connectionName": "shared_teams",
                                "operationId": "OnNewChannelMessage",
                                "apiId": "/providers/Microsoft.PowerApps/apis/shared_teams"
                            },
                            "parameters": {
                                // User picks Team + Channel here in the designer.
                                "poller/channel/groupId": "",
                                "poller/channel/channelId": ""
                            },
                            "authentication": "@parameters('$authentication')"
                        }
                    }
                },
                "actions": {
                    "Create_file": teams_create_file_action(&file_content)
                }
            }
        },
        "connectionReferences": {
            "shared_teams": {
                "runtimeSource": "embedded", "connection": {}, "api": { "name": "shared_teams" }
            },
            "shared_onedriveforbusiness": {
                "runtimeSource": "embedded", "connection": {}, "api": { "name": "shared_onedriveforbusiness" }
            }
        }
    })
}

/// The mail BACKFILL flow definition — manual trigger → Get emails (V3) over the
/// chosen mailbox (last BACKFILL_WINDOW_DAYS days, paged) → Apply-to-each → Create file (kind email,
/// capture backfill).
pub fn build_email_backfill_flow_definition(mailbox: Mailbox) -> serde_json::Value {
    let file_content = format!("@{{{}}}", email_backfill_file_content_expression(mailbox));
    json!({
        "name": mail_backfill_flow_name(mailbox),
        "properties": {
            "displayName": mail_backfill_flow_name(mailbox),
            "definition": {
                "$schema": "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#",
                "contentVersion": "1.0.0.0",
                "parameters": {
                    "$connections": { "defaultValue": {}, "type": "Object" },
                    "$authentication": { "defaultValue": {}, "type": "SecureObject" }
                },
                "triggers": {
                    "manual": {
                        "type": "Request",
                        "kind": "Button",
                        "inputs": {}
                    }
                },
                "actions": {
                    "Get_emails_V3": {
                        "type": "OpenApiConnection",
                        "runAfter": {},
                        "inputs": {
                            "host": {
                                "connectionName": "shared_office365",
                                "operationId": "GetEmailsV3",
                                "apiId": "/providers/Microsoft.PowerApps/apis/shared_office365"
                            },
                            "parameters": {
                                "folderPath": mailbox.trigger_folder(),
                                "fetchOnlyUnread": false,
                                "includeAttachments": false,
                                "importance": "Any",
                                // The backfill window, paged (the designer exposes both).
                                "searchQuery": format!("received:>=@{{addDays(utcNow(),-{BACKFILL_WINDOW_DAYS})}}"),
                                "top": 250
                            },
                            "authentication": "@parameters('$authentication')",
                            "runtimeConfiguration": {
                                "paginationPolicy": { "minimumItemCount": 5000 }
                            }
                        }
                    },
                    "Apply_to_each_email": {
                        "type": "Foreach",
                        "foreach": "@outputs('Get_emails_V3')?['body/value']",
                        "runAfter": { "Get_emails_V3": ["Succeeded"] },
                        "actions": {
                            "Create_file": mail_create_file_action(&file_content)
                        }
                    }
                }
            }
        },
        "connectionReferences": {
            "shared_office365": {
                "runtimeSource": "embedded", "connection": {}, "api": { "name": "shared_office365" }
            },
            "shared_onedriveforbusiness": {
                "runtimeSource": "embedded", "connection": {}, "api": { "name": "shared_onedriveforbusiness" }
            }
        }
    })
}

/// The Teams BACKFILL flow definition — manual trigger → Get messages for a
/// chosen channel → Apply-to-each (filter the window client-side is documented in
/// the recipe) → Create file (kind teams-channel, capture backfill).
pub fn build_teams_backfill_flow_definition() -> serde_json::Value {
    let file_content = format!("@{{{}}}", teams_backfill_file_content_expression());
    json!({
        "name": teams_backfill_flow_name(),
        "properties": {
            "displayName": teams_backfill_flow_name(),
            "definition": {
                "$schema": "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#",
                "contentVersion": "1.0.0.0",
                "parameters": {
                    "$connections": { "defaultValue": {}, "type": "Object" },
                    "$authentication": { "defaultValue": {}, "type": "SecureObject" }
                },
                "triggers": {
                    "manual": {
                        "type": "Request",
                        "kind": "Button",
                        "inputs": {}
                    }
                },
                "actions": {
                    "Get_messages": {
                        "type": "OpenApiConnection",
                        "runAfter": {},
                        "inputs": {
                            "host": {
                                "connectionName": "shared_teams",
                                "operationId": "GetMessagesFromChannel",
                                "apiId": "/providers/Microsoft.PowerApps/apis/shared_teams"
                            },
                            "parameters": {
                                // User picks Team + Channel here in the designer.
                                "groupId": "",
                                "channelId": ""
                            },
                            "authentication": "@parameters('$authentication')",
                            "runtimeConfiguration": {
                                "paginationPolicy": { "minimumItemCount": 5000 }
                            }
                        }
                    },
                    "Apply_to_each_message": {
                        "type": "Foreach",
                        "foreach": "@outputs('Get_messages')?['body/value']",
                        "runAfter": { "Get_messages": ["Succeeded"] },
                        "actions": {
                            // Only keep messages inside the backfill window.
                            "Only_within_backfill_window": {
                                "type": "If",
                                "expression": {
                                    "greaterOrEquals": [
                                        "@item()?['createdDateTime']",
                                        format!("@addDays(utcNow(),-{BACKFILL_WINDOW_DAYS})")
                                    ]
                                },
                                "actions": {
                                    "Create_file": teams_create_file_action(&file_content)
                                }
                            }
                        }
                    }
                }
            }
        },
        "connectionReferences": {
            "shared_teams": {
                "runtimeSource": "embedded", "connection": {}, "api": { "name": "shared_teams" }
            },
            "shared_onedriveforbusiness": {
                "runtimeSource": "embedded", "connection": {}, "api": { "name": "shared_onedriveforbusiness" }
            }
        }
    })
}

/// The shared OneDrive Create-file action for a mail file (guid name, sweep
/// folder, the given File Content expression).
fn mail_create_file_action(file_content: &str) -> serde_json::Value {
    json!({
        "type": "OpenApiConnection",
        "runAfter": {},
        "inputs": {
            "host": {
                "connectionName": "shared_onedriveforbusiness",
                "operationId": "CreateFile",
                "apiId": "/providers/Microsoft.PowerApps/apis/shared_onedriveforbusiness"
            },
            "parameters": {
                "folderPath": CREATE_FILE_FOLDER_PATH,
                "name": CREATE_FILE_NAME_EXPRESSION,
                "body": file_content
            },
            "authentication": "@parameters('$authentication')"
        }
    })
}

/// The shared OneDrive Create-file action for a Teams file (identical shape; kept
/// separate for readability + the teams folder const).
fn teams_create_file_action(file_content: &str) -> serde_json::Value {
    json!({
        "type": "OpenApiConnection",
        "runAfter": {},
        "inputs": {
            "host": {
                "connectionName": "shared_onedriveforbusiness",
                "operationId": "CreateFile",
                "apiId": "/providers/Microsoft.PowerApps/apis/shared_onedriveforbusiness"
            },
            "parameters": {
                "folderPath": CREATE_FILE_FOLDER_PATH_TEAMS,
                "name": CREATE_FILE_NAME_EXPRESSION,
                "body": file_content
            },
            "authentication": "@parameters('$authentication')"
        }
    })
}

/// The Teams live + backfill setup recipe (paste-ready, frozen expressions
/// inline). Deterministic — the unit test asserts the frozen expressions appear.
pub fn build_teams_recipe() -> String {
    let live_expr = teams_live_file_content_expression();
    format!(
        r#"# Threshold Teams flow — live channel capture (1 flow per channel)

This flow quietly copies each new message in ONE Teams channel into
`OneDrive → Apps → Threshold → mail` as a small JSON file. Threshold's app sweeps
that folder and pulls each message into your workspace. Build one flow per channel
you want followed. Standard connectors only — no admin rights.

> Prefer to import? The definition is provided as `threshold-teams-live.flow.json`
> next to this file. The manual build below is the reliable path (~1 minute).

**Step 1 — New flow.** Power Automate → **Create** → **Automated cloud flow**.
Name it after the channel, e.g. `Threshold Teams — Renewals`.

**Step 2 — Trigger.** Choose **Microsoft Teams → When a new channel message is
added**. Pick the **Team** and **Channel** you want followed.

**Step 3 — Action.** Add **OneDrive for Business → Create file**.
- **Folder Path:** `{folder}`
- **File Name:** switch to expression and paste: `concat(guid(),'.json')`

**Step 4 — File Content (the important one).** Switch the **File Content** field to
the expression editor and paste EXACTLY:

    {live_expr}

This maps the message's **HTML body** (`body/content`) into `bodyHtml` — do NOT
add any "HTML to text" step; formatting like strikethrough carries meaning and is
interpreted engine-side. (Optional: replace the two empty `''` after `channelName`
and `teamName` with your channel / team name in quotes for prettier titles.)

**Step 5 — Save + test.** Save. Post a test message in the channel; within a
minute a `.json` file appears in `OneDrive/Apps/Threshold/mail` and the channel
flips green on Threshold's next sweep.

---
If a step is blocked ("your admin hasn't allowed this connector"), that's an org
policy — Threshold's doctor records it. For a one-time history import of the same
channel, see `BACKFILL-RECIPE.md`.
"#,
        folder = CREATE_FILE_FOLDER_PATH_TEAMS,
        live_expr = live_expr,
    )
}

/// The COLDSTART backfill recipe (recommended = Sent mail; optional Inbox and
/// Teams-channel history). One-time, manually-triggered flows; delete after they
/// run.
pub fn build_backfill_recipe() -> String {
    let mail_expr = email_backfill_file_content_expression(Mailbox::Sent);
    let inbox_expr = email_backfill_file_content_expression(Mailbox::Inbox);
    let teams_expr = teams_backfill_file_content_expression();
    format!(
        r#"# Threshold coldstart — import your last {win} days (one-time)

These are **instant** flows: you run each ONCE (a **Run** button in Power
Automate), it imports the last {win} days, then you can delete it. Everything lands
as the same JSON files Threshold sweeps, and the engine dedupes against anything
already captured. Backfilled items are filed as background context (searchable
everywhere) and won't crowd today's agenda.

## Recommended: Sent mail, last {win} days ({mail_name})

Your sent mail is dense signal with low noise — the best jump-start.

**Step 1 — New flow.** Power Automate → **Create** → **Instant cloud flow** →
**Manually trigger a flow**. Name it `{mail_name}`.

**Step 2 — Get emails.** Add **Office 365 Outlook → Get emails (V3)**.
- **Folder:** `Sent Items`
- **Fetch Only Unread:** No · **Include Attachments:** No
- **Top:** `250` and turn **Pagination** ON (Settings → Pagination) so it pages
  through the full {win} days.
- **Search Query:** `received:>=@{{addDays(utcNow(),-{win})}}`

**Step 3 — Loop + Create file.** Add **Apply to each** over the **value** output
of Get emails. Inside it add **OneDrive for Business → Create file**:
- **Folder Path:** `{folder}` · **File Name:** `concat(guid(),'.json')` (expression)
- **File Content** (expression editor), paste EXACTLY:

    {mail_expr}

This maps the email's **HTML Body** into `bodyHtml` — never use **Body Preview**
as the body and never add an html-to-text step (formatting is meaning here).

**Step 4 — Run once.** Save → **Test** → **Manually** → **Run flow**. Watch the
files land in `OneDrive/Apps/Threshold/mail`. When it finishes, **delete the flow**
(it has done its one job).

## Optional: Inbox, last {win} days ({inbox_name})

**Run the Sent flow first, and only run this one if Threshold is holding
unknown senders for you.** Your Inbox contains solicitations you never asked
for; importing them is permanent (each message is deduped by its id, so it
cannot be un-imported). With the reciprocity gate on, this import self-filters
to people you already correspond with — which is exactly why Sent goes first:
it's what teaches Threshold who those people are.

Same five steps as above, with two changes:

**Step 1 — New flow.** Name it `{inbox_name}`.

**Step 2 — Get emails (V3).** Set **Folder** to `Inbox` (not Sent Items).

**Step 4 — File Content.** Paste this instead:

    {inbox_expr}

## Optional: Teams channel history, last {win} days ({teams_name})

Same idea for one Teams channel. Instant flow → **Microsoft Teams → Get messages**
(pick Team + Channel, Pagination ON) → **Apply to each** over **value** → a
**Condition** keeping only `createdDateTime` ≥ {win} days ago → **Create file** with:

    {teams_expr}

Same capture-boundary rule: the message **HTML** `body/content` → `bodyHtml`, no
text conversion. Run once, then delete.

---
Import instead? The definitions are provided as `{mail_file}`
and `{teams_file}` next to this file.
"#,
        mail_name = mail_backfill_flow_name(Mailbox::Sent),
        inbox_name = mail_backfill_flow_name(Mailbox::Inbox),
        teams_name = teams_backfill_flow_name(),
        folder = CREATE_FILE_FOLDER_PATH,
        mail_expr = mail_expr,
        inbox_expr = inbox_expr,
        teams_expr = teams_expr,
        win = BACKFILL_WINDOW_DAYS,
        mail_file = mail_backfill_filename(Mailbox::Sent),
        teams_file = teams_backfill_filename(),
    )
}

/// The files `generate_flow_package` wrote, returned to the UI so it can reveal /
/// copy them.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedPackage {
    /// The directory everything was written into.
    pub dir: String,
    /// Absolute path to the Inbox flow definition.
    pub inbox_definition: String,
    /// Absolute path to the Sent flow definition.
    pub sent_definition: String,
    /// Absolute path to the (live-mail) recipe markdown.
    pub recipe: String,
    /// Absolute path to the Teams LIVE flow definition (WP-INTAKE TEAMS).
    pub teams_live_definition: String,
    /// Absolute path to the mail BACKFILL flow definition (WP-INTAKE COLDSTART).
    pub mail_backfill_definition: String,
    /// The INBOX backfill definition. Safe to run only with the reciprocity gate
    /// on (it self-filters); the recipe says so.
    pub mail_backfill_inbox_definition: String,
    /// Absolute path to the Teams BACKFILL flow definition (WP-INTAKE COLDSTART).
    pub teams_backfill_definition: String,
    /// Absolute path to the Teams setup recipe markdown.
    pub teams_recipe: String,
    /// Absolute path to the coldstart/backfill recipe markdown.
    pub backfill_recipe: String,
    /// True — signals the UI this is the definition+recipe fallback, not a
    /// one-click `.zip` package (so it renders the "build in ~1 min" guidance,
    /// not "import this zip").
    pub is_fallback: bool,
}

/// Write the flow definitions + recipes into `dest_dir`, creating a
/// `Threshold-PowerAutomate/` subfolder so the artifacts stay grouped (e.g. in
/// Downloads). Overwrites on re-run (idempotent). Returns the written paths.
///
/// SUPERSEDED FILES ARE REMOVED. Overwriting-by-name is not enough: our own
/// filenames carry the backfill window (`…-30d.flow.json` → `…-14d.flow.json`),
/// so changing it STRANDS the old file — and a stranded file is not merely
/// clutter, it is a working-looking artifact carrying whatever bug the old
/// build had. That happened for real: after the window moved to 14d and the
/// createObject fix landed, the `-30d` definitions were still sitting in
/// OneDrive containing a function Power Automate does not have. A user browsing
/// the folder cannot tell which is current.
///
/// Only files matching OUR OWN generated names are removed (`threshold-*.flow.json`
/// we did not just write). Anything a user put here is untouched.
pub fn generate_flow_package(dest_dir: &Path) -> std::io::Result<GeneratedPackage> {
    let pkg_dir = dest_dir.join("Threshold-PowerAutomate");
    std::fs::create_dir_all(&pkg_dir)?;

    let inbox_path = pkg_dir.join(Mailbox::Inbox.definition_filename());
    let sent_path = pkg_dir.join(Mailbox::Sent.definition_filename());
    let recipe_path = pkg_dir.join("IMPORT-RECIPE.md");
    // v2 flows (WP-INTAKE TEAMS + COLDSTART).
    let teams_live_path = pkg_dir.join("threshold-teams-live.flow.json");
    let mail_backfill_path = pkg_dir.join(mail_backfill_filename(Mailbox::Sent));
    let mail_backfill_inbox_path = pkg_dir.join(mail_backfill_filename(Mailbox::Inbox));
    let teams_backfill_path = pkg_dir.join(teams_backfill_filename());
    let teams_recipe_path = pkg_dir.join("TEAMS-RECIPE.md");
    let backfill_recipe_path = pkg_dir.join("BACKFILL-RECIPE.md");

    // Everything this run legitimately produces. Anything else of ours is stale.
    let written: Vec<&Path> = vec![
        inbox_path.as_path(),
        sent_path.as_path(),
        teams_live_path.as_path(),
        mail_backfill_path.as_path(),
        mail_backfill_inbox_path.as_path(),
        teams_backfill_path.as_path(),
    ];
    if let Ok(entries) = std::fs::read_dir(&pkg_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            // Scope tightly: only our own generated definitions, never a user file.
            if !(name.starts_with("threshold-") && name.ends_with(".flow.json")) {
                continue;
            }
            if written.iter().any(|w| *w == path.as_path()) {
                continue;
            }
            // Best-effort: a failed cleanup must never fail the generation.
            match std::fs::remove_file(&path) {
                Ok(()) => log::info!("flow package: removed superseded {name}"),
                Err(e) => log::warn!("flow package: could not remove superseded {name}: {e}"),
            }
        }
    }

    let pretty = |v: &serde_json::Value| -> std::io::Result<String> {
        serde_json::to_string_pretty(v).map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
    };

    std::fs::write(&inbox_path, pretty(&build_flow_definition(Mailbox::Inbox))?)?;
    std::fs::write(&sent_path, pretty(&build_flow_definition(Mailbox::Sent))?)?;
    std::fs::write(&recipe_path, build_recipe())?;
    std::fs::write(&teams_live_path, pretty(&build_teams_live_flow_definition())?)?;
    std::fs::write(&mail_backfill_path, pretty(&build_email_backfill_flow_definition(Mailbox::Sent))?)?;
    std::fs::write(
        &mail_backfill_inbox_path,
        pretty(&build_email_backfill_flow_definition(Mailbox::Inbox))?,
    )?;
    std::fs::write(&teams_backfill_path, pretty(&build_teams_backfill_flow_definition())?)?;
    std::fs::write(&teams_recipe_path, build_teams_recipe())?;
    std::fs::write(&backfill_recipe_path, build_backfill_recipe())?;

    Ok(GeneratedPackage {
        dir: pkg_dir.to_string_lossy().into_owned(),
        inbox_definition: path_string(&inbox_path),
        sent_definition: path_string(&sent_path),
        recipe: path_string(&recipe_path),
        teams_live_definition: path_string(&teams_live_path),
        mail_backfill_definition: path_string(&mail_backfill_path),
        mail_backfill_inbox_definition: path_string(&mail_backfill_inbox_path),
        teams_backfill_definition: path_string(&teams_backfill_path),
        teams_recipe: path_string(&teams_recipe_path),
        backfill_recipe: path_string(&backfill_recipe_path),
        is_fallback: true,
    })
}

fn path_string(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests — the FROZEN-expression drift guard + definition/package shape.
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    // The canonical frozen strings. These are NOT copied from the brief any more
    // — the brief's spec called createObject(), a function Power Automate does
    // not have, and these constants faithfully asserted that broken string for
    // the product's whole life. A spec copy proves the code matches a document;
    // it proves nothing about Microsoft accepting it. FROZEN_INBOX below is the
    // expression a real flow ran successfully (2026-07-16, Olympus tenant),
    // producing a file that parsed as MailFileV1 with every required field.
    const FROZEN_INBOX: &str = "string(setProperty(setProperty(setProperty(setProperty(setProperty(setProperty(setProperty(setProperty(setProperty(json('{}'),'schemaVersion',1),'mailbox','inbox'),'from',triggerBody()?['from']),'to',coalesce(triggerBody()?['toRecipients'],'')),'cc',coalesce(triggerBody()?['ccRecipients'],'')),'subject',coalesce(triggerBody()?['subject'],'')),'dateTimeCreated',triggerBody()?['receivedDateTime']),'bodyHtml',coalesce(triggerBody()?['body'],'')),'internetMessageId',triggerBody()?['internetMessageId']))";
    const FROZEN_SENT: &str = "string(setProperty(setProperty(setProperty(setProperty(setProperty(setProperty(setProperty(setProperty(setProperty(json('{}'),'schemaVersion',1),'mailbox','sent'),'from',triggerBody()?['from']),'to',coalesce(triggerBody()?['toRecipients'],'')),'cc',coalesce(triggerBody()?['ccRecipients'],'')),'subject',coalesce(triggerBody()?['subject'],'')),'dateTimeCreated',triggerBody()?['receivedDateTime']),'bodyHtml',coalesce(triggerBody()?['body'],'')),'internetMessageId',triggerBody()?['internetMessageId']))";

    /// Guards the CLASS of bug that shipped here, not the instance.
    ///
    /// `createObject` isn't a Power Automate function, so every generated flow
    /// failed instantly with InvalidTemplate — and the drift-guard tests were
    /// green throughout, because they compared the code against a copy of the
    /// same wrong spec. Nothing in the suite could tell "matches the brief" from
    /// "actually works".
    ///
    /// This asserts every File Content expression is built only from functions
    /// observed working against live Power Automate. Adding a function here
    /// means running a real flow with it first — that's the whole point.
    #[test]
    fn expressions_use_only_verified_template_functions() {
        // Verified in a live run, Olympus tenant, 2026-07-16.
        const VERIFIED: &[&str] = &["string(", "setProperty(", "json(", "coalesce(", "triggerBody(", "item("];
        // Known-not-a-function. The literal that cost us this bug.
        const FORBIDDEN: &[&str] = &["createObject(", "createRecord(", "makeObject("];

        let all = [
            file_content_expression(Mailbox::Inbox),
            file_content_expression(Mailbox::Sent),
            teams_live_file_content_expression(),
            email_backfill_file_content_expression(Mailbox::Sent),
            email_backfill_file_content_expression(Mailbox::Inbox),
            teams_backfill_file_content_expression(),
        ];
        for expr in &all {
            for bad in FORBIDDEN {
                assert!(!expr.contains(bad), "expression uses a non-existent template function `{bad}`: {expr}");
            }
            // Every `name(` in the expression must be a function we've seen work.
            let mut rest = expr.as_str();
            while let Some(open) = rest.find('(') {
                let head = &rest[..open];
                let name_start = head
                    .rfind(|c: char| !c.is_ascii_alphanumeric() && c != '_')
                    .map(|i| i + 1)
                    .unwrap_or(0);
                let call = format!("{}(", &head[name_start..]);
                if call != "(" {
                    assert!(
                        VERIFIED.iter().any(|v| *v == call),
                        "unverified template function `{call}` — run it against real Power \
                         Automate before adding it to VERIFIED: {expr}"
                    );
                }
                rest = &rest[open + 1..];
            }
        }
    }

    #[test]
    fn file_content_expression_is_frozen_byte_exact() {
        assert_eq!(file_content_expression(Mailbox::Inbox), FROZEN_INBOX);
        assert_eq!(file_content_expression(Mailbox::Sent), FROZEN_SENT);
        // The only difference between them is the mailbox literal.
        assert_eq!(
            FROZEN_INBOX.replace("'mailbox','inbox'", "'mailbox','sent'"),
            FROZEN_SENT
        );
    }

    #[test]
    fn frozen_expression_keys_match_schema_v1_fields() {
        // The keys the sweep's MailFileV1 reads (bodyText/inReplyTo/references are
        // optional and intentionally omitted — the trigger doesn't expose them;
        // bodyHtml present ⇒ the parser's at-least-one-body floor is met).
        for key in [
            "'schemaVersion'",
            "'mailbox'",
            "'from'",
            "'to'",
            "'cc'",
            "'subject'",
            "'dateTimeCreated'",
            "'bodyHtml'",
            "'internetMessageId'",
        ] {
            assert!(
                FROZEN_INBOX.contains(key),
                "frozen expression must carry {key}"
            );
        }
    }

    #[test]
    fn flow_definition_parses_and_carries_frozen_expression() {
        for (mb, frozen, folder) in [
            (Mailbox::Inbox, FROZEN_INBOX, "Inbox"),
            (Mailbox::Sent, FROZEN_SENT, "SentItems"),
        ] {
            let def = build_flow_definition(mb);
            // Round-trips through JSON.
            let s = serde_json::to_string(&def).unwrap();
            let reparsed: serde_json::Value = serde_json::from_str(&s).unwrap();
            assert_eq!(reparsed, def);

            let props = &def["properties"];
            let actions = &props["definition"]["actions"]["Create_file"]["inputs"]["parameters"];
            // Create-file targets the sweep folder + guid filename.
            assert_eq!(actions["folderPath"], CREATE_FILE_FOLDER_PATH);
            assert_eq!(actions["name"], CREATE_FILE_NAME_EXPRESSION);
            // File Content carries the frozen expression, wrapped @{...}.
            assert_eq!(actions["body"], format!("@{{{}}}", frozen));

            // Trigger watches the right folder.
            let trig = &props["definition"]["triggers"]["When_a_new_email_arrives_V3"]
                ["inputs"]["parameters"]["folderPath"];
            assert_eq!(trig, folder);

            // Both connectors are referenced.
            assert!(def["connectionReferences"].get("shared_office365").is_some());
            assert!(def["connectionReferences"]
                .get("shared_onedriveforbusiness")
                .is_some());
        }
    }

    #[test]
    fn recipe_contains_both_frozen_expressions_and_folder() {
        let r = build_recipe();
        assert!(r.contains(FROZEN_INBOX));
        assert!(r.contains(FROZEN_SENT));
        assert!(r.contains(CREATE_FILE_FOLDER_PATH));
        assert!(r.contains("concat(guid(),'.json')"));
        // Names both flows.
        assert!(r.contains(Mailbox::Inbox.flow_name()));
        assert!(r.contains(Mailbox::Sent.flow_name()));
    }

    // ── v2 flows (WP-INTAKE TEAMS + COLDSTART): frozen-expression drift guards ──
    // Independent literal copies of the v2 File Content expressions. If a
    // generator drifts from what `onedrive_mail_sweep`'s v2 dispatcher parses,
    // THESE fail.
    const FROZEN_TEAMS_LIVE: &str = "string(setProperty(setProperty(setProperty(setProperty(setProperty(setProperty(setProperty(setProperty(setProperty(setProperty(setProperty(json('{}'),'schemaVersion',2),'kind','teams-channel'),'capture','live'),'channelId',triggerBody()?['channelIdentity']?['channelId']),'channelName',''),'teamName',''),'author',triggerBody()?['from']?['user']?['displayName']),'messageId',triggerBody()?['id']),'replyToId',coalesce(triggerBody()?['replyToId'],'')),'dateTimeCreated',triggerBody()?['createdDateTime']),'bodyHtml',coalesce(triggerBody()?['body']?['content'],'')))";
    const FROZEN_MAIL_BACKFILL: &str = "string(setProperty(setProperty(setProperty(setProperty(setProperty(setProperty(setProperty(setProperty(setProperty(setProperty(setProperty(json('{}'),'schemaVersion',2),'kind','email'),'capture','backfill'),'mailbox','sent'),'from',item()?['from']),'to',coalesce(item()?['toRecipients'],'')),'cc',coalesce(item()?['ccRecipients'],'')),'subject',coalesce(item()?['subject'],'')),'dateTimeCreated',item()?['receivedDateTime']),'bodyHtml',coalesce(item()?['body'],'')),'internetMessageId',item()?['internetMessageId']))";
    const FROZEN_TEAMS_BACKFILL: &str = "string(setProperty(setProperty(setProperty(setProperty(setProperty(setProperty(setProperty(setProperty(setProperty(setProperty(setProperty(json('{}'),'schemaVersion',2),'kind','teams-channel'),'capture','backfill'),'channelId',item()?['channelIdentity']?['channelId']),'channelName',''),'teamName',''),'author',item()?['from']?['user']?['displayName']),'messageId',item()?['id']),'replyToId',coalesce(item()?['replyToId'],'')),'dateTimeCreated',item()?['createdDateTime']),'bodyHtml',coalesce(item()?['body']?['content'],'')))";

    /// The window is ONE number. It used to be seven copies — the search query,
    /// a Teams filter, two flow names, two filenames, and the recipe prose — and
    /// a flow NAMED "30d" that imports 14 is a lie that survives review, because
    /// nothing compares the label to the query. Everything derives; this pins it.
    /// The Inbox backfill must actually READ the Inbox. A flow named "Inbox"
    /// that queries Sent Items would make every downstream measurement a lie —
    /// and nothing else in the suite compares the label to the folder.
    #[test]
    fn inbox_backfill_reads_inbox_and_sent_reads_sent() {
        let sent = serde_json::to_string(&build_email_backfill_flow_definition(Mailbox::Sent)).unwrap();
        let inbox = serde_json::to_string(&build_email_backfill_flow_definition(Mailbox::Inbox)).unwrap();
        assert!(sent.contains("\"folderPath\":\"SentItems\""), "sent backfill reads Sent Items");
        assert!(inbox.contains("\"folderPath\":\"Inbox\""), "inbox backfill reads Inbox");
        assert!(sent.contains("'mailbox','sent'"), "sent stamps mailbox sent");
        assert!(inbox.contains("'mailbox','inbox'"), "inbox stamps mailbox inbox");
        // The label must match the folder — that pairing is the whole contract.
        assert!(mail_backfill_flow_name(Mailbox::Inbox).contains("Inbox"));
        assert!(mail_backfill_flow_name(Mailbox::Sent).contains("Sent"));
    }

    /// Every "<n> day(s)" / "<n>d" occurrence in a recipe, as numbers.
    fn regex_lite_day_counts(text: &str) -> Vec<u32> {
        let b: Vec<char> = text.chars().collect();
        let mut out = Vec::new();
        let mut i = 0usize;
        while i < b.len() {
            if b[i].is_ascii_digit() {
                let start = i;
                while i < b.len() && b[i].is_ascii_digit() {
                    i += 1;
                }
                // Build from the CHAR slice — `text[start..i]` mixes char indices
                // with byte indices and panics on the recipe's em-dashes.
                let num: String = b[start..i].iter().collect();
                let n: u32 = num.parse().unwrap_or(0);
                let rest: String = b[i..].iter().take(6).collect();
                if rest.starts_with("d ") || rest.starts_with("d)") || rest.starts_with(" day") {
                    out.push(n);
                }
                continue;
            }
            i += 1;
        }
        out
    }

    #[test]
    fn backfill_window_is_one_number_everywhere() {
        let w = BACKFILL_WINDOW_DAYS;
        assert!(mail_backfill_flow_name(Mailbox::Sent).contains(&format!("{w}d")), "flow name states the window");
        assert!(mail_backfill_flow_name(Mailbox::Inbox).contains(&format!("{w}d")));
        assert!(teams_backfill_flow_name().contains(&format!("{w}d")));
        assert!(mail_backfill_filename(Mailbox::Sent).contains(&format!("{w}d")), "filename states the window");
        assert!(mail_backfill_filename(Mailbox::Inbox).contains(&format!("{w}d")));
        assert!(teams_backfill_filename().contains(&format!("{w}d")));

        // The QUERY must ask for the same window the name advertises.
        let mail = serde_json::to_string(&build_email_backfill_flow_definition(Mailbox::Sent)).unwrap();
        assert!(mail.contains(&format!("addDays(utcNow(),-{w})")), "search query uses the window");
        let teams = serde_json::to_string(&build_teams_backfill_flow_definition()).unwrap();
        assert!(teams.contains(&format!("addDays(utcNow(),-{w})")), "teams filter uses the window");

        // And the recipe a human follows must not contradict either.
        let recipe = build_backfill_recipe();
        assert!(recipe.contains(&format!("last {w} days")), "recipe prose states the window");
        assert!(recipe.contains(&format!("addDays(utcNow(),-{w})")), "recipe query matches");
        // Widened after a live miss: the recipe said "pages through the full 30
        // days" while every other site said 14, and a `contains("30d")` check
        // sailed past it. Assert NO day-count other than the window appears —
        // prose drifts in words, not just in the token you thought to check.
        for m in regex_lite_day_counts(&recipe) {
            assert_eq!(m, w, "recipe mentions {m} days but the window is {w}");
        }
    }

    #[test]
    fn v2_file_content_expressions_are_frozen_byte_exact() {
        assert_eq!(teams_live_file_content_expression(), FROZEN_TEAMS_LIVE);
        assert_eq!(email_backfill_file_content_expression(Mailbox::Sent), FROZEN_MAIL_BACKFILL);
        // The Inbox variant differs ONLY in the mailbox literal — if it ever
        // differs in anything else, the sweep would parse the two differently.
        assert_eq!(
            FROZEN_MAIL_BACKFILL.replace("'mailbox','sent'", "'mailbox','inbox'"),
            email_backfill_file_content_expression(Mailbox::Inbox),
            "inbox backfill must differ from sent ONLY in the mailbox literal"
        );
        assert_eq!(teams_backfill_file_content_expression(), FROZEN_TEAMS_BACKFILL);
    }

    #[test]
    fn v2_expressions_carry_schema_v2_discriminators_and_kind_keys() {
        // Every v2 expression declares schemaVersion 2, a kind, and a capture.
        for (expr, kind, capture) in [
            (FROZEN_TEAMS_LIVE, "'kind','teams-channel'", "'capture','live'"),
            (FROZEN_MAIL_BACKFILL, "'kind','email'", "'capture','backfill'"),
            (FROZEN_TEAMS_BACKFILL, "'kind','teams-channel'", "'capture','backfill'"),
        ] {
            assert!(expr.contains("'schemaVersion',2"), "must be schema v2: {expr}");
            assert!(expr.contains(kind), "must carry {kind}");
            assert!(expr.contains(capture), "must carry {capture}");
        }
        // Teams expressions carry the engine's required Teams keys.
        for expr in [FROZEN_TEAMS_LIVE, FROZEN_TEAMS_BACKFILL] {
            for key in ["'channelId'", "'author'", "'messageId'", "'replyToId'"] {
                assert!(expr.contains(key), "teams expr must carry {key}");
            }
        }
        // The email backfill carries the same v1 email keys the sweep reads.
        for key in ["'from'", "'to'", "'cc'", "'subject'", "'internetMessageId'"] {
            assert!(FROZEN_MAIL_BACKFILL.contains(key), "mail expr must carry {key}");
        }
    }

    /// The capture-boundary invariant (WP-FORMATTING-SEMANTICS): every generated
    /// File Content expression MUST map an HTML body token into `bodyHtml`, and
    /// must NEVER introduce an html-to-text step or use a text preview as the
    /// primary body. Locks the INVARIANT, not just the current bytes.
    #[test]
    fn every_expression_maps_html_into_bodyhtml_and_never_flattens() {
        // (expression, the exact HTML token expected right after 'bodyHtml',)
        let cases = [
            (FROZEN_INBOX, "'bodyHtml',coalesce(triggerBody()?['body'],''"),
            (FROZEN_SENT, "'bodyHtml',coalesce(triggerBody()?['body'],''"),
            (FROZEN_TEAMS_LIVE, "'bodyHtml',coalesce(triggerBody()?['body']?['content'],''"),
            (FROZEN_MAIL_BACKFILL, "'bodyHtml',coalesce(item()?['body'],''"),
            (FROZEN_TEAMS_BACKFILL, "'bodyHtml',coalesce(item()?['body']?['content'],''"),
        ];
        for (expr, html_into_bodyhtml) in cases {
            // The HTML body token is mapped straight into bodyHtml.
            assert!(
                expr.contains(html_into_bodyhtml),
                "expr must map HTML body → bodyHtml ({html_into_bodyhtml}): {expr}"
            );
            // No text-preview substitution and no flow-side html-to-text step.
            assert!(!expr.to_lowercase().contains("preview"), "no body preview: {expr}");
            assert!(!expr.to_lowercase().contains("htmltotext"), "no html-to-text: {expr}");
            assert!(!expr.to_lowercase().contains("html_to_text"), "no html-to-text: {expr}");
            // bodyText is never emitted as a key by any generated flow (it would
            // only ever be an auxiliary field, never a substitute for bodyHtml).
            assert!(!expr.contains("'bodyText'"), "no bodyText key: {expr}");
        }
    }

    #[test]
    fn v2_flow_definitions_parse_and_carry_frozen_expression() {
        for (def, frozen, connector) in [
            (build_teams_live_flow_definition(), FROZEN_TEAMS_LIVE, "shared_teams"),
            (build_email_backfill_flow_definition(Mailbox::Sent), FROZEN_MAIL_BACKFILL, "shared_office365"),
            (build_teams_backfill_flow_definition(), FROZEN_TEAMS_BACKFILL, "shared_teams"),
        ] {
            // Round-trips through JSON.
            let s = serde_json::to_string(&def).unwrap();
            let reparsed: serde_json::Value = serde_json::from_str(&s).unwrap();
            assert_eq!(reparsed, def);
            // The File Content expression appears verbatim somewhere in the def,
            // wrapped @{...} (nested under an Apply-to-each for the backfills).
            assert!(
                s.contains(&format!("@{{{}}}", frozen).replace('"', "\\\"")) || s.contains(frozen),
                "definition must carry the frozen expression"
            );
            // The source connector + OneDrive Create-file connector are referenced.
            assert!(def["connectionReferences"].get(connector).is_some());
            assert!(def["connectionReferences"]
                .get("shared_onedriveforbusiness")
                .is_some());
        }
    }

    #[test]
    fn v2_recipes_carry_frozen_expressions_and_names() {
        let teams = build_teams_recipe();
        assert!(teams.contains(FROZEN_TEAMS_LIVE));
        assert!(teams.contains(CREATE_FILE_FOLDER_PATH_TEAMS));
        assert!(teams.contains("concat(guid(),'.json')"));

        let backfill = build_backfill_recipe();
        assert!(backfill.contains(FROZEN_MAIL_BACKFILL));
        assert!(backfill.contains(FROZEN_TEAMS_BACKFILL));
        assert!(backfill.contains(&mail_backfill_flow_name(Mailbox::Sent)));
        assert!(backfill.contains(&teams_backfill_flow_name()));
    }

    /// Eyeball smoke — writes a real package to a chosen dir + prints paths.
    /// `#[ignore]` (writes outside tempdir on demand):
    ///   `cargo test --lib flow_package_live_smoke -- --ignored --nocapture`
    /// Set `FLOWPKG_OUT` to the target directory.
    #[test]
    #[ignore]
    fn flow_package_live_smoke() {
        let out = std::env::var("FLOWPKG_OUT").expect("set FLOWPKG_OUT");
        let pkg = generate_flow_package(Path::new(&out)).unwrap();
        println!("FLOWPKG={}", serde_json::to_string_pretty(&pkg).unwrap());
    }

    /// Regeneration must not leave a stale definition behind. Our filenames carry
    /// the window, so a window change strands the old file — carrying whatever bug
    /// the old build had, looking just as legitimate. This happened for real
    /// (a `-30d` file full of `createObject` sat next to the working `-14d` one).
    /// Equally: a file the USER put here must survive.
    #[test]
    fn generate_removes_superseded_definitions_but_not_user_files() {
        let root = std::env::temp_dir().join(format!(
            "threshold-stale-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let pkg_dir = root.join("Threshold-PowerAutomate");
        std::fs::create_dir_all(&pkg_dir).unwrap();

        // A stale definition from an older window, and a user's own file.
        let stale = pkg_dir.join("threshold-mail-backfill-30d.flow.json");
        let users = pkg_dir.join("my-notes.json");
        let users_flow = pkg_dir.join("my-own.flow.json"); // not ours: no threshold- prefix
        std::fs::write(&stale, "{\"createObject\":\"broken\"}").unwrap();
        std::fs::write(&users, "{}").unwrap();
        std::fs::write(&users_flow, "{}").unwrap();

        generate_flow_package(&root).unwrap();

        assert!(!stale.exists(), "superseded definition must be removed");
        assert!(users.exists(), "a user's file must survive");
        assert!(users_flow.exists(), "a non-threshold flow file must survive");
        // And the current ones are present.
        assert!(pkg_dir.join(mail_backfill_filename(Mailbox::Sent)).exists());
        assert!(pkg_dir.join(mail_backfill_filename(Mailbox::Inbox)).exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn generate_flow_package_writes_all_three_files() {
        let root = std::env::temp_dir().join(format!(
            "threshold-flowpkg-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();

        let pkg = generate_flow_package(&root).unwrap();
        assert!(pkg.is_fallback);

        // All artifacts exist under the grouped subfolder (v1 mail + v2 flows).
        assert!(Path::new(&pkg.inbox_definition).exists());
        assert!(Path::new(&pkg.sent_definition).exists());
        assert!(Path::new(&pkg.recipe).exists());
        assert!(Path::new(&pkg.teams_live_definition).exists());
        assert!(Path::new(&pkg.mail_backfill_definition).exists());
        assert!(Path::new(&pkg.teams_backfill_definition).exists());
        assert!(Path::new(&pkg.teams_recipe).exists());
        assert!(Path::new(&pkg.backfill_recipe).exists());
        assert!(pkg.dir.ends_with("Threshold-PowerAutomate"));

        // A written v2 definition parses + carries its frozen expression.
        let teams: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&pkg.teams_live_definition).unwrap())
                .unwrap();
        let tbody = &teams["properties"]["definition"]["actions"]["Create_file"]["inputs"]
            ["parameters"]["body"];
        assert_eq!(tbody, &format!("@{{{}}}", FROZEN_TEAMS_LIVE));

        // The written definitions parse + carry the frozen expression.
        let inbox: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&pkg.inbox_definition).unwrap()).unwrap();
        let body = &inbox["properties"]["definition"]["actions"]["Create_file"]["inputs"]
            ["parameters"]["body"];
        assert_eq!(body, &format!("@{{{}}}", FROZEN_INBOX));

        // Idempotent — a second run overwrites cleanly.
        let pkg2 = generate_flow_package(&root).unwrap();
        assert_eq!(pkg.inbox_definition, pkg2.inbox_definition);

        let _ = std::fs::remove_dir_all(&root);
    }
}
